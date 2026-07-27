// Edita atributos de una campaña TikTok Ads.
// Fase 2: solo presupuesto (budget). Fase 2b: nombre.
//
// Body:
//   {
//     advertiser_id: "123",
//     campaign_id: "456",
//     budget: 40000,           // en MONEDA DE LA CUENTA (COP, USD, CLP...)
//     budget_mode: "BUDGET_MODE_DAY" | "BUDGET_MODE_TOTAL"   // opcional, default DAY
//     campaign_name: "..."     // opcional (Fase 2b)
//   }
//
// TikTok Ads API v1.3:
//   POST /open_api/v1.3/campaign/update/
//   Body: { advertiser_id, campaign_id, budget, budget_mode, campaign_name }
//
// IMPORTANTE: el campo `budget` debe estar en la MONEDA DE LA CUENTA
// (no en CLP). El frontend BKDROP guarda en CLP pero convierte antes
// de llamar usando el fxRate expuesto por /tiktok-report.

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
  const campaignId = body.campaign_id;
  const budget = body.budget != null ? Number(body.budget) : null;
  const budgetMode = body.budget_mode || 'BUDGET_MODE_DAY';
  const campaignName = body.campaign_name != null ? String(body.campaign_name).trim() : null;

  if (!advertiserId) return json(400, { error: 'Falta advertiser_id' });
  if (!campaignId) return json(400, { error: 'Falta campaign_id' });
  if (budget == null && campaignName == null) {
    return json(400, { error: 'Nada que actualizar (falta budget o campaign_name)' });
  }
  if (budget != null && (!isFinite(budget) || budget <= 0)) {
    return json(400, { error: 'budget debe ser numero > 0' });
  }
  if (budget != null && !['BUDGET_MODE_DAY', 'BUDGET_MODE_TOTAL'].includes(budgetMode)) {
    return json(400, { error: 'budget_mode invalido' });
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
    campaign_id: String(campaignId),
  };
  if (budget != null) {
    tiktokBody.budget = Number(budget);
    tiktokBody.budget_mode = budgetMode;
  }
  if (campaignName) {
    tiktokBody.campaign_name = campaignName.slice(0, 120);
  }

  try {
    const resp = await fetch('https://business-api.tiktok.com/open_api/v1.3/campaign/update/', {
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
        error: 'TikTok API error',
        detail: data,
        sentBody: tiktokBody,
      });
    }
    return json(200, {
      ok: true,
      campaignId: String(campaignId),
      updatedFields: Object.keys(tiktokBody).filter(k => !['advertiser_id', 'campaign_id'].includes(k)),
      tiktokResponse: data,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(502, { error: 'Fetch TikTok fail: ' + (err.message || 'unknown') });
  }
}
