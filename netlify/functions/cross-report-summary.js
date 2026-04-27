// Versión liviana de cross-report. Solo trae los agregados básicos (gasto,
// órdenes Shopify, revenue, costos) para alimentar el comparativo de períodos
// sin gastar requests a Meta en metadata de campañas / by-day / etc.
//
// Endpoint: GET /.netlify/functions/cross-report-summary?account_id=act_xxx&since=YYYY-MM-DD&until=YYYY-MM-DD
// Responde: { spend, orders, revenue, totalCost, hasAnyCost, currency }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET')      return respond(405, { error: 'Method not allowed' });

  const shopifyDomain = process.env.SHOPIFY_DOMAIN;
  const shopifyToken  = process.env.SHOPIFY_TOKEN;
  const metaToken     = process.env.META_ACCESS_TOKEN;
  if (!shopifyDomain || !shopifyToken) return respond(500, { error: 'Faltan credenciales de Shopify' });
  if (!metaToken) return respond(500, { error: 'Falta META_ACCESS_TOKEN' });

  const params = event.queryStringParameters || {};
  const accountId = (params.account_id || '').trim();
  if (!/^act_\d+$/.test(accountId)) return respond(400, { error: 'account_id inválido' });

  const since = params.since;
  const until = params.until;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    return respond(400, { error: 'since/until inválidos (YYYY-MM-DD)' });
  }

  const tz = 'America/Santiago';
  const offsetH = getTzOffsetHours(new Date(), tz);
  const off = String(Math.abs(offsetH)).padStart(2, '0');
  const startUTC = new Date(since + 'T' + off + ':00:00Z');
  const endUTC = new Date(new Date(until + 'T' + off + ':00:00Z').getTime() + 24 * 3600000);

  try {
    const [orders, metaInsights, accountInfo] = await Promise.all([
      fetchShopifyOrders(shopifyDomain, shopifyToken, startUTC, endUTC),
      fetchMetaSpend(accountId, metaToken, since, until),
      fetchAccountInfo(accountId, metaToken),
    ]);

    // Recolectar variant IDs para costos
    const variantIds = new Set();
    for (const o of orders) {
      for (const li of (o.line_items || [])) {
        if (li.variant_id) variantIds.add(String(li.variant_id));
      }
    }
    let costsByVariant = {};
    if (variantIds.size > 0) {
      try { costsByVariant = await fetchVariantCosts(shopifyDomain, shopifyToken, [...variantIds]); }
      catch {}
    }

    // Agregar revenue + cost de las órdenes vía Meta
    let orderCount = 0, revenue = 0, totalCost = 0, hasAnyCost = false;
    for (const o of orders) {
      if (extractUtmSource(o) !== 'meta') continue;
      orderCount += 1;
      revenue += parseFloat(o.current_subtotal_price || 0);
      const items = o.line_items || [];
      for (const it of items) {
        const refQty = getRefundedQty(o, it.id);
        const netQty = (it.quantity || 0) - refQty;
        if (netQty <= 0) continue;
        const variantId = it.variant_id ? String(it.variant_id) : null;
        if (variantId && costsByVariant[variantId] != null) {
          totalCost += costsByVariant[variantId] * netQty;
          hasAnyCost = true;
        }
      }
    }

    return respond(200, {
      spend: metaInsights.spend,
      metaPurchases: metaInsights.metaPurchases,
      metaPurchaseValue: metaInsights.metaPurchaseValue,
      orders: orderCount,
      revenue,
      totalCost: hasAnyCost ? totalCost : null,
      currency: accountInfo.currency,
      since, until,
    });
  } catch (err) {
    return respond(500, { error: err.message || 'Error en cross-report-summary' });
  }
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractUtmSource(order) {
  const attrs = order.note_attributes || [];
  const utmAttr = attrs.find(a => a.name && a.name.toLowerCase().replace(/_/g, ' ') === 'utm source');
  if (utmAttr && utmAttr.value) {
    const s = utmAttr.value.toLowerCase().trim();
    if (['facebook', 'instagram', 'fb', 'meta'].includes(s)) return 'meta';
    return s;
  }
  for (const f of [order.landing_site, order.referring_site]) {
    if (!f) continue;
    try {
      const url = new URL(f.startsWith('http') ? f : 'https://x.com' + f);
      const src = url.searchParams.get('utm_source');
      if (src) {
        const s = src.toLowerCase();
        if (['facebook', 'instagram', 'fb', 'meta'].includes(s)) return 'meta';
        return s;
      }
      if (url.searchParams.get('fbclid')) return 'meta';
    } catch {}
  }
  const sn = (order.source_name || '').toLowerCase().trim();
  if (['facebook', 'instagram', 'fb', 'meta'].includes(sn)) return 'meta';
  return 'directo';
}

function getRefundedQty(order, lineItemId) {
  if (!order.refunds) return 0;
  let qty = 0;
  for (const r of order.refunds)
    for (const ri of (r.refund_line_items || []))
      if (ri.line_item_id === lineItemId) qty += ri.quantity || 0;
  return qty;
}

async function fetchShopifyOrders(domain, token, startUTC, endUTC) {
  const FIELDS = 'id,line_items,landing_site,referring_site,source_name,cancelled_at,financial_status,refunds,created_at,current_subtotal_price,note_attributes';
  let url = `https://${domain}/admin/api/2024-10/orders.json?status=any&created_at_min=${startUTC.toISOString()}&created_at_max=${endUTC.toISOString()}&limit=250&fields=${FIELDS}`;
  let all = [];
  while (url) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
    if (!resp.ok) throw new Error('Shopify API error ' + resp.status);
    const data = await resp.json();
    all = all.concat((data.orders || []).filter(o => !o.cancelled_at && o.financial_status !== 'voided'));
    const link = resp.headers.get('Link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return all;
}

async function fetchMetaSpend(accountId, token, since, until) {
  const fields = 'spend,actions,action_values';
  const tr = encodeURIComponent(JSON.stringify({ since, until }));
  const url = `https://graph.facebook.com/v19.0/${accountId}/insights?fields=${fields}&time_range=${tr}&level=account&access_token=${encodeURIComponent(token)}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error('Meta: ' + (data?.error?.message || resp.status));
  const r = (data.data || [])[0] || {};
  const find = (arr, type) => (arr || []).find(a => a.action_type === type);
  const pAct = find(r.actions, 'purchase') || find(r.actions, 'omni_purchase');
  const pVal = find(r.action_values, 'purchase') || find(r.action_values, 'omni_purchase');
  return {
    spend: parseFloat(r.spend || 0),
    metaPurchases: pAct ? parseFloat(pAct.value) : 0,
    metaPurchaseValue: pVal ? parseFloat(pVal.value) : 0,
  };
}

async function fetchAccountInfo(accountId, token) {
  const url = `https://graph.facebook.com/v19.0/${accountId}?fields=currency&access_token=${encodeURIComponent(token)}`;
  const resp = await fetch(url);
  const data = await resp.json();
  return resp.ok ? data : { currency: 'USD' };
}

async function fetchVariantCosts(domain, token, variantIds) {
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
      if (!node || !node.id) continue;
      const m = node.id.match(/(\d+)$/);
      if (m && node.inventoryItem?.unitCost?.amount != null) {
        map[m[1]] = parseFloat(node.inventoryItem.unitCost.amount);
      }
    }
  }
  return map;
}

function getTzOffsetHours(date, tz) {
  const u = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const t = date.toLocaleString('en-US', { timeZone: tz });
  return Math.round((new Date(u) - new Date(t)) / 3600000);
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
