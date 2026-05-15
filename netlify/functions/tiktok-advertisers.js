// Lista los advertisers (ad accounts) conectados al access_token de TikTok
// guardado en Netlify Blobs ('bk-tokens'/'tiktok_auth'). Compartido entre browsers.
//
// GET /.netlify/functions/tiktok-advertisers
// Responde: { advertisers: [{ advertiser_id, advertiser_name, currency, status }] }
// Si no hay token: 401 { error: 'NOT_CONNECTED' }.

import { getStore } from '@netlify/blobs';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors() });
  if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const appId  = process.env.TIKTOK_APP_ID;
  const secret = process.env.TIKTOK_APP_SECRET;
  if (!appId || !secret) {
    return json(500, { error: 'Faltan TIKTOK_APP_ID o TIKTOK_APP_SECRET en el servidor' });
  }

  let auth;
  try {
    const store = getStore({ name: 'bk-tokens', consistency: 'strong' });
    auth = await store.get('tiktok_auth', { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Storage error: ' + (e.message || 'unknown') });
  }
  if (!auth || !auth.access_token) return json(401, { error: 'NOT_CONNECTED' });
  const token = auth.access_token;

  // Listar advertisers vinculados al token
  const listUrl = `https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/?app_id=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`;
  let listData;
  try {
    const r = await fetch(listUrl, { headers: { 'Access-Token': token } });
    listData = await r.json();
    if (listData.code !== 0) {
      return json(400, { error: 'TikTok: ' + (listData.message || 'error') });
    }
  } catch (e) {
    return json(502, { error: 'Red TikTok: ' + (e.message || 'error') });
  }

  const ids = (listData.data && listData.data.list || []).map(a => a.advertiser_id);
  if (!ids.length) return json(200, { advertisers: [] });

  // Info detallada (currency, status, name). TikTok devuelve data:[...] o data:{list:[...]}.
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

  return json(200, { advertisers });
}

export const config = { path: '/.netlify/functions/tiktok-advertisers' };
