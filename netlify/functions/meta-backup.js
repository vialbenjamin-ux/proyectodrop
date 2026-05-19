// Backup completo de campañas + adsets + ads + creativos de una ad account.
// Endpoint: GET /.netlify/functions/meta-backup?account_id=act_xxx
// Responde JSON con toda la estructura para reconstruir las campañas en otra cuenta
// si la actual es baneada.
//
// Anti-ban:
// - Llamadas a Meta SECUENCIALES con ≥3s entre cada una (no Promise.all).
// - Field expansion en /ads para traer creativos en la misma respuesta
//   (en vez de batch '?ids=A,B,C' que Meta cuenta como tráfico sospechoso).
// - Parse de error 368/190/17/32 con response específico.
// - Versión API v21.0.
// - Cap de páginas reducido (5 = ~500 ads max) para no abusar.

const meta = require('./_meta-api');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const params = event.queryStringParameters || {};
  const tenant = String(params.tenant || 'chile').toLowerCase();
  const token = (tenant === 'gt')
    ? process.env.META_ACCESS_TOKEN_GT
    : process.env.META_ACCESS_TOKEN;
  if (!token) return respond(500, { error: 'META_ACCESS_TOKEN' + (tenant === 'gt' ? '_GT' : '') + ' no configurada' });

  const accountId = (params.account_id || '').trim();
  if (!/^act_\d+$/.test(accountId)) {
    return respond(400, { error: 'account_id inválido (esperado: act_xxxxx)' });
  }

  const accountFields = 'id,name,currency,account_status,timezone_name,business_country_code';
  const campaignFields = [
    'id','name','status','effective_status','objective','buying_type',
    'daily_budget','lifetime_budget','budget_remaining','spend_cap',
    'start_time','stop_time','created_time','updated_time',
    'special_ad_categories','bid_strategy','source_campaign_id',
  ].join(',');
  const adsetFields = [
    'id','name','campaign_id','status','effective_status',
    'daily_budget','lifetime_budget','budget_remaining','bid_amount','bid_strategy',
    'billing_event','optimization_goal','start_time','end_time',
    'targeting','promoted_object','attribution_spec','destination_type',
    'created_time','updated_time',
  ].join(',');
  // Ads con creative EXPANDIDO en la misma llamada (evita batch ?ids=).
  const adFields = [
    'id','name','adset_id','campaign_id','status','effective_status',
    'created_time','updated_time',
    'creative{id,name,title,body,link_url,instagram_permalink_url,thumbnail_url,image_url,video_id,call_to_action_type,effective_object_story_id,object_type}',
  ].join(',');

  // Timeout budget: Netlify Functions mata a los 10s. Reservamos margen.
  const startedAt = Date.now();
  const TIMEOUT_BUDGET_MS = 8500;
  const elapsed = () => Date.now() - startedAt;
  const remaining = () => TIMEOUT_BUDGET_MS - elapsed();

  const V = meta.META_API_VERSION;

  try {
    // SECUENCIAL — una llamada Meta atrás de otra con delay ≥3s entre cada bloque.
    // Las páginas del MISMO endpoint también van con delay entre páginas.
    const account = await meta.fetchOne(
      `https://graph.facebook.com/${V}/${accountId}?fields=${accountFields}&access_token=${encodeURIComponent(token)}`
    );

    await meta.delay();
    const campaigns = await fetchAllPagesSafe(
      `https://graph.facebook.com/${V}/${accountId}/campaigns?fields=${campaignFields}&limit=100&access_token=${encodeURIComponent(token)}`,
      remaining
    );

    if (remaining() < 4000) {
      return respond(200, partialResponse(account, campaigns, [], [], 'campañas', elapsed()));
    }
    await meta.delay();
    const adsets = await fetchAllPagesSafe(
      `https://graph.facebook.com/${V}/${accountId}/adsets?fields=${adsetFields}&limit=100&access_token=${encodeURIComponent(token)}`,
      remaining
    );

    if (remaining() < 4000) {
      return respond(200, partialResponse(account, campaigns, adsets, [], 'adsets', elapsed()));
    }
    await meta.delay();
    const ads = await fetchAllPagesSafe(
      `https://graph.facebook.com/${V}/${accountId}/ads?fields=${adFields}&limit=100&access_token=${encodeURIComponent(token)}`,
      remaining
    );

    // Construir jerarquía: campaign → adset → ad (con creative ya expandido)
    const adsByAdset = {};
    for (const ad of ads) {
      if (!adsByAdset[ad.adset_id]) adsByAdset[ad.adset_id] = [];
      adsByAdset[ad.adset_id].push(ad);
    }
    const adsetsByCampaign = {};
    for (const adset of adsets) {
      adset.ads = adsByAdset[adset.id] || [];
      if (!adsetsByCampaign[adset.campaign_id]) adsetsByCampaign[adset.campaign_id] = [];
      adsetsByCampaign[adset.campaign_id].push(adset);
    }
    const campaignsTree = campaigns.map(c => ({
      ...c,
      adsets: adsetsByCampaign[c.id] || [],
    }));

    return respond(200, {
      exportedAt: new Date().toISOString(),
      account: {
        id: account.id,
        name: account.name,
        currency: account.currency,
        timezone: account.timezone_name,
        country: account.business_country_code,
        status: account.account_status,
      },
      summary: {
        campaigns: campaigns.length,
        adsets: adsets.length,
        ads: ads.length,
        creativesLoaded: ads.filter(a => a.creative && a.creative.title).length,
        partialCreatives: false,
        elapsedMs: elapsed(),
      },
      campaigns: campaignsTree,
    });
  } catch (err) {
    if (err.isPolicyViolation || err.tokenInvalid || err.isRateLimit) {
      return meta.metaErrorToResponse(err, respond);
    }
    return respond(500, { error: err.message || 'Error generando backup' });
  }
};

function partialResponse(account, campaigns, adsets, ads, stoppedAt, elapsedMs) {
  return {
    exportedAt: new Date().toISOString(),
    partial: true,
    stoppedAt,
    account: {
      id: account.id, name: account.name, currency: account.currency,
      timezone: account.timezone_name, country: account.business_country_code,
      status: account.account_status,
    },
    summary: {
      campaigns: campaigns.length, adsets: adsets.length, ads: ads.length,
      creativesLoaded: ads.filter(a => a.creative && a.creative.title).length,
      partialCreatives: ads.length === 0,
      elapsedMs,
    },
    campaigns,
  };
}

// Pagina respetando intervalos entre páginas. Cap reducido a 5 páginas
// (~500 items con limit=100) para no abusar de Meta.
async function fetchAllPagesSafe(initialUrl, remainingFn, maxPages = 5) {
  const all = [];
  let url = initialUrl;
  let pages = 0;
  while (url && pages < maxPages) {
    if (pages > 0) {
      if (remainingFn() < 4000) break;
      await meta.delay(); // ≥3s entre páginas
    }
    const data = await meta.fetchOne(url);
    if (Array.isArray(data.data)) all.push(...data.data);
    url = data?.paging?.next || null;
    pages++;
  }
  return all;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
