// Devuelve info de los Business Managers accesibles con el token BKDROP.
// Sirve para obtener el Business ID (necesario para "Assign partners" en
// otra cuenta que quieras compartir con este BM).
//
// GET /.netlify/functions/meta-business-info?tenant=chile
// Respuesta:
//   { businesses: [{ id, name, verification_status }] }
//
// Requiere que el token tenga scope 'business_management'.

const meta = require('./_meta-api');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const params = event.queryStringParameters || {};
  const tenant = String(params.tenant || 'chile').toLowerCase();
  const token = (tenant === 'gt')
    ? process.env.META_ACCESS_TOKEN_GT
    : process.env.META_ACCESS_TOKEN;
  if (!token) return respond(500, { error: 'META_ACCESS_TOKEN' + (tenant === 'gt' ? '_GT' : '') + ' no configurada' });

  const V = meta.META_API_VERSION;
  const url = `https://graph.facebook.com/${V}/me/businesses?fields=id,name,verification_status,created_time&limit=100&access_token=${encodeURIComponent(token)}`;

  try {
    const data = await meta.fetchOne(url);
    const businesses = (data.data || []).map(b => ({
      id: b.id,
      name: b.name,
      verification_status: b.verification_status || null,
      created_time: b.created_time || null,
    }));
    return respond(200, {
      businesses,
      total: businesses.length,
      tenant,
      hint: businesses.length === 1
        ? 'Solo hay 1 BM asociado a este token. Ese es tu BM Principal — usá ese ID para asignar partners desde el otro BM.'
        : 'Hay múltiples BMs asociados. El principal suele ser el que tiene más cuentas activas.',
    });
  } catch (err) {
    if (err.isPolicyViolation || err.tokenInvalid || err.isRateLimit) {
      return meta.metaErrorToResponse(err, respond);
    }
    return respond(500, { error: err.message || 'Error consultando /me/businesses' });
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
