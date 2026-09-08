// Lista productos Shopify que pertenecen al mismo proveedor Dropi
// (metafield dropi._dropi_product.user.id === supplier_id).
//
// Usado por el buscador manual del modal de Releasit para filtrar upsells
// del mismo proveedor Dropi -- garantiza que el pedido se despache desde
// UNA sola bodega (regla dura del PDF).
//
// Antes recorria /products.json y pedia el metafield producto por producto.
// Con ese techo (2 paginas, 150 lookups) solo se veian los primeros ~500
// productos del catalogo y siempre aparecian los mismos: los recien creados
// nunca entraban. Ahora GraphQL trae el metafield en la misma consulta, asi
// que se puede recorrer el catalogo entero.
//
// GET /.netlify/functions/dropi-supplier-shopify-products?supplier_id=1001&q=texto&limit=30
//   &tenant=gt para Guatemala.
//
// Response:
//   { products: [ { id, title, handle, image, price, variantId, cost, status } ],
//     scanned, matched, truncated }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });

  const qs = event.queryStringParameters || {};
  const supplierId = String(qs.supplier_id || '').trim();
  const q = String(qs.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(qs.limit, 10) || 30, 1), 50);
  const excludeId = String(qs.exclude_product_id || '').trim();

  if (!supplierId) return respond(400, { error: 'Falta supplier_id' });

  const isGT = String(qs.tenant || 'chile').toLowerCase() === 'gt';
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' + (isGT ? ' GT' : '') });

  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const GQL = 'https://' + domain + '/admin/api/2024-10/graphql.json';

  const normalize = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const terms = normalize(q).split(/\s+/).filter(Boolean);

  const QUERY = [
    'query($cursor: String) {',
    '  products(first: 250, after: $cursor) {',
    '    pageInfo { hasNextPage endCursor }',
    '    edges { node {',
    '      id title handle status',
    '      featuredImage { url }',
    '      variants(first: 1) { edges { node { id price } } }',
    '      metafield(namespace: "dropi", key: "_dropi_product") { value }',
    '    } }',
    '  }',
    '}',
  ].join('\n');

  const MAX_PAGES = 8;   // 2000 productos: alcanza para el catalogo completo
  let scanned = 0;
  let cursor = null;
  let pages = 0;
  let truncated = false;
  const results = [];

  try {
    while (pages < MAX_PAGES) {
      const r = await fetch(GQL, {
        method: 'POST', headers: H,
        body: JSON.stringify({ query: QUERY, variables: { cursor } }),
      });
      if (!r.ok) return respond(502, { error: 'GraphQL ' + r.status + ': ' + (await r.text()).slice(0, 200) });
      const j = await r.json();
      if (j.errors) return respond(502, { error: 'GraphQL: ' + JSON.stringify(j.errors).slice(0, 300) });

      const conn = ((j.data || {}).products) || {};
      const edges = conn.edges || [];
      scanned += edges.length;

      for (const e of edges) {
        const n = e.node || {};
        const id = String(n.id || '').split('/').pop();
        if (!id || (excludeId && id === excludeId)) continue;
        if (!n.metafield || !n.metafield.value) continue;

        let meta;
        try { meta = JSON.parse(n.metafield.value); } catch (_) { continue; }
        if (!meta.user || String(meta.user.id) !== supplierId) continue;

        if (terms.length) {
          const hay = normalize((n.title || '') + ' ' + (n.handle || ''));
          if (!terms.every((t) => hay.includes(t))) continue;
        }

        const v0 = (((n.variants || {}).edges || [])[0] || {}).node || null;
        if (!v0) continue;

        results.push({
          id,
          title: n.title,
          handle: n.handle,
          status: String(n.status || '').toLowerCase(),
          image: (n.featuredImage && n.featuredImage.url) || null,
          price: parseFloat(v0.price || 0),
          variantId: String(v0.id || '').split('/').pop(),
          cost: meta.sale_price != null ? Number(meta.sale_price) : null,
          dropiId: meta.id || null,
        });
      }

      if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
      pages++;
      if (pages >= MAX_PAGES) truncated = true;
    }
  } catch (err) {
    return respond(502, { error: err.message || 'unknown' });
  }

  // Sin texto de busqueda los activos primero: son los que sirven de upsell.
  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });

  return respond(200, {
    supplierId,
    query: q || null,
    scanned,
    matched: results.length,
    truncated,
    products: results.slice(0, limit),
  });
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
