// TEMPORAL: probar si Dropi permite editar precio/total de una orden existente
// via PUT /integrations/orders/myorders/{id}
//
// Uso: GET /.netlify/functions/dropi-probe-update?orderId=X&testBody=1|2|3

exports.handler = async (event) => {
  const token = process.env.DROPI_TOKEN_CL;
  if (!token) return respond(500, { error: 'Falta DROPI_TOKEN_CL' });

  const qs = event.queryStringParameters || {};
  const orderId = qs.orderId;
  const testBody = parseInt(qs.testBody || '1', 10);
  if (!orderId) return respond(400, { error: 'Falta orderId. Ej: ?orderId=7259023&testBody=1' });

  const base = 'https://api.dropi.cl';
  const headers = {
    'dropi-integration-key': token,
    'Content-Type': 'application/json',
    'User-Agent': 'BKDROP-Probe/1.0',
  };

  // Primero, traer la orden actual para ver estructura
  let currentOrder = null;
  try {
    const listResp = await fetch(base + '/integrations/orders/myorders?start=0&result_number=100', {
      method: 'GET', headers,
    });
    const listData = JSON.parse(await listResp.text());
    currentOrder = (listData.objects || []).find(o => String(o.id) === String(orderId));
  } catch (e) { /* seguir */ }

  // Bodies candidatos para probar edicion
  const bodies = {
    1: { total_order: 34990 },
    2: { total_order: 34990, products: [{ id: 92587, product_id: 92587, quantity: 3, price: 11660 }] },
    3: { orderdetails: [{ product_id: 92587, quantity: 3, price: 11660 }] },
    4: { products: [{ id: 92587, product_id: 92587, quantity: 3, price: 11660 }] },
  };
  const body = bodies[testBody] || bodies[1];

  try {
    const resp = await fetch(base + '/integrations/orders/myorders/' + orderId, {
      method: 'PUT', headers, body: JSON.stringify(body)
    });
    const txt = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt.slice(0, 500) }; }
    return respond(200, {
      testBody,
      sentBody: body,
      orderIdTargeted: orderId,
      currentOrderStatus: currentOrder ? currentOrder.status : 'no-encontrada',
      currentTotal: currentOrder ? currentOrder.total_order : null,
      currentProducts: currentOrder && currentOrder.orderdetails ? currentOrder.orderdetails.map(od => ({ product_id: od.product_id, quantity: od.quantity, name: od.product && od.product.name })) : null,
      httpStatus: resp.status,
      response: parsed,
    });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload, null, 2),
  };
}
