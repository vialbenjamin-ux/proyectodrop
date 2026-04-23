exports.handler = async function (event) {
  const token = process.env.SHOPIFY_TOKEN;
  const domain = process.env.SHOPIFY_DOMAIN;

  if (!token || !domain) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Faltan credenciales de Shopify' })
    };
  }

  // Determina el offset UTC de Santiago dinamicamente (maneja DST automaticamente)
  function getSantiagoOffsetHours(date) {
    const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
    const santiStr = date.toLocaleString('en-US', { timeZone: 'America/Santiago' });
    return (new Date(utcStr) - new Date(santiStr)) / 3600000;
  }

  const now = new Date();
  const offsetHours = getSantiagoOffsetHours(now);

  let targetDate = (event.queryStringParameters || {}).date;
  let todayStartUTC, todayEndUTC, dateLabel;

  if (targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    const refDate = new Date(targetDate + 'T12:00:00Z');
    const off = getSantiagoOffsetHours(refDate);
    todayStartUTC = new Date(targetDate + 'T' + String(off).padStart(2, '0') + ':00:00Z');
    todayEndUTC = new Date(todayStartUTC.getTime() + 24 * 3600000);
    dateLabel = targetDate;
  } else {
    const santiStr = now.toLocaleString('en-CA', { timeZone: 'America/Santiago' });
    const santiDate = santiStr.split(',')[0].trim();
    dateLabel = santiDate;
    todayStartUTC = new Date(santiDate + 'T' + String(offsetHours).padStart(2, '0') + ':00:00Z');
    todayEndUTC = null;
  }

  let allOrders = [];
  let pageUrl = 'https://' + domain + '/admin/api/2024-10/orders.json?status=any'
    + '&created_at_min=' + todayStartUTC.toISOString()
    + (todayEndUTC ? '&created_at_max=' + todayEndUTC.toISOString() : '')
    + '&limit=250&fields=id,line_items,landing_site,referring_site,source_name,cancelled_at,financial_status,refunds,created_at';

  while (pageUrl) {
    let response;
    try {
      response = await fetch(pageUrl, {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
      });
    } catch (err) {
      return { statusCode: 502, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
    }
    if (!response.ok) {
      return { statusCode: response.status, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Shopify API error' }) };
    }
    const data = await response.json();
    const filtered = (data.orders || []).filter(o =>
      !o.cancelled_at && o.financial_status !== 'voided'
    );
    allOrders = allOrders.concat(filtered);
    const linkHeader = response.headers.get('Link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    pageUrl = nextMatch ? nextMatch[1] : null;
  }

  function extractUtm(order) {
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

  const bySource = {};
  const byProduct = {};
  let totalProducts = 0, totalRevenue = 0;

  for (const order of allOrders) {
    const src = extractUtm(order);
    if (!bySource[src]) bySource[src] = { orders: 0, products: 0, revenue: 0 };
    bySource[src].orders += 1;

    for (const item of order.line_items || []) {
      const origQty = item.quantity || 0;
      const refundedQty = getRefundedQty(order, item.id);
      const netQty = origQty - refundedQty;
      if (netQty <= 0) continue;

      const unitPrice = parseFloat(item.price || 0);
      const totalDiscount = parseFloat(item.total_discount || 0);
      const unitDiscount = origQty > 0 ? totalDiscount / origQty : 0;
      const revenue = (unitPrice - unitDiscount) * netQty;

      const name = item.title || 'Sin nombre';
      const variant = (item.variant_title && item.variant_title !== 'Default Title') ? item.variant_title : '';
      const key = name + (variant ? '__' + variant : '');

      if (!byProduct[key]) byProduct[key] = { product: name, variant, orders: 0, qty: 0, revenue: 0, bySource: {} };
      byProduct[key].orders += 1;
      byProduct[key].qty += netQty;
      byProduct[key].revenue += revenue;
      byProduct[key].bySource[src] = (byProduct[key].bySource[src] || 0) + 1;

      bySource[src].products += netQty;
      bySource[src].revenue += revenue;
      totalProducts += netQty;
      totalRevenue += revenue;
    }
  }

  const products = Object.values(byProduct).sort((a, b) => b.qty - a.qty);

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: dateLabel,
      offsetHours,
      totalOrders: allOrders.length,
      totalProducts,
      totalRevenue,
      bySource,
      products,
      updatedAt: new Date().toISOString()
    })
  };
};
