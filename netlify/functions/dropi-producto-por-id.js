// Resuelve un producto a partir de su ID de Dropi y el pais, para que
// Landing Auto necesite solo esos dos datos.
//
// La API de Dropi NO tiene endpoint de productos (probado con 14 rutas: todas
// 400/404), asi que el nombre y las fotos salen de Shopify: el barcode de la
// variante es el ID de Dropi, y el metafield dropi._dropi_product trae el
// nombre real del proveedor y la galeria completa de imagenes.
//
// GET /.netlify/functions/dropi-producto-por-id?tenant=chile&dropi_id=66774
//
// Respuesta:
//   { encontrado: true, tenant, dropiId, shopifyId, titulo, handle,
//     nombreDropi, descripcion, fotos: [url], proveedor, tipo, variaciones }
//   { encontrado: false, tenant, dropiId, motivo }
//
// Si `encontrado` es false el producto todavia no esta en Shopify: hay que
// importarlo desde el panel de Dropi (asi el metafield queda completo, ver
// dropi-relink-product) y recien ahi se puede armar la landing.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });

  const qs = event.queryStringParameters || {};
  const tenant = String(qs.tenant || 'chile').toLowerCase();
  const isGT = tenant === 'gt';
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify de ' + tenant });

  const dropiId = String(qs.dropi_id || '').trim();
  if (!/^\d+$/.test(dropiId)) return respond(400, { error: 'dropi_id invalido (debe ser numerico)' });

  // El barcode de un producto con variantes es `<producto>-<variacion>`, asi
  // que se buscan las dos formas.
  const filtro = 'barcode:' + dropiId + ' OR barcode:' + dropiId + '-*';
  const query = `query($q: String!) {
    productVariants(first: 20, query: $q) {
      edges { node {
        barcode
        product {
          id legacyResourceId title handle status
          featuredImage { url }
          images(first: 12) { edges { node { url } } }
          metafield(namespace: "dropi", key: "_dropi_product") { value }
        }
      } }
    }
  }`;

  try {
    const r = await fetch('https://' + domain + '/admin/api/2024-10/graphql.json', {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { q: filtro } }),
    });
    if (!r.ok) {
      const txt = await r.text();
      return respond(502, { error: 'Shopify ' + r.status + ': ' + txt.slice(0, 200) });
    }
    const j = await r.json();
    if (j.errors) return respond(502, { error: 'GraphQL: ' + JSON.stringify(j.errors).slice(0, 200) });

    const edges = (((j.data || {}).productVariants || {}).edges) || [];
    // El filtro de Shopify es amplio (barcode:171680-* tambien trae 1716801),
    // asi que se confirma el prefijo exacto a mano.
    const match = edges.find(e => {
      const b = String((e.node || {}).barcode || '').trim();
      return b === dropiId || b.startsWith(dropiId + '-');
    });
    if (!match) {
      return respond(200, {
        encontrado: false, tenant, dropiId,
        motivo: 'No hay ningun producto en Shopify ' + (isGT ? 'GT' : 'Chile')
              + ' con el barcode ' + dropiId + '. Importalo primero desde el panel de Dropi.',
      });
    }

    const p = match.node.product || {};
    let meta = null;
    if (p.metafield && p.metafield.value) {
      try { meta = JSON.parse(p.metafield.value); } catch (_) { meta = null; }
    }

    // Las fotos: primero la galeria de Dropi (son las del proveedor, limpias),
    // y si no hay, las del producto en Shopify.
    const fotosDropi = [];
    for (const g of ((meta || {}).gallery || [])) {
      const u = typeof g === 'string' ? g : (g && (g.url || g.urlS3 || g.name));
      if (u && /^https?:\/\//.test(u)) fotosDropi.push(u);
    }
    const fotosShopify = (((p.images || {}).edges) || []).map(e => (e.node || {}).url).filter(Boolean);

    return respond(200, {
      encontrado: true,
      tenant, dropiId,
      shopifyId: p.legacyResourceId || null,
      titulo: p.title || '',
      handle: p.handle || '',
      status: p.status || null,
      nombreDropi: (meta && meta.name) || '',
      descripcion: (meta && meta.description) || '',
      proveedor: (meta && meta.user && meta.user.name) || null,
      tipo: (meta && meta.type) || null,
      variaciones: ((meta && meta.variations) || []).length,
      camposMetafield: meta ? Object.keys(meta).length : 0,
      fotos: (fotosDropi.length ? fotosDropi : fotosShopify).slice(0, 12),
      fotoPrincipal: (p.featuredImage && p.featuredImage.url) || fotosDropi[0] || fotosShopify[0] || null,
    });
  } catch (err) {
    return respond(502, { error: err.message || 'error desconocido' });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

function respond(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
