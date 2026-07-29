// Devuelve info detallada de una cuenta publicitaria (owner + business + status)
// Solo lectura. Sirve para diagnosticar por qué una cuenta aparece o no en BKDROP.
//
// GET /.netlify/functions/meta-account-info?act_id=act_XXX&tenant=chile
const meta = require('./_meta-api');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });
  const params = event.queryStringParameters || {};
  const actId = String(params.act_id || '').trim();
  const tenant = String(params.tenant || 'chile').toLowerCase();
  if (!/^act_\d+$/.test(actId)) return respond(400, { error: 'act_id inválido (debe ser act_XXX)' });
  const token = tenant === 'gt' ? process.env.META_ACCESS_TOKEN_GT : process.env.META_ACCESS_TOKEN;
  if (!token) return respond(500, { error: 'META_ACCESS_TOKEN no configurada' });
  const V = meta.META_API_VERSION;
  const fields = [
    'id','name','account_id','account_status','currency','timezone_name',
    'business{id,name}','owner',
    'partner','agency_client_declaration',
    'disable_reason',
  ].join(',');
  try {
    const data = await meta.fetchOne(`https://graph.facebook.com/${V}/${actId}?fields=${fields}&access_token=${encodeURIComponent(token)}`);
    return respond(200, data);
  } catch (err) {
    if (err.isPolicyViolation || err.tokenInvalid || err.isRateLimit) return meta.metaErrorToResponse(err, respond);
    return respond(err.code === 100 ? 400 : 502, {
      error: err.message || 'Error',
      code: err.code || null,
      hint: err.code === 100 ? 'La cuenta no es accesible con este token (probablemente no está compartida al BM del token).' : null,
    });
  }
};

function cors() { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function respond(s, p) { return { statusCode: s, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(p) }; }
