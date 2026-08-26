// DEBUG: exploración exhaustiva de endpoints Dropi para hallar uno que
// devuelva info del producto por ID (para el importador).
// GET /.netlify/functions/dropi-explore?id=56778

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  const qs = event.queryStringParameters || {};
  const id = String(qs.id || '56778').trim();
  const token = process.env.DROPI_TOKEN_CL;
  if (!token) return respond(500, { error: 'Falta DROPI_TOKEN_CL' });
  const H = { 'dropi-integration-key': token, 'Content-Type': 'application/json', 'User-Agent': 'BKDROP-Sync/1.0' };

  // Endpoints candidatos. Priorizamos los que suelen funcionar en integraciones REST.
  const attempts = [
    { url: 'https://api.dropi.cl/integrations/products/myproducts', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/myproducts?start=0&result_number=5', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/imported', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/imported?start=0&result_number=5', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/my', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/mine', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/marketplace', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/marketplace?id=' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/marketplace/products', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/marketplace/products/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/product/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/product?id=' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/product/details/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/product/details?id=' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/detail/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/get/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/getById/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/getbyid?id=' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/info?id=' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/find?id=' + id, method: 'GET' },
    // POST tentativos
    { url: 'https://api.dropi.cl/integrations/products/get', method: 'POST', body: { id: Number(id) } },
    { url: 'https://api.dropi.cl/integrations/products/detail', method: 'POST', body: { id: Number(id) } },
    { url: 'https://api.dropi.cl/integrations/products/info', method: 'POST', body: { id: Number(id) } },
    { url: 'https://api.dropi.cl/integrations/products/find', method: 'POST', body: { product_id: Number(id) } },
    // Con /catalog
    { url: 'https://api.dropi.cl/integrations/catalog/products', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/catalog/product/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/catalog/products/' + id, method: 'GET' },
    // Endpoints con V1/v2
    { url: 'https://api.dropi.cl/integrations/v1/products/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/v2/products/' + id, method: 'GET' },
    // Endpoints raíz sin /integrations/
    { url: 'https://api.dropi.cl/products/' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/api/products/' + id, method: 'GET' },
    // Import
    { url: 'https://api.dropi.cl/integrations/products/import', method: 'POST', body: { id: Number(id) } },
    { url: 'https://api.dropi.cl/integrations/import/product', method: 'POST', body: { id: Number(id) } },
    { url: 'https://api.dropi.cl/integrations/import/products', method: 'POST', body: { ids: [Number(id)] } },
    // Con status
    { url: 'https://api.dropi.cl/integrations/products?id=' + id, method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/all', method: 'GET' },
    { url: 'https://api.dropi.cl/integrations/products/all?start=0&result_number=5', method: 'GET' },
  ];

  const results = [];
  for (const a of attempts) {
    try {
      const opts = { method: a.method, headers: H };
      if (a.body) opts.body = JSON.stringify(a.body);
      const r = await fetch(a.url, opts);
      const txt = await r.text();
      let data;
      try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 200) }; }
      const isUseful = r.ok && data && typeof data === 'object'
        && !data.message?.match(/permiso|access|denied|not found/i);
      const brief = {
        url: a.url, method: a.method,
        body: a.body || null,
        status: r.status, ok: r.ok,
        message: data?.message || null,
        keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 10) : null,
      };
      if (isUseful || (r.ok && (Array.isArray(data) || (data.objects || data.data || data.products || data.results)))) {
        brief.dataPreview = JSON.stringify(data).slice(0, 800);
        brief.useful = true;
      }
      results.push(brief);
    } catch (err) {
      results.push({ url: a.url, method: a.method, error: err.message });
    }
  }

  const useful = results.filter(r => r.useful);
  return respond(200, {
    id,
    totalTried: results.length,
    usefulCount: useful.length,
    useful,
    all: results,
  });
};

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
