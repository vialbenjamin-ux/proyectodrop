// Backup completo de campañas + adsets + ads + creativos de una ad account.
// Endpoint: GET /.netlify/functions/meta-backup?account_id=act_xxx
// Responde JSON con toda la estructura para reconstruir las campañas en otra cuenta
// si la actual es baneada.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return respond(500, { error: 'META_ACCESS_TOKEN no configurada' });

  const params = event.queryStringParameters || {};
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
  // Fase 1: ads sin creative completo (liviano). Solo guardamos creative.id.
  const adFields = [
    'id','name','adset_id','campaign_id','status','effective_status',
    'created_time','updated_time','creative{id}',
  ].join(',');

  // Fase 2: creativos en batch (más liviano que pedirlos anidados en ads).
  const creativeFields = [
    'id','name','title','body','link_url','instagram_permalink_url',
    'thumbnail_url','image_url','video_id','call_to_action_type',
    'effective_object_story_id','object_type',
  ].join(',');

  try {
    const [account, campaigns, adsets, ads] = await Promise.all([
      fetchOne(`https://graph.facebook.com/v19.0/${accountId}?fields=${accountFields}&access_token=${encodeURIComponent(token)}`),
      fetchAllPages(`https://graph.facebook.com/v19.0/${accountId}/campaigns?fields=${campaignFields}&limit=100&access_token=${encodeURIComponent(token)}`),
      fetchAllPages(`https://graph.facebook.com/v19.0/${accountId}/adsets?fields=${adsetFields}&limit=100&access_token=${encodeURIComponent(token)}`),
      fetchAllPages(`https://graph.facebook.com/v19.0/${accountId}/ads?fields=${adFields}&limit=100&access_token=${encodeURIComponent(token)}`),
    ]);

    // Recolectar creative.id únicos y traer creativos en lotes de 50
    const creativeIds = Array.from(new Set(
      ads.map(a => a.creative?.id).filter(Boolean)
    ));
    const creativesById = {};
    for (let i = 0; i < creativeIds.length; i += 50){
      const chunk = creativeIds.slice(i, i + 50);
      const url = `https://graph.facebook.com/v19.0/?ids=${chunk.join(',')}&fields=${creativeFields}&access_token=${encodeURIComponent(token)}`;
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Error trayendo creativos');
      Object.assign(creativesById, data || {});
    }
    // Sustituir el creative liviano por el completo
    for (const ad of ads){
      const cid = ad.creative?.id;
      if (cid && creativesById[cid]) ad.creative = creativesById[cid];
    }

    // Construir jerarquía: campaign → adset → ad
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
      },
      campaigns: campaignsTree,
    });
  } catch (err) {
    return respond(500, { error: err.message || 'Error generando backup' });
  }
};

async function fetchOne(url) {
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'Error en Meta API');
  return data;
}

// Recorre cursores de paginación con cap de seguridad (max 20 páginas = ~4000 items).
async function fetchAllPages(initialUrl, maxPages = 20) {
  const all = [];
  let url = initialUrl;
  let pages = 0;
  while (url && pages < maxPages) {
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || 'Error en Meta API');
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
