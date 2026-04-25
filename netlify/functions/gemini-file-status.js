// Consulta el estado de un archivo subido a Gemini File API.
// Endpoint: GET /.netlify/functions/gemini-file-status?name=files/abc123
// Responde: { state: "ACTIVE"|"PROCESSING"|"FAILED", uri, mimeType }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return respond(500, { error: 'GEMINI_API_KEY no configurada' });
  }

  const name = event.queryStringParameters && event.queryStringParameters.name;
  if (!name || !/^files\/[\w-]+$/.test(name)) {
    return respond(400, { error: 'Param "name" inválido (esperado: files/xxx)' });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/${name}?key=${apiKey}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) {
      return respond(resp.status, { error: data?.error?.message || 'Error consultando archivo' });
    }
    return respond(200, {
      state: data.state,
      uri: data.uri,
      mimeType: data.mimeType,
      name: data.name,
    });
  } catch (err) {
    return respond(500, { error: err.message || 'Error consultando archivo' });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
