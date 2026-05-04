exports.handler = async function (event) {
  const tenant = String(((event.queryStringParameters || {}).tenant || 'chile')).toLowerCase();
  const isGT = (tenant === 'gt');
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;

  if (!token || !domain) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Faltan credenciales de Shopify' + (isGT ? ' GT' : '') })
    };
  }

  function getSantiagoOffsetHours(date) {
    const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
    const santiStr = date.toLocaleString('en-US', { timeZone: 'America/Santiago' });
    return (new Date(utcStr) - new Date(santiStr)) / 3600000;
  }

  function getSantiagoDate(isoString) {
    return new Date(isoString).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
  }

  function extractUtm(order) {
    const attrs = order.note_attributes || [];
    const utmAttr = attrs.find(a => a.name && a.name.toLowerCase() === 'utm source');
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

  function getRefundedQty(order, lineItemId) {
    if (!order.refunds) return 0;
    let qty = 0;
    for (const refund of order.refunds)
      for (const ri of (refund.refund_line_items || []))
        if (ri.line_item_id === lineItemId) qty += ri.quantity || 0;
    return qty;
  }

  function processOrders(orders, includeProducts) {
    const bySource = {};
    const byProduct = {};
    let totalProducts = 0, totalRevenue = 0;

    for (const order of orders) {
      const src = extractUtm(order);
      if (!bySource[src]) bySource[src] = { orders: 0, products: 0, revenue: 0 };
      bySource[src].orders += 1;

      const orderGross = (order.line_items || []).reduce((sum, item) => {
        const refQty = getRefundedQty(order, item.id);
        const netQty = (item.quantity || 0) - refQty;
        return sum + (netQty > 0 ? parseFloat(item.price || 0) * netQty : 0);
      }, 0);
      const orderRevenue = parseFloat(order.current_subtotal_price || 0);

      for (const item of order.line_items || []) {
        const origQty = item.quantity || 0;
        const refundedQty = getRefundedQty(order, item.id);
        const netQty = origQty - refundedQty;
        if (netQty <= 0) continue;

        const itemGross = parseFloat(item.price || 0) * netQty;
        const revenue = orderGross > 0 ? (itemGross / orderGross) * orderRevenue : 0;

        bySource[src].products += netQty;
        bySource[src].revenue += revenue;
        totalProducts += netQty;
        totalRevenue += revenue;

        if (includeProducts) {
          const name = item.title || 'Sin nombre';
          const variant = (item.variant_title && item.variant_title !== 'Default Title') ? item.variant_title : '';
          const key = name + (variant ? '__' + variant : '');
          if (!byProduct[key]) byProduct[key] = { product: name, variant, orders: 0, qty: 0, revenue: 0, bySource: {} };
          byProduct[key].orders += 1;
          byProduct[key].qty += netQty;
          byProduct[key].revenue += revenue;
          byProduct[key].bySource[src] = (byProduct[key].bySource[src] || 0) + 1;
        }
      }
    }

    return { bySource, byProduct, totalProducts, totalRevenue };
  }

  const FIELDS = 'id,line_items,landing_site,referring_site,source_name,cancelled_at,financial_status,refunds,created_at,current_subtotal_price,note_attributes';
  // Para ayer (comparación) solo necesitamos contar y sumar revenue.
  // Bajamos el payload ~10x evitando line_items/refunds/etc.
  const FIELDS_LIGHT = 'id,cancelled_at,financial_status,current_subtotal_price';

  function buildUrl(startUTC, endUTC, light) {
    return 'https://' + domain + '/admin/api/2024-10/orders.json?status=any'
      + '&created_at_min=' + startUTC.toISOString()
      + (endUTC ? '&created_at_max=' + endUTC.toISOString() : '')
      + '&limit=250&fields=' + (light ? FIELDS_LIGHT : FIELDS);
  }

  async function fetchAllOrders(startUrl) {
    let allOrders = [];
    let pageUrl = startUrl;
    while (pageUrl) {
      let response;
      try {
        response = await fetch(pageUrl, {
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        throw new Error(err.message);
      }
      if (!response.ok) throw new Error('Shopify API error ' + response.status);
      const data = await response.json();
      const filtered = (data.orders || []).filter(o =>
        !o.cancelled_at && o.financial_status !== 'voided'
      );
      allOrders = allOrders.concat(filtered);
      const linkHeader = response.headers.get('Link') || '';
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = nextMatch ? nextMatch[1] : null;
    }
    return allOrders;
  }

  function sumRevenue(orders) {
    return orders.reduce((s, o) => s + parseFloat(o.current_subtotal_price || 0), 0);
  }

  const now = new Date();
  const qs = event.queryStringParameters || {};

  const dateFrom = qs.date_from;
  const dateTo   = qs.date_to;
  const isRange  = dateFrom && dateTo && dateFrom !== dateTo
    && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) && /^\d{4}-\d{2}-\d{2}$/.test(dateTo);

  if (isRange) {
    const offFrom    = getSantiagoOffsetHours(new Date(dateFrom + 'T12:00:00Z'));
    const rangeStart = new Date(dateFrom + 'T' + String(offFrom).padStart(2, '0') + ':00:00Z');
    const offTo      = getSantiagoOffsetHours(new Date(dateTo + 'T12:00:00Z'));
    const rangeEnd   = new Date(
      new Date(dateTo + 'T' + String(offTo).padStart(2, '0') + ':00:00Z').getTime() + 24 * 3600000
    );

    let allOrders;
    try {
      allOrders = await fetchAllOrders(buildUrl(rangeStart, rangeEnd));
    } catch (err) {
      return { statusCode: 502, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
    }

    const dayMap = {};
    for (const order of allOrders) {
      const d = getSantiagoDate(order.created_at);
      if (!dayMap[d]) dayMap[d] = [];
      dayMap[d].push(order);
    }

    const dates = Object.keys(dayMap).sort();
    const totals = { totalOrders: 0, totalProducts: 0, totalRevenue: 0, bySource: {} };
    const days = dates.map(function(date) {
      const dayOrders = dayMap[date];
      const result = processOrders(dayOrders, false);
      const bySource = result.bySource;
      const totalProducts = result.totalProducts;
      const totalRevenue = result.totalRevenue;
      totals.totalOrders   += dayOrders.length;
      totals.totalProducts += totalProducts;
      totals.totalRevenue  += totalRevenue;
      for (const src of Object.keys(bySource)) {
        const sv = bySource[src];
        if (!totals.bySource[src]) totals.bySource[src] = { orders: 0, products: 0, revenue: 0 };
        totals.bySource[src].orders   += sv.orders;
        totals.bySource[src].products += sv.products;
        totals.bySource[src].revenue  += sv.revenue;
      }
      return { date, totalOrders: dayOrders.length, totalProducts, totalRevenue, bySource };
    });

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'range', dateFrom, dateTo, days, totals, updatedAt: new Date().toISOString() })
    };
  }

  // Single-day mode
  const offsetHours = getSantiagoOffsetHours(now);
  const santiDateToday = now.toLocaleString('en-CA', { timeZone: 'America/Santiago' }).split(',')[0].trim();
  let targetDate = qs.date;
  let todayStartUTC, todayEndUTC, dateLabel;

  if (targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    const refDate = new Date(targetDate + 'T12:00:00Z');
    const off = getSantiagoOffsetHours(refDate);
    todayStartUTC = new Date(targetDate + 'T' + String(off).padStart(2, '0') + ':00:00Z');
    // Si la fecha seleccionada es hoy en Santiago, ventana abierta (modo vivo)
    todayEndUTC = (targetDate === santiDateToday)
      ? null
      : new Date(todayStartUTC.getTime() + 24 * 3600000);
    dateLabel = targetDate;
  } else {
    dateLabel     = santiDateToday;
    todayStartUTC = new Date(santiDateToday + 'T' + String(offsetHours).padStart(2, '0') + ':00:00Z');
    todayEndUTC   = null;
  }

  // Fetch hoy + ayer en paralelo. La comparación con día anterior a la misma
  // hora es secundaria — si falla, devolvemos solo el día actual.
  const yesterdayStartUTC = new Date(todayStartUTC.getTime() - 24 * 3600000);
  const yesterdayEndUTC   = todayEndUTC
    ? new Date(todayEndUTC.getTime() - 24 * 3600000)
    : new Date(now.getTime() - 24 * 3600000);

  const [todayResult, yesterdayResult] = await Promise.allSettled([
    fetchAllOrders(buildUrl(todayStartUTC, todayEndUTC, false)),
    fetchAllOrders(buildUrl(yesterdayStartUTC, yesterdayEndUTC, true)),
  ]);

  if (todayResult.status === 'rejected') {
    return { statusCode: 502, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: todayResult.reason?.message || 'Error fetching orders' }) };
  }
  const allOrders = todayResult.value;
  const proc = processOrders(allOrders, true);
  const products = Object.values(proc.byProduct).sort(function(a, b) { return b.qty - a.qty; });

  let previousDay = null;
  if (yesterdayResult.status === 'fulfilled') {
    const yOrders = yesterdayResult.value;
    previousDay = {
      totalOrders: yOrders.length,
      totalRevenue: sumRevenue(yOrders)
    };
  }

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: dateLabel,
      offsetHours,
      totalOrders: allOrders.length,
      totalProducts: proc.totalProducts,
      totalRevenue: proc.totalRevenue,
      bySource: proc.bySource,
      products,
      previousDay,
      updatedAt: new Date().toISOString()
    })
  };
};
