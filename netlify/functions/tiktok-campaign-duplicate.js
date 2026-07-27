// Duplica una campaña TikTok Ads (con sus adgroups + ads).
// Usa el endpoint de copy oficial: POST /open_api/v1.3/campaign/copy/
//
// Body:
//   {
//     advertiser_id: "123",
//     source_campaign_id: "456",
//     new_name: "Nombre opcional para la copia" // opcional
//   }
//
// Respuesta:
//   { ok, newCampaignId, sourceCampaignId, tiktokResponse }
//
// Notas:
// - La copia hereda: objective, budget_mode, budget, targeting, creatives, etc.
// - La copia queda en estado DISABLE (pausada) por default para revisar antes.
// - Si new_name viene, luego llamamos campaign/update/ para renombrar
//   (el endpoint copy no acepta nombre custom directamente).

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
  const sourceCampaignId = body.source_campaign_id;
  const newName = body.new_name != null ? String(body.new_name).trim() : null;

  if (!advertiserId) return json(400, { error: 'Falta advertiser_id' });
  if (!sourceCampaignId) return json(400, { error: 'Falta source_campaign_id' });
  if (newName != null && newName.length > 120) return json(400, { error: 'new_name muy largo (max 120)' });

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

  // 1. Copiar la campaña. TikTok crea la copia PAUSADA por seguridad.
  const copyBody = {
    advertiser_id: String(advertiserId),
    copy_content_list: [
      { copy_from_id: String(sourceCampaignId) },
    ],
  };

  let copyResponse;
  try {
    const resp = await fetch('https://business-api.tiktok.com/open_api/v1.3/campaign/copy/', {
      method: 'POST',
      headers: {
        'Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(copyBody),
    });
    copyResponse = await resp.json();
    if (!resp.ok || copyResponse.code !== 0) {
      return json(502, {
        error: 'TikTok copy error',
        detail: copyResponse,
        sentBody: copyBody,
      });
    }
  } catch (err) {
    return json(502, { error: 'Fetch TikTok copy fail: ' + (err.message || 'unknown') });
  }

  // Extraer ID de la nueva campaña. La respuesta suele venir como:
  // { code: 0, data: { copy_task_id: "..." } } o
  // { code: 0, data: { campaign_ids: ["..."] } } segun version.
  let newCampaignId = null;
  const d = copyResponse.data || {};
  if (Array.isArray(d.campaign_ids) && d.campaign_ids.length > 0) {
    newCampaignId = String(d.campaign_ids[0]);
  } else if (Array.isArray(d.copy_result) && d.copy_result.length > 0) {
    // Formato: [{ copy_from_id, copy_to_id }]
    newCampaignId = String(d.copy_result[0].copy_to_id || d.copy_result[0].campaign_id || '');
  } else if (d.campaign_id) {
    newCampaignId = String(d.campaign_id);
  }

  // 2. Si el usuario pasó new_name, renombrar la copia.
  let renameResponse = null;
  if (newName && newCampaignId) {
    try {
      const renResp = await fetch('https://business-api.tiktok.com/open_api/v1.3/campaign/update/', {
        method: 'POST',
        headers: {
          'Access-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          advertiser_id: String(advertiserId),
          campaign_id: newCampaignId,
          campaign_name: newName.slice(0, 120),
        }),
      });
      renameResponse = await renResp.json();
      // No abortamos si falla el rename; la copia ya existe.
    } catch { /* swallow */ }
  }

  return json(200, {
    ok: true,
    newCampaignId,
    sourceCampaignId: String(sourceCampaignId),
    renamed: !!(newName && renameResponse && renameResponse.code === 0),
    tiktokCopyResponse: copyResponse,
    tiktokRenameResponse: renameResponse,
    createdAt: new Date().toISOString(),
  });
}
