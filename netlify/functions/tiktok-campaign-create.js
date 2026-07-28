// Crea una campaña TikTok Ads desde cero (nivel 1: campaign).
// NO crea adgroups ni ads. Para eso: usar duplicar (Fase 3) o TikTok Ads Manager.
//
// Body:
//   {
//     advertiser_id: "123",
//     campaign_name: "...",
//     objective_type: "TRAFFIC" | "WEB_CONVERSIONS" | "PRODUCT_SALES" | ...,
//     budget_mode: "BUDGET_MODE_DAY" | "BUDGET_MODE_TOTAL" | "BUDGET_MODE_INFINITE",
//     budget: 40000                // en MONEDA DE LA CUENTA (no CLP). Omitir si INFINITE.
//   }
//
// TikTok Ads API v1.3:
//   POST /open_api/v1.3/campaign/create/
//
// La campaña se crea en estado ENABLE pero SIN adgroups/ads no gastará nada
// hasta que le agregues creatividades.

import { getStore } from '@netlify/blobs';

const OBJECTIVES_VALIDOS = new Set([
  'TRAFFIC',
  'VIDEO_VIEWS',
  'WEB_CONVERSIONS',
  'PRODUCT_SALES',
  'LEAD_GENERATION',
  'REACH',
  'APP_PROMOTION',
  'ENGAGEMENT',
  'CATALOG_SALES',
]);

const BUDGET_MODES_VALIDOS = new Set([
  'BUDGET_MODE_DAY',
  'BUDGET_MODE_TOTAL',
  'BUDGET_MODE_INFINITE',
  'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
]);

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
  const campaignName = String(body.campaign_name || '').trim();
  const objectiveType = String(body.objective_type || '').toUpperCase();
  const budgetMode = String(body.budget_mode || 'BUDGET_MODE_DAY');
  const budget = body.budget != null ? Number(body.budget) : null;

  if (!advertiserId) return json(400, { error: 'Falta advertiser_id' });
  if (!campaignName) return json(400, { error: 'Falta campaign_name' });
  if (campaignName.length > 120) return json(400, { error: 'campaign_name muy largo (max 120)' });
  if (!OBJECTIVES_VALIDOS.has(objectiveType)) {
    return json(400, { error: 'objective_type invalido', validos: [...OBJECTIVES_VALIDOS] });
  }
  if (!BUDGET_MODES_VALIDOS.has(budgetMode)) {
    return json(400, { error: 'budget_mode invalido', validos: [...BUDGET_MODES_VALIDOS] });
  }
  if (budgetMode !== 'BUDGET_MODE_INFINITE') {
    if (budget == null || !isFinite(budget) || budget <= 0) {
      return json(400, { error: 'budget requerido y > 0 cuando el modo no es INFINITE' });
    }
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

  const tiktokBody = {
    advertiser_id: String(advertiserId),
    campaign_name: campaignName,
    objective_type: objectiveType,
    budget_mode: budgetMode,
  };
  if (budgetMode !== 'BUDGET_MODE_INFINITE') {
    tiktokBody.budget = Number(budget);
  }

  try {
    const resp = await fetch('https://business-api.tiktok.com/open_api/v1.3/campaign/create/', {
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
        error: 'TikTok create error',
        detail: data,
        sentBody: tiktokBody,
      });
    }
    const newCampaignId = (data.data && (data.data.campaign_id || data.data.id)) || null;
    return json(200, {
      ok: true,
      campaignId: newCampaignId ? String(newCampaignId) : null,
      tiktokResponse: data,
      createdAt: new Date().toISOString(),
      hint: 'La campaña quedó creada SIN adgroups/ads. Agrégalos en TikTok Ads Manager o duplica una plantilla existente con adgroups.',
    });
  } catch (err) {
    return json(502, { error: 'Fetch TikTok create fail: ' + (err.message || 'unknown') });
  }
}
