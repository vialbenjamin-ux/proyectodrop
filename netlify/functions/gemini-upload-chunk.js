// Reenvía un chunk del video al endpoint de upload resumable de Gemini.
// Endpoint: POST /.netlify/functions/gemini-upload-chunk
// Body JSON: { uploadUrl, offset, chunkBase64, finalize }
// Responde: { ok: true } para chunks intermedios, o el fileMeta de Google
//   ({ file: { name, uri, state, ... } }) cuando finalize=true.
//
// Por qué este proxy: algunos navegadores/redes bloquean uploads
// cross-origin a googleapis.com. Mandando el archivo a esta function
// (mismo origen) y desde acá a Google, evitamos cualquier bloqueo.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON inválido' }); }

  const { uploadUrl, offset, chunkBase64, finalize } = body;
  if (!uploadUrl) return respond(400, { error: 'Falta uploadUrl' });
  if (typeof offset !== 'number') return respond(400, { error: 'Falta offset (number)' });
  if (!chunkBase64) return respond(400, { error: 'Falta chunkBase64' });

  const chunkBuf = Buffer.from(chunkBase64, 'base64');

  try {
    const resp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': String(offset),
        'X-Goog-Upload-Command': finalize ? 'upload, finalize' : 'upload',
        'Content-Length': String(chunkBuf.length),
      },
      body: chunkBuf,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return respond(resp.status, { error: 'Google rechazó chunk @offset=' + offset + ': ' + errText.slice(0, 300) });
    }

    if (finalize) {
      // Última pieza: Google responde con el fileMeta completo
      const data = await resp.json();
      return respond(200, data);
    } else {
      // Chunk intermedio: response vacía con status OK
      return respond(200, { ok: true });
    }
  } catch (err) {
    return respond(500, { error: err.message || 'Error reenviando chunk' });
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
