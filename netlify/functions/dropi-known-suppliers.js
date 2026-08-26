// Lista los proveedores Dropi conocidos (que ya tienen al menos 1 producto
// importado en la tienda Shopify Chile). Se obtiene leyendo el metafield
// dropi._dropi_product de cada producto y extrayendo user.id + user.name.
//
// Usado por el importador para autocompletar el campo 'user_name' con los
// proveedores que ya conoces, evitando pedir user_id manualmente.
//
// GET /.netlify/functions/dropi-known-suppliers
// Response: { suppliers: [{ id, name, productCount }] }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };

  const token = process.env.SHOPIFY_TOKEN;
  const domain = process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' });
  const H = { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' };
  const API = 'https://' + domain + '/admin/api/2024-10';

  const PAGE_SIZE = 250;
  const MAX_PAGES = 3;
  const MAX_LOOKUPS = 250;
  const byId = new Map();
  let lookups = 0;
  let pageUrl = API + '/products.json?limit=' + PAGE_SIZE + '&fields=id,title&status=any';
  let pages = 0;

  try {
    while (pageUrl && pages < MAX_PAGES && lookups < MAX_LOOKUPS) {
      const r = await fetch(pageUrl, { headers: H });
      if (!r.ok) break;
      const j = await r.json();
      for (const p of (j.products || [])) {
        if (lookups >= MAX_LOOKUPS) break;
        lookups++;
        const mR = await fetch(API + '/products/' + p.id + '/metafields.json?namespace=dropi', { headers: H });
        if (!mR.ok) continue;
        const mJ = await mR.json();
        const mfDropi = (mJ.metafields || []).find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
        if (!mfDropi) continue;
        try {
          const d = JSON.parse(mfDropi.value);
          if (d && d.user && d.user.id != null) {
            const uid = String(d.user.id);
            const uname = String(d.user.name || '').trim();
            const cur = byId.get(uid) || { id: uid, name: uname, productCount: 0, sampleProductId: String(p.id), sampleHasTokens: !!d.tokens };
            cur.productCount++;
            if (!cur.name && uname) cur.name = uname;
            // Guardar sampleProductId con tokens si aparece uno.
            if (!cur.sampleHasTokens && d.tokens) {
              cur.sampleProductId = String(p.id);
              cur.sampleHasTokens = true;
            }
            byId.set(uid, cur);
          }
        } catch (_) {}
      }
      const link = r.headers.get('Link') || '';
      const nx = link.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = nx ? nx[1] : null;
      pages++;
    }
  } catch (err) {
    return respond(502, { error: err.message || 'unknown' });
  }

  const suppliers = Array.from(byId.values()).sort((a, b) => b.productCount - a.productCount);
  return respond(200, { suppliers, scannedProducts: lookups });
};

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
