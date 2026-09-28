// Escaneo del catalogo de un proveedor Dropi, con GraphQL, para armar el pool
// de upsells posibles.
//
// Por que existe: el buscador manual del modal ya recorria el catalogo entero
// con GraphQL (una consulta por 250 productos, metafield incluido), pero el
// upsell AUTOMATICO usaba otro camino -- /products.json y un GET de metafields
// por producto, con techo de 120 consultas -- y veia 1 o 2 candidatos. Con dos
// implementaciones distintas el automatico elegia peor que el manual sobre el
// mismo catalogo. Unificado el 28 sep 2026.
//
// escanearProveedor({ domain, token, supplierId, baseId })
//   -> { productos: [...], base, scanned, truncated }
//
// Cada producto trae: id, title, handle, status, image, price, variantId,
// cost (sale_price de Dropi = lo que cobra al dropshipper), dropiId, bodegas,
// stock, cuenta (del token del metafield) y texto (titulo + categorias +
// descripcion, de donde sale el rubro).

const { textoDe } = require('./_rubros');

const QUERY = [
  'query($cursor: String) {',
  '  products(first: 250, after: $cursor) {',
  '    pageInfo { hasNextPage endCursor }',
  '    edges { node {',
  '      id title handle status totalInventory',
  '      featuredImage { url }',
  '      variants(first: 1) { edges { node { id price } } }',
  '      metafield(namespace: "dropi", key: "_dropi_product") { value }',
  '    } }',
  '  }',
  '}',
].join('\n');

// Bodegas donde el proveedor tiene el producto. Importa porque una orden de
// Dropi tiene UNA bodega: un upsell en otra bodega hace imposible el pedido.
function bodegasDe(meta) {
  const wp = (meta && meta.warehouse_product) || [];
  if (!Array.isArray(wp)) return [];
  const out = [];
  for (const w of wp) {
    if (w && w.warehouse_id != null) {
      const id = Number(w.warehouse_id);
      if (out.indexOf(id) === -1) out.push(id);
    }
  }
  return out;
}

// La cuenta Dropi que emitio el token guardado en el metafield. Si no es la
// cuenta actual, el pedido rebota por saldo.
function cuentaDeTokens(tok) {
  try {
    const parts = String(tok || '').split('.');
    if (parts.length < 2) return null;
    let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const p = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
    return p && p.sub != null ? String(p.sub) : null;
  } catch (_) {
    return null;
  }
}

async function escanearProveedor({ domain, token, supplierId, baseId, maxPages }) {
  const GQL = 'https://' + domain + '/admin/api/2024-10/graphql.json';
  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const MAX_PAGES = maxPages || 8; // 2000 productos: el catalogo completo
  const productos = [];
  let base = null;
  let scanned = 0;
  let cursor = null;
  let pages = 0;
  let truncated = false;

  while (pages < MAX_PAGES) {
    const r = await fetch(GQL, {
      method: 'POST', headers: H,
      body: JSON.stringify({ query: QUERY, variables: { cursor } }),
    });
    if (!r.ok) throw new Error('GraphQL ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors).slice(0, 300));

    const conn = ((j.data || {}).products) || {};
    const edges = conn.edges || [];
    scanned += edges.length;

    for (const e of edges) {
      const n = e.node || {};
      const id = String(n.id || '').split('/').pop();
      if (!id || !n.metafield || !n.metafield.value) continue;
      let meta;
      try { meta = JSON.parse(n.metafield.value); } catch (_) { continue; }

      // El base puede aparecer en cualquier pagina: se anota y no compite.
      if (baseId && id === String(baseId)) {
        base = {
          id, title: n.title || '',
          costo: meta.sale_price != null ? Number(meta.sale_price) : null,
          bodegas: bodegasDe(meta),
          supplierId: meta.user && meta.user.id != null ? String(meta.user.id) : null,
          texto: (n.title || '') + ' ' + textoDe(meta),
        };
        continue;
      }
      if (supplierId && (!meta.user || String(meta.user.id) !== String(supplierId))) continue;

      const v0 = (((n.variants || {}).edges || [])[0] || {}).node || null;
      if (!v0) continue;

      productos.push({
        id,
        title: n.title || '',
        handle: n.handle || '',
        status: String(n.status || '').toLowerCase(),
        image: (n.featuredImage && n.featuredImage.url) || null,
        price: parseFloat(v0.price || 0),
        variantId: String(v0.id || '').split('/').pop(),
        cost: meta.sale_price != null ? Number(meta.sale_price) : null,
        dropiId: meta.id || null,
        bodegas: bodegasDe(meta),
        stock: n.totalInventory != null ? n.totalInventory : null,
        cuenta: cuentaDeTokens(meta.tokens),
        texto: (n.title || '') + ' ' + textoDe(meta),
      });
    }

    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    pages++;
    if (pages >= MAX_PAGES) truncated = true;
  }

  return { productos, base, scanned, truncated };
}

// Precio de venta del upsell. NO sale del precio de lista del producto: sale
// del costo de Dropi. El upsell es un agregado, viaja gratis en el mismo envio
// y no paga publicidad, asi que con $2.000 a $4.000 sobre el costo alcanza
// (regla de Benjamin, 28 sep 2026). Por eso el criterio viejo -- techo del 60%
// del precio de venta del base -- dejaba fuera el catalogo entero: todos sus
// productos estan en la misma banda de $25.000 a $30.000.
function precioUpsell(costo, tenant) {
  const c = Number(costo);
  if (!c || c <= 0) return null;
  if (tenant === 'gt') {
    // Equivalente en quetzales: Q20 a Q30, terminado en 9.
    const p = Math.round((c + 25) / 10) * 10 - 1;
    return Math.max(c + 20, Math.min(c + 30, p));
  }
  // Chile: terminado en 990, y la ganancia queda entre $2.000 y $4.000.
  const p = Math.round((c + 3000 - 990) / 1000) * 1000 + 990;
  return Math.max(c + 2000, Math.min(c + 4000, p));
}

module.exports = { escanearProveedor, bodegasDe, cuentaDeTokens, precioUpsell };
