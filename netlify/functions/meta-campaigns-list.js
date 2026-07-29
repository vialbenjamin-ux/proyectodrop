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
  const tokenByTenant = {
    gt:    process.env.META_ACCESS_TOKEN_GT,
    cp:    process.env.META_ACCESS_TOKEN_CP,
    chile: process.env.META_ACCESS_TOKEN,
  };
  const token = tokenByTenant[tenant] || tokenByTenant.chile;
  if (!token) return respond(500, { error: 'Token Meta no configurado para tenant=' + tenant });

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

    // Lista de campañas activas (o con insights) para el matcher por producto.
    // Restringimos a las que están en insights o ACTIVE para evitar matchear
    // campañas viejas eliminadas.
    const campsForProductMatch = (campsData?.data || [])
      .filter(c => insightCampaignIds.has(c.id) || c.status === 'ACTIVE')
      .map(c => ({ id: c.id, name: c.name || '' }));

    // Set de todos los campaign_ids para match directo por ID (Meta UTM template
    // usa {{campaign.id}} numérico como utm_campaign en muchos casos).
    const allCampaignIds = new Set((campsData?.data || []).map(c => c.id));

    // Cruzar órdenes Shopify con campañas Meta.
    // Prioridad:
    //   1) utm_campaign == campaign_id de Meta (match exacto por ID) → método='utm'
    //   2) utm_campaign matchea nombre de campaña → método='utm'
    //   3) fuzzy match por keywords del nombre de campaña vs line_items → método='product'
    //   4) sin match → huérfana
    const ordersByCampaignId = {};    // { campId: { orders, qty, revenue, byMethod: {utm, product} } }
    let unmatchedMetaOrders = 0;
    let unmatchedQty = 0;
    let unmatchedRevenue = 0;
    const unmatchedUtmCounts = {};
    const orphanOrders = [];
    for (const order of shopifyOrders) {
      if (utm.extractUtmSource(order) !== 'meta') continue;
      const utmCamp = utm.extractUtmCampaign(order);
      let campId = null;
      let matchMethod = null;
      // 1) Match exacto por campaign_id (UTM template Meta con {{campaign.id}})
      if (utmCamp && /^\d+$/.test(utmCamp) && allCampaignIds.has(utmCamp)) {
        campId = utmCamp;
        matchMethod = 'utm';
      }
      // 2) Match por nombre de campaña (UTM template Meta con {{campaign.name}})
      if (!campId && utmCamp) {
        const candidates = campsByName[utm.normalizeCampaignName(utmCamp)] || [];
        const preferred = candidates.find(c => insightCampaignIds.has(c.id)) || candidates[0];
        if (preferred) { campId = preferred.id; matchMethod = 'utm'; }
      }
      // 3) Fallback: match por producto (keywords campaña vs line_items)
      if (!campId) {
        const productMatch = utm.matchOrderToCampaignByProduct(order, campsForProductMatch);
        if (productMatch) { campId = productMatch.id; matchMethod = 'product'; }
      }
      const orderRev = utm.computeOrderRevenue(order);
      let orderQty = 0;
      for (const li of (order.line_items || [])) {
        const refunded = utm.getRefundedQty(order, li.id);
        orderQty += Math.max(0, (li.quantity || 0) - refunded);
      }
      if (!campId) {
        unmatchedMetaOrders++;
        unmatchedQty += orderQty;
        unmatchedRevenue += orderRev;
        const key = utmCamp || '(sin utm_campaign)';
        unmatchedUtmCounts[key] = (unmatchedUtmCounts[key] || 0) + 1;
        orphanOrders.push({
          id: order.id,
          name: order.order_number ? '#' + order.order_number : '#' + order.id,
          createdAt: order.created_at,
          total: orderRev,
          qty: orderQty,
          utmCampaign: utmCamp || null,
          items: (order.line_items || []).map(li => li.title).slice(0, 3),
        });
        continue;
      }
      if (!ordersByCampaignId[campId]) {
        ordersByCampaignId[campId] = { orders: 0, qty: 0, revenue: 0, byMethod: { utm: 0, product: 0 } };
      }
      ordersByCampaignId[campId].orders += 1;
      ordersByCampaignId[campId].qty += orderQty;
      ordersByCampaignId[campId].revenue += orderRev;
      ordersByCampaignId[campId].byMethod[matchMethod] += 1;
    }
    const unmatchedDetail = Object.entries(unmatchedUtmCounts)
      .map(([utmC, count]) => ({ utm: utmC, count }))
      .sort((a, b) => b.count - a.count);

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
      const shop = ordersByCampaignId[c.id] || { orders: 0, qty: 0, revenue: 0, byMethod: { utm: 0, product: 0 } };
      const realPurchases = shop.orders;
      const realRevenue = shop.revenue;
      const cpaReal = realPurchases > 0 ? spend / realPurchases : null;
      const roasReal = spend > 0 && realRevenue > 0 ? realRevenue / spend : null;
      // Método de match dominante: 'utm' si al menos 1 orden fue por UTM, 'product' si todas fueron por producto
      const matchByMethod = shop.byMethod || { utm: 0, product: 0 };
      const realMatchMethod = realPurchases === 0 ? null
        : matchByMethod.utm > 0 ? 'utm' : 'product';
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
        realMatchMethod,               // 'utm' | 'product' | null
        realMatchByMethod: matchByMethod,   // { utm: N, product: M }
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

    // Nombres de campañas (para que el frontend compare visualmente)
    const campaignNames = (campsData?.data || []).map(c => c.name).slice(0, 200);

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
      unmatchedMetaOrders,
      unmatchedDetail,
      orphan: {
        orders: unmatchedMetaOrders,
        qty: unmatchedQty,
        revenue: unmatchedRevenue,
        details: orphanOrders,
      },
      campaignNames,
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
