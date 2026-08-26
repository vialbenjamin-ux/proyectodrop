// DEBUG: lee metafields de un producto Shopify para inspeccionar apps
// instaladas (Releasit COD Form, etc.) y deducir el schema.
//
// GET /.netlify/functions/shopify-product-metafields?handle=mopa-titanio
// o    ?product_id=1234567890

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });
  const params = event.queryStringParameters || {};
  const tenant = String(params.tenant || 'chile').toLowerCase();
  const isGT = tenant === 'gt';
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' });

  const handle = (params.handle || '').trim();
  let productId = (params.product_id || '').trim();

  try {
    // 1) Si vino handle, resolver product_id primero
    if (handle && !productId) {
      const r = await fetch('https://' + domain + '/admin/api/2024-10/products.json?handle=' + encodeURIComponent(handle) + '&fields=id,handle,title', {
        headers: { 'X-Shopify-Access-Token': token }
      });
      if (!r.ok) return respond(502, { error: 'Shopify products fetch: ' + r.status });
      const j = await r.json();
      const p = (j.products || [])[0];
      if (!p) return respond(404, { error: 'Producto no encontrado por handle: ' + handle });
      productId = String(p.id);
    }
    if (!productId) return respond(400, { error: 'Falta handle o product_id' });

    // 2) Fetch metafields del producto
    const mR = await fetch('https://' + domain + '/admin/api/2024-10/products/' + productId + '/metafields.json', {
      headers: { 'X-Shopify-Access-Token': token }
    });
    if (!mR.ok) return respond(502, { error: 'Shopify metafields fetch: ' + mR.status });
    const mJ = await mR.json();
    const all = mJ.metafields || [];

    // 3) Fetch producto también para contexto + variants con sus metafields
    const pR = await fetch('https://' + domain + '/admin/api/2024-10/products/' + productId + '.json', {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const pJ = pR.ok ? await pR.json() : null;
    const product = pJ && pJ.product ? pJ.product : null;

    // 4) Filtrar por namespaces útiles (Releasit u otras apps conocidas)
    const releasit = all.filter(m => /releasit/i.test(m.namespace) || /releasit/i.test(m.key));
    const byNamespace = {};
    for (const m of all) {
      if (!byNamespace[m.namespace]) byNamespace[m.namespace] = [];
      byNamespace[m.namespace].push({ key: m.key, type: m.type, valuePreview: (typeof m.value === 'string' ? m.value.slice(0, 500) : m.value) });
    }

    return respond(200, {
      productId,
      product: product ? {
        id: product.id,
        title: product.title,
        handle: product.handle,
        variantsCount: (product.variants || []).length,
        variants: (product.variants || []).map(v => ({ id: v.id, title: v.title, price: v.price, sku: v.sku, barcode: v.barcode })),
      } : null,
      allMetafields: all.map(m => ({ id: m.id, namespace: m.namespace, key: m.key, type: m.type, valuePreview: (typeof m.value === 'string' ? m.value.slice(0, params.full === '1' ? 40000 : 2000) : m.value) })),
      releasitMetafields: releasit,
      namespacesFound: Object.keys(byNamespace),
      byNamespace,
    });
  } catch (err) {
    return respond(502, { error: 'Fetch fail: ' + (err.message || 'unknown') });
  }
};

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
