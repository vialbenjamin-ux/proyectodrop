// Insights de adsets dentro de una campaña de Meta Ads.
// Endpoint: GET /.netlify/functions/meta-adsets?campaign_id=XXX&date_preset=last_7d
// Responde: { rows: [{ id, name, status, dailyBudget, spend, ..., purchases, cpa, roas }] }

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
  const campaignId = (params.campaign_id || '').trim();
  if (!/^\d+$/.test(campaignId)) return respond(400, { error: 'campaign_id inválido' });

  const datePreset = params.date_preset || 'last_7d';
  const validPresets = ['today','yesterday','last_3d','last_7d','last_14d','last_28d','last_30d','last_90d','this_month','last_month','this_quarter','maximum'];
  if (!validPresets.includes(datePreset)) return respond(400, { error: 'date_preset inválido' });

  const fields = [
    'adset_id','adset_name','spend','impressions','clicks','cpc','ctr','cpm',
    'frequency','reach','actions','action_values','purchase_roas','cost_per_action_type',
  ].join(',');

  const insightsUrl = `https://graph.facebook.com/v19.0/${campaignId}/insights?fields=${fields}&date_preset=${datePreset}&level=adset&limit=200&access_token=${encodeURIComponent(token)}`;
  const adsetsUrl   = `https://graph.facebook.com/v19.0/${campaignId}/adsets?fields=id,name,status,effective_status,daily_budget,lifetime_budget,optimization_goal,bid_strategy&limit=200&access_token=${encodeURIComponent(token)}`;

  try {
    const [insightsR, adsetsR] = await Promise.all([fetch(insightsUrl), fetch(adsetsUrl)]);
    const insightsData = await insightsR.json();
    const adsetsData   = await adsetsR.json();
    if (!insightsR.ok) return respond(insightsR.status, { error: insightsData?.error?.message || 'Error en insights' });

    const metaById = {};
    for (const a of (adsetsData?.data || [])) {
      metaById[a.id] = {
        status: a.effective_status || a.status,
        dailyBudget: a.daily_budget ? parseInt(a.daily_budget, 10) / 100 : null,
        lifetimeBudget: a.lifetime_budget ? parseInt(a.lifetime_budget, 10) / 100 : null,
        optimizationGoal: a.optimization_goal,
        bidStrategy: a.bid_strategy,
      };
    }

    const rows = (insightsData.data || []).map(r => {
      const find = (arr, type) => (arr || []).find(x => x.action_type === type);
      const pAct  = find(r.actions, 'purchase') || find(r.actions, 'omni_purchase') || find(r.actions, 'offsite_conversion.fb_pixel_purchase');
      const pVal  = find(r.action_values, 'purchase') || find(r.action_values, 'omni_purchase') || find(r.action_values, 'offsite_conversion.fb_pixel_purchase');
      const roas  = find(r.purchase_roas, 'purchase') || find(r.purchase_roas, 'omni_purchase');
      const cpa   = find(r.cost_per_action_type, 'purchase') || find(r.cost_per_action_type, 'omni_purchase');
      const meta  = metaById[r.adset_id] || {};
      return {
        id: r.adset_id,
        name: r.adset_name || '(sin nombre)',
        status: meta.status || '?',
        dailyBudget: meta.dailyBudget,
        optimizationGoal: meta.optimizationGoal,
        spend: parseFloat(r.spend || 0),
        impressions: parseInt(r.impressions || 0, 10),
        clicks: parseInt(r.clicks || 0, 10),
        cpc: parseFloat(r.cpc || 0),
        ctr: parseFloat(r.ctr || 0),
        cpm: parseFloat(r.cpm || 0),
        frequency: parseFloat(r.frequency || 0),
        reach: parseInt(r.reach || 0, 10),
        purchases: pAct ? parseFloat(pAct.value) : 0,
        purchaseValue: pVal ? parseFloat(pVal.value) : 0,
        cpa: cpa ? parseFloat(cpa.value) : null,
        roas: roas ? parseFloat(roas.value) : null,
      };
    });

    rows.sort((a, b) => b.spend - a.spend);
    return respond(200, { rows, campaignId, datePreset });
  } catch (err) {
    return respond(500, { error: err.message || 'Error consultando adsets' });
  }
};

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
