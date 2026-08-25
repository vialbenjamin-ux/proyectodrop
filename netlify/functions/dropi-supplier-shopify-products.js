// Lista productos Shopify que pertenecen al mismo proveedor Dropi
// (metafield dropi._dropi_product.user.id === supplier_id).
//
// Usado por el buscador manual del modal de Releasit para filtrar upsells
// del mismo proveedor Dropi -- garantiza que el pedido se despache desde
// UNA sola bodega (regla dura del PDF).
//
// GET /.netlify/functions/dropi-supplier-shopify-products?supplier_id=1001&q=texto&limit=30
//
// Response:
//   { products: [ { id, title, handle, image, price, variantId, cost, status } ], scanned }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });

  const qs = event.queryStringParameters || {};
  const supplierId = String(qs.supplier_id || '').trim();
  const q = String(qs.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(qs.limit, 10) || 30, 1), 50);
  const excludeId = String(qs.exclude_product_id || '').trim();

  if (!supplierId) return respond(400, { error: 'Falta supplier_id' });

  const token = process.env.SHOPIFY_TOKEN;
  const domain = process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' });

  const H = { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' };
  const API = 'https://' + domain + '/admin/api/2024-10';

  const normalize = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const qNorm = normalize(q);
  const terms = qNorm.split(/\s+/).filter(Boolean);

  // Escaneo: 2 páginas de 250 productos (hasta 500 escaneados).
  // Para cada producto matcheado por query (o todos si no hay query),
  // leemos el metafield dropi._dropi_product y comparamos user.id.
  // Techo duro de metafield lookups para no reventar el timeout.
  const PAGE_SIZE = 250;
  const MAX_PAGES = 2;
  const MAX_METAFIELD_LOOKUPS = 150;

  let scanned = 0;
  let lookups = 0;
  const results = [];
  let pageUrl = API + '/products.json?limit=' + PAGE_SIZE + '&status=any&fields=id,title,handle,status,variants,image';
  let pages = 0;

  try {
    while (pageUrl && pages < MAX_PAGES && lookups < MAX_METAFIELD_LOOKUPS && results.length < limit) {
      const r = await fetch(pageUrl, { headers: H });
      if (!r.ok) break;
      const j = await r.json();
      const products = j.products || [];
      scanned += products.length;

      for (const p of products) {
        if (excludeId && String(p.id) === excludeId) continue;
        // Filtro rápido por query (evita metafield lookup para no-matches).
        if (terms.length) {
          const hay = normalize((p.title || '') + ' ' + (p.handle || ''));
          if (!terms.every(t => hay.includes(t))) continue;
        }
        const v0 = (p.variants || [])[0];
        if (!v0) continue;

        if (lookups >= MAX_METAFIELD_LOOKUPS) break;
        lookups++;

        const mR = await fetch(API + '/products/' + p.id + '/metafields.json?namespace=dropi', { headers: H });
        if (!mR.ok) continue;
        const mJ = await mR.json();
        const mfDropi = (mJ.metafields || []).find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
        if (!mfDropi) continue;
        try {
          const dropiData = JSON.parse(mfDropi.value);
          if (dropiData.user && String(dropiData.user.id) === supplierId) {
            results.push({
              id: p.id,
              title: p.title,
              handle: p.handle,
              status: p.status,
              image: (p.image && p.image.src) || null,
              price: parseFloat(v0.price || 0),
              variantId: v0.id,
              cost: dropiData.sale_price != null ? Number(dropiData.sale_price) : null,
              dropiId: dropiData.id || null,
            });
            if (results.length >= limit) break;
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

  return respond(200, {
    supplierId,
    query: q || null,
    scanned,
    metafieldLookups: lookups,
    matched: results.length,
    products: results,
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
