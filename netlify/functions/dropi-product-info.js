// DEBUG endpoint 3: prueba masiva de endpoints Dropi para descubrir uno que
// devuelva warehouse info de un producto ajeno (marketplace).
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  const qs = event.queryStringParameters || {};
  const id = String(qs.id || '70842').trim();
  const token = process.env.DROPI_TOKEN_CL;
  if (!token) return respond(500, { error: 'Falta DROPI_TOKEN_CL' });
  const headers = { 'dropi-integration-key': token, 'Content-Type': 'application/json', 'User-Agent': 'BKDROP-Sync/1.0' };

  const attempts = [
    // GET search/list (dijeron soportan GET/HEAD/PUT/DELETE)
    { url: 'https://api.dropi.cl/integrations/products/search?id=' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/search', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/list', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/list?id=' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/search?product_id=' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/search?sku=2000', method: 'GET' },
    // Catalog
    { url: 'https://api.dropi.cl/integrations/catalog', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/catalog/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products?start=0&result_number=5', method: 'GET' },
    // User info / shops
    { url: 'https://api.dropi.cl/integrations/user', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/shops', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/shop', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/dropshippers', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/vendors', method: 'GET' },
    // Quote / simulate
    { url: 'https://api.dropi.cl/integrations/orders/quote', method: 'POST', body: { product_id: Number(id), quantity: 1 } },
    { url: 'https://api.dropi.cl/integrations/orders/simulate', method: 'POST', body: { product_id: Number(id), quantity: 1 } },
    { url: 'https://api.dropi.cl/integrations/orders/preview', method: 'POST', body: { product_id: Number(id), quantity: 1 } },
    // Producto (métodos permitidos según error 405 previo)
    { url: 'https://api.dropi.cl/integrations/products', method: 'PUT', body: { id: Number(id) } },
    { url: 'https://api.dropi.cl/integrations/products', method: 'DELETE' },
    { url: 'https://api.dropi.cl/integrations/products', method: 'HEAD' },
  ];
  const results = [];
  for (const a of attempts) {
    try {
      const opts = { method: a.method, headers };
      if (a.body) opts.body = JSON.stringify(a.body);
      const r = await fetch(a.url, opts);
      const txt = await r.text();
      let data;
      try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 300) }; }
      const brief = {
        url: a.url,
        method: a.method,
        body: a.body || null,
        status: r.status,
        ok: r.ok,
        message: data && data.message ? data.message : null,
        keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : null,
      };
      // Si es OK y hay data útil, incluir preview del cuerpo
      if (r.ok || (r.status >= 200 && r.status < 500 && !brief.message)) {
        brief.dataPreview = JSON.stringify(data).slice(0, 500);
      }
      results.push(brief);
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
