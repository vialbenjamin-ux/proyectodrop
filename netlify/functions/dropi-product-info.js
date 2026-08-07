// DEBUG endpoint: devuelve raw response de Dropi /integrations/products/{id}
// para inspeccionar la estructura de variantes + bodegas y adaptar el código.
// GET /.netlify/functions/dropi-product-info?id=70842

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  const qs = event.queryStringParameters || {};
  const id = String(qs.id || '').trim();
  if (!/^\d+$/.test(id)) return respond(400, { error: 'id numerico requerido' });
  const token = process.env.DROPI_TOKEN_CL;
  if (!token) return respond(500, { error: 'Falta DROPI_TOKEN_CL' });
  const headers = {
    'dropi-integration-key': token,
    'Content-Type': 'application/json',
    'User-Agent': 'BKDROP-Sync/1.0',
  };
  const attempts = [
    { url: 'https://api.dropi.cl/integrations/products/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products', method: 'POST', body: { id: Number(id) } },
    { url: 'https://api.dropi.cl/integrations/products', method: 'POST', body: { product_id: Number(id) } },
    { url: 'https://api.dropi.cl/integrations/products/search', method: 'POST', body: { id: Number(id) } },
    { url: 'https://api.dropi.cl/integrations/products/list', method: 'POST', body: { id: Number(id) } },
    { url: 'https://api.dropi.cl/integrations/product/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/detail/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/inventory/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/warehouses', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/warehouse-stock/' + id, method: 'GET' },
  ];
  const results = [];
  for (const a of attempts) {
    try {
      const opts = { method: a.method, headers };
      if (a.body) opts.body = JSON.stringify(a.body);
      const r = await fetch(a.url, opts);
      const txt = await r.text();
      let data;
      try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 1500) }; }
      results.push({ url: a.url, method: a.method, body: a.body || null, status: r.status, ok: r.ok, data });
    } catch (err) {
      results.push({ url: a.url, method: a.method, error: err.message });
    }
  }
  return respond(200, { productId: id, tried: results });
};

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
