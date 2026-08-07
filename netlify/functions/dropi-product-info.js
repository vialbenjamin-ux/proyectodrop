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
  const urls = [
    'https://api.dropi.cl/integrations/products/' + id,
    'https://api.dropi.cl/integrations/products/get/' + id,
    'https://api.dropi.cl/integrations/products?id=' + id,
  ];
  const results = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: 'GET', headers });
      const txt = await r.text();
      let data;
      try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 2000) }; }
      results.push({ url, status: r.status, ok: r.ok, data });
    } catch (err) {
      results.push({ url, error: err.message });
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
