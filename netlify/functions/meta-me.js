// Devuelve el ID + nombre del System User que corresponde al token BKDROP.
// Sirve para identificar cuál System User asignar activos.
const meta = require('./_meta-api');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });
  const tenant = String((event.queryStringParameters || {}).tenant || 'chile').toLowerCase();
  const token = tenant === 'gt' ? process.env.META_ACCESS_TOKEN_GT : process.env.META_ACCESS_TOKEN;
  if (!token) return respond(500, { error: 'META_ACCESS_TOKEN no configurada' });
  const V = meta.META_API_VERSION;
  try {
    const data = await meta.fetchOne(`https://graph.facebook.com/${V}/me?fields=id,name,business{id,name},list_of_permissions&access_token=${encodeURIComponent(token)}`);
    return respond(200, {
      id: data.id,
      name: data.name,
      business: data.business || null,
      permissions: data.list_of_permissions || null,
      tenant,
      hint: 'El "business" es el BM padre del System User. Ese es el socio al que hay que asignar la nueva cuenta.',
    });
  } catch (err) {
    if (err.isPolicyViolation || err.tokenInvalid || err.isRateLimit) return meta.metaErrorToResponse(err, respond);
    return respond(500, { error: err.message || 'Error' });
  }
};

function cors() { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function respond(s, p) { return { statusCode: s, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(p) }; }
