// Cambia status de una campaña Meta Ads (ACTIVE / PAUSED).
// Uso desde BKDROP frontend:
//   POST /.netlify/functions/meta-campaign-status
//   Body: { campaign_id: "123456789", operation: "ACTIVE"|"PAUSED", tenant?: "chile"|"gt" }
//
// Meta Marketing API:
//   POST /{campaign_id}?status=ACTIVE|PAUSED
//
// Cap 1 campaña por request (Meta hace 1 update por request). Si querés
// batch, llamá varias veces con delay entre cada una (anti-ban).

const meta = require('./_meta-api');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON invalido' }); }

  const campaignId = String(body.campaign_id || '').trim();
  const operation = String(body.operation || '').toUpperCase();
  const tenant = String(body.tenant || 'chile').toLowerCase();

  if (!campaignId || !/^\d+$/.test(campaignId)) return respond(400, { error: 'campaign_id inválido' });
  if (!['ACTIVE', 'PAUSED'].includes(operation)) {
    return respond(400, { error: 'operation debe ser ACTIVE o PAUSED' });
  }

  const tokenByTenant = {
    gt:    process.env.META_ACCESS_TOKEN_GT,
    cp:    process.env.META_ACCESS_TOKEN_CP,
    chile: process.env.META_ACCESS_TOKEN,
  };
  const token = tokenByTenant[tenant] || tokenByTenant.chile;
  if (!token) return respond(500, { error: 'Token Meta no configurado para tenant=' + tenant });

  const V = meta.META_API_VERSION;
  const url = `https://graph.facebook.com/${V}/${campaignId}?access_token=${encodeURIComponent(token)}`;
  const formBody = new URLSearchParams({ status: operation }).toString();

  try {
    const data = await meta.fetchOne(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
    });
    // Meta devuelve { success: true } en actualización correcta.
    if (data && data.success === false) {
      return respond(502, { error: 'Meta rechazó el update', detail: data });
    }
    return respond(200, {
      ok: true,
      campaignId,
      operation,
      metaResponse: data,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err.isPolicyViolation || err.tokenInvalid || err.isRateLimit) {
      return meta.metaErrorToResponse(err, respond);
    }
    return respond(500, { error: err.message || 'Error actualizando status Meta', code: err.code || null });
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
