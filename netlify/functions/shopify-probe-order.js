// TEMPORAL: trae 1 orden Shopify con etiqueta "Dropi Sync Error" completa
// (sin filtrar ningun campo) para descubrir donde Releasit COD Form guarda
// los datos del cliente.

exports.handler = async function (event) {
  const tenant = String(((event.queryStringParameters || {}).tenant || 'chile')).toLowerCase();
  const isGT = tenant === 'gt';
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Falta credencial Shopify' });

  const sinceUTC = new Date(Date.now() - 48 * 3600 * 1000);
  const url = 'https://' + domain + '/admin/api/2024-10/orders.json'
    + '?status=any'
    + '&created_at_min=' + sinceUTC.toISOString()
    + '&limit=50';

  try {
    const resp = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) return respond(502, { error: 'Shopify ' + resp.status });
    const data = await resp.json();
    const orders = data.orders || [];
    // Buscar 1 orden con etiqueta "Dropi Sync Error"
    const target = orders.find(o => {
      const tags = String(o.tags || '').toLowerCase();
      return tags.includes('dropi sync error');
    });
    if (!target) {
      return respond(200, { error: 'No hay ordenes con Dropi Sync Error en las ultimas 48h', totalOrders: orders.length });
    }
    return respond(200, { sampleOrder: target });
  } catch (err) {
    return respond(502, { error: err.message });
  }
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload, null, 2),
  };
}
