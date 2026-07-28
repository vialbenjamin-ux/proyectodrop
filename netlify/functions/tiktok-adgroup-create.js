// Crea un AdGroup TikTok Ads con los defaults confirmados de la plantilla
// "1.1 TESTEO OFICIAL" (cuenta FEXXA). Reglas de negocio hardcoded:
//   - location Chile, idioma es, TODAS las edades, GENDER_UNLIMITED
//   - placement TIKTOK, promotion WEBSITE
//   - CONVERT/SHOPPING, OCPM, PACING_SMOOTH, INFINITE (ppto en campaign)
//   - schedule: mañana 05:30 AM Chile (America/Santiago)
//   - pixel_id + identity_id de FEXXA hardcoded
//
// Body:
//   {
//     advertiser_id: "123",
//     campaign_id: "456",
//     adgroup_name: "0728 MOPA VAPOR",
//     start_date: "2026-07-28"    // opcional, default mañana Chile
//   }

import { getStore } from '@netlify/blobs';

// Constantes hardcoded desde inspección de 1.1 TESTEO OFICIAL (cuenta FEXXA).
// Si un día cambia la cuenta o los pixels, extraer de env vars.
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

// Devuelve string "YYYY-MM-DD HH:MM:SS" que representa mañana 05:30 en Chile,
// pero expresado en zona horaria del anunciante TikTok (que es CL: UTC-3 o
// -4 según DST). Simplicidad: usamos formato Chile directo, TikTok lo interpreta
// según timezone del advertiser (que es Santiago).
function tomorrowChile530(startDateOverride) {
  const TZ = 'America/Santiago';
  // Fecha hoy Chile
  const todayCl = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
  let target;
  if (startDateOverride && /^\d{4}-\d{2}-\d{2}$/.test(startDateOverride)) {
    target = startDateOverride;
  } else {
    // Mañana: sumamos 1 día partiendo del mediodía UTC para evitar DST
    const base = new Date(todayCl + 'T12:00:00Z');
    base.setUTCDate(base.getUTCDate() + 1);
    target = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(base);
  }
  return target + ' 05:30:00';
}

// End time: 10 años después de start.
function farFutureEnd(startStr) {
  const [datePart] = startStr.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  return (y + 10) + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0') + ' 23:59:00';
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors() });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = await req.json(); }
  catch { return json(400, { error: 'JSON invalido' }); }

  const advertiserId = body.advertiser_id;
  const campaignId = body.campaign_id;
  const adgroupName = String(body.adgroup_name || '').trim();
  const startDateOverride = body.start_date || null;
  const identityId = body.identity_id || null;
  const identityType = body.identity_type || 'BC_AUTH_TT';
  const pixelId = body.pixel_id || PIXEL_ID;

  if (!advertiserId) return json(400, { error: 'Falta advertiser_id' });
  if (!campaignId) return json(400, { error: 'Falta campaign_id' });
  if (!adgroupName) return json(400, { error: 'Falta adgroup_name' });
  if (adgroupName.length > 100) return json(400, { error: 'adgroup_name muy largo (max 100)' });

  let token;
  try {
    const store = getStore({ name: 'bk-tokens', consistency: 'strong' });
    const auth = await getActiveAuth(store);
    if (!auth || !auth.access_token) return json(401, { error: 'NOT_CONNECTED' });
    token = auth.access_token;
  } catch (e) {
    return json(500, { error: 'Storage error: ' + (e.message || 'unknown') });
  }

  const start = tomorrowChile530(startDateOverride);
  const end = farFutureEnd(start);

  const tiktokBody = {
    advertiser_id: String(advertiserId),
    campaign_id: String(campaignId),
    adgroup_name: adgroupName,
    // Presupuesto INFINITE porque la campaign es DYNAMIC_DAILY_BUDGET
    budget_mode: 'BUDGET_MODE_INFINITE',
    // Optimización
    optimization_goal: 'CONVERT',
    optimization_event: 'SHOPPING',
    billing_event: 'OCPM',
    bid_type: 'BID_TYPE_CUSTOM',
    bid_price: 0,   // TikTok autobid
    pacing: 'PACING_MODE_SMOOTH',
    // Schedule
    schedule_type: 'SCHEDULE_START_END',
    schedule_start_time: start,
    schedule_end_time: end,
    // Targeting Chile
    location_ids: [CHILE_LOCATION_ID],
    age_groups: AGE_GROUPS_ALL,
    gender: 'GENDER_UNLIMITED',
    languages: ['es'],
    // Placement
    placement_type: 'PLACEMENT_TYPE_NORMAL',
    placements: ['PLACEMENT_TIKTOK'],
    // Promotion
    promotion_type: 'WEBSITE',
    pixel_id: pixelId,
  };
  if (identityId) {
    tiktokBody.identity_id = identityId;
    tiktokBody.identity_type = identityType;
  }

  try {
    const resp = await fetch('https://business-api.tiktok.com/open_api/v1.3/adgroup/create/', {
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
        error: 'TikTok adgroup/create error',
        detail: data,
        sentBody: tiktokBody,
      });
    }
    const newAdgroupId = (data.data && (data.data.adgroup_id || data.data.id)) || null;
    return json(200, {
      ok: true,
      adgroupId: newAdgroupId ? String(newAdgroupId) : null,
      scheduleStart: start,
      scheduleEnd: end,
      tiktokResponse: data,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(502, { error: 'Fetch TikTok adgroup create fail: ' + (err.message || 'unknown') });
  }
}
