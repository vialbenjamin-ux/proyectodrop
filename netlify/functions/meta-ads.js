// Insights de ANUNCIOS (level=ad) dentro de un adset de Meta Ads.
// Endpoint: GET /.netlify/functions/meta-ads?adset_id=XXX&date_preset=last_7d&tenant=chile
// Devuelve { rows: [{ id, name, status, spend, ..., metaPurchases, metaPurchaseValue, createdAt }], currency, fxRate }
//
// Anti-ban: 2 llamadas secuenciales a Meta con ≥3s entre cada una.

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

  const adsetId = (params.adset_id || '').trim();
  if (!/^\d+$/.test(adsetId)) return respond(400, { error: 'adset_id inválido' });

  const datePreset = params.date_preset || 'last_7d';
  const validPresets = ['today','yesterday','last_3d','last_7d','last_14d','last_28d','last_30d','last_90d','this_month','last_month','this_quarter','maximum'];
  if (!validPresets.includes(datePreset)) return respond(400, { error: 'date_preset inválido' });

  const fields = [
    'ad_id','ad_name','spend','impressions','clicks','cpc','ctr','cpm',
    'frequency','reach','actions','action_values','purchase_roas','cost_per_action_type',
  ].join(',');

  const V = meta.META_API_VERSION;
  const insightsUrl = `https://graph.facebook.com/${V}/${adsetId}/insights?fields=${fields}&date_preset=${datePreset}&level=ad&limit=200&access_token=${encodeURIComponent(token)}`;
  const adsUrl      = `https://graph.facebook.com/${V}/${adsetId}/ads?fields=id,name,status,effective_status,created_time&limit=200&access_token=${encodeURIComponent(token)}`;

  try {
    const fxPromise = tenant === 'gt' ? getUsdToClpRate() : Promise.resolve(null);
    const insightsData = await meta.fetchOne(insightsUrl);
    await meta.delay();
    const adsData = await meta.fetchOne(adsUrl);
    const usdClpRate = await fxPromise;

    const metaById = {};
    for (const a of (adsData?.data || [])) {
      metaById[a.id] = {
        status: a.effective_status || a.status,
        createdAt: a.created_time || null,
      };
    }

    const rows = (insightsData.data || []).map(r => {
      const find = (arr, type) => (arr || []).find(x => x.action_type === type);
      const pAct  = find(r.actions, 'purchase') || find(r.actions, 'omni_purchase') || find(r.actions, 'offsite_conversion.fb_pixel_purchase');
      const pVal  = find(r.action_values, 'purchase') || find(r.action_values, 'omni_purchase') || find(r.action_values, 'offsite_conversion.fb_pixel_purchase');
      const roas  = find(r.purchase_roas, 'purchase') || find(r.purchase_roas, 'omni_purchase');
      const cpa   = find(r.cost_per_action_type, 'purchase') || find(r.cost_per_action_type, 'omni_purchase');
      const m     = metaById[r.ad_id] || {};
      return {
        id: r.ad_id,
        name: r.ad_name || '(sin nombre)',
        status: m.status || '?',
        createdAt: m.createdAt,
        spend: parseFloat(r.spend || 0),
        impressions: parseInt(r.impressions || 0, 10),
        clicks: parseInt(r.clicks || 0, 10),
        cpc: parseFloat(r.cpc || 0),
        ctr: parseFloat(r.ctr || 0),
        cpm: parseFloat(r.cpm || 0),
        frequency: parseFloat(r.frequency || 0),
        reach: parseInt(r.reach || 0, 10),
        metaPurchases: pAct ? parseFloat(pAct.value) : 0,
        metaPurchaseValue: pVal ? parseFloat(pVal.value) : 0,
        cpa: cpa ? parseFloat(cpa.value) : null,
        roas: roas ? parseFloat(roas.value) : null,
      };
    });

    // Conversión USD→CLP para tenant=gt
    if (tenant === 'gt' && usdClpRate) {
      const mul = ['spend','cpc','cpm','metaPurchaseValue','cpa'];
      for (const row of rows) {
        for (const k of mul) if (row[k] != null) row[k] = row[k] * usdClpRate;
      }
    }

    rows.sort((a, b) => b.spend - a.spend);
    return respond(200, {
      rows,
      adsetId,
      datePreset,
      currency: (tenant === 'gt' && usdClpRate) ? 'CLP' : 'USD',
      fxRate: (tenant === 'gt' && usdClpRate) ? usdClpRate : null,
    });
  } catch (err) {
    if (err.isPolicyViolation || err.tokenInvalid || err.isRateLimit) {
      return meta.metaErrorToResponse(err, respond);
    }
    return respond(500, { error: err.message || 'Error consultando anuncios' });
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
