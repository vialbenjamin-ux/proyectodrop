// Llamada simple (no-streaming) a Gemini con imágenes inline + prompt.
// Endpoint: POST /.netlify/functions/gemini-vision
// Body: { prompt: string, images: [{ mimeType, data (base64) }, ...], model? }
// Respuesta: { text } o { error }

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

  const model = body.model || 'gemini-2.5-flash';
  const parts = [];
  if (Array.isArray(body.images)) {
    for (const img of body.images) {
      if (img && img.mimeType && img.data) {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      }
    }
  }
  parts.push({ text: prompt });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const reqBody = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 0.6, maxOutputTokens: 1024 },
  });

  // Reintentos para errores transitorios (high demand / 429 / 503)
  const BACKOFF = [1500, 3000];
  for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: reqBody,
      });
    } catch (err) {
      if (attempt < BACKOFF.length) {
        await new Promise(r => setTimeout(r, BACKOFF[attempt]));
        continue;
      }
      return respond(502, { error: 'Network: ' + (err.message || '?') });
    }
    if (resp.ok) {
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return respond(200, { text });
    }
    // Error: leer mensaje
    const errText = await resp.text();
    let errMsg = errText;
    try { const j = JSON.parse(errText); errMsg = j?.error?.message || errText; } catch {}
    const transient = resp.status === 503 || resp.status === 429
      || /high demand|overloaded|temporarily|try again/i.test(errMsg);
    if (transient && attempt < BACKOFF.length) {
      await new Promise(r => setTimeout(r, BACKOFF[attempt]));
      continue;
    }
    return respond(resp.status, { error: 'Gemini: ' + String(errMsg).slice(0, 400) });
  }
  return respond(503, { error: 'Gemini sigue saturado' });
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
