// Inspecciona la estructura completa de una campaña TikTok Ads:
// campaign + todos sus adgroups + todos los ads de cada adgroup.
// Sirve como base para replicar plantillas (Fase 5) y para debug general.
//
// GET /.netlify/functions/tiktok-campaign-inspect?advertiser_id=X&campaign_id=Y
//
// Respuesta:
//   {
//     campaign: { id, name, status, objective, budget_mode, budget },
//     adgroups: [
//       {
//         id, name, status, budget_mode, budget, bid_type, bid_price,
//         optimization_goal, targeting: { location_ids, age_groups, genders,
//         languages, operating_systems, placements, interest_category_ids,
//         behavior_ids }, schedule, ads_count,
//         ads: [
//           { id, name, status, video_id, image_ids, ad_text, call_to_action,
//             landing_page_url, display_name, profile_image, etc }
//         ]
//       }
//     ],
//     summary: { adgroups_count, ads_count, videos_used: [...] }
//   }

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

async function fetchTiktok(url, token) {
  const r = await fetch(url, { headers: { 'Access-Token': token } });
  const j = await r.json();
  return { ok: r.ok, json: j };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors() });
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const url = new URL(req.url);
  const advertiserId = url.searchParams.get('advertiser_id');
  const campaignId = url.searchParams.get('campaign_id');

  if (!advertiserId) return json(400, { error: 'Falta advertiser_id' });
  if (!campaignId) return json(400, { error: 'Falta campaign_id' });

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

  // 1. Campaign details
  const campQs = new URLSearchParams({
    advertiser_id: advertiserId,
    filtering: JSON.stringify({ campaign_ids: [campaignId] }),
    fields: JSON.stringify([
      'campaign_id','campaign_name','operation_status','budget','budget_mode',
      'objective_type','campaign_type','create_time','modify_time',
    ]),
  });
  const camp = await fetchTiktok(base + '/campaign/get/?' + campQs.toString(), token);
  if (!camp.ok || camp.json.code !== 0) {
    return json(502, { error: 'campaign/get fail', detail: camp.json });
  }
  const campaignData = (camp.json.data && camp.json.data.list && camp.json.data.list[0]) || null;
  if (!campaignData) return json(404, { error: 'Campaña no encontrada' });

  // 2. AdGroups de la campaña
  // Fields conservadores: solo los oficiales estables en v1.3. TikTok rechaza
  // el batch completo si algún campo no existe (error 40002).
  const agQs = new URLSearchParams({
    advertiser_id: advertiserId,
    filtering: JSON.stringify({ campaign_ids: [campaignId] }),
    fields: JSON.stringify([
      'adgroup_id','adgroup_name','operation_status','secondary_status',
      'budget','budget_mode','bid_type','bid_price',
      'optimization_goal','optimization_event','billing_event','pacing',
      'schedule_type','schedule_start_time','schedule_end_time',
      'location_ids','age_groups','gender','languages','operating_systems',
      'placement_type','placements',
      'interest_category_ids','interest_keyword_ids',
      'creative_material_mode','identity_id','identity_type',
      'promotion_type','pixel_id',
    ]),
    page_size: '100',
  });
  const ag = await fetchTiktok(base + '/adgroup/get/?' + agQs.toString(), token);
  if (!ag.ok || ag.json.code !== 0) {
    return json(502, { error: 'adgroup/get fail', detail: ag.json });
  }
  const adgroupsRaw = (ag.json.data && ag.json.data.list) || [];

  // 3. Para cada adgroup: sus ads
  const adgroups = [];
  const videosSet = new Set();
  let totalAds = 0;
  for (const adg of adgroupsRaw) {
    const adQs = new URLSearchParams({
      advertiser_id: advertiserId,
      filtering: JSON.stringify({ adgroup_ids: [adg.adgroup_id] }),
      fields: JSON.stringify([
        'ad_id','ad_name','operation_status','secondary_status',
        'ad_format','ad_text','video_id','image_ids',
        'display_name','call_to_action','landing_page_url',
      ]),
      page_size: '100',
    });
    const adResp = await fetchTiktok(base + '/ad/get/?' + adQs.toString(), token);
    const ads = (adResp.ok && adResp.json.code === 0 && adResp.json.data && adResp.json.data.list) || [];
    totalAds += ads.length;
    for (const a of ads) if (a.video_id) videosSet.add(a.video_id);
    adgroups.push({
      id: adg.adgroup_id,
      name: adg.adgroup_name,
      status: adg.operation_status,
      budget: adg.budget != null ? Number(adg.budget) : null,
      budget_mode: adg.budget_mode,
      bid_type: adg.bid_type,
      bid_price: adg.bid_price != null ? Number(adg.bid_price) : null,
      optimization_goal: adg.optimization_goal,
      optimization_event: adg.optimization_event,
      billing_event: adg.billing_event,
      pacing: adg.pacing,
      schedule: {
        type: adg.schedule_type,
        start: adg.schedule_start_time || null,
        end: adg.schedule_end_time || null,
      },
      targeting: {
        location_ids: adg.location_ids || [],
        age_groups: adg.age_groups || [],
        gender: adg.gender,
        languages: adg.languages || [],
        operating_systems: adg.operating_systems || [],
        placement_type: adg.placement_type,
        placements: adg.placements || [],
        interest_category_ids: adg.interest_category_ids || [],
        interest_keyword_ids: adg.interest_keyword_ids || [],
      },
      creative_material_mode: adg.creative_material_mode,
      identity_id: adg.identity_id,
      identity_type: adg.identity_type,
      promotion_type: adg.promotion_type,
      pixel_id: adg.pixel_id,
      secondary_status: adg.secondary_status,
      ads_count: ads.length,
      ads: ads.map(a => ({
        id: a.ad_id,
        name: a.ad_name,
        status: a.operation_status,
        secondary_status: a.secondary_status,
        format: a.ad_format,
        ad_text: a.ad_text,
        video_id: a.video_id,
        image_ids: a.image_ids || [],
        display_name: a.display_name,
        call_to_action: a.call_to_action,
        landing_page_url: a.landing_page_url,
      })),
    });
  }

  return json(200, {
    campaign: {
      id: campaignData.campaign_id,
      name: campaignData.campaign_name,
      status: campaignData.operation_status,
      objective: campaignData.objective_type,
      budget_mode: campaignData.budget_mode,
      budget: campaignData.budget != null ? Number(campaignData.budget) : null,
      created: campaignData.create_time,
      modified: campaignData.modify_time,
    },
    adgroups,
    summary: {
      adgroups_count: adgroups.length,
      ads_count: totalAds,
      videos_unique: videosSet.size,
      video_ids: [...videosSet],
    },
    fetchedAt: new Date().toISOString(),
  });
}
