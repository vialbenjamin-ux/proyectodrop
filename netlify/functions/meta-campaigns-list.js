// Lista campañas Meta Ads de una cuenta con estado + gasto + CPA + compras.
// Espejo de tiktok-report pero a nivel campaign.
//
// GET /.netlify/functions/meta-campaigns-list?ad_account_id=act_XXX&date_preset=today&tenant=chile
//
// Respuesta:
//   { rows: [{ id, name, status, effective_status, dailyBudget, spend, purchases, cpa, roas, objective, createdAt }],
//     currency, fxRate, accountName, adAccountId, datePreset }
//
// Anti-ban: 2 llamadas secuenciales con >=3s entre cada una.

const meta = require('./_meta-api');
const utm = require('./_shopify-utm');

const VALID_PRESETS = ['today','yesterday','last_3d','last_7d','last_14d','last_28d','last_30d','last_90d','this_month','last_month','this_quarter','maximum'];

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

  const adAccountId = (params.ad_account_id || '').trim();
  if (!/^act_\d+$/.test(adAccountId)) return respond(400, { error: 'ad_account_id inválido (debe ser act_XXX)' });

  const datePreset = params.date_preset || 'today';
  if (!VALID_PRESETS.includes(datePreset)) return respond(400, { error: 'date_preset inválido' });

  const V = meta.META_API_VERSION;
  const campFields = [
    'id','name','status','effective_status','objective','buying_type',
    'daily_budget','lifetime_budget','budget_remaining','special_ad_categories',
    'created_time','updated_time','start_time','stop_time',
  ].join(',');
  const insightFields = [
    'campaign_id','campaign_name','spend','impressions','clicks','cpc','ctr','cpm',
    'frequency','reach','actions','action_values','purchase_roas','cost_per_action_type',
  ].join(',');

  const campsUrl = `https://graph.facebook.com/${V}/${adAccountId}/campaigns?fields=${campFields}&limit=500&access_token=${encodeURIComponent(token)}`;
  const insightsUrl = `https://graph.facebook.com/${V}/${adAccountId}/insights?fields=${insightFields}&date_preset=${datePreset}&level=campaign&limit=500&access_token=${encodeURIComponent(token)}`;
  const acctUrl = `https://graph.facebook.com/${V}/${adAccountId}?fields=id,name,currency,account_status&access_token=${encodeURIComponent(token)}`;

  // Shopify credentials para el cruce (mismo pattern que tiktok-report)
  const isGT = tenant === 'gt';
  const shopifyDomain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  const shopifyToken  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const canCross = !!(shopifyDomain && shopifyToken);
  const range = utm.computeDateRange(datePreset);

  try {
    const fxPromise = tenant === 'gt' ? getUsdToClpRate() : Promise.resolve(null);
    const campsData = await meta.fetchOne(campsUrl);
    await meta.delay();
    const insightsData = await meta.fetchOne(insightsUrl);
    await meta.delay();
    const acctData = await meta.fetchOne(acctUrl);
    const shopifyOrders = canCross
      ? await utm.fetchShopifyOrders(shopifyDomain, shopifyToken, range.start, range.end).catch(() => [])
      : [];
    const usdClpRate = await fxPromise;

    const accountName = acctData?.name || '';
    const accountCurrency = String(acctData?.currency || 'USD').toUpperCase();

    // Mapa insights por campaign_id
    const insByCamp = {};
    for (const r of (insightsData?.data || [])) {
      insByCamp[r.campaign_id] = r;
    }

    // Set de campaign_ids con insights (para desambiguar en collisiones de nombre)
    const insightCampaignIds = new Set(Object.keys(insByCamp));

    // Map campaign_name normalizado -> [{ id, name }] para matchear utm_campaign.
    // Si un mismo nombre aparece varias veces (borradas + activa), preferimos la
    // que tenga insights en el rango.
    const campsByName = {};
    (campsData?.data || []).forEach(c => {
      const key = utm.normalizeCampaignName(c.name);
      if (!key) return;
      if (!campsByName[key]) campsByName[key] = [];
      campsByName[key].push({ id: c.id, name: c.name });
    });

    // Cruzar órdenes Shopify con campañas Meta por nombre
    const ordersByCampaignId = {};
    for (const order of shopifyOrders) {
      if (utm.extractUtmSource(order) !== 'meta') continue;
      const utmCamp = utm.extractUtmCampaign(order);
      let campId = null;
      if (utmCamp) {
        const candidates = campsByName[utm.normalizeCampaignName(utmCamp)] || [];
        const preferred = candidates.find(c => insightCampaignIds.has(c.id)) || candidates[0];
        if (preferred) campId = preferred.id;
      }
      if (!campId) continue;
      const orderRev = utm.computeOrderRevenue(order);
      let orderQty = 0;
      for (const li of (order.line_items || [])) {
        const refunded = utm.getRefundedQty(order, li.id);
        orderQty += Math.max(0, (li.quantity || 0) - refunded);
      }
      if (!ordersByCampaignId[campId]) ordersByCampaignId[campId] = { orders: 0, qty: 0, revenue: 0 };
      ordersByCampaignId[campId].orders += 1;
      ordersByCampaignId[campId].qty += orderQty;
      ordersByCampaignId[campId].revenue += orderRev;
    }

    const find = (arr, type) => (arr || []).find(x => x.action_type === type);

    const rows = (campsData?.data || []).map(c => {
      const ins = insByCamp[c.id] || {};
      const pAct  = find(ins.actions, 'purchase') || find(ins.actions, 'omni_purchase') || find(ins.actions, 'offsite_conversion.fb_pixel_purchase');
      const pVal  = find(ins.action_values, 'purchase') || find(ins.action_values, 'omni_purchase') || find(ins.action_values, 'offsite_conversion.fb_pixel_purchase');
      const roas  = find(ins.purchase_roas, 'purchase') || find(ins.purchase_roas, 'omni_purchase');
      const cpa   = find(ins.cost_per_action_type, 'purchase') || find(ins.cost_per_action_type, 'omni_purchase');
      // Meta devuelve budgets en centavos de la moneda de la cuenta. Convertir a unidad.
      const dailyBudget    = c.daily_budget    ? Number(c.daily_budget) / 100 : null;
      const lifetimeBudget = c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null;
      const spend = parseFloat(ins.spend || 0);
      // Cruce real Shopify
      const shop = ordersByCampaignId[c.id] || { orders: 0, qty: 0, revenue: 0 };
      const realPurchases = shop.orders;
      const realRevenue = shop.revenue;
      const cpaReal = realPurchases > 0 ? spend / realPurchases : null;
      const roasReal = spend > 0 && realRevenue > 0 ? realRevenue / spend : null;
      return {
        id: c.id,
        name: c.name || '',
        status: c.status,
        effective_status: c.effective_status,
        objective: c.objective,
        buying_type: c.buying_type,
        dailyBudget,
        lifetimeBudget,
        createdAt: c.created_time,
        spend,
        impressions: parseInt(ins.impressions || 0, 10),
        clicks: parseInt(ins.clicks || 0, 10),
        cpc: parseFloat(ins.cpc || 0),
        ctr: parseFloat(ins.ctr || 0),
        cpm: parseFloat(ins.cpm || 0),
        purchases: pAct ? parseFloat(pAct.value) : 0,
        purchaseValue: pVal ? parseFloat(pVal.value) : 0,
        cpa: cpa ? parseFloat(cpa.value) : null,
        roas: roas ? parseFloat(roas.value) : null,
        // Cruce real Shopify
        realPurchases,
        realUnits: shop.qty,
        realRevenue,
        cpaReal,
        roasReal,
      };
    });

    // Conversión moneda cuenta → CLP si no es CLP.
    // Campos en moneda cuenta se multiplican. realRevenue viene de Shopify
    // (CLP siempre), no se toca. cpaReal/roasReal se RECALCULAN con spend
    // ya convertido a CLP.
    let willConvert = false;
    let fxRate = 1;
    let currency = accountCurrency;
    if (accountCurrency !== 'CLP') {
      const rate = accountCurrency === 'USD' && usdClpRate ? usdClpRate : await getFxToClpRate(accountCurrency);
      if (rate && rate > 0) {
        willConvert = true;
        fxRate = rate;
        currency = 'CLP';
        const mul = ['dailyBudget','lifetimeBudget','spend','cpc','cpm','purchaseValue','cpa'];
        for (const row of rows) {
          for (const k of mul) if (row[k] != null) row[k] = row[k] * fxRate;
          if (row.realPurchases > 0) row.cpaReal = row.spend / row.realPurchases;
          if (row.spend > 0 && row.realRevenue > 0) row.roasReal = row.realRevenue / row.spend;
        }
      }
    }

    rows.sort((a, b) => b.spend - a.spend);

    return respond(200, {
      rows,
      currency,
      originalCurrency: accountCurrency,
      fxRate: willConvert ? fxRate : null,
      accountName,
      adAccountId,
      datePreset,
      tenant,
      crossEnabled: canCross,
      shopifyOrdersScanned: shopifyOrders.length,
      startDate: range.start,
      endDate: range.end,
    });
  } catch (err) {
    if (err.isPolicyViolation || err.tokenInvalid || err.isRateLimit) {
      return meta.metaErrorToResponse(err, respond);
    }
    return respond(500, { error: err.message || 'Error consultando campaigns Meta' });
  }
};

async function getUsdToClpRate() {
  return getFxToClpRate('USD');
}

async function getFxToClpRate(fromCurrency) {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/' + encodeURIComponent(fromCurrency));
    if (!r.ok) return null;
    const j = await r.json();
    if (j && j.result !== 'success') return null;
    const rate = j && j.rates && j.rates.CLP ? Number(j.rates.CLP) : null;
    return (rate && isFinite(rate) && rate > 0) ? rate : null;
  } catch { return null; }
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
