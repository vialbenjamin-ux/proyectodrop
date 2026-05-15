// Insights de campañas de Meta Ads.
// Endpoint: GET /.netlify/functions/meta-ads-insights?account_id=act_xxx&date_preset=today
// Responde: { rows: [{name, status, dailyBudget, spend, impressions, clicks, cpc, ctr, purchases, purchaseValue, cpa, roas, frequency, reach}], currency, datePreset }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const params = event.queryStringParameters || {};
  // Selección de tenant: ?tenant=gt usa GT, default chile.
  const tenant = String(params.tenant || 'chile').toLowerCase();
  const token = (tenant === 'gt')
    ? process.env.META_ACCESS_TOKEN_GT
    : process.env.META_ACCESS_TOKEN;
  if (!token) {
    return respond(500, { error: 'META_ACCESS_TOKEN' + (tenant === 'gt' ? '_GT' : '') + ' no configurada' });
  }

  const accountId = (params.account_id || '').trim();
  if (!/^act_\d+$/.test(accountId)) {
    return respond(400, { error: 'account_id inválido (esperado: act_xxxxx)' });
  }

  const datePreset = params.date_preset || 'today';
  const validPresets = ['today','yesterday','last_3d','last_7d','last_14d','last_28d','last_30d','last_90d','this_month','last_month','this_quarter','maximum'];
  if (!validPresets.includes(datePreset)) {
    return respond(400, { error: 'date_preset inválido' });
  }

  const fields = [
    'campaign_id',
    'campaign_name',
    'spend',
    'impressions',
    'clicks',
    'cpc',
    'ctr',
    'cpm',
    'frequency',
    'reach',
    'actions',
    'action_values',
    'purchase_roas',
    'cost_per_action_type',
  ].join(',');

  const insightsUrl = `https://graph.facebook.com/v19.0/${accountId}/insights?` +
    `fields=${fields}&date_preset=${datePreset}&level=campaign&limit=200&access_token=${encodeURIComponent(token)}`;

  // Datos extra de cada campaña: status, presupuesto, objetivo
  const campaignsUrl = `https://graph.facebook.com/v19.0/${accountId}/campaigns?` +
    `fields=id,name,status,effective_status,daily_budget,lifetime_budget,objective&limit=200&access_token=${encodeURIComponent(token)}`;

  // Currency de la cuenta
  const accountUrl = `https://graph.facebook.com/v19.0/${accountId}?fields=currency,name&access_token=${encodeURIComponent(token)}`;

  try {
    const [insightsResp, campaignsResp, accountResp, usdClpRate] = await Promise.all([
      fetch(insightsUrl),
      fetch(campaignsUrl),
      fetch(accountUrl),
      tenant === 'gt' ? getUsdToClpRate() : Promise.resolve(null),
    ]);

    const insightsData = await insightsResp.json();
    if (!insightsResp.ok) {
      return respond(insightsResp.status, { error: insightsData?.error?.message || 'Error en insights' });
    }

    const campaignsData = await campaignsResp.json();
    const accountData = await accountResp.json();

    const campsById = {};
    if (campaignsResp.ok && campaignsData.data) {
      for (const c of campaignsData.data) {
        campsById[c.id] = {
          status: c.effective_status || c.status,
          dailyBudget: c.daily_budget ? parseInt(c.daily_budget, 10) / 100 : null,
          lifetimeBudget: c.lifetime_budget ? parseInt(c.lifetime_budget, 10) / 100 : null,
          objective: c.objective,
        };
      }
    }

    const rows = (insightsData.data || []).map(r => {
      const findAction = (arr, type) => (arr || []).find(a => a.action_type === type);
      const purchaseAction = findAction(r.actions, 'purchase')
        || findAction(r.actions, 'omni_purchase')
        || findAction(r.actions, 'offsite_conversion.fb_pixel_purchase');
      const purchaseValueAction = findAction(r.action_values, 'purchase')
        || findAction(r.action_values, 'omni_purchase')
        || findAction(r.action_values, 'offsite_conversion.fb_pixel_purchase');
      const roasAction = findAction(r.purchase_roas, 'purchase')
        || findAction(r.purchase_roas, 'omni_purchase');
      const cpaAction = findAction(r.cost_per_action_type, 'purchase')
        || findAction(r.cost_per_action_type, 'omni_purchase');

      const camp = campsById[r.campaign_id] || {};
      return {
        id: r.campaign_id,
        name: r.campaign_name || '(sin nombre)',
        status: camp.status || '?',
        objective: camp.objective || '',
        dailyBudget: camp.dailyBudget,
        lifetimeBudget: camp.lifetimeBudget,
        spend: parseFloat(r.spend || 0),
        impressions: parseInt(r.impressions || 0, 10),
        clicks: parseInt(r.clicks || 0, 10),
        cpc: parseFloat(r.cpc || 0),
        ctr: parseFloat(r.ctr || 0),
        cpm: parseFloat(r.cpm || 0),
        frequency: parseFloat(r.frequency || 0),
        reach: parseInt(r.reach || 0, 10),
        purchases: purchaseAction ? parseFloat(purchaseAction.value) : 0,
        purchaseValue: purchaseValueAction ? parseFloat(purchaseValueAction.value) : 0,
        cpa: cpaAction ? parseFloat(cpaAction.value) : null,
        roas: roasAction ? parseFloat(roasAction.value) : null,
      };
    });

    // Conversión USD→CLP para tenant=gt. ROAS y % no se tocan.
    let displayCurrency = accountData?.currency || 'USD';
    if (tenant === 'gt' && usdClpRate && displayCurrency === 'USD') {
      const mul = ['dailyBudget','lifetimeBudget','spend','cpc','cpm','purchaseValue','cpa'];
      for (const row of rows) {
        for (const k of mul) if (row[k] != null) row[k] = row[k] * usdClpRate;
      }
      displayCurrency = 'CLP';
    }

    return respond(200, {
      rows,
      currency: displayCurrency,
      originalCurrency: accountData?.currency || 'USD',
      fxRate: (tenant === 'gt' && usdClpRate) ? usdClpRate : null,
      accountName: accountData?.name || '',
      datePreset,
      accountId,
    });
  } catch (err) {
    return respond(500, { error: err.message || 'Error consultando Meta' });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function getUsdToClpRate() {
  // open.er-api.com es gratis, sin API key, soporta todas las monedas
  // (frankfurter.app solo cubre majors del ECB, sin CLP).
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!r.ok) return null;
    const j = await r.json();
    if (j && j.result !== 'success') return null;
    const rate = j && j.rates && j.rates.CLP ? Number(j.rates.CLP) : null;
    return (rate && isFinite(rate) && rate > 0) ? rate : null;
  } catch { return null; }
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(payload),
  };
}
