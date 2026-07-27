// Cambia status de campañas TikTok Ads (ENABLE / DISABLE).
// Uso desde BKDROP frontend:
//   POST /.netlify/functions/tiktok-campaign-status
//   Body: { advertiser_id: "123", campaign_ids: ["456","789"], operation: "ENABLE"|"DISABLE" }
//
// TikTok Ads API v1.3:
//   POST /open_api/v1.3/campaign/status/update/
//   Body: { advertiser_id, campaign_ids: [str,...], operation_status: "ENABLE"|"DISABLE" }
//
// Cap 20 campañas por request (seguridad).

import { getStore } from '@netlify/blobs';

async function getActiveAuth(store) {
  try {
    const activeId = await store.get('tiktok_active', { type: 'json' });
    if (activeId) {
      const a = await store.get('tiktok_auth_' + activeId, { type: 'json' });
      if (a && a.access_token) return a;
    }
  } catch { /* fall through */ }
  return await store.get('tiktok_auth', { type: 'json' });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = await req.json(); }
  catch { return json(400, { error: 'JSON invalido' }); }

  const advertiserId = body.advertiser_id;
  const campaignIds = Array.isArray(body.campaign_ids) ? body.campaign_ids : [];
  const operation = String(body.operation || '').toUpperCase();

  if (!advertiserId) return json(400, { error: 'Falta advertiser_id' });
  if (campaignIds.length === 0) return json(400, { error: 'campaign_ids vacio' });
  if (campaignIds.length > 20) return json(400, { error: 'Cap 20 campañas por request' });
  if (!['ENABLE', 'DISABLE'].includes(operation)) {
    return json(400, { error: 'operation debe ser ENABLE o DISABLE' });
  }

  // Token
  let token;
  try {
    const store = getStore({ name: 'bk-tokens', consistency: 'strong' });
    const auth = await getActiveAuth(store);
    if (!auth || !auth.access_token) return json(401, { error: 'NOT_CONNECTED' });
    token = auth.access_token;
  } catch (e) {
    return json(500, { error: 'Storage error: ' + (e.message || 'unknown') });
  }

  // Sanitizar IDs a strings
  const cleanIds = campaignIds.map(id => String(id).trim()).filter(Boolean);

  const tiktokBody = {
    advertiser_id: String(advertiserId),
    campaign_ids: cleanIds,
    operation_status: operation,
  };

  try {
    const resp = await fetch('https://business-api.tiktok.com/open_api/v1.3/campaign/status/update/', {
      method: 'POST',
      headers: {
        'Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tiktokBody),
    });
    const data = await resp.json();
    // TikTok devuelve { code: 0, message: "OK", ... } cuando OK, code!=0 si error
    if (!resp.ok || data.code !== 0) {
      return json(502, {
        error: 'TikTok API error',
        detail: data,
        sentBody: tiktokBody,
      });
    }
    return json(200, {
      ok: true,
      operation,
      count: cleanIds.length,
      campaignIds: cleanIds,
      tiktokResponse: data,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(502, { error: 'Fetch TikTok fail: ' + (err.message || 'unknown') });
  }
}
