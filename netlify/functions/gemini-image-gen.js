// Generación / edición de imágenes con Gemini 2.5 Flash Image (Nano Banana).
// Endpoint: POST /.netlify/functions/gemini-image-gen
// Body: { prompt: string, images?: [{ mimeType, data (base64) }, ...] }
// Respuesta: { mimeType, data } (imagen generada en base64) o { error }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST')    return respond(405, { error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return respond(500, { error: 'GEMINI_API_KEY no configurada' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON inválido' }); }

  const prompt = (body.prompt || '').trim();
  if (!prompt) return respond(400, { error: 'Falta el campo prompt' });

  // Modelos a probar en orden. Los nombres de modelos de imagen cambian
  // seguido en la API de Gemini. Probamos varios y usamos el primero que
  // responde sin 'not found'.
  const MODEL_CANDIDATES = body.model
    ? [body.model]
    : [
        'gemini-2.5-flash-image',
        'gemini-2.0-flash-exp-image-generation',
        'gemini-2.0-flash-preview-image-generation',
        'gemini-2.5-flash-image-preview',
      ];

  const parts = [];
  if (Array.isArray(body.images)) {
    for (const img of body.images) {
      if (img && img.mimeType && img.data) {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      }
    }
  }
  parts.push({ text: prompt });

  const reqBody = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      temperature: 0.8,
    },
  });

  const BACKOFF = [2000, 4000];
  let lastErrMsg = null;
  let lastStatus = null;

  for (const model of MODEL_CANDIDATES) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
    for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: reqBody,
        });
      } catch (err) {
        lastErrMsg = 'Network: ' + (err.message || '?');
        if (attempt < BACKOFF.length) { await new Promise(r => setTimeout(r, BACKOFF[attempt])); continue; }
        break;
      }
      if (resp.ok) {
        const data = await resp.json();
        const imgPart = data?.candidates?.[0]?.content?.parts?.find(p => p?.inlineData?.data);
        if (!imgPart) {
          const txt = data?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
          lastErrMsg = 'Gemini no devolvió imagen' + (txt ? (': ' + txt.slice(0, 200)) : '');
          break;
        }
        return respond(200, {
          mimeType: imgPart.inlineData.mimeType || 'image/png',
          data: imgPart.inlineData.data,
          modelUsed: model,
        });
      }
      const errText = await resp.text();
      let errMsg = errText;
      try { const j = JSON.parse(errText); errMsg = j?.error?.message || errText; } catch {}
      lastErrMsg = errMsg;
      lastStatus = resp.status;
      // Si el modelo no existe, ir al siguiente sin gastar reintentos
      if (resp.status === 404 || /not found|is not supported/i.test(errMsg)) {
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
  }
  return respond(lastStatus || 502, { error: 'Gemini Image: ' + String(lastErrMsg || 'todos los modelos fallaron').slice(0, 400) });
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
