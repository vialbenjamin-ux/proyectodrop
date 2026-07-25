// Fetch ordenes recientes de Shopify con detalles completos para el
// detector de huerfanos (Shopify -> Dropi). Devuelve los campos que
// necesita el flujo de creacion manual en Dropi: cliente, phone,
// direccion, comuna, producto, monto, fecha.
//
// Endpoint: GET /.netlify/functions/shopify-orders-detailed?hours=48
//   hours: ventana en horas (default 48, max 168).
//
// Filtros aplicados (mismos que shopify-report para consistencia):
//   - Excluye cancelled + voided.

exports.handler = async function (event) {
  const tenant = String(((event.queryStringParameters || {}).tenant || 'chile')).toLowerCase();
  const isGT = tenant === 'gt';
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) {
    return respond(500, { error: 'Faltan credenciales Shopify' + (isGT ? ' GT' : '') });
  }

  const qs = event.queryStringParameters || {};
  const hours = Math.min(parseInt(qs.hours || '48', 10) || 48, 168);
  const sinceUTC = new Date(Date.now() - hours * 3600 * 1000);

  const FIELDS = [
    'id','name','created_at','cancelled_at','financial_status',
    'total_price','current_subtotal_price',
    'customer','shipping_address','billing_address',
    'phone','contact_email',
    'line_items','note_attributes','landing_site','source_name',
    'tags','note',
  ].join(',');

  const url = 'https://' + domain + '/admin/api/2024-10/orders.json'
    + '?status=any'
    + '&created_at_min=' + sinceUTC.toISOString()
    + '&limit=250&fields=' + FIELDS;

  const allOrders = [];
  let pageUrl = url;
  try {
    while (pageUrl) {
      const resp = await fetch(pageUrl, {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
      });
      if (!resp.ok) return respond(502, { error: 'Shopify ' + resp.status });
      const data = await resp.json();
      for (const o of (data.orders || [])) {
        if (o.cancelled_at) continue;
        if (o.financial_status === 'voided') continue;
        allOrders.push(compact(o));
      }
      const link = resp.headers.get('Link') || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = nextMatch ? nextMatch[1] : null;
    }
  } catch (err) {
    return respond(502, { error: 'Fetch fail: ' + (err.message || 'unknown') });
  }

  return respond(200, {
    orders: allOrders,
    count: allOrders.length,
    hours,
    sinceUTC: sinceUTC.toISOString(),
    fetchedAt: new Date().toISOString(),
  });
};

function compact(o) {
  const cust = o.customer || {};
  const ship = o.shipping_address || o.billing_address || {};
  const phoneRaw = ship.phone || cust.phone || o.phone || (o.billing_address && o.billing_address.phone) || '';
  const lineItems = (o.line_items || []).map(li => ({
    name: li.title || '',
    variant: (li.variant_title && li.variant_title !== 'Default Title') ? li.variant_title : '',
    qty: li.quantity || 0,
    price: parseFloat(li.price || 0),
    sku: li.sku || '',
  }));
  return {
    id: o.id,
    name: o.name,
    created_at: o.created_at,
    financial_status: o.financial_status,
    total: parseFloat(o.total_price || 0),
    subtotal: parseFloat(o.current_subtotal_price || 0),
    customer_name: [cust.first_name, cust.last_name].filter(Boolean).join(' ') || (ship.first_name || '') + ' ' + (ship.last_name || ''),
    phone: normalizePhone(phoneRaw),
    phone_raw: String(phoneRaw || ''),
    email: cust.email || o.contact_email || '',
    address: [ship.address1, ship.address2].filter(Boolean).join(' - '),
    city: ship.city || '',
    province: ship.province || '',
    zip: ship.zip || '',
    country: ship.country || '',
    items: lineItems,
    source: (o.source_name || '').toLowerCase(),
    tags: String(o.tags || ''),
    note: String(o.note || ''),
  };
}

function normalizePhone(p) {
  if (!p) return '';
  let s = String(p).replace(/\D/g, '');
  if (s.startsWith('56') && s.length >= 11) s = s.slice(2);
  return s;
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  };
}
