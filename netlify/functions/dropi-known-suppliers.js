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

  // Multi-tenant. Sin ?tenant escanea Chile, como siempre.
  const isGT = String(((event.queryStringParameters || {}).tenant) || 'chile').toLowerCase() === 'gt';
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' });
  const H = { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' };
  const API = 'https://' + domain + '/admin/api/2024-10';

  // GraphQL bulk: 1 request trae 250 productos + metafield dropi. Sin
  // GraphQL harian 250 requests REST -> timeout de Netlify (10s).
  const byId = new Map();
  const dbg = { pagesFetched: 0, totalProductsSeen: 0, lastError: null, withDropi: 0 };
  const GQL_URL = 'https://' + domain + '/admin/api/2024-10/graphql.json';
  const GQL_H = { ...H, 'Content-Type': 'application/json' };
  let cursor = null;
  const MAX_PAGES = 3;

  try {
    for (let pg = 0; pg < MAX_PAGES; pg++) {
      const query = 'query($cursor: String){ products(first: 250, after: $cursor) { edges { cursor node { id title metafield(namespace: "dropi", key: "_dropi_product") { value } } } pageInfo { hasNextPage endCursor } } }';
      const r = await fetch(GQL_URL, { method: 'POST', headers: GQL_H, body: JSON.stringify({ query, variables: { cursor } }) });
      if (!r.ok) { dbg.lastError = 'graphql ' + r.status; break; }
      const j = await r.json();
      if (j.errors) { dbg.lastError = 'graphql errors: ' + JSON.stringify(j.errors).slice(0, 200); break; }
      const edges = (j.data && j.data.products && j.data.products.edges) || [];
      dbg.pagesFetched++;
      dbg.totalProductsSeen += edges.length;
      for (const e of edges) {
        const node = e.node;
        const gid = node.id; // gid://shopify/Product/12345
        const pid = String(gid).split('/').pop();
        const mf = node.metafield;
        if (!mf || !mf.value) continue;
        dbg.withDropi++;
        try {
          const d = JSON.parse(mf.value);
          if (d && d.user && d.user.id != null) {
            const uid = String(d.user.id);
            const uname = String(d.user.name || '').trim();
            const cur = byId.get(uid) || { id: uid, name: uname, productCount: 0, sampleProductId: pid, sampleHasTokens: !!d.tokens };
            cur.productCount++;
            if (!cur.name && uname) cur.name = uname;
            if (!cur.sampleHasTokens && d.tokens) {
              cur.sampleProductId = pid;
              cur.sampleHasTokens = true;
            }
            byId.set(uid, cur);
          }
        } catch (_) {}
      }
      const pi = j.data.products.pageInfo;
      if (!pi || !pi.hasNextPage) break;
      cursor = pi.endCursor;
    }
  } catch (err) {
    return respond(502, { error: err.message || 'unknown' });
  }

  const suppliers = Array.from(byId.values()).sort((a, b) => b.productCount - a.productCount);
  return respond(200, { suppliers, scannedProducts: dbg.totalProductsSeen, debug: dbg });
};

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
