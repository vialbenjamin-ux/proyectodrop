// Devuelve el ID + nombre del System User que corresponde al token BKDROP.
// Sirve para identificar cuál System User asignar activos.
const { pais } = require('./_tenant');
// Token de Meta del pais. 'cp' (cuentas de otro BM) sigue usando el token de
// Chile, como antes de _tenant.js. Desconocido o 'mx' sin token: null y la funcion avisa.
const metaTokenDe = t => { if (String(t).toLowerCase() === 'cp') return process.env.META_ACCESS_TOKEN; const P = pais(t); return P.error ? null : P.metaToken; };
const metaEnvDe = t => { if (String(t).toLowerCase() === 'cp') return 'META_ACCESS_TOKEN'; const P = pais(t); return P.error ? P.error : P.envMetaToken; };
const meta = require('./_meta-api');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });
  const tenant = String((event.queryStringParameters || {}).tenant || 'chile').toLowerCase();
  const token = metaTokenDe(tenant);
  if (!token) return respond(500, { error: 'META_ACCESS_TOKEN no configurada' });
  const V = meta.META_API_VERSION;
  try {
    const data = await meta.fetchOne(`https://graph.facebook.com/${V}/me?fields=id,name&access_token=${encodeURIComponent(token)}`);
    return respond(200, { id: data.id, name: data.name, tenant });
  } catch (err) {
    if (err.isPolicyViolation || err.tokenInvalid || err.isRateLimit) return meta.metaErrorToResponse(err, respond);
    return respond(500, { error: err.message || 'Error' });
  }
};

function cors() { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function respond(s, p) { return { statusCode: s, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(p) }; }
