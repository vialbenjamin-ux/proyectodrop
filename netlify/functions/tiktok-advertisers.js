// Devuelve la lista de advertisers (ad accounts) conectados al access_token de
// TikTok que el usuario obtuvo via OAuth. El token vive en localStorage del
// frontend, lo manda en el body para no exponerlo en URL/logs.
//
// POST /.netlify/functions/tiktok-advertisers
// Body: { "access_token": "..." }
// Responde: { advertisers: [{ advertiser_id, advertiser_name, currency, status }] }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const appId  = process.env.TIKTOK_APP_ID;
  const secret = process.env.TIKTOK_APP_SECRET;
  if (!appId || !secret) {
    return respond(500, { error: 'Faltan TIKTOK_APP_ID o TIKTOK_APP_SECRET en el servidor' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON inválido' }); }
  const token = body.access_token;
  if (!token) return respond(400, { error: 'Falta access_token' });

  // Listar advertisers vinculados al token
  const listUrl = `https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/?app_id=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`;
  let listData;
  try {
    const r = await fetch(listUrl, { headers: { 'Access-Token': token } });
    listData = await r.json();
    if (listData.code !== 0) {
      return respond(400, { error: 'TikTok: ' + (listData.message || 'error') });
    }
  } catch (e) {
    return respond(502, { error: 'Red TikTok: ' + (e.message || 'error') });
  }

  const ids = (listData.data && listData.data.list || []).map(a => a.advertiser_id);
  if (!ids.length) {
    return respond(200, { advertisers: [] });
  }

  // Traer info detallada (currency, status, name actualizado)
  const infoUrl = `https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify(ids))}`;
  let info = {};
  try {
    const r = await fetch(infoUrl, { headers: { 'Access-Token': token } });
    const d = await r.json();
    if (d.code === 0 && d.data) {
      for (const a of d.data) info[a.advertiser_id] = a;
    }
  } catch { /* fallback: usamos solo lo que vino del list */ }

  const advertisers = (listData.data && listData.data.list || []).map(a => {
    const detail = info[a.advertiser_id] || {};
    return {
      advertiser_id: a.advertiser_id,
      advertiser_name: detail.name || a.advertiser_name || 'Advertiser',
      currency: detail.currency || null,
      status: detail.status || null,
      timezone: detail.timezone || null,
    };
  });

  return respond(200, { advertisers });
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
