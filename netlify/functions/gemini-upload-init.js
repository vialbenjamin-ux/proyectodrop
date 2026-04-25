// Inicia un upload resumable a Gemini File API.
// Endpoint: POST /.netlify/functions/gemini-upload-init
// Body: { mimeType, sizeBytes, displayName? }
// Responde: { uploadUrl } — el frontend hace PUT directo a Google con esa URL.
// La API key vive en Netlify env vars (GEMINI_API_KEY), nunca en el frontend.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return respond(500, { error: 'GEMINI_API_KEY no configurada' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'JSON inválido' });
  }

  const mimeType = body.mimeType;
  const sizeBytes = body.sizeBytes;
  const displayName = body.displayName || 'bkdrop_video';

  if (!mimeType || !sizeBytes) {
    return respond(400, { error: 'mimeType y sizeBytes son requeridos' });
  }

  // Hard cap: 20 MB para evitar abuso (el usuario dice que sus videos son ≤10MB)
  const MAX_BYTES = 20 * 1024 * 1024;
  if (sizeBytes > MAX_BYTES) {
    return respond(400, { error: `Archivo muy grande (${(sizeBytes/1024/1024).toFixed(1)}MB). Máximo 20MB.` });
  }

  const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(sizeBytes),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return respond(resp.status, { error: 'Init upload falló: ' + text.slice(0, 300) });
    }

    const uploadUrl = resp.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      return respond(502, { error: 'Google no devolvió X-Goog-Upload-URL' });
    }

    return respond(200, { uploadUrl });
  } catch (err) {
    return respond(500, { error: err.message || 'Error iniciando upload' });
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
