// Generación de imágenes con los modelos de imagen de OpenAI.
//
// Mismo contrato que gemini-image-gen.js a propósito, para que quien llame
// pueda cambiar de motor cambiando solo la URL:
//   POST /.netlify/functions/openai-image-gen
//   Body: { prompt, images?: [{mimeType, data}], model?, quality?, size?, background? }
//   background: 'transparent' devuelve PNG con alfa (para sellos y recortes).
//   Respuesta: { mimeType, data, modelUsed } o { error }
//
// Para qué se usa: Gemini escribe mal el texto en español dentro de la imagen
// ("Deságue", "LAVMANOS", "FURTE"), y la imagen HERO del producto es la que
// lleva el título, el sello y las etiquetas. Esa se genera acá; las otras dos
// del carrusel siguen saliendo de Gemini, que es más barato y ahí el texto
// pesa menos.
//
// Costo aproximado (precios de sept 2026): gpt-image-2 cobra US$30 por millón
// de tokens de salida, o sea ~US$0,13 por imagen de 1024x1024 en calidad alta,
// más ~US$0,01 por cada imagen de referencia que se le mande.
//
// OJO con el tiempo: una función síncrona de Netlify corta a los 26 s y una
// imagen en calidad alta puede tardar más. Por eso el default es 'medium', que
// además cuesta bastante menos. 'high' queda disponible pidiéndolo explícito.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST')    return respond(405, { error: 'Method not allowed' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return respond(500, { error: 'OPENAI_API_KEY no configurada en Netlify' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON inválido' }); }

  const prompt = (body.prompt || '').trim();
  if (!prompt) return respond(400, { error: 'Falta prompt' });

  const size = ['1024x1024', '1024x1536', '1536x1024', 'auto'].includes(body.size) ? body.size : '1024x1024';
  const quality = ['low', 'medium', 'high', 'auto'].includes(body.quality) ? body.quality : 'medium';
  // 'transparent' solo vale con PNG, y es lo que necesitan los sellos.
  const background = ['transparent', 'opaque', 'auto'].includes(body.background) ? body.background : null;

  // En cascada, como gemini-image-gen: si la cuenta no tiene acceso al primero
  // se prueba el siguiente en vez de fallar.
  const MODELOS = body.model ? [body.model] : ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1'];

  const referencias = Array.isArray(body.images)
    ? body.images.filter(i => i && i.mimeType && i.data).slice(0, 8)
    : [];

  let ultimoError = null;
  let ultimoStatus = null;

  for (const model of MODELOS) {
    try {
      const r = referencias.length
        ? await conReferencias(apiKey, model, prompt, referencias, size, quality, background)
        : await sinReferencias(apiKey, model, prompt, size, quality, background);

      if (r.ok) return respond(200, { mimeType: 'image/png', data: r.b64, modelUsed: model });

      ultimoError = r.error;
      ultimoStatus = r.status;
      // Modelo que la cuenta no tiene: pasar al siguiente sin insistir.
      if (r.status === 404 || /does not exist|not have access|unsupported|must be verified/i.test(r.error || '')) continue;
      // Sin saldo o key inválida: no tiene sentido probar otro modelo.
      if (r.status === 401 || r.status === 403 || /billing|quota|insufficient/i.test(r.error || '')) break;
    } catch (err) {
      ultimoError = err.message || 'error desconocido';
    }
  }

  return respond(ultimoStatus === 401 ? 401 : 502, {
    error: 'OpenAI: ' + (ultimoError || 'no se pudo generar la imagen'),
    modelosProbados: MODELOS,
  });
};

// Con imágenes de referencia va a /images/edits, que es multipart.
async function conReferencias(apiKey, model, prompt, referencias, size, quality, background) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('quality', quality);
  form.append('n', '1');
  if (background) { form.append('background', background); form.append('output_format', 'png'); }
  referencias.forEach((img, i) => {
    const bin = Buffer.from(img.data, 'base64');
    const ext = (img.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg');
    form.append('image[]', new Blob([bin], { type: img.mimeType }), 'ref-' + (i + 1) + '.' + ext);
  });

  const resp = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey },
    body: form,
  });
  return await leer(resp);
}

async function sinReferencias(apiKey, model, prompt, size, quality, background) {
  const cuerpo = { model, prompt, size, quality, n: 1 };
  if (background) { cuerpo.background = background; cuerpo.output_format = 'png'; }
  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  return await leer(resp);
}

async function leer(resp) {
  const txt = await resp.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* respuesta no JSON */ }

  if (!resp.ok) {
    const msg = (j && j.error && j.error.message) || txt.slice(0, 300);
    return { ok: false, status: resp.status, error: msg };
  }
  const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) return { ok: false, status: resp.status, error: 'respuesta sin imagen' };
  return { ok: true, b64 };
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function respond(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
