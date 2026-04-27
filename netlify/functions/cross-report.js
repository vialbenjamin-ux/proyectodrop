// Cruce Shopify × Meta — KPIs reales y recomendaciones.
// Endpoint: GET /.netlify/functions/cross-report?account_id=act_xxx&date_preset=last_7d
// Trae en paralelo:
//   1) Órdenes de Shopify del período (con UTM source + UTM campaign + line_items)
//   2) Insights de Meta a nivel campaña
//   3) Metadata de campañas (estado, presupuesto)
//   4) Currency de la cuenta
// Cruza ventas Shopify con campañas de Meta por utm_campaign (match por ID
// o por nombre como fallback) y devuelve KPIs reales, tabla por campaña,
// tabla por producto y lista de recomendaciones.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const shopifyDomain = process.env.SHOPIFY_DOMAIN;
  const shopifyToken  = process.env.SHOPIFY_TOKEN;
  const metaToken     = process.env.META_ACCESS_TOKEN;
  if (!shopifyDomain || !shopifyToken) return respond(500, { error: 'Faltan credenciales de Shopify' });
  if (!metaToken) return respond(500, { error: 'Falta META_ACCESS_TOKEN' });

  const params = event.queryStringParameters || {};
  const accountId = (params.account_id || '').trim();
  if (!/^act_\d+$/.test(accountId)) return respond(400, { error: 'account_id inválido' });

  const datePreset = params.date_preset || 'last_7d';
  const validPresets = ['today','yesterday','last_3d','last_7d','last_14d','last_28d','last_30d','last_90d','this_month','last_month'];
  if (!validPresets.includes(datePreset)) return respond(400, { error: 'date_preset inválido' });

  // Convertir preset a rango de fechas para Shopify (timezone Santiago)
  const { startUTC, endUTC, dateFrom, dateTo } = presetToRange(datePreset);

  try {
    const [orders, insightsRaw, campaignsRaw, accountRaw] = await Promise.all([
      fetchShopifyOrders(shopifyDomain, shopifyToken, startUTC, endUTC),
      fetchMetaInsights(accountId, metaToken, datePreset),
      fetchMetaCampaigns(accountId, metaToken),
      fetchMetaAccount(accountId, metaToken),
    ]);

    // Traer costos de las variantes presentes en las órdenes (Shopify GraphQL)
    const variantIds = new Set();
    for (const o of orders) {
      for (const li of (o.line_items || [])) {
        if (li.variant_id) variantIds.add(String(li.variant_id));
      }
    }
    let costsByVariant = {};
    let costsAvailable = false;
    if (variantIds.size > 0) {
      try {
        costsByVariant = await fetchVariantCosts(shopifyDomain, shopifyToken, [...variantIds]);
        costsAvailable = Object.keys(costsByVariant).length > 0;
      } catch (e) {
        costsAvailable = false;
      }
    }

    const currency = accountRaw?.currency || 'USD';
    const accountName = accountRaw?.name || '';

    // Index de campañas Meta por id y por nombre (lowercase)
    const campsById = {};
    const campsByName = {};
    for (const c of (campaignsRaw?.data || [])) {
      const meta = {
        id: c.id,
        name: c.name,
        status: c.effective_status || c.status,
        dailyBudget: c.daily_budget ? parseInt(c.daily_budget, 10) / 100 : null,
        objective: c.objective,
      };
      campsById[c.id] = meta;
      campsByName[(c.name || '').toLowerCase().trim()] = meta;
    }

    // Procesar insights por campaña
    const insightsByCampaignId = {};
    for (const r of (insightsRaw?.data || [])) {
      const findAction = (arr, type) => (arr || []).find(a => a.action_type === type);
      const purchaseAct = findAction(r.actions, 'purchase')
        || findAction(r.actions, 'omni_purchase')
        || findAction(r.actions, 'offsite_conversion.fb_pixel_purchase');
      const purchaseValAct = findAction(r.action_values, 'purchase')
        || findAction(r.action_values, 'omni_purchase')
        || findAction(r.action_values, 'offsite_conversion.fb_pixel_purchase');
      insightsByCampaignId[r.campaign_id] = {
        spend: parseFloat(r.spend || 0),
        impressions: parseInt(r.impressions || 0, 10),
        clicks: parseInt(r.clicks || 0, 10),
        cpc: parseFloat(r.cpc || 0),
        ctr: parseFloat(r.ctr || 0),
        frequency: parseFloat(r.frequency || 0),
        reach: parseInt(r.reach || 0, 10),
        metaPurchases: purchaseAct ? parseFloat(purchaseAct.value) : 0,
        metaPurchaseValue: purchaseValAct ? parseFloat(purchaseValAct.value) : 0,
      };
    }

    // Procesar órdenes Shopify y agrupar por utm_campaign
    const ordersByCampaignKey = {};   // campaignKey (id o name) -> { orders, products, revenue, byProduct }
    const productsAll = {};
    const ordersBySource = {};        // source -> { orders, products, revenue }
    let shopifyMetaOrdersTotal = 0;
    let shopifyMetaRevenueTotal = 0;
    let totalOrdersAll = 0;
    let unmatchedMetaOrders = 0;

    for (const order of orders) {
      const src = extractUtmSource(order);
      if (!ordersBySource[src]) ordersBySource[src] = { orders: 0, products: 0, revenue: 0 };
      ordersBySource[src].orders += 1;
      totalOrdersAll += 1;

      const orderRevenue = parseFloat(order.current_subtotal_price || 0);
      const lineRev = computeLineRevenues(order);

      for (const li of lineRev) {
        ordersBySource[src].products += li.qty;
        ordersBySource[src].revenue += li.revenue;

        // Costo unitario desde Shopify (si está disponible)
        const unitCost = li.variantId ? costsByVariant[li.variantId] : null;
        const totalCost = unitCost != null ? unitCost * li.qty : null;

        // Acumular en productos globales con distribución de cantidades
        const pkey = li.title;
        if (!productsAll[pkey]) {
          productsAll[pkey] = {
            name: li.title,
            variantIds: new Set(),
            qty: 0, revenue: 0, totalCost: 0, hasAnyCost: false, orders: 0,
            qtyDistribution: {},
            fromMeta: { qty: 0, revenue: 0, totalCost: 0, hasAnyCost: false, orders: 0, qtyDistribution: {} },
          };
        }
        if (li.variantId) productsAll[pkey].variantIds.add(li.variantId);
        productsAll[pkey].qty += li.qty;
        productsAll[pkey].revenue += li.revenue;
        productsAll[pkey].orders += 1;
        if (totalCost != null) { productsAll[pkey].totalCost += totalCost; productsAll[pkey].hasAnyCost = true; }
        const qKey = String(li.qty);
        productsAll[pkey].qtyDistribution[qKey] = (productsAll[pkey].qtyDistribution[qKey] || 0) + 1;

        if (src === 'meta') {
          productsAll[pkey].fromMeta.qty += li.qty;
          productsAll[pkey].fromMeta.revenue += li.revenue;
          productsAll[pkey].fromMeta.orders += 1;
          if (totalCost != null) { productsAll[pkey].fromMeta.totalCost += totalCost; productsAll[pkey].fromMeta.hasAnyCost = true; }
          productsAll[pkey].fromMeta.qtyDistribution[qKey] = (productsAll[pkey].fromMeta.qtyDistribution[qKey] || 0) + 1;
        }
      }

      if (src !== 'meta') continue;

      shopifyMetaOrdersTotal += 1;
      shopifyMetaRevenueTotal += orderRevenue;

      // Match con campaña Meta
      const utmCamp = extractUtmCampaign(order);
      let key = null;
      if (utmCamp) {
        if (campsById[utmCamp]) key = 'id:' + utmCamp;
        else {
          const found = campsByName[utmCamp.toLowerCase().trim()];
          if (found) key = 'id:' + found.id;
        }
      }
      if (!key) {
        key = 'unmatched';
        unmatchedMetaOrders += 1;
      }
      if (!ordersByCampaignKey[key]) ordersByCampaignKey[key] = { orders: 0, products: 0, revenue: 0, byProduct: {} };
      ordersByCampaignKey[key].orders += 1;
      ordersByCampaignKey[key].revenue += orderRevenue;
      for (const li of lineRev) {
        ordersByCampaignKey[key].products += li.qty;
        if (!ordersByCampaignKey[key].byProduct[li.title]) ordersByCampaignKey[key].byProduct[li.title] = { qty: 0, revenue: 0 };
        ordersByCampaignKey[key].byProduct[li.title].qty += li.qty;
        ordersByCampaignKey[key].byProduct[li.title].revenue += li.revenue;
      }
    }

    // Construir filas por campaña: para cada campaña con insights, agregar lo que matcheó de Shopify
    const byCampaign = [];
    for (const cid of Object.keys(insightsByCampaignId)) {
      const ins = insightsByCampaignId[cid];
      const camp = campsById[cid] || { name: '(sin nombre)', status: '?', dailyBudget: null };
      const shop = ordersByCampaignKey['id:' + cid] || { orders: 0, products: 0, revenue: 0, byProduct: {} };
      const realPurchases = shop.orders;
      const realRevenue = shop.revenue;
      const cpaReal = realPurchases > 0 ? ins.spend / realPurchases : null;
      const roasReal = ins.spend > 0 && realRevenue > 0 ? realRevenue / ins.spend : null;
      const deltaPct = ins.metaPurchases > 0 || realPurchases > 0
        ? (realPurchases - ins.metaPurchases) / Math.max(realPurchases, ins.metaPurchases || 1)
        : 0;
      // Calcular unidades totales vendidas en esta campaña (suma de todos los productos)
      const realUnits = Object.values(shop.byProduct || {}).reduce((s, p) => s + (p.qty || 0), 0);
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
        metaPurchases: ins.metaPurchases,
        metaPurchaseValue: ins.metaPurchaseValue,
        realPurchases,                      // órdenes únicas
        realUnits,                          // unidades totales (combos suman más)
        realRevenue,
        cpaReal,
        roasReal,
        deltaPct,
        attributedProducts: shop.byProduct,
      });
    }

    byCampaign.sort((a, b) => b.spend - a.spend);

    // KPIs agregados (basados en lo que cruza con Meta)
    let totalSpend = 0, totalMetaPurchases = 0, totalMetaValue = 0;
    let totalRealPurchases = 0, totalRealRevenue = 0;
    for (const r of byCampaign) {
      totalSpend += r.spend;
      totalMetaPurchases += r.metaPurchases;
      totalMetaValue += r.metaPurchaseValue;
      totalRealPurchases += r.realPurchases;
      totalRealRevenue += r.realRevenue;
    }

    // KPIs agregados (sin costos todavía — los agregamos después de construir byProduct)
    const kpis = {
      spend: totalSpend,
      metaPurchases: totalMetaPurchases,
      metaPurchaseValue: totalMetaValue,
      realPurchases: totalRealPurchases,
      realRevenue: totalRealRevenue,
      cpaReal: totalRealPurchases > 0 ? totalSpend / totalRealPurchases : null,
      roasReal: totalSpend > 0 && totalRealRevenue > 0 ? totalRealRevenue / totalSpend : null,
      cpaMeta: totalMetaPurchases > 0 ? totalSpend / totalMetaPurchases : null,
      roasMeta: totalSpend > 0 && totalMetaValue > 0 ? totalMetaValue / totalSpend : null,
      shopifyMetaOrders: shopifyMetaOrdersTotal,
      shopifyMetaRevenue: shopifyMetaRevenueTotal,
      cpaAccount: shopifyMetaOrdersTotal > 0 ? totalSpend / shopifyMetaOrdersTotal : null,
      roasAccount: totalSpend > 0 && shopifyMetaRevenueTotal > 0 ? shopifyMetaRevenueTotal / totalSpend : null,
      unmatchedMetaOrders,
      costsAvailable,
    };

    // Tabla por producto: para cada producto con ventas atribuidas a Meta, sumar ventas y gasto estimado
    const byProduct = [];
    for (const pkey of Object.keys(productsAll)) {
      const p = productsAll[pkey];
      if (p.fromMeta.qty === 0) continue;

      // Estimar gasto atribuido al producto:
      // por cada campaña, prorratear su spend según la fracción de revenue de ese producto en esa campaña
      let attributedSpend = 0;
      for (const r of byCampaign) {
        const ap = r.attributedProducts[pkey];
        if (!ap || r.realRevenue === 0) continue;
        const fraction = ap.revenue / r.realRevenue;
        attributedSpend += r.spend * fraction;
      }

      const cpa = p.fromMeta.orders > 0 ? attributedSpend / p.fromMeta.orders : null;
      const roas = attributedSpend > 0 ? p.fromMeta.revenue / attributedSpend : null;
      const avgUnitsPerOrder = p.fromMeta.orders > 0 ? p.fromMeta.qty / p.fromMeta.orders : 0;
      const avgTicket = p.fromMeta.orders > 0 ? p.fromMeta.revenue / p.fromMeta.orders : 0;

      // Costos / rentabilidad
      const unitCost = p.fromMeta.hasAnyCost && p.fromMeta.qty > 0
        ? p.fromMeta.totalCost / p.fromMeta.qty
        : null;
      const grossProfit = unitCost != null ? p.fromMeta.revenue - p.fromMeta.totalCost : null;
      const netProfit = grossProfit != null ? grossProfit - attributedSpend : null;
      const marginPct = unitCost != null && p.fromMeta.revenue > 0
        ? (grossProfit / p.fromMeta.revenue) * 100
        : null;

      byProduct.push({
        name: p.name,
        variantIds: [...p.variantIds],
        qty: p.fromMeta.qty,
        orders: p.fromMeta.orders,
        revenue: p.fromMeta.revenue,
        attributedSpend,
        cpa,
        roas,
        avgUnitsPerOrder,
        avgTicket,
        qtyDistribution: p.fromMeta.qtyDistribution,
        unitCost,
        totalCost: unitCost != null ? p.fromMeta.totalCost : null,
        grossProfit,
        netProfit,
        marginPct,
        costFromShopify: p.fromMeta.hasAnyCost,
      });
    }
    byProduct.sort((a, b) => b.revenue - a.revenue);

    // Totales de costo/ganancia (de productos vendidos vía Meta) — necesita byProduct construido
    let totalCogs = 0, totalCogsRevenue = 0;
    for (const r of byProduct) {
      if (r.totalCost != null) {
        totalCogs += r.totalCost;
        totalCogsRevenue += r.revenue;
      }
    }
    kpis.cogs = totalCogs || 0;
    kpis.grossProfit = totalCogsRevenue > 0 ? totalCogsRevenue - totalCogs : null;
    kpis.netProfit = kpis.grossProfit != null ? kpis.grossProfit - totalSpend : null;
    kpis.productsWithoutCost = byProduct.filter(p => p.totalCost == null).length;

    // Recomendaciones
    const recommendations = generateRecommendations(byCampaign, currency);

    return respond(200, {
      kpis,
      byCampaign,
      byProduct,
      recommendations,
      currency,
      accountName,
      datePreset,
      dateFrom,
      dateTo,
      meta: {
        totalShopifyOrders: totalOrdersAll,
        bySource: ordersBySource,
        hasUtmCampaign: shopifyMetaOrdersTotal > 0 && unmatchedMetaOrders < shopifyMetaOrdersTotal,
      },
    });
  } catch (err) {
    return respond(500, { error: err.message || 'Error en cross-report' });
  }
};

// ── Helpers Shopify ─────────────────────────────────────────────────────────

function extractUtmSource(order) {
  const attrs = order.note_attributes || [];
  const utmAttr = attrs.find(a => a.name && a.name.toLowerCase().replace(/_/g, ' ') === 'utm source');
  if (utmAttr && utmAttr.value) {
    const s = utmAttr.value.toLowerCase().trim();
    if (['facebook', 'instagram', 'fb', 'meta'].includes(s)) return 'meta';
    if (s === 'tiktok') return 'tiktok';
    if (['google', 'cpc', 'adwords'].includes(s)) return 'google';
    return s;
  }
  for (const field of [order.landing_site, order.referring_site]) {
    if (!field) continue;
    try {
      const url = new URL(field.startsWith('http') ? field : 'https://x.com' + field);
      const src = url.searchParams.get('utm_source');
      if (src) {
        const s = src.toLowerCase();
        if (['facebook', 'instagram', 'fb', 'meta'].includes(s)) return 'meta';
        if (s === 'tiktok') return 'tiktok';
        if (['google', 'cpc', 'adwords'].includes(s)) return 'google';
        return s;
      }
      if (url.searchParams.get('fbclid')) return 'meta';
      if (url.searchParams.get('ttclid')) return 'tiktok';
    } catch (_) {}
  }
  const sn = (order.source_name || '').toLowerCase().trim();
  if (['facebook', 'instagram', 'fb', 'meta'].includes(sn)) return 'meta';
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
      const url = new URL(field.startsWith('http') ? field : 'https://x.com' + field);
      const camp = url.searchParams.get('utm_campaign');
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

function computeLineRevenues(order) {
  const orderRevenue = parseFloat(order.current_subtotal_price || 0);
  const items = order.line_items || [];
  const grossPerItem = items.map(it => {
    const refQty = getRefundedQty(order, it.id);
    const netQty = (it.quantity || 0) - refQty;
    if (netQty <= 0) return null;
    return { it, netQty, gross: parseFloat(it.price || 0) * netQty };
  }).filter(Boolean);
  const totalGross = grossPerItem.reduce((s, x) => s + x.gross, 0);
  return grossPerItem.map(x => ({
    title: x.it.title || 'Sin nombre',
    variantId: x.it.variant_id ? String(x.it.variant_id) : null,
    qty: x.netQty,
    revenue: totalGross > 0 ? (x.gross / totalGross) * orderRevenue : 0,
  }));
}

async function fetchVariantCosts(domain, token, variantIds) {
  if (!variantIds || variantIds.length === 0) return {};
  const map = {};
  // GraphQL nodes() acepta hasta 250 IDs por query
  const chunks = [];
  for (let i = 0; i < variantIds.length; i += 250) chunks.push(variantIds.slice(i, i + 250));
  for (const chunk of chunks) {
    const gids = chunk.map(id => `gid://shopify/ProductVariant/${id}`);
    const query = `
      query GetCosts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            inventoryItem { unitCost { amount } }
          }
        }
      }`;
    const resp = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { ids: gids } }),
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    if (data.errors) continue;
    for (const node of (data.data?.nodes || [])) {
      if (!node || !node.id) continue;
      const m = node.id.match(/(\d+)$/);
      const numericId = m ? m[1] : null;
      const cost = node.inventoryItem?.unitCost?.amount;
      if (numericId && cost != null) map[numericId] = parseFloat(cost);
    }
  }
  return map;
}

async function fetchShopifyOrders(domain, token, startUTC, endUTC) {
  const FIELDS = 'id,line_items,landing_site,referring_site,source_name,cancelled_at,financial_status,refunds,created_at,current_subtotal_price,note_attributes';
  const start = startUTC.toISOString();
  const end = endUTC.toISOString();
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

// ── Helpers Meta ────────────────────────────────────────────────────────────

async function fetchMetaInsights(accountId, token, datePreset) {
  const fields = 'campaign_id,campaign_name,spend,impressions,clicks,cpc,ctr,frequency,reach,actions,action_values,purchase_roas';
  const url = `https://graph.facebook.com/v19.0/${accountId}/insights?fields=${fields}&date_preset=${datePreset}&level=campaign&limit=200&access_token=${encodeURIComponent(token)}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error('Meta insights: ' + (data?.error?.message || resp.status));
  return data;
}

async function fetchMetaCampaigns(accountId, token) {
  const url = `https://graph.facebook.com/v19.0/${accountId}/campaigns?fields=id,name,status,effective_status,daily_budget,objective&limit=200&access_token=${encodeURIComponent(token)}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) return { data: [] };
  return data;
}

async function fetchMetaAccount(accountId, token) {
  const url = `https://graph.facebook.com/v19.0/${accountId}?fields=currency,name&access_token=${encodeURIComponent(token)}`;
  const resp = await fetch(url);
  const data = await resp.json();
  return resp.ok ? data : { currency: 'USD', name: '' };
}

// ── Date preset → rango en UTC (Santiago) ──────────────────────────────────

function presetToRange(preset) {
  const tz = 'America/Santiago';
  const now = new Date();
  const today = now.toLocaleString('en-CA', { timeZone: tz }).split(',')[0].trim();
  const offsetH = getTzOffsetHours(now, tz);
  const off = String(Math.abs(offsetH)).padStart(2, '0');

  const dayStartUTC = (yyyymmdd) => new Date(yyyymmdd + 'T' + off + ':00:00Z');
  const dayEndUTC = (yyyymmdd) => new Date(dayStartUTC(yyyymmdd).getTime() + 24 * 3600000);
  const addDays = (yyyymmdd, n) => {
    const d = new Date(yyyymmdd + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().split('T')[0];
  };

  let dateFrom, dateTo;
  switch (preset) {
    case 'today':       dateFrom = today; dateTo = today; break;
    case 'yesterday':   dateFrom = addDays(today, -1); dateTo = dateFrom; break;
    case 'last_3d':     dateFrom = addDays(today, -3); dateTo = addDays(today, -1); break;
    case 'last_7d':     dateFrom = addDays(today, -7); dateTo = addDays(today, -1); break;
    case 'last_14d':    dateFrom = addDays(today, -14); dateTo = addDays(today, -1); break;
    case 'last_28d':    dateFrom = addDays(today, -28); dateTo = addDays(today, -1); break;
    case 'last_30d':    dateFrom = addDays(today, -30); dateTo = addDays(today, -1); break;
    case 'last_90d':    dateFrom = addDays(today, -90); dateTo = addDays(today, -1); break;
    case 'this_month':  dateFrom = today.slice(0,7) + '-01'; dateTo = today; break;
    case 'last_month': {
      const d = new Date(today + 'T12:00:00Z');
      d.setUTCDate(0);
      const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0');
      dateTo = `${y}-${m}-${String(d.getUTCDate()).padStart(2,'0')}`;
      dateFrom = `${y}-${m}-01`;
      break;
    }
    default:            dateFrom = addDays(today, -7); dateTo = addDays(today, -1);
  }

  return {
    dateFrom,
    dateTo,
    startUTC: dayStartUTC(dateFrom),
    endUTC:   preset === 'today' ? new Date() : dayEndUTC(dateTo),
  };
}

function getTzOffsetHours(date, tz) {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone: tz });
  return Math.round((new Date(utcStr) - new Date(tzStr)) / 3600000);
}

// ── Recomendaciones ─────────────────────────────────────────────────────────

function generateRecommendations(rows, currency) {
  const isCLP = currency === 'CLP';
  const SPEND_HIGH   = isCLP ? 30000 : 30;
  const SPEND_BURNED = isCLP ? 50000 : 50;
  const recs = [];

  for (const r of rows) {
    if (r.spend === 0) continue;

    if (r.spend > SPEND_BURNED && r.realPurchases === 0) {
      recs.push({
        type: 'burned',
        emoji: '💸',
        priority: 0,
        campaign: r.name,
        title: 'Quemada — sin ventas reales',
        body: `Gasto ${fmtMoney(r.spend, currency)} sin ninguna venta confirmada en Shopify. Revisar urgente.`,
      });
      continue;
    }

    if (r.realRoas !== null && r.realRoas < 1.5 && r.spend > SPEND_HIGH && r.realPurchases < 2) {
      recs.push({
        type: 'turnoff',
        emoji: '🔴',
        priority: 1,
        campaign: r.name,
        title: 'Apagar — ROAS real bajo',
        body: `ROAS real ${r.realRoas.toFixed(2)}x con ${fmtMoney(r.spend, currency)} gastado y solo ${r.realPurchases} ${r.realPurchases === 1 ? 'venta' : 'ventas'}.`,
      });
    }

    if (r.realPurchases > 0 && r.metaPurchases > 0 && r.deltaPct > 0.30) {
      recs.push({
        type: 'underreport',
        emoji: '📉',
        priority: 2,
        campaign: r.name,
        title: 'Pixel/CAPI subreporta',
        body: `Meta marca ${r.metaPurchases} compras pero Shopify tiene ${r.realPurchases} (+${Math.round(r.deltaPct * 100)}%). Revisar evento de compra.`,
      });
    }

    if (r.frequency > 4) {
      recs.push({
        type: 'saturated',
        emoji: '⚠️',
        priority: 3,
        campaign: r.name,
        title: 'Audiencia saturada',
        body: `Frecuencia ${r.frequency.toFixed(1)}x — refrescar creativos o ampliar audiencia.`,
      });
    }

    if (r.realRoas !== null && r.realRoas > 3 && r.realPurchases >= 5 && r.frequency < 2.5) {
      recs.push({
        type: 'scale',
        emoji: '🟢',
        priority: 4,
        campaign: r.name,
        title: 'Escalar — ROAS sostenido',
        body: `ROAS real ${r.realRoas.toFixed(2)}x con ${r.realPurchases} ventas y frecuencia ${r.frequency.toFixed(1)}x. Subir presupuesto 30% e ir monitoreando.`,
      });
    }
  }

  return recs.sort((a, b) => a.priority - b.priority);
}

function fmtMoney(n, currency) {
  if (n == null) return '—';
  const sym = currency === 'CLP' ? '$' : currency === 'USD' ? 'US$' : (currency || '') + ' ';
  const decs = currency === 'CLP' ? 0 : 2;
  return sym + Number(n).toLocaleString('es-CL', { minimumFractionDigits: decs, maximumFractionDigits: decs });
}

// ── Response helpers ────────────────────────────────────────────────────────

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
