// Devuelve la lista de advertisers (ad accounts) conectados al access_token de
// TikTok que el usuario obtuvo via OAuth. El token vive en Netlify Blobs (store
// 'bk-tokens', key 'tiktok_auth') así es compartido entre browsers (AdsPower
// y Chrome normal ven los mismos datos).
//
// GET /.netlify/functions/tiktok-advertisers
// Responde: { advertisers: [{ advertiser_id, advertiser_name, currency, status }] }
// Si no hay token guardado: { error: 'NOT_CONNECTED' } con 401.

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const appId  = process.env.TIKTOK_APP_ID;
  const secret = process.env.TIKTOK_APP_SECRET;
  if (!appId || !secret) {
    return respond(500, { error: 'Faltan TIKTOK_APP_ID o TIKTOK_APP_SECRET en el servidor' });
  }

  let auth;
  try {
    const store = getStore({ name: 'bk-tokens', consistency: 'strong' });
    auth = await store.get('tiktok_auth', { type: 'json' });
  } catch (e) {
    return respond(500, { error: 'Storage error: ' + (e.message || 'unknown') });
  }
  if (!auth || !auth.access_token) {
    return respond(401, { error: 'NOT_CONNECTED' });
  }
  const token = auth.access_token;

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

  // Traer info detallada (currency, status, name actualizado).
  // TikTok puede devolver data:[...] o data:{list:[...]} según versión.
  const infoUrl = `https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify(ids))}`;
  let info = {};
  try {
    const r = await fetch(infoUrl, { headers: { 'Access-Token': token } });
    const d = await r.json();
    if (d.code === 0) {
      const list = Array.isArray(d.data) ? d.data
                 : (d.data && Array.isArray(d.data.list) ? d.data.list : []);
      for (const a of list) info[a.advertiser_id] = a;
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
