// DEBUG endpoint 2: buscar en cache de ordenes qué campos vienen para product_id=70842
// y qué warehouse/attribute/variant info se puede sacar.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  const qs = event.queryStringParameters || {};
  const id = String(qs.id || '').trim();
  const token = process.env.DROPI_TOKEN_CL;
  if (!token) return respond(500, { error: 'Falta DROPI_TOKEN_CL' });
  const headers = { 'dropi-integration-key': token, 'Content-Type': 'application/json', 'User-Agent': 'BKDROP-Sync/1.0' };

  // Fetch 500 ordenes recientes
  let allOrders = [];
  for (let start = 0; start < 500; start += 100) {
    const r = await fetch('https://api.dropi.cl/integrations/orders/myorders?start=' + start + '&result_number=100', { headers });
    if (!r.ok) break;
    const d = await r.json();
    const objs = d.objects || [];
    if (objs.length === 0) break;
    allOrders = allOrders.concat(objs);
    await new Promise(res => setTimeout(res, 200));
  }

  // Buscar orderdetails con product_id = id
  const matches = [];
  for (const o of allOrders) {
    for (const od of (o.orderdetails || [])) {
      if (od.product && String(od.product.id) === id) {
        matches.push({
          order_id: o.id,
          warehouse_id: o.warehouse_id,
          shop_id: o.shop_id,
          orderdetail_keys: Object.keys(od),
          orderdetail: od,   // TODA la info
        });
        if (matches.length >= 3) break;
      }
    }
    if (matches.length >= 3) break;
  }

  return respond(200, {
    productId: id,
    matchesFound: matches.length,
    totalOrdersScanned: allOrders.length,
    matches,
  });
};

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
