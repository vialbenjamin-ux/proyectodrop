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

  // Inicio del día en hora Chile (UTC-3)
  const CHILE_OFFSET = 3;
  const now = new Date();
  const chileNow = new Date(now.getTime() - CHILE_OFFSET * 3600000);
  const chileStartOfDay = new Date(Date.UTC(
    chileNow.getUTCFullYear(),
    chileNow.getUTCMonth(),
    chileNow.getUTCDate()
  ));
  const todayStartUTC = new Date(chileStartOfDay.getTime() + CHILE_OFFSET * 3600000);
  const dateLabel = chileStartOfDay.toISOString().split('T')[0];

  // Paginación: obtener todos los pedidos del día
  let allOrders = [];
  let pageUrl = `https://${domain}/admin/api/2024-10/orders.json?status=any&created_at_min=${todayStartUTC.toISOString()}&limit=250&fields=id,line_items,landing_site,source_name,created_at`;

  while (pageUrl) {
    let response;
    try {
      response = await fetch(pageUrl, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
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
    const orders = data.orders || [];
    allOrders = allOrders.concat(orders);

    // Paginación con Link header
    const linkHeader = response.headers.get('Link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    pageUrl = nextMatch ? nextMatch[1] : null;
  }

  // Procesar pedidos
  const bySource = {};
  const byProductSource = {};
  let totalProducts = 0;

  for (const order of allOrders) {
    const landingSite = order.landing_site || '';
    let utmSource = 'directo';

    try {
      const parsed = new URL(landingSite.startsWith('http') ? landingSite : 'https://x.com' + landingSite);
      const param = parsed.searchParams.get('utm_source');
      if (param) utmSource = param.toLowerCase();
    } catch (_) {}

    // Totales por fuente
    if (!bySource[utmSource]) bySource[utmSource] = { orders: 0, products: 0 };
    bySource[utmSource].orders += 1;

    // Detalle por producto y fuente
    for (const item of order.line_items || []) {
      const qty = item.quantity || 0;
      const productName = item.title || 'Sin nombre';
      const variant = item.variant_title || '';
      const key = `${productName}||${variant}||${utmSource}`;

      if (!byProductSource[key]) {
        byProductSource[key] = {
          product: productName,
          variant,
          source: utmSource,
          qty: 0
        };
      }
      byProductSource[key].qty += qty;
      bySource[utmSource].products += qty;
      totalProducts += qty;
    }
  }

  const details = Object.values(byProductSource).sort((a, b) => b.qty - a.qty);

  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      date: dateLabel,
      totalOrders: allOrders.length,
      totalProducts,
      bySource,
      details,
      updatedAt: new Date().toISOString()
    })
  };
};
