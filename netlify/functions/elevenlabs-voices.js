// Lista las voces de la cuenta de ElevenLabs filtradas para uso en BKDROP.
// Endpoint: GET /.netlify/functions/elevenlabs-voices
// Filtros: solo voces con language=es (todas las latinoamericanas + chilenas).
// Responde: { voices: [{ id, name, gender, accent, use_case, category }] }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return respond(500, { error: 'ELEVENLABS_API_KEY no configurada' });
  }

  try {
    const resp = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
    });
    const data = await resp.json();
    if (!resp.ok) {
      return respond(resp.status, { error: data?.detail?.message || data?.detail || 'Error consultando voces' });
    }
    const all = (data.voices || []).map(v => ({
      id: v.voice_id,
      name: v.name,
      gender: (v.labels && v.labels.gender) || '',
      age: (v.labels && v.labels.age) || '',
      accent: (v.labels && v.labels.accent) || '',
      language: (v.labels && v.labels.language) || '',
      use_case: (v.labels && (v.labels.use_case || v.labels.useCase)) || '',
      category: v.category || '',
    }));
    // Solo voces con language=es (descarta las en inglés default de Eleven)
    const filtered = all.filter(v => v.language === 'es');
    return respond(200, { voices: filtered });
  } catch (err) {
    return respond(500, { error: err.message || 'Error consultando voces' });
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
