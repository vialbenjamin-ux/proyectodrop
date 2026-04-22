exports.handler = async function () {
  const token = process.env.SHOPIFY_TOKEN;
  const domain = process.env.SHOPIFY_DOMAIN;

  if (!token || !domain) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Faltan credenciales de Shopify en las variables de entorno' })
    };
  }

  // Inicio del día en UTC (Shopify usa UTC)
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

  const url = `https://${domain}/admin/api/2024-10/orders.json?status=any&created_at_min=${todayStart}&limit=250&fields=id,line_items,landing_site,source_name,created_at`;

  let response;
  try {
    response = await fetch(url, {
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

  const bySource = {};
  let totalProducts = 0;

  for (const order of orders) {
    const landingSite = order.landing_site || '';
    let utmSource = 'directo';

    try {
      const parsedUrl = new URL(landingSite.startsWith('http') ? landingSite : 'https://x.com' + landingSite);
      const param = parsedUrl.searchParams.get('utm_source');
      if (param) utmSource = param.toLowerCase();
    } catch (_) {}

    const qty = (order.line_items || []).reduce((sum, item) => sum + (item.quantity || 0), 0);

    if (!bySource[utmSource]) bySource[utmSource] = { orders: 0, products: 0 };
    bySource[utmSource].orders += 1;
    bySource[utmSource].products += qty;
    totalProducts += qty;
  }

  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      date: todayStart.split('T')[0],
      totalOrders: orders.length,
      totalProducts,
      bySource,
      updatedAt: new Date().toISOString()
    })
  };
};
