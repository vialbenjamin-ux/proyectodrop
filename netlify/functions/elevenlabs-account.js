// Devuelve info de la cuenta ElevenLabs: plan actual, caracteres disponibles,
// si tiene dubbing habilitado. Se usa para diagnosticar antes de armar features.
// GET /.netlify/functions/elevenlabs-account

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return respond(500, { error: 'ELEVENLABS_API_KEY no configurada' });

  const headers = { 'xi-api-key': apiKey };

  try {
    const [userR, dubR] = await Promise.all([
      fetch('https://api.elevenlabs.io/v1/user/subscription', { headers }),
      // Probar acceso al endpoint de dubbing (listado). Si lo permite, tenemos acceso.
      fetch('https://api.elevenlabs.io/v1/dubbing?page_size=1', { headers }),
    ]);
    const userTxt = await userR.text();
    const dubTxt = await dubR.text();
    let userData, dubData;
    try { userData = JSON.parse(userTxt); } catch { userData = { raw: userTxt.slice(0, 300) }; }
    try { dubData = JSON.parse(dubTxt); } catch { dubData = { raw: dubTxt.slice(0, 300) }; }

    return respond(200, {
      account: {
        tier: userData.tier || null,
        status: userData.status || null,
        character_count: userData.character_count || null,
        character_limit: userData.character_limit || null,
        can_extend_character_limit: userData.can_extend_character_limit || null,
        allowed_to_extend_character_limit: userData.allowed_to_extend_character_limit || null,
        next_character_count_reset_unix: userData.next_character_count_reset_unix || null,
      },
      dubbing: {
        endpointStatus: dubR.status,
        endpointOk: dubR.ok,
        response: dubR.ok ? dubData : { error: dubData.detail || dubData.message || dubData },
      },
      rawUser: userData,
    });
  } catch (err) {
    return respond(502, { error: 'Fetch fail: ' + (err.message || 'unknown') });
  }
};

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
