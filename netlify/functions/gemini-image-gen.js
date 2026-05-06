// Generación de imágenes vía Gemini Image (multimodal con referencia) o
// Imagen 3 (text-to-image puro). Probamos varios modelos en cascada para
// soportar cuentas con distintos niveles de acceso.
// Endpoint: POST /.netlify/functions/gemini-image-gen
// Body: { prompt: string, images?: [{mimeType, data}], model?: string }
// Respuesta: { mimeType, data, modelUsed } o { error }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST')    return respond(405, { error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return respond(500, { error: 'GEMINI_API_KEY no configurada' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON inválido' }); }

  const prompt = (body.prompt || '').trim();
  if (!prompt) return respond(400, { error: 'Falta prompt' });

  // Modelos en orden de preferencia. Los gemini-* permiten imagen de referencia
  // (multimodal). Los imagen-* son text-to-image puro pero más estables/disponibles.
  const MODEL_CANDIDATES = body.model
    ? [body.model]
    : [
        'gemini-2.5-flash-image',
        'gemini-2.0-flash-exp-image-generation',
        'gemini-2.0-flash-preview-image-generation',
        'gemini-2.5-flash-image-preview',
        'imagen-3.0-fast-generate-001',
        'imagen-3.0-generate-002',
        'imagen-3.0-generate-001',
      ];

  const referenceImages = Array.isArray(body.images) ? body.images.filter(i => i && i.mimeType && i.data) : [];

  let lastErrMsg = null;
  let lastStatus = null;

  for (const model of MODEL_CANDIDATES) {
    const isImagen = /^imagen-/i.test(model);
    const endpoint = isImagen ? 'predict' : 'generateContent';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${endpoint}?key=${apiKey}`;

    let payload;
    if (isImagen) {
      // Imagen 3: text-to-image. Ignora imágenes de referencia (no soporta).
      payload = JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: '1:1', personGeneration: 'allow_adult' },
      });
    } else {
      const parts = [];
      for (const img of referenceImages) {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      }
      parts.push({ text: prompt });
      payload = JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ['IMAGE'], temperature: 0.8 },
      });
    }

    const BACKOFF = [2000, 4000];
    let modelFinalErr = null;
    for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
      } catch (err) {
        modelFinalErr = 'Network: ' + (err.message || '?');
        if (attempt < BACKOFF.length) { await new Promise(r => setTimeout(r, BACKOFF[attempt])); continue; }
        break;
      }

      if (resp.ok) {
        const data = await resp.json();
        let img = null;
        if (isImagen) {
          const pred = data?.predictions?.[0];
          if (pred?.bytesBase64Encoded) {
            img = { mimeType: pred.mimeType || 'image/png', data: pred.bytesBase64Encoded };
          }
        } else {
          const p = data?.candidates?.[0]?.content?.parts?.find(p => p?.inlineData?.data);
          if (p) img = { mimeType: p.inlineData.mimeType || 'image/png', data: p.inlineData.data };
        }
        if (img) {
          return respond(200, { ...img, modelUsed: model });
        }
        const txt = data?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
        modelFinalErr = 'Sin imagen' + (txt ? ': ' + txt.slice(0, 200) : '');
        break;
      }

      const errText = await resp.text();
      let errMsg = errText;
      try { const j = JSON.parse(errText); errMsg = j?.error?.message || errText; } catch {}
      modelFinalErr = errMsg;
      lastStatus = resp.status;

      // 404 / not found / not supported → ir al siguiente modelo sin reintentar
      if (resp.status === 404 || /not found|is not supported|not enabled/i.test(errMsg)) {
        break;
      }
      // 403 (permiso denegado) → probar otro modelo
      if (resp.status === 403) {
        break;
      }
      const transient = resp.status === 503 || resp.status === 429
        || /high demand|overloaded|temporarily|try again/i.test(errMsg);
      if (transient && attempt < BACKOFF.length) {
        await new Promise(r => setTimeout(r, BACKOFF[attempt]));
        continue;
      }
      break;
    }
    lastErrMsg = `[${model}] ${modelFinalErr || '?'}`;
  }

  return respond(lastStatus || 502, {
    error: 'Ningún modelo de imagen disponible. Último: ' + String(lastErrMsg || '?').slice(0, 400)
  });
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
