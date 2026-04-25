// Reenvía un upload completo (1 sola pieza, finalize) a Gemini File API.
// Endpoint: POST /.netlify/functions/gemini-upload-chunk
// Headers requeridos:
//   - Content-Type: application/octet-stream
//   - X-BK-Upload-Url: el uploadUrl que devolvió gemini-upload-init
// Body: los bytes del archivo (raw, no JSON, no base64)
// Responde: el fileMeta de Google { file: { name, uri, state, ... } }
//
// Único path soportado: 1-shot upload con finalize. Para archivos
// más grandes que ~5.5MB esta function no sirve (límite de body de
// Netlify es 6MB). En ese caso el frontend debe fallback a upload
// directo a Google desde el navegador.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const headers = lowercaseHeaders(event.headers || {});
  const uploadUrl = headers['x-bk-upload-url'];
  if (!uploadUrl) {
    return respond(400, { error: 'Falta header X-BK-Upload-Url' });
  }

  // Netlify pasa el body como base64 cuando isBase64Encoded=true
  const buf = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'binary');

  if (!buf.length) {
    return respond(400, { error: 'Body vacío' });
  }

  try {
    const resp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
        'Content-Length': String(buf.length),
      },
      body: buf,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return respond(resp.status, { error: 'Google rechazó upload: ' + errText.slice(0, 400) });
    }

    const data = await resp.json();
    return respond(200, data);
  } catch (err) {
    return respond(500, { error: err.message || 'Error reenviando upload' });
  }
};

function lowercaseHeaders(obj) {
  const r = {};
  for (const k in obj) r[k.toLowerCase()] = obj[k];
  return r;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-BK-Upload-Url',
  };
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(payload),
  };
}
