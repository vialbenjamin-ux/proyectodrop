// Crea un Ad TikTok con video + copy + CTA + landing page.
//
// Body:
//   {
//     advertiser_id: "123",
//     adgroup_id: "456",
//     identity_id: "114ddbee-...",
//     identity_type: "BC_AUTH_TT",
//     ad_name: "Video1 + Copy1",
//     video_id: "v10033...",
//     ad_text: "El copy visible arriba del video",
//     call_to_action: "SHOP_NOW",
//     display_name: "benkotienda",
//     landing_page_url: "https://benkotienda.com/products/mopa-titanio"
//   }
//
// TikTok Ads API v1.3:
//   POST /open_api/v1.3/ad/create/
//   Body: { advertiser_id, adgroup_id, creatives: [{...}] }

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
  const adgroupId = body.adgroup_id;
  const identityId = body.identity_id;
  const identityType = body.identity_type || 'BC_AUTH_TT';
  const adName = String(body.ad_name || '').trim();
  const videoId = String(body.video_id || '').trim();
  const adText = String(body.ad_text || '').trim();
  const cta = String(body.call_to_action || 'SHOP_NOW').toUpperCase();
  const displayName = String(body.display_name || 'benkotienda').trim();
  const landingPageUrl = String(body.landing_page_url || '').trim();

  if (!advertiserId) return json(400, { error: 'Falta advertiser_id' });
  if (!adgroupId) return json(400, { error: 'Falta adgroup_id' });
  if (!identityId) return json(400, { error: 'Falta identity_id' });
  if (!adName) return json(400, { error: 'Falta ad_name' });
  if (!videoId) return json(400, { error: 'Falta video_id' });
  if (!adText) return json(400, { error: 'Falta ad_text (copy)' });
  if (adText.length > 100) return json(400, { error: 'ad_text muy largo (max 100 chars)' });
  if (!landingPageUrl) return json(400, { error: 'Falta landing_page_url' });
  if (!/^https?:\/\//.test(landingPageUrl)) return json(400, { error: 'landing_page_url debe ser HTTP(S)' });

  let token;
  try {
    const store = getStore({ name: 'bk-tokens', consistency: 'strong' });
    const auth = await getActiveAuth(store);
    if (!auth || !auth.access_token) return json(401, { error: 'NOT_CONNECTED' });
    token = auth.access_token;
  } catch (e) {
    return json(500, { error: 'Storage error: ' + (e.message || 'unknown') });
  }

  const creative = {
    ad_name: adName.slice(0, 100),
    ad_format: 'SINGLE_VIDEO',
    ad_text: adText.slice(0, 100),
    video_id: videoId,
    identity_id: identityId,
    identity_type: identityType,
    display_name: displayName.slice(0, 40),
    call_to_action: cta,
    landing_page_url: landingPageUrl,
  };

  const tiktokBody = {
    advertiser_id: String(advertiserId),
    adgroup_id: String(adgroupId),
    creatives: [creative],
  };

  try {
    const resp = await fetch('https://business-api.tiktok.com/open_api/v1.3/ad/create/', {
      method: 'POST',
      headers: {
        'Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tiktokBody),
    });
    const data = await resp.json();
    if (!resp.ok || data.code !== 0) {
      return json(502, {
        error: 'TikTok ad/create error',
        detail: data,
        sentBody: tiktokBody,
      });
    }
    const adIds = (data.data && Array.isArray(data.data.ad_ids)) ? data.data.ad_ids : [];
    return json(200, {
      ok: true,
      adId: adIds[0] || null,
      adIds,
      tiktokResponse: data,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(502, { error: 'Fetch TikTok ad create fail: ' + (err.message || 'unknown') });
  }
}
