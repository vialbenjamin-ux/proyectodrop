// Fetch ordenes de Dropi Chile. El frontend llama este endpoint,
// escribe el resultado a Firestore (coleccion bkdrop_dropi_orders).
//
// SOP referencia: seccion 1.2 + 4 (cache de ordenes).
// - Token: dropi-integration-key: <DROPI_TOKEN_CL> (tipo CHATCENTER).
// - Base Chile: https://api.dropi.cl
// - Rate limit: "Too Many Attempts" bloquea por horas. Un sync incremental basta.
//
// Endpoint: GET /.netlify/functions/dropi-fetch?start=0&result_number=100
//   start: offset de paginacion (default 0)
//   result_number: page size, max 100 (default 100)
//
// Respuesta: { orders: [...], count, hasMore }
// Cada orden viene COMPACTADA a los campos del SOP para no explotar Firestore.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const token = process.env.DROPI_TOKEN_CL;
  if (!token) return respond(500, { error: 'Falta DROPI_TOKEN_CL en env' });

  const qs = event.queryStringParameters || {};
  const start = parseInt(qs.start || '0', 10);
  const resultNumber = Math.min(parseInt(qs.result_number || '100', 10), 100);

  const url = 'https://api.dropi.cl/integrations/orders/myorders'
    + '?start=' + start
    + '&result_number=' + resultNumber;

  let raw;
  try {
    const resp = await fetch(url, {
      headers: {
        'dropi-integration-key': token,
        'Content-Type': 'application/json',
        'User-Agent': 'BKDROP-Sync/1.0',
      },
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return respond(502, { error: 'Dropi API ' + resp.status + ': ' + txt.slice(0, 300) });
    }
    raw = await resp.json();
  } catch (err) {
    return respond(502, { error: 'Fetch Dropi fail: ' + (err.message || 'unknown') });
  }

  // Dropi devuelve { objects: [...], total: N } o similar segun version.
  // Toleramos ambos.
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw.objects) ? raw.objects
    : Array.isArray(raw.data) ? raw.data
    : Array.isArray(raw.orders) ? raw.orders
    : [];

  // Compactar al esquema del SOP seccion 4
  const orders = list.map(o => compact(o));

  return respond(200, {
    orders,
    count: orders.length,
    hasMore: orders.length === resultNumber,
    start,
    fetchedAt: new Date().toISOString(),
  });
};

// Compacta una orden de Dropi al esquema del SOP seccion 4:
// { id, status, created (YYYY-MM-DD), producto, productoId, ciudad, provincia,
//   transportadora, flete, total, guia, dir (90 chars), fin (updated_at YYYY-MM-DD) }
function compact(o) {
  const productName = firstOf(o, ['name_product', 'product_name', 'product', 'producto', 'products_name', 'name']);
  const productId   = firstOf(o, ['id_product', 'product_id', 'productoId']);
  const carrier     = firstOf(o, ['transport', 'transportadora', 'carrier', 'shipping_company', 'transport_service']);
  const guia        = firstOf(o, ['guide', 'guia', 'tracking_number', 'tracking', 'transport_guide']);
  const city        = firstOf(o, ['city', 'ciudad', 'city_name']);
  const state       = firstOf(o, ['state', 'provincia', 'department', 'region', 'department_name']);
  const status      = firstOf(o, ['status', 'estado', 'order_status']);
  const total       = numOf(firstOf(o, ['total_order', 'total', 'amount', 'monto', 'total_price']));
  const flete       = numOf(firstOf(o, ['transport_price', 'shipping_price', 'flete', 'transport_service_price']));
  const dirRaw      = firstOf(o, ['dir', 'address', 'direccion', 'shipping_address']);
  const phoneRaw    = firstOf(o, ['phone', 'telefono', 'client_phone', 'phone_client', 'phone_number', 'whatsapp']);
  const clientName  = firstOf(o, ['client_name', 'name_client', 'client', 'customer', 'customer_name']);

  return {
    id: firstOf(o, ['id']),
    status: String(status || ''),
    created: dateOnly(firstOf(o, ['created_at', 'date_created', 'created'])),
    producto: String(productName || '').slice(0, 120),
    productoId: productId != null ? String(productId) : null,
    ciudad: String(city || ''),
    provincia: String(state || ''),
    transportadora: String(carrier || ''),
    flete: flete,
    total: total,
    guia: String(guia || ''),
    dir: String(dirRaw || '').slice(0, 90),
    phone: String(phoneRaw || ''),
    cliente: String(clientName || '').slice(0, 80),
    fin: dateOnly(firstOf(o, ['updated_at', 'date_updated', 'finished_at', 'delivered_at'])),
  };
}

function firstOf(obj, keys) {
  for (const k of keys) {
    if (obj != null && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

function numOf(v) {
  if (v == null) return 0;
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function dateOnly(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...cors() },
    body: JSON.stringify(payload),
  };
}
