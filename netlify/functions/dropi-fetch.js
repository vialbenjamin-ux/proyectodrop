// Fetch ordenes de Dropi Chile. El frontend llama este endpoint,
// escribe el resultado a Firestore (coleccion bkdrop_dropi_orders).
//
// SOP referencia: seccion 1.2 + 4 (cache de ordenes).
// - Token: dropi-integration-key. Multi-tenant: DROPI_TOKEN_CL (default) o
//   DROPI_TOKEN_GT con ?tenant=gt.
// - Base: https://api.dropi.cl  |  https://api.dropi.gt
// - Rate limit: "Too Many Attempts" bloquea por horas. Un sync incremental basta.
//
// Endpoint: GET /.netlify/functions/dropi-fetch?start=0&result_number=100
//   start: offset de paginacion (default 0)
//   result_number: page size, max 100 (default 100)
//
// Respuesta: { orders: [...], count, hasMore }
// Cada orden viene COMPACTADA a los campos del SOP para no explotar Firestore.

const { dropiTenant } = require('./_dropi-tenant');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const qs = event.queryStringParameters || {};
  const T = dropiTenant(qs);
  const token = T.token;
  if (!token) return respond(500, { error: 'Falta ' + T.envName + ' en env' });
  const start = parseInt(qs.start || '0', 10);
  const resultNumber = Math.min(parseInt(qs.result_number || '100', 10), 100);

  const url = T.base + '/integrations/orders/myorders'
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
  // Dropi trae producto ANIDADO en orderdetails[0].product (name + id).
  // Los aliases top-level NO existen en la respuesta REST y accidentalmente
  // matcheaban `name` = nombre del cliente. Aca priorizamos el anidado.
  const orderDetails = Array.isArray(o.orderdetails) ? o.orderdetails : [];
  const firstItem = orderDetails[0] || {};
  const productInfo = firstItem.product || {};
  const productName = productInfo.name || firstOf(o, ['name_product', 'product_name']);
  const productId   = productInfo.id || firstOf(o, ['id_product', 'product_id']);

  const warehouseInfo = o.warehouse || {};
  const proveedor = warehouseInfo.name || '';

  // Nombre y apellido del cliente vienen SEPARADOS en top-level (name + surname).
  const clientFirst = String(o.name || '').trim();
  const clientLast  = String(o.surname || '').trim();
  const clientName  = (clientFirst + ' ' + clientLast).trim() || firstOf(o, ['client_name', 'customer_name']);

  const carrier     = firstOf(o, ['shipping_company', 'transport', 'transportadora', 'carrier']);
  const guia        = firstOf(o, ['shipping_guide', 'guide', 'guia', 'tracking_number']);
  const city        = firstOf(o, ['city', 'ciudad']);
  const state       = firstOf(o, ['state', 'provincia', 'department']);
  const status      = firstOf(o, ['status', 'estado', 'order_status']);
  const total       = numOf(firstOf(o, ['total_order', 'total']));
  const flete       = numOf(firstOf(o, ['shipping_amount', 'transport_price', 'flete']));
  const dirRaw      = firstOf(o, ['dir', 'address', 'direccion']);
  const phoneRaw    = firstOf(o, ['phone', 'telefono']);

  return {
    id: firstOf(o, ['id']),
    status: String(status || ''),
    created: dateOnly(firstOf(o, ['created_at', 'date_created', 'created'])),
    producto: String(productName || '').slice(0, 120),
    productoId: productId != null ? String(productId) : null,
    proveedor: String(proveedor).slice(0, 80),
    ciudad: String(city || ''),
    provincia: String(state || ''),
    transportadora: String(carrier || ''),
    flete: flete,
    total: total,
    guia: String(guia || ''),
    dir: String(dirRaw || '').slice(0, 90),
    phone: String(phoneRaw || ''),
    cliente: String(clientName || '').slice(0, 80),
    notes: String(firstOf(o, ['notes']) || '').slice(0, 200),
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
