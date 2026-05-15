// TikTok Ads insights por campaña, formato unificado con meta-ads-insights.
//
// GET  /.netlify/functions/tiktok-report?advertiser_id=XXX&date_preset=last_7d
// POST también acepta { advertiser_id, date_preset } por body (legacy).
// El access_token se lee de Netlify Blobs ('bk-tokens'/'tiktok_auth'), compartido
// entre browsers.

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  // Parámetros: pueden venir por query o por body.
  const qs = event.queryStringParameters || {};
  let bodyJson = {};
  if (event.httpMethod === 'POST') {
    try { bodyJson = JSON.parse(event.body || '{}'); } catch {}
  }
  const advertiserId = qs.advertiser_id || bodyJson.advertiser_id;
  if (!advertiserId) {
    return respond(400, { error: 'Falta advertiser_id' });
  }

  // Token: leer de Netlify Blobs
  let token;
  try {
    const store = getStore({ name: 'bk-tokens', consistency: 'strong' });
    const auth = await store.get('tiktok_auth', { type: 'json' });
    if (!auth || !auth.access_token) return respond(401, { error: 'NOT_CONNECTED' });
    token = auth.access_token;
  } catch (e) {
    return respond(500, { error: 'Storage error: ' + (e.message || 'unknown') });
  }

  const datePreset = qs.date_preset || bodyJson.date_preset || 'today';
  const range = computeDateRange(datePreset);
  if (!range) return respond(400, { error: 'date_preset inválido' });

  const metrics = [
    'spend','impressions','clicks','ctr','cpc','cpm','conversion','cost_per_conversion',
    'conversion_rate','complete_payment','complete_payment_roas','total_complete_payment_rate',
    'value_per_complete_payment','frequency','reach',
  ];

  const reportQs = new URLSearchParams({
    advertiser_id: advertiserId,
    report_type: 'BASIC',
    data_level: 'AUCTION_CAMPAIGN',
    dimensions: JSON.stringify(['campaign_id']),
    metrics: JSON.stringify(metrics),
    start_date: range.start,
    end_date: range.end,
    page: '1',
    page_size: '200',
  });

  const reportUrl   = 'https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/?' + reportQs.toString();
  const campaignsUrl = 'https://business-api.tiktok.com/open_api/v1.3/campaign/get/?' +
    new URLSearchParams({
      advertiser_id: advertiserId,
      fields: JSON.stringify(['campaign_id','campaign_name','operation_status','budget','budget_mode','objective_type']),
      page: '1',
      page_size: '200',
    }).toString();
  const advUrl = 'https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?advertiser_ids=' + encodeURIComponent(JSON.stringify([advertiserId]));

  try {
    const [reportR, campsR, advR] = await Promise.all([
      fetch(reportUrl, { headers: { 'Access-Token': token } }),
      fetch(campaignsUrl, { headers: { 'Access-Token': token } }),
      fetch(advUrl, { headers: { 'Access-Token': token } }),
    ]);
    const reportData = await reportR.json();
    const campsData  = await campsR.json();
    const advData    = await advR.json();

    // FX: si la cuenta no es CLP, convertimos a CLP usando frankfurter.app.
    // TikTok puede devolver advertiser/info como data:[...] o data:{list:[...]}
    const advertiserPreview = extractAdvertiserInfo(advData);
    const sourceCurrency = (advertiserPreview.currency || 'USD').toUpperCase();
    const fxRate = sourceCurrency === 'CLP' ? 1 : await getFxToClpRate(sourceCurrency);

    if (reportData.code !== 0) {
      return respond(400, { error: 'TikTok report: ' + (reportData.message || 'error') });
    }

    const campsById = {};
    if (campsData.code === 0 && campsData.data && Array.isArray(campsData.data.list)) {
      for (const c of campsData.data.list) {
        campsById[c.campaign_id] = {
          status: c.operation_status || '?',
          dailyBudget: c.budget_mode === 'BUDGET_MODE_DAY' ? Number(c.budget) : null,
          lifetimeBudget: c.budget_mode === 'BUDGET_MODE_TOTAL' ? Number(c.budget) : null,
          objective: c.objective_type || '',
          name: c.campaign_name || '',
        };
      }
    }

    const advertiser = advertiserPreview;
    const accountName = advertiser.name || '';
    const willConvert = fxRate && fxRate !== 1;
    const currency = willConvert ? 'CLP' : sourceCurrency;

    const list = (reportData.data && reportData.data.list) || [];
    const rows = list.map(r => {
      const dim = r.dimensions || {};
      const m   = r.metrics || {};
      const campId = dim.campaign_id;
      const camp = campsById[campId] || {};
      const purchases    = parseFloat(m.complete_payment || m.conversion || 0);
      const purchaseValue = purchases > 0 ? (purchases * parseFloat(m.value_per_complete_payment || 0)) : 0;
      const roas          = parseFloat(m.complete_payment_roas || 0);
      const cpa           = parseFloat(m.cost_per_conversion || 0) || null;

      return {
        id: campId,
        name: camp.name || dim.campaign_name || '(sin nombre)',
        status: camp.status || '?',
        objective: camp.objective || '',
        dailyBudget: camp.dailyBudget,
        lifetimeBudget: camp.lifetimeBudget,
        spend: parseFloat(m.spend || 0),
        impressions: parseInt(m.impressions || 0, 10),
        clicks: parseInt(m.clicks || 0, 10),
        cpc: parseFloat(m.cpc || 0),
        ctr: parseFloat(m.ctr || 0),
        cpm: parseFloat(m.cpm || 0),
        frequency: parseFloat(m.frequency || 0),
        reach: parseInt(m.reach || 0, 10),
        purchases,
        purchaseValue,
        cpa,
        roas: roas > 0 ? roas : null,
      };
    });

    // Aplicar conversión a CLP si la cuenta original no es CLP.
    if (willConvert) {
      const moneyFields = ['dailyBudget','lifetimeBudget','spend','cpc','cpm','purchaseValue','cpa'];
      for (const row of rows) {
        for (const k of moneyFields) if (row[k] != null) row[k] = row[k] * fxRate;
      }
    }

    rows.sort((a, b) => b.spend - a.spend);

    return respond(200, {
      rows,
      currency,
      originalCurrency: sourceCurrency,
      fxRate: willConvert ? fxRate : null,
      accountName,
      advertiserId,
      datePreset,
      startDate: range.start,
      endDate: range.end,
    });
  } catch (err) {
    return respond(502, { error: 'Red TikTok: ' + (err.message || 'error') });
  }
};

// Convierte date_preset estilo Meta a un rango YYYY-MM-DD para TikTok.
function computeDateRange(preset) {
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0,10);
  const minus = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return d; };

  switch (preset) {
    case 'today':       return { start: fmt(today),        end: fmt(today) };
    case 'yesterday':   return { start: fmt(minus(1)),     end: fmt(minus(1)) };
    case 'last_3d':     return { start: fmt(minus(3)),     end: fmt(minus(1)) };
    case 'last_7d':     return { start: fmt(minus(7)),     end: fmt(minus(1)) };
    case 'last_14d':    return { start: fmt(minus(14)),    end: fmt(minus(1)) };
    case 'last_28d':    return { start: fmt(minus(28)),    end: fmt(minus(1)) };
    case 'last_30d':    return { start: fmt(minus(30)),    end: fmt(minus(1)) };
    case 'last_90d':    return { start: fmt(minus(90)),    end: fmt(minus(1)) };
    case 'this_month': {
      const start = new Date(today.getUTCFullYear(), today.getUTCMonth(), 1);
      return { start: fmt(start), end: fmt(today) };
    }
    case 'last_month': {
      const start = new Date(today.getUTCFullYear(), today.getUTCMonth() - 1, 1);
      const end   = new Date(today.getUTCFullYear(), today.getUTCMonth(), 0);
      return { start: fmt(start), end: fmt(end) };
    }
    case 'maximum':     return { start: '2020-01-01',      end: fmt(today) };
    default: return null;
  }
}

// TikTok devuelve advertiser/info en formatos distintos según versión:
// - { code:0, data:[{...}] }
// - { code:0, data:{ list:[{...}] } }
// Probamos ambos para extraer el primer advertiser.
function extractAdvertiserInfo(advData) {
  if (!advData || advData.code !== 0) return {};
  if (Array.isArray(advData.data)) return advData.data[0] || {};
  if (advData.data && Array.isArray(advData.data.list)) return advData.data.list[0] || {};
  return {};
}

async function getFxToClpRate(fromCurrency) {
  // open.er-api.com es gratis, sin API key, y soporta COP/CLP (frankfurter solo majors).
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
