// Cruce real TikTok × Shopify. Misma idea que cross-report.js (Meta×Shopify)
// pero usando TikTok Ads como source de gasto.
//
// GET /.netlify/functions/tiktok-cross-report?advertiser_id=X&date_preset=Y[&tenant=chile][&since=...&until=...]
//
// Responde: { kpis, byCampaign, byProduct, currency, accountName, dateFrom, dateTo }
//   kpis: { spend, realPurchases, realRevenue, cogs, grossProfit, netProfit, ... }
//   byCampaign: [{ id, name, status, dailyBudget, spend, realPurchases, realRevenue, cpaReal, roasReal, ... }]
//   byProduct: [{ name, qty, orders, revenue, attributedSpend, unitCost, totalCost, grossProfit, netProfit, marginPct }]
//
// Tokens: TIKTOK access_token de Netlify Blobs ('bk-tokens'/'tiktok_auth'),
// SHOPIFY_TOKEN/SHOPIFY_DOMAIN de env vars (o las _GT si tenant=gt).

import { getStore } from '@netlify/blobs';

// Lee el token de la cuenta TikTok ACTIVA (multi-account). Si no hay
// tiktok_active, cae al legacy 'tiktok_auth' para compatibilidad.
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

const TZ_CL = 'America/Santiago';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors() });
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const url = new URL(req.url);
  const advertiserId = url.searchParams.get('advertiser_id');
  const datePreset = url.searchParams.get('date_preset') || 'today';
  const sinceParam = url.searchParams.get('since');
  const untilParam = url.searchParams.get('until');
  const tenant = (url.searchParams.get('tenant') || 'chile').toLowerCase();
  const isGT = tenant === 'gt';
  if (!advertiserId) return json(400, { error: 'Falta advertiser_id' });

  // Rango (en hora Chile)
  let range;
  if (sinceParam && untilParam && /^\d{4}-\d{2}-\d{2}$/.test(sinceParam) && /^\d{4}-\d{2}-\d{2}$/.test(untilParam)) {
    range = { start: sinceParam, end: untilParam };
  } else {
    range = computeDateRange(datePreset);
  }
  if (!range) return json(400, { error: 'date_preset o since/until inválidos' });

  // Tokens
  let ttToken;
  try {
    const store = getStore({ name: 'bk-tokens', consistency: 'strong' });
    const auth = await getActiveAuth(store);
    if (!auth || !auth.access_token) return json(401, { error: 'NOT_CONNECTED' });
    ttToken = auth.access_token;
  } catch (e) {
    return json(500, { error: 'Storage error: ' + (e.message || 'unknown') });
  }
  const shopifyDomain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  const shopifyToken  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  if (!shopifyDomain || !shopifyToken) return json(500, { error: 'Faltan credenciales Shopify' + (isGT ? ' GT' : '') });

  // URLs TikTok
  const reportQs = new URLSearchParams({
    advertiser_id: advertiserId,
    report_type: 'BASIC',
    data_level: 'AUCTION_CAMPAIGN',
    dimensions: JSON.stringify(['campaign_id']),
    metrics: JSON.stringify(['spend','impressions','clicks','ctr','cpc','cpm','frequency','reach']),
    start_date: range.start,
    end_date: range.end,
    page: '1', page_size: '200',
  });
  const reportUrl = 'https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/?' + reportQs.toString();
  const campsUrl  = 'https://business-api.tiktok.com/open_api/v1.3/campaign/get/?' + new URLSearchParams({
    advertiser_id: advertiserId,
    fields: JSON.stringify(['campaign_id','campaign_name','operation_status','budget','budget_mode','objective_type']),
    page: '1', page_size: '200',
  }).toString();
  const advUrl = 'https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?advertiser_ids=' + encodeURIComponent(JSON.stringify([advertiserId]));

  try {
    const [reportR, campsR, advR, shopifyOrders] = await Promise.all([
      fetch(reportUrl, { headers: { 'Access-Token': ttToken } }),
      fetch(campsUrl,  { headers: { 'Access-Token': ttToken } }),
      fetch(advUrl,    { headers: { 'Access-Token': ttToken } }),
      fetchShopifyOrders(shopifyDomain, shopifyToken, range.start, range.end).catch(() => []),
    ]);
    const reportData = await reportR.json();
    const campsData  = await campsR.json();
    const advData    = await advR.json();
    if (reportData.code !== 0) return json(400, { error: 'TikTok report: ' + (reportData.message || 'error') });

    // FX a CLP
    const advertiserPreview = extractAdvertiserInfo(advData);
    const sourceCurrency = (advertiserPreview.currency || 'USD').toUpperCase();
    const fxRate = sourceCurrency === 'CLP' ? 1 : await getFxToClpRate(sourceCurrency);
    const willConvert = fxRate && fxRate !== 1;
    const currency = willConvert ? 'CLP' : sourceCurrency;

    // Campañas (indexar por id y nombre normalizado)
    const campsById = {};
    const campsByName = {};
    if (campsData.code === 0 && campsData.data?.list) {
      for (const c of campsData.data.list) {
        const meta = {
          id: c.campaign_id,
          name: c.campaign_name || '',
          status: c.operation_status || '?',
          dailyBudget: c.budget_mode === 'BUDGET_MODE_DAY' ? Number(c.budget) : null,
          objective: c.objective_type || '',
        };
        campsById[c.campaign_id] = meta;
        const nk = normalizeCampaignName(c.campaign_name);
        if (nk) campsByName[nk] = meta;
      }
    }

    // Insights TikTok por campaña
    const insightsByCamp = {};
    for (const r of (reportData.data?.list || [])) {
      const cid = r.dimensions?.campaign_id;
      const m = r.metrics || {};
      let spend = parseFloat(m.spend || 0);
      let cpc   = parseFloat(m.cpc || 0);
      let cpm   = parseFloat(m.cpm || 0);
      if (willConvert) { spend *= fxRate; cpc *= fxRate; cpm *= fxRate; }
      insightsByCamp[cid] = {
        spend, cpc, cpm,
        impressions: parseInt(m.impressions || 0, 10),
        clicks:      parseInt(m.clicks || 0, 10),
        ctr:         parseFloat(m.ctr || 0),
        frequency:   parseFloat(m.frequency || 0),
        reach:       parseInt(m.reach || 0, 10),
      };
    }

    // Cruce: órdenes TikTok de Shopify atribuidas por utm_campaign
    const ordersByCampaign = {}; // cid → { orders, qty, revenue, byProduct: { key → {qty, revenue} } }
    const productsAll = {};      // key → { name, variantIds, qty, revenue, fromTiktok }
    let unmatchedOrders = 0;
    let unmatchedRevenue = 0;
    for (const order of shopifyOrders) {
      if (extractUtmSource(order) !== 'tiktok') continue;
      const utm = extractUtmCampaign(order);
      let cid = null;
      if (utm) {
        if (campsById[utm]) cid = utm;
        else {
          const found = campsByName[normalizeCampaignName(utm)];
          if (found) cid = found.id;
        }
      }
      const orderRevenue = computeOrderRevenue(order);
      const productLines = expandOrderProducts(order, orderRevenue);
      if (!cid) {
        unmatchedOrders++;
        unmatchedRevenue += orderRevenue;
        continue;
      }
      if (!ordersByCampaign[cid]) ordersByCampaign[cid] = { orders: 0, qty: 0, revenue: 0, byProduct: {} };
      ordersByCampaign[cid].orders += 1;
      ordersByCampaign[cid].revenue += orderRevenue;
      for (const li of productLines) {
        ordersByCampaign[cid].qty += li.qty;
        const pkey = li.variantId || li.title;
        if (!ordersByCampaign[cid].byProduct[pkey]) ordersByCampaign[cid].byProduct[pkey] = { qty: 0, revenue: 0 };
        ordersByCampaign[cid].byProduct[pkey].qty += li.qty;
        ordersByCampaign[cid].byProduct[pkey].revenue += li.revenue;
        if (!productsAll[pkey]) productsAll[pkey] = { name: li.title, variantIds: new Set(), fromTiktok: { qty:0, orders:0, revenue:0, totalCost:0, hasAnyCost:false } };
        if (li.variantId) productsAll[pkey].variantIds.add(String(li.variantId));
        productsAll[pkey].fromTiktok.qty += li.qty;
        productsAll[pkey].fromTiktok.revenue += li.revenue;
      }
    }
    // Recalcular orders por producto (orden = orden única que tuvo este producto)
    for (const cid of Object.keys(ordersByCampaign)) {
      const camp = ordersByCampaign[cid];
      for (const pkey of Object.keys(camp.byProduct)) {
        // contamos +1 por orden que tuvo este producto
        if (productsAll[pkey]) productsAll[pkey].fromTiktok.orders += 1;
      }
    }

    // Costos de variantes
    const variantIds = new Set();
    for (const p of Object.values(productsAll)) for (const v of p.variantIds) variantIds.add(v);
    let costsByVariant = {};
    if (variantIds.size > 0) {
      try {
        costsByVariant = await fetchVariantCosts(shopifyDomain, shopifyToken, [...variantIds]);
      } catch { /* silenciar y seguir sin costos */ }
    }
    // Aplicar costos por producto
    for (const pkey of Object.keys(productsAll)) {
      const p = productsAll[pkey];
      let total = 0, qtyWithCost = 0, hasAny = false;
      for (const vid of p.variantIds) {
        const c = costsByVariant[vid];
        if (c != null) hasAny = true;
      }
      // simple: tomar el cost del primer variant que lo tenga, multiplicar por qty total
      let unitCost = null;
      for (const vid of p.variantIds) {
        if (costsByVariant[vid] != null) { unitCost = costsByVariant[vid]; break; }
      }
      if (unitCost != null) {
        p.fromTiktok.totalCost = unitCost * p.fromTiktok.qty;
        p.fromTiktok.hasAnyCost = true;
        p.fromTiktok.unitCost = unitCost;
      }
    }

    // byCampaign
    const byCampaign = [];
    let totalSpend = 0, totalRealPurchases = 0, totalRealRevenue = 0;
    for (const cid of Object.keys(insightsByCamp)) {
      const ins = insightsByCamp[cid];
      const camp = campsById[cid] || { name: '(sin nombre)', status: '?', dailyBudget: null };
      const shop = ordersByCampaign[cid] || { orders: 0, qty: 0, revenue: 0, byProduct: {} };
      const cpaReal  = shop.orders > 0 ? ins.spend / shop.orders : null;
      const roasReal = ins.spend > 0 && shop.revenue > 0 ? shop.revenue / ins.spend : null;
      byCampaign.push({
        id: cid,
        name: camp.name,
        status: camp.status,
        dailyBudget: camp.dailyBudget,
        spend: ins.spend,
        impressions: ins.impressions,
        clicks: ins.clicks,
        ctr: ins.ctr,
        cpc: ins.cpc,
        frequency: ins.frequency,
        realPurchases: shop.orders,
        realUnits: shop.qty,
        realRevenue: shop.revenue,
        cpaReal,
        roasReal,
        attributedProducts: shop.byProduct,
      });
      totalSpend += ins.spend;
      totalRealPurchases += shop.orders;
      totalRealRevenue += shop.revenue;
    }
    byCampaign.sort((a, b) => b.spend - a.spend);

    // byProduct con costos + ganancia
    const byProduct = [];
    for (const pkey of Object.keys(productsAll)) {
      const p = productsAll[pkey];
      if (p.fromTiktok.qty === 0) continue;
      // Atribuir gasto al producto: prorratear según fracción de revenue por campaña
      let attributedSpend = 0;
      for (const r of byCampaign) {
        const ap = r.attributedProducts[pkey];
        if (!ap || r.realRevenue === 0) continue;
        attributedSpend += r.spend * (ap.revenue / r.realRevenue);
      }
      const totalCost = p.fromTiktok.totalCost || 0;
      const unitCost  = p.fromTiktok.unitCost ?? null;
      const grossProfit = unitCost != null ? p.fromTiktok.revenue - totalCost : null;
      const netProfit   = grossProfit != null ? grossProfit - attributedSpend : null;
      const marginPct   = unitCost != null && p.fromTiktok.revenue > 0 ? (grossProfit / p.fromTiktok.revenue) * 100 : null;
      byProduct.push({
        name: p.name,
        variantIds: [...p.variantIds],
        qty: p.fromTiktok.qty,
        orders: p.fromTiktok.orders,
        revenue: p.fromTiktok.revenue,
        attributedSpend,
        unitCost,
        totalCost: unitCost != null ? totalCost : null,
        grossProfit,
        netProfit,
        marginPct,
        costFromShopify: p.fromTiktok.hasAnyCost,
      });
    }
    byProduct.sort((a, b) => b.revenue - a.revenue);

    // KPIs agregados
    let totalCogs = 0, revenueWithCost = 0;
    for (const r of byProduct) {
      if (r.totalCost != null) {
        totalCogs += r.totalCost;
        revenueWithCost += r.revenue;
      }
    }
    const kpis = {
      spend: totalSpend,
      realPurchases: totalRealPurchases,
      realRevenue: totalRealRevenue,
      cpaReal:  totalRealPurchases > 0 ? totalSpend / totalRealPurchases : null,
      roasReal: totalSpend > 0 && totalRealRevenue > 0 ? totalRealRevenue / totalSpend : null,
      cogs: totalCogs,
      grossProfit: revenueWithCost > 0 ? revenueWithCost - totalCogs : null,
      netProfit:   revenueWithCost > 0 ? revenueWithCost - totalCogs - totalSpend : null,
      productsWithoutCost: byProduct.filter(p => p.totalCost == null).length,
      unmatchedOrders,
      unmatchedRevenue,
    };

    return json(200, {
      kpis,
      byCampaign,
      byProduct,
      currency,
      originalCurrency: sourceCurrency,
      fxRate: willConvert ? fxRate : null,
      accountName: advertiserPreview.name || '',
      advertiserId,
      datePreset,
      dateFrom: range.start,
      dateTo: range.end,
      tenant,
    });
  } catch (err) {
    return json(502, { error: 'Cruce TikTok: ' + (err.message || 'error') });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtChileDate(d) { return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ_CL }).format(d); }
function chileToday() { return fmtChileDate(new Date()); }
function chileDateMinus(yyyy_mm_dd, days) {
  const base = new Date(yyyy_mm_dd + 'T12:00:00Z');
  base.setUTCDate(base.getUTCDate() - days);
  return fmtChileDate(base);
}
function getChileOffsetHours() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ_CL, year:'numeric', month:'2-digit', day:'2-digit',
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
    case 'last_4d_today': return { start: chileDateMinus(today, 3), end: today };
    case 'last_7d':   return { start: chileDateMinus(today, 7),  end: chileDateMinus(today, 1) };
    case 'last_14d':  return { start: chileDateMinus(today, 14), end: chileDateMinus(today, 1) };
    case 'last_28d':  return { start: chileDateMinus(today, 28), end: chileDateMinus(today, 1) };
    case 'last_30d':  return { start: chileDateMinus(today, 30), end: chileDateMinus(today, 1) };
    case 'this_month': { const [y, m] = today.split('-'); return { start: `${y}-${m}-01`, end: today }; }
    case 'last_month': {
      const [y, m] = today.split('-').map(Number);
      const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
      const ld = new Date(Date.UTC(py, pm, 0)).getUTCDate();
      return { start: `${py}-${String(pm).padStart(2,'0')}-01`, end: `${py}-${String(pm).padStart(2,'0')}-${String(ld).padStart(2,'0')}` };
    }
    default: return null;
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
    if (j.result !== 'success') return null;
    const rate = j.rates?.CLP;
    return rate && isFinite(rate) && rate > 0 ? Number(rate) : null;
  } catch { return null; }
}
function normalizeCampaignName(s) {
  return String(s || '').replace(/\+/g, ' ').replace(/%20/gi, ' ').replace(/\s+/g, ' ').toLowerCase().trim();
}

// ── Shopify helpers ─────────────────────────────────────────────────────────

async function fetchShopifyOrders(domain, token, startDateISO, endDateISO) {
  const FIELDS = 'id,line_items,landing_site,referring_site,source_name,cancelled_at,financial_status,refunds,created_at,current_subtotal_price,note_attributes';
  const offset = getChileOffsetHours();
  const startUTC = new Date(startDateISO + 'T00:00:00Z');
  startUTC.setUTCHours(startUTC.getUTCHours() - offset);
  const endUTC = new Date(endDateISO + 'T23:59:59Z');
  endUTC.setUTCHours(endUTC.getUTCHours() - offset);
  let url = `https://${domain}/admin/api/2024-10/orders.json?status=any&created_at_min=${startUTC.toISOString()}&created_at_max=${endUTC.toISOString()}&limit=250&fields=${FIELDS}`;
  let all = [];
  while (url) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
    if (!resp.ok) throw new Error('Shopify API error ' + resp.status);
    const data = await resp.json();
    all = all.concat((data.orders || []).filter(o => !o.cancelled_at && o.financial_status !== 'voided'));
    const link = resp.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return all;
}

async function fetchVariantCosts(domain, token, variantIds) {
  if (!variantIds || !variantIds.length) return {};
  const map = {};
  const chunks = [];
  for (let i = 0; i < variantIds.length; i += 250) chunks.push(variantIds.slice(i, i + 250));
  for (const chunk of chunks) {
    const gids = chunk.map(id => `gid://shopify/ProductVariant/${id}`);
    const query = `query GetCosts($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { unitCost { amount } } } } }`;
    const resp = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { ids: gids } }),
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    if (data.errors) continue;
    for (const node of (data.data?.nodes || [])) {
      if (!node?.id) continue;
      const m = node.id.match(/(\d+)$/);
      const numericId = m ? m[1] : null;
      const cost = node.inventoryItem?.unitCost?.amount;
      if (numericId && cost != null) map[numericId] = parseFloat(cost);
    }
  }
  return map;
}

function extractUtmSource(order) {
  const attrs = order.note_attributes || [];
  const a = attrs.find(x => x.name && x.name.toLowerCase().replace(/_/g,' ') === 'utm source');
  if (a?.value) {
    const s = a.value.toLowerCase().trim();
    if (s === 'tiktok') return 'tiktok';
    if (['facebook','instagram','fb','meta'].includes(s)) return 'meta';
    return s;
  }
  for (const f of [order.landing_site, order.referring_site]) {
    if (!f) continue;
    try {
      const u = new URL(f.startsWith('http') ? f : 'https://x.com' + f);
      const src = u.searchParams.get('utm_source');
      if (src) {
        const s = src.toLowerCase();
        if (s === 'tiktok') return 'tiktok';
        if (['facebook','instagram','fb','meta'].includes(s)) return 'meta';
        return s;
      }
      if (u.searchParams.get('ttclid')) return 'tiktok';
      if (u.searchParams.get('fbclid')) return 'meta';
    } catch {}
  }
  return (order.source_name || '').toLowerCase().trim() === 'tiktok' ? 'tiktok' : 'directo';
}

function extractUtmCampaign(order) {
  const attrs = order.note_attributes || [];
  const a = attrs.find(x => x.name && x.name.toLowerCase().replace(/_/g,' ') === 'utm campaign');
  if (a?.value) return a.value.trim();
  for (const f of [order.landing_site, order.referring_site]) {
    if (!f) continue;
    try {
      const u = new URL(f.startsWith('http') ? f : 'https://x.com' + f);
      const c = u.searchParams.get('utm_campaign');
      if (c) return c;
    } catch {}
  }
  return null;
}

function computeOrderRevenue(order) {
  const r = parseFloat(order.current_subtotal_price || 0);
  return (isFinite(r) && r > 0) ? r : 0;
}

function getRefundedQty(order, lineItemId) {
  if (!order.refunds) return 0;
  let qty = 0;
  for (const ref of order.refunds)
    for (const ri of (ref.refund_line_items || []))
      if (ri.line_item_id === lineItemId) qty += ri.quantity || 0;
  return qty;
}

// Prorratea el revenue de la orden por línea según gross precio del item × qty.
function expandOrderProducts(order, orderRevenue) {
  const items = (order.line_items || []).filter(li => {
    const refunded = getRefundedQty(order, li.id);
    return Math.max(0, (li.quantity || 0) - refunded) > 0;
  });
  if (!items.length) return [];
  const lines = items.map(li => {
    const refunded = getRefundedQty(order, li.id);
    const netQty = Math.max(0, (li.quantity || 0) - refunded);
    const gross  = parseFloat(li.price || 0) * netQty;
    return { it: li, netQty, gross };
  });
  const totalGross = lines.reduce((s, x) => s + x.gross, 0);
  return lines.map(x => ({
    title: x.it.title || 'Sin nombre',
    variantId: x.it.variant_id ? String(x.it.variant_id) : null,
    qty: x.netQty,
    revenue: totalGross > 0 ? (x.gross / totalGross) * orderRevenue : 0,
  }));
}

export const config = { path: '/.netlify/functions/tiktok-cross-report' };
