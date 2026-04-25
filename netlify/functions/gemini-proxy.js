// Proxy seguro a Gemini API — la API key vive solo en Netlify env vars
// Endpoint: POST /.netlify/functions/gemini-proxy  body: { prompt, model? }
// Responde: { text } o { error }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return respond(500, { error: 'GEMINI_API_KEY no configurada en el servidor' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'JSON inválido' });
  }

  const prompt = (body.prompt || '').trim();
  if (!prompt) {
    return respond(400, { error: 'Falta el campo "prompt"' });
  }

  const model = body.model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  // Si viene un archivo subido a Gemini File API, lo incluimos como parte multimodal
  const parts = [];
  if (body.fileUri && body.mimeType) {
    parts.push({ fileData: { mimeType: body.mimeType, fileUri: body.fileUri } });
  }
  parts.push({ text: prompt });

  const maxOutputTokens = body.fileUri ? 16384 : 8192;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens,
        },
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      const msg = data?.error?.message || `Gemini API error ${resp.status}`;
      return respond(resp.status, { error: msg });
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) {
      return respond(502, { error: 'Gemini no devolvió texto', raw: data });
    }

    return respond(200, { text, model });
  } catch (err) {
    return respond(500, { error: err.message || 'Error llamando a Gemini' });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(payload),
  };
}
