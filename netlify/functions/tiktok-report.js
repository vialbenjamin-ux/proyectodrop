// TikTok Ads insights por campaña, con cruce real Shopify×TikTok (CPA/ROAS reales).
//
// GET /.netlify/functions/tiktok-report?advertiser_id=XXX&date_preset=last_7d[&tenant=chile|gt]
// access_token leído de Netlify Blobs ('bk-tokens'/'tiktok_auth').
// Si la cuenta no es CLP, convierte automáticamente a CLP via open.er-api.com.
//
// El cruce con Shopify se hace por utm_campaign matcheando el name de la campaña
// TikTok (lowercase trim). Cada row incluye:
//   realPurchases, realRevenue, cpaReal, roasReal (basado en órdenes Shopify).

import { getStore } from '@netlify/blobs';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
  if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const url = new URL(req.url);
  const advertiserId = url.searchParams.get('advertiser_id');
  const datePreset = url.searchParams.get('date_preset') || 'today';
  const sinceParam = url.searchParams.get('since');
  const untilParam = url.searchParams.get('until');
  const tenant = (url.searchParams.get('tenant') || 'chile').toLowerCase();
  const isGT = tenant === 'gt';
  if (!advertiserId) return json(400, { error: 'Falta advertiser_id' });

  // since/until override el date_preset si vienen ambos
  let range;
  if (sinceParam && untilParam && /^\d{4}-\d{2}-\d{2}$/.test(sinceParam) && /^\d{4}-\d{2}-\d{2}$/.test(untilParam)) {
    range = { start: sinceParam, end: untilParam };
  } else {
    range = computeDateRange(datePreset);
  }
  if (!range) return json(400, { error: 'date_preset o since/until inválidos' });

  // Token: leer de Netlify Blobs
  let token;
  try {
    const store = getStore({ name: 'bk-tokens', consistency: 'strong' });
    const auth = await store.get('tiktok_auth', { type: 'json' });
    if (!auth || !auth.access_token) return json(401, { error: 'NOT_CONNECTED' });
    token = auth.access_token;
  } catch (e) {
    return json(500, { error: 'Storage error: ' + (e.message || 'unknown') });
  }

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

  // Shopify credentials para el cruce
  const shopifyDomain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  const shopifyToken  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const canCross = !!(shopifyDomain && shopifyToken);

  try {
    const [reportR, campsR, advR, shopifyOrders] = await Promise.all([
      fetch(reportUrl, { headers: { 'Access-Token': token } }),
      fetch(campaignsUrl, { headers: { 'Access-Token': token } }),
      fetch(advUrl, { headers: { 'Access-Token': token } }),
      canCross ? fetchShopifyOrders(shopifyDomain, shopifyToken, range.start, range.end).catch(() => []) : Promise.resolve([]),
    ]);
    const reportData = await reportR.json();
    const campsData  = await campsR.json();
    const advData    = await advR.json();

    const advertiserPreview = extractAdvertiserInfo(advData);
    const sourceCurrency = (advertiserPreview.currency || 'USD').toUpperCase();
    const fxRate = sourceCurrency === 'CLP' ? 1 : await getFxToClpRate(sourceCurrency);

    if (reportData.code !== 0) {
      return json(400, { error: 'TikTok report: ' + (reportData.message || 'error') });
    }

    const campsById = {};
    const campsByName = {};
    if (campsData.code === 0 && campsData.data && Array.isArray(campsData.data.list)) {
      for (const c of campsData.data.list) {
        const camp = {
          id: c.campaign_id,
          status: c.operation_status || '?',
          dailyBudget: c.budget_mode === 'BUDGET_MODE_DAY' ? Number(c.budget) : null,
          lifetimeBudget: c.budget_mode === 'BUDGET_MODE_TOTAL' ? Number(c.budget) : null,
          objective: c.objective_type || '',
          name: c.campaign_name || '',
        };
        campsById[c.campaign_id] = camp;
        const nameKey = normalizeCampaignName(c.campaign_name);
        if (nameKey) campsByName[nameKey] = camp;
      }
    }

    // Cruzar órdenes Shopify (utm_source=tiktok) con campañas TikTok por nombre.
    const ordersByCampaignId = {};
    let unmatchedTikTokOrders = 0;
    let unmatchedQty = 0;
    let unmatchedRevenue = 0;
    const unmatchedUtmCounts = {};
    const orphanOrders = []; // detalle de las huérfanas
    for (const order of shopifyOrders) {
      if (extractUtmSource(order) !== 'tiktok') continue;
      const utmCamp = extractUtmCampaign(order);
      let campId = null;
      if (utmCamp) {
        if (campsById[utmCamp]) campId = utmCamp;
        else {
          const camp = campsByName[normalizeCampaignName(utmCamp)];
          if (camp) campId = camp.id;
        }
      }
      const orderRev = computeOrderRevenue(order);
      let orderQty = 0;
      for (const li of (order.line_items || [])) {
        const refunded = getRefundedQty(order, li.id);
        orderQty += Math.max(0, (li.quantity || 0) - refunded);
      }
      const orderDetail = {
        id: order.id,
        name: order.order_number ? '#' + order.order_number : '#' + order.id,
        createdAt: order.created_at,
        total: orderRev,
        qty: orderQty,
        sourceName: order.source_name || null,
        utmCampaign: utmCamp || null,
        financialStatus: order.financial_status || null,
        items: (order.line_items || []).map(li => ({
          title: li.title,
          qty: Math.max(0, (li.quantity || 0) - getRefundedQty(order, li.id)),
        })),
      };
      if (!campId) {
        unmatchedTikTokOrders++;
        unmatchedQty += orderQty;
        unmatchedRevenue += orderRev;
        const key = utmCamp || '(sin utm_campaign)';
        unmatchedUtmCounts[key] = (unmatchedUtmCounts[key] || 0) + 1;
        orphanOrders.push(orderDetail);
        continue;
      }
      if (!ordersByCampaignId[campId]) ordersByCampaignId[campId] = { orders: 0, qty: 0, revenue: 0, details: [] };
      ordersByCampaignId[campId].orders += 1;
      ordersByCampaignId[campId].revenue += orderRev;
      ordersByCampaignId[campId].qty += orderQty;
      ordersByCampaignId[campId].details.push(orderDetail);
    }
    // Lista de los UTM no matcheados ordenada por frecuencia
    const unmatchedDetail = Object.entries(unmatchedUtmCounts)
      .map(([utm, count]) => ({ utm, count }))
      .sort((a, b) => b.count - a.count);

    const accountName = advertiserPreview.name || '';
    const willConvert = fxRate && fxRate !== 1;
    const currency = willConvert ? 'CLP' : sourceCurrency;

    const list = (reportData.data && reportData.data.list) || [];
    const rows = list.map(r => {
      const dim = r.dimensions || {};
      const m   = r.metrics || {};
      const campId = dim.campaign_id;
      const camp = campsById[campId] || {};
      const purchases     = parseFloat(m.complete_payment || m.conversion || 0);
      const purchaseValue = purchases > 0 ? (purchases * parseFloat(m.value_per_complete_payment || 0)) : 0;
      const roas          = parseFloat(m.complete_payment_roas || 0);
      const cpa           = parseFloat(m.cost_per_conversion || 0) || null;
      const spend         = parseFloat(m.spend || 0);

      // Cruce real con Shopify (utm_source=tiktok matcheado por campaign name)
      const shop = ordersByCampaignId[campId] || { orders: 0, qty: 0, revenue: 0, details: [] };
      const realPurchases = shop.orders;
      const realRevenue   = shop.revenue;
      const cpaReal  = realPurchases > 0 ? spend / realPurchases : null;
      const roasReal = spend > 0 && realRevenue > 0 ? realRevenue / spend : null;
      const orderDetails = shop.details || [];

      return {
        id: campId,
        name: camp.name || dim.campaign_name || '(sin nombre)',
        status: camp.status || '?',
        objective: camp.objective || '',
        dailyBudget: camp.dailyBudget,
        lifetimeBudget: camp.lifetimeBudget,
        spend,
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
        // Cruce real (los nombres siguen el patrón de cross-report Meta)
        realPurchases,
        realUnits: shop.qty,
        realRevenue,
        cpaReal,
        roasReal,
        orderDetails,
      };
    });

    if (willConvert) {
      // Campos en moneda TikTok: se convierten. realRevenue viene de Shopify
      // (CLP siempre), no se convierte. cpaReal/roasReal se recalculan con spend
      // ya convertido a CLP.
      const moneyFields = ['dailyBudget','lifetimeBudget','spend','cpc','cpm','purchaseValue','cpa'];
      for (const row of rows) {
        for (const k of moneyFields) if (row[k] != null) row[k] = row[k] * fxRate;
        if (row.realPurchases > 0) row.cpaReal = row.spend / row.realPurchases;
        if (row.spend > 0 && row.realRevenue > 0) row.roasReal = row.realRevenue / row.spend;
      }
    }

    rows.sort((a, b) => b.spend - a.spend);

    return json(200, {
      rows,
      currency,
      originalCurrency: sourceCurrency,
      fxRate: willConvert ? fxRate : null,
      accountName,
      advertiserId,
      datePreset,
      startDate: range.start,
      endDate: range.end,
      tenant,
      crossEnabled: canCross,
      unmatchedTikTokOrders,
      unmatchedDetail,
      orphan: {
        orders: unmatchedTikTokOrders,
        qty: unmatchedQty,
        revenue: unmatchedRevenue,
        details: orphanOrders,
      },
      shopifyDomain,
      // Lista de nombres de campañas TikTok (para que el frontend muestre side-by-side al usuario)
      campaignNames: Object.values(campsByName).map(c => c.name).slice(0, 100),
    });
  } catch (err) {
    return json(502, { error: 'Red TikTok: ' + (err.message || 'error') });
  }
}

function extractAdvertiserInfo(advData) {
  if (!advData || advData.code !== 0) return {};
  if (Array.isArray(advData.data)) return advData.data[0] || {};
  if (advData.data && Array.isArray(advData.data.list)) return advData.data.list[0] || {};
  return {};
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

// ── Timezone helpers (Chile / America/Santiago) ─────────────────────────────
// El reporte se alinea a hora Chile. Eso afecta:
// 1) "Hoy" / "Ayer" / etc. → calculados con el calendario Chile, no UTC.
// 2) Filtro de órdenes Shopify → rango UTC equivalente a 00:00–23:59 Chile.
// TikTok report sigue usando timezone del advertiser (limitación de su API).
const TZ_CL = 'America/Santiago';

function fmtChileDate(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ_CL }).format(d);
}
function chileToday() { return fmtChileDate(new Date()); }
function chileDateMinus(yyyy_mm_dd, days) {
  // Tomamos mediodía UTC del día Chile y restamos N días — no se ve afectado
  // por cambios de DST cuando la diferencia es ±N días enteros.
  const base = new Date(yyyy_mm_dd + 'T12:00:00Z');
  base.setUTCDate(base.getUTCDate() - days);
  return fmtChileDate(base);
}
function getChileOffsetHours() {
  // Offset actual de Chile en horas (negativo). -3 (verano) o -4 (invierno).
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ_CL,
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
  }).formatToParts(now);
  const get = (t) => parseInt(parts.find(p => p.type === t).value, 10);
  const chileAsUTCms = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((chileAsUTCms - now.getTime()) / 3600000);
}

function computeDateRange(preset) {
  const today = chileToday();
  switch (preset) {
    case 'today':     return { start: today, end: today };
    case 'yesterday': { const y = chileDateMinus(today, 1); return { start: y, end: y }; }
    case 'last_3d':   return { start: chileDateMinus(today, 3),  end: chileDateMinus(today, 1) };
    case 'last_7d':   return { start: chileDateMinus(today, 7),  end: chileDateMinus(today, 1) };
    case 'last_14d':  return { start: chileDateMinus(today, 14), end: chileDateMinus(today, 1) };
    case 'last_28d':  return { start: chileDateMinus(today, 28), end: chileDateMinus(today, 1) };
    case 'last_30d':  return { start: chileDateMinus(today, 30), end: chileDateMinus(today, 1) };
    case 'last_90d':  return { start: chileDateMinus(today, 90), end: chileDateMinus(today, 1) };
    case 'this_month': {
      const [y, m] = today.split('-');
      return { start: `${y}-${m}-01`, end: today };
    }
    case 'last_month': {
      const [y, m] = today.split('-').map(Number);
      const prevMonth = m === 1 ? 12 : m - 1;
      const prevYear  = m === 1 ? y - 1 : y;
      const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
      const pm = String(prevMonth).padStart(2, '0');
      const pd = String(lastDay).padStart(2, '0');
      return { start: `${prevYear}-${pm}-01`, end: `${prevYear}-${pm}-${pd}` };
    }
    case 'maximum':   return { start: '2020-01-01', end: today };
    default: return null;
  }
}

// ── Helpers Shopify (copiados de cross-report.js para autocontener) ─────────

async function fetchShopifyOrders(domain, token, startDateISO, endDateISO) {
  const FIELDS = 'id,line_items,landing_site,referring_site,source_name,cancelled_at,financial_status,refunds,created_at,current_subtotal_price,note_attributes';
  // Convertir 00:00–23:59 día Chile a rango UTC equivalente.
  const offset = getChileOffsetHours();
  const startUTC = new Date(startDateISO + 'T00:00:00Z');
  startUTC.setUTCHours(startUTC.getUTCHours() - offset); // offset negativo → suma horas
  const endUTC = new Date(endDateISO + 'T23:59:59Z');
  endUTC.setUTCHours(endUTC.getUTCHours() - offset);
  const start = startUTC.toISOString();
  const end   = endUTC.toISOString();
  let url = `https://${domain}/admin/api/2024-10/orders.json?status=any&created_at_min=${start}&created_at_max=${end}&limit=250&fields=${FIELDS}`;
  let all = [];
  while (url) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
    if (!resp.ok) throw new Error('Shopify API error ' + resp.status);
    const data = await resp.json();
    const filtered = (data.orders || []).filter(o => !o.cancelled_at && o.financial_status !== 'voided');
    all = all.concat(filtered);
    const linkHeader = resp.headers.get('Link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }
  return all;
}

function extractUtmSource(order) {
  const attrs = order.note_attributes || [];
  const utmAttr = attrs.find(a => a.name && a.name.toLowerCase().replace(/_/g, ' ') === 'utm source');
  if (utmAttr && utmAttr.value) {
    const s = utmAttr.value.toLowerCase().trim();
    if (['facebook','instagram','fb','meta'].includes(s)) return 'meta';
    if (s === 'tiktok') return 'tiktok';
    return s;
  }
  for (const field of [order.landing_site, order.referring_site]) {
    if (!field) continue;
    try {
      const u = new URL(field.startsWith('http') ? field : 'https://x.com' + field);
      const src = u.searchParams.get('utm_source');
      if (src) {
        const s = src.toLowerCase();
        if (['facebook','instagram','fb','meta'].includes(s)) return 'meta';
        if (s === 'tiktok') return 'tiktok';
        return s;
      }
      if (u.searchParams.get('ttclid')) return 'tiktok';
      if (u.searchParams.get('fbclid')) return 'meta';
    } catch (_) {}
  }
  const sn = (order.source_name || '').toLowerCase().trim();
  if (sn === 'tiktok') return 'tiktok';
  return 'directo';
}

function extractUtmCampaign(order) {
  const attrs = order.note_attributes || [];
  const utmAttr = attrs.find(a => a.name && a.name.toLowerCase().replace(/_/g, ' ') === 'utm campaign');
  if (utmAttr && utmAttr.value) return utmAttr.value.trim();
  for (const field of [order.landing_site, order.referring_site]) {
    if (!field) continue;
    try {
      const u = new URL(field.startsWith('http') ? field : 'https://x.com' + field);
      const camp = u.searchParams.get('utm_campaign');
      if (camp) return camp;
    } catch (_) {}
  }
  return null;
}

function getRefundedQty(order, lineItemId) {
  if (!order.refunds) return 0;
  let qty = 0;
  for (const refund of order.refunds)
    for (const ri of (refund.refund_line_items || []))
      if (ri.line_item_id === lineItemId) qty += ri.quantity || 0;
  return qty;
}

function computeOrderRevenue(order) {
  // Subtotal Shopify menos refunds parciales
  let revenue = parseFloat(order.current_subtotal_price || 0);
  if (!isFinite(revenue) || revenue < 0) revenue = 0;
  return revenue;
}

// Normaliza nombres de campaña / utm_campaign para comparar:
// - '+' → espacio (URL-encoded form)
// - '%20' → espacio (URL-encoded estándar)
// - varios espacios → uno
// - lowercase + trim
function normalizeCampaignName(s) {
  return String(s || '')
    .replace(/\+/g, ' ')
    .replace(/%20/gi, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

export const config = { path: '/.netlify/functions/tiktok-report' };
