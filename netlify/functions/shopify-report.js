exports.handler = async function () {
  const token = process.env.SHOPIFY_TOKEN;
  const domain = process.env.SHOPIFY_DOMAIN;

  if (!token || !domain) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Faltan credenciales de Shopify' })
    };
  }

  const CHILE_OFFSET = 3;
  const now = new Date();
  const chileNow = new Date(now.getTime() - CHILE_OFFSET * 3600000);
  const chileStartOfDay = new Date(Date.UTC(
    chileNow.getUTCFullYear(), chileNow.getUTCMonth(), chileNow.getUTCDate()
  ));
  const todayStartUTC = new Date(chileStartOfDay.getTime() + CHILE_OFFSET * 3600000);
  const dateLabel = chileStartOfDay.toISOString().split('T')[0];

  let allOrders = [];
  let pageUrl = `https://${domain}/admin/api/2024-10/orders.json?status=any&created_at_min=${todayStartUTC.toISOString()}&limit=250&fields=id,line_items,landing_site,referring_site,source_name,cancelled_at,financial_status,refunds,created_at`;

  while (pageUrl) {
    let response;
    try {
      response = await fetch(pageUrl, {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
      });
    } catch (err) {
      return {
        statusCode: 502,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'No se pudo conectar con Shopify', detail: err.message })
      };
    }

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Error de Shopify API', status: response.status })
      };
    }

    const data = await response.json();
    const orders = (data.orders || []).filter(o =>
      !o.cancelled_at && o.financial_status !== 'voided'
    );
    allOrders = allOrders.concat(orders);

    const linkHeader = response.headers.get('Link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    pageUrl = nextMatch ? nextMatch[1] : null;
  }

  function extractUtm(order) {
    // Intentar landing_site primero, luego referring_site
    for (const field of [order.landing_site, order.referring_site]) {
      if (!field) continue;
      try {
        const url = new URL(field.startsWith('http') ? field : 'https://x.com' + field);
        const src = url.searchParams.get('utm_source');
        if (src) return src.toLowerCase();
      } catch (_) {}
    }
    // Fallback: source_name (web, pos, iphone, android, etc.)
    const sn = (order.source_name || '').toLowerCase();
    if (sn && sn !== 'web') return sn;
    return 'directo';
  }

  // Calcular unidades netas (descontando reembolsos)
  function netQty(order, lineItemId, grossQty) {
    if (!order.refunds) return grossQty;
    let refunded = 0;
    for (const refund of order.refunds) {
      for (const ri of (refund.refund_line_items || [])) {
        if (ri.line_item_id === lineItemId) refunded += ri.quantity || 0;
      }
    }
    return grossQty - refunded;
  }

  const bySource = {};
  const byProduct = {};
  let totalProducts = 0;
  let totalOrders = allOrders.length;

  for (const order of allOrders) {
    const utmSource = extractUtm(order);

    if (!bySource[utmSource]) bySource[utmSource] = { orders: 0, products: 0 };
    bySource[utmSource].orders += 1;

    for (const item of order.line_items || []) {
      const qty = netQty(order, item.id, item.quantity || 0);
      if (qty <= 0) continue;

      const productName = item.title || 'Sin nombre';
      // Ignorar "Default Title" como variante (es el placeholder de Shopify)
      const variant = (item.variant_title && item.variant_title !== 'Default Title')
        ? item.variant_title : '';
      const key = productName + (variant ? `__${variant}` : '');

      if (!byProduct[key]) byProduct[key] = { product: productName, variant, qty: 0, bySource: {} };
      byProduct[key].qty += qty;
      byProduct[key].bySource[utmSource] = (byProduct[key].bySource[utmSource] || 0) + qty;

      bySource[utmSource].products += qty;
      totalProducts += qty;
    }
  }

  const products = Object.values(byProduct).sort((a, b) => b.qty - a.qty);

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: dateLabel,
      totalOrders,
      totalProducts,
      bySource,
      products,
      updatedAt: new Date().toISOString()
    })
  };
};
