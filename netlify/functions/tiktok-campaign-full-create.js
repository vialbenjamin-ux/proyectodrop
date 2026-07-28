// Orquestador Fase 5b: sube una campaña TikTok completa (campaign + adgroup
// + N ads) en un solo request desde el frontend.
//
// Los videos deben estar YA subidos a TikTok Ads Library (obtener video_ids
// via /tiktok-video-upload por separado). El frontend maneja el upload
// paralelo de los N videos antes de llamar acá.
//
// Body:
//   {
//     advertiser_id: "123",
//     campaign_name: "0728 MOPA TITANIO",
//     adgroup_name: "0728 MOPA TITANIO",   // opcional, default = campaign_name
//     budget_clp: 25000,                    // ppto CAMPAIGN
//     fx_rate: 0.2952,                      // CLP por 1 unidad moneda cuenta (COP typically)
//     original_currency: "COP",             // moneda cuenta
//     video_ids: ["v1","v2","v3"],          // 1-10 videos
//     copys: ["copy1","copy2","copy3","copy4","copy5"],  // 1-10 copys (cada uno <100 chars)
//     landing_page_url: "https://benkotienda.com/products/mopa-titanio",
//     identity_id: "114ddbee-...",
//     identity_type: "BC_AUTH_TT",
//     display_name: "benkotienda",
//     call_to_action: "SHOP_NOW",
//     start_date: "2026-07-28"              // opcional, default mañana Chile
//   }
//
// Se crea: 1 campaign, 1 adgroup, videos.length * copys.length ads.
// Todos los ads comparten adgroup (que es la unidad de targeting).
//
// Respuesta:
//   { ok, campaignId, adgroupId, ads: [{video_id, copy, ad_id}], summary }

import { getStore } from '@netlify/blobs';

const CHILE_LOCATION_ID = '3895114';
const PIXEL_ID = '7645747705037275154';
const AGE_GROUPS_ALL = ['AGE_18_24','AGE_25_34','AGE_35_44','AGE_45_54','AGE_55_100'];

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

function tomorrowChile530(startDateOverride) {
  const TZ = 'America/Santiago';
  const todayCl = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
  let target;
  if (startDateOverride && /^\d{4}-\d{2}-\d{2}$/.test(startDateOverride)) {
    target = startDateOverride;
  } else {
    const base = new Date(todayCl + 'T12:00:00Z');
    base.setUTCDate(base.getUTCDate() + 1);
    target = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(base);
  }
  return target + ' 05:30:00';
}

function farFutureEnd(startStr) {
  const [datePart] = startStr.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  return (y + 10) + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0') + ' 23:59:00';
}

async function ttFetch(url, token, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  return { ok: resp.ok, data };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors() });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = await req.json(); }
  catch { return json(400, { error: 'JSON invalido' }); }

  const advertiserId = body.advertiser_id;
  const campaignName = String(body.campaign_name || '').trim();
  const adgroupName = String(body.adgroup_name || campaignName).trim();
  const budgetClp = Number(body.budget_clp || 0);
  const fxRate = Number(body.fx_rate || 1);   // CLP per 1 unidad moneda cuenta
  const originalCurrency = String(body.original_currency || 'CLP').toUpperCase();
  const videoIds = Array.isArray(body.video_ids) ? body.video_ids.map(String).filter(Boolean) : [];
  const copys = Array.isArray(body.copys) ? body.copys.map(s => String(s).trim()).filter(Boolean) : [];
  const landingPageUrl = String(body.landing_page_url || '').trim();
  const identityId = String(body.identity_id || '').trim();
  const identityType = String(body.identity_type || 'BC_AUTH_TT').trim();
  const displayName = String(body.display_name || 'benkotienda').trim();
  const cta = String(body.call_to_action || 'SHOP_NOW').toUpperCase();
  const startDate = body.start_date || null;

  // Validaciones
  if (!advertiserId) return json(400, { error: 'Falta advertiser_id' });
  if (!campaignName) return json(400, { error: 'Falta campaign_name' });
  if (!budgetClp || budgetClp <= 0) return json(400, { error: 'budget_clp invalido' });
  if (videoIds.length === 0) return json(400, { error: 'video_ids vacio' });
  if (videoIds.length > 10) return json(400, { error: 'max 10 videos' });
  if (copys.length === 0) return json(400, { error: 'copys vacio' });
  if (copys.length > 10) return json(400, { error: 'max 10 copys' });
  if (!landingPageUrl) return json(400, { error: 'Falta landing_page_url' });
  if (!identityId) return json(400, { error: 'Falta identity_id' });
  const invalidCopy = copys.find(c => c.length > 100);
  if (invalidCopy) return json(400, { error: 'Un copy supera 100 chars: ' + invalidCopy.slice(0, 50) + '...' });

  // Convertir CLP -> moneda cuenta
  const budgetEnMoneda = originalCurrency === 'CLP' ? budgetClp : Math.round(budgetClp / fxRate);

  let token;
  try {
    const store = getStore({ name: 'bk-tokens', consistency: 'strong' });
    const auth = await getActiveAuth(store);
    if (!auth || !auth.access_token) return json(401, { error: 'NOT_CONNECTED' });
    token = auth.access_token;
  } catch (e) {
    return json(500, { error: 'Storage error: ' + (e.message || 'unknown') });
  }

  const base = 'https://business-api.tiktok.com/open_api/v1.3';
  const result = {
    campaignId: null,
    adgroupId: null,
    ads: [],
    errors: [],
  };

  // 1. Crear Campaign
  const campBody = {
    advertiser_id: String(advertiserId),
    campaign_name: campaignName.slice(0, 120),
    objective_type: 'WEB_CONVERSIONS',
    budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
    budget: budgetEnMoneda,
  };
  const camp = await ttFetch(base + '/campaign/create/', token, campBody);
  if (!camp.ok || camp.data.code !== 0) {
    return json(502, { error: 'campaign/create fail', step: 'campaign', detail: camp.data, sentBody: campBody });
  }
  result.campaignId = (camp.data.data && (camp.data.data.campaign_id || camp.data.data.id)) || null;
  if (!result.campaignId) {
    return json(502, { error: 'campaign/create OK pero sin campaign_id', detail: camp.data });
  }

  // 2. Crear AdGroup con schedule mañana 5:30 CL
  const start = tomorrowChile530(startDate);
  const end = farFutureEnd(start);
  const agBody = {
    advertiser_id: String(advertiserId),
    campaign_id: String(result.campaignId),
    adgroup_name: adgroupName.slice(0, 100),
    budget_mode: 'BUDGET_MODE_INFINITE',
    optimization_goal: 'CONVERT',
    optimization_event: 'SHOPPING',
    billing_event: 'OCPM',
    bid_type: 'BID_TYPE_CUSTOM',
    bid_price: 0,
    pacing: 'PACING_MODE_SMOOTH',
    schedule_type: 'SCHEDULE_START_END',
    schedule_start_time: start,
    schedule_end_time: end,
    location_ids: [CHILE_LOCATION_ID],
    age_groups: AGE_GROUPS_ALL,
    gender: 'GENDER_UNLIMITED',
    languages: ['es'],
    placement_type: 'PLACEMENT_TYPE_NORMAL',
    placements: ['PLACEMENT_TIKTOK'],
    promotion_type: 'WEBSITE',
    pixel_id: PIXEL_ID,
    identity_id: identityId,
    identity_type: identityType,
  };
  const ag = await ttFetch(base + '/adgroup/create/', token, agBody);
  if (!ag.ok || ag.data.code !== 0) {
    return json(502, {
      error: 'adgroup/create fail',
      step: 'adgroup',
      detail: ag.data,
      sentBody: agBody,
      partial: { campaignId: result.campaignId },
    });
  }
  result.adgroupId = (ag.data.data && (ag.data.data.adgroup_id || ag.data.data.id)) || null;
  if (!result.adgroupId) {
    return json(502, { error: 'adgroup/create OK pero sin adgroup_id', detail: ag.data, partial: { campaignId: result.campaignId } });
  }

  // 3. Crear N x M ads (video x copy). TikTok /ad/create/ acepta un array
  // de "creatives" en una sola llamada — enviamos todos juntos.
  const creatives = [];
  for (let vi = 0; vi < videoIds.length; vi++) {
    for (let ci = 0; ci < copys.length; ci++) {
      creatives.push({
        ad_name: (adgroupName + ' V' + (vi + 1) + ' C' + (ci + 1)).slice(0, 100),
        ad_format: 'SINGLE_VIDEO',
        ad_text: copys[ci].slice(0, 100),
        video_id: videoIds[vi],
        identity_id: identityId,
        identity_type: identityType,
        display_name: displayName.slice(0, 40),
        call_to_action: cta,
        landing_page_url: landingPageUrl,
      });
    }
  }

  // TikTok limita creatives por request (usualmente 20). Si supera, batchear.
  const CREATIVE_BATCH_MAX = 20;
  const adIdsAll = [];
  for (let i = 0; i < creatives.length; i += CREATIVE_BATCH_MAX) {
    const chunk = creatives.slice(i, i + CREATIVE_BATCH_MAX);
    const adBody = {
      advertiser_id: String(advertiserId),
      adgroup_id: String(result.adgroupId),
      creatives: chunk,
    };
    const adResp = await ttFetch(base + '/ad/create/', token, adBody);
    if (!adResp.ok || adResp.data.code !== 0) {
      result.errors.push({
        step: 'ad/create batch ' + (i / CREATIVE_BATCH_MAX + 1),
        detail: adResp.data,
        sentCreatives: chunk.map(c => ({ ad_name: c.ad_name, video_id: c.video_id, copy: c.ad_text.slice(0, 40) })),
      });
      continue;
    }
    const batchIds = (adResp.data.data && Array.isArray(adResp.data.data.ad_ids)) ? adResp.data.data.ad_ids : [];
    adIdsAll.push(...batchIds);
  }

  // Mapear ad_ids con sus creatives (asumiendo mismo orden que TikTok devuelve)
  creatives.forEach((c, idx) => {
    result.ads.push({
      ad_name: c.ad_name,
      video_id: c.video_id,
      copy: c.ad_text,
      ad_id: adIdsAll[idx] || null,
    });
  });

  return json(200, {
    ok: result.errors.length === 0,
    campaignId: result.campaignId,
    adgroupId: result.adgroupId,
    adsCreated: adIdsAll.length,
    adsExpected: creatives.length,
    videos: videoIds.length,
    copys: copys.length,
    schedule: { start, end },
    ads: result.ads,
    errors: result.errors,
    createdAt: new Date().toISOString(),
    hint: 'Campaña y ads creados PAUSADOS (adgroup empieza ' + start + ' Chile). Revisá antes de activar la campaign.',
  });
}
