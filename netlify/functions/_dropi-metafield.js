// Construye el metafield dropi._dropi_product COMPLETO, pidiendole a Dropi el
// producto entero en vez de inventarse un JSON minimo.
//
// Por que existe: el importador de BKDROP escribia a mano un objeto de 7 a 9
// campos (id, name, type, description, sale_price, gallery, user, tokens,
// shop_name), que era todo lo que se podia armar cuando se creia que la API de
// Dropi no exponia productos. Dropi espera bastante mas -- entre otros
// warehouse_product (las bodegas), variations, sku, active y categories -- y
// cuando no los encuentra NO sincroniza el pedido: cae entero en DROPITEA. Le
// paso al Cepillo Limpiador 9 en 1 (metafield de 9 campos) y a todos los
// productos creados por el importador.
//
// Desde el 28 sep 2026 se usa GET /integrations/products/v2/{id}, que devuelve
// el objeto tal como lo tiene Dropi. El metafield pasa a ser ese objeto mas
// los tres datos que son POR TIENDA y no vienen del producto:
//   tokens     -> identifica la cuenta de Dropi de la tienda (se copia de otro
//                 producto ya importado; NO se toca nunca)
//   shop_name  -> idem
//   gallery    -> el formato de fotos que ya leian otras partes de BKDROP

const CDN_DROPI = 'https://d39ru7awumhhs2.cloudfront.net/';

// Pide el producto a Dropi. Devuelve el objeto, { bloqueado: true } si Dropi
// esta cortando por exceso de consultas, o null si no lo conoce.
async function pedirProductoDropi(isGT, dropiId) {
  const key = String((isGT ? process.env.DROPI_TOKEN_GT : process.env.DROPI_TOKEN_CL) || '').trim();
  if (!key) return null;
  const base = isGT ? 'https://api.dropi.gt' : 'https://api.dropi.cl';
  try {
    const r = await fetch(base + '/integrations/products/v2/' + encodeURIComponent(dropiId), {
      headers: { 'dropi-integration-key': key, 'User-Agent': 'BKDROP-Sync/1.0' },
    });
    // 429 = "Too Many Attempts". Devolver null aca haria parecer que el
    // producto no existe y se escribiria un metafield peor que el que hay.
    if (r.status === 429) return { bloqueado: true };
    if (!r.ok) return null;
    const j = await r.json();
    const o = j.objects || j.object || null;
    const p = Array.isArray(o) ? o[0] : o;
    return (p && p.id) ? p : null;
  } catch (_) {
    return null;
  }
}

// Las fotos de Dropi: `url` casi siempre viene vacia y hay que armarla con el
// CDN mas urlS3 codificado (sin codificar da 403). La principal va primero.
function galeriaDe(producto) {
  const out = [];
  const pics = ((producto && producto.photos) || []).slice()
    .sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0));
  for (const g of pics) {
    let u = g.url || null;
    if (!u && g.urlS3) u = CDN_DROPI + String(g.urlS3).split('/').map(encodeURIComponent).join('/');
    if (u && !out.some((x) => x.url === u)) out.push({ url: u });
  }
  return out;
}

// El metafield final. `previo` es el metafield que ya tiene el producto: de ahi
// salen tokens y shop_name, y se respeta la eleccion de variaciones que haya
// hecho alguien a mano (variationstoimport / chose_variations).
function construirMetafield(producto, previo, extra) {
  const base = Object.assign({}, producto);
  const p = previo || {};
  const e = extra || {};

  const meta = Object.assign(base, {
    gallery: galeriaDe(producto),
    tokens: e.tokens || p.tokens || null,
    shop_name: e.shopName || p.shop_name || null,
  });

  // Un producto VARIABLE necesita decir CUALES variaciones se importaron, o
  // Dropi rebota el pedido con "el producto es variable, pero no tiene
  // asignada una variacion id". Si ya venian elegidas se respetan; si no, se
  // toman todas las que Dropi declara.
  if (String(meta.type || '').toUpperCase() === 'VARIABLE') {
    const ids = (meta.variations || []).map((v) => String(v.id)).filter(Boolean);
    meta.variationstoimport = (p.variationstoimport && p.variationstoimport.length)
      ? p.variationstoimport : ids;
    meta.chose_variations = (p.chose_variations && p.chose_variations.length)
      ? p.chose_variations : ids;
  }

  // Nunca dejar el metafield sin la cuenta: sin tokens el pedido no se despacha.
  for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
  return meta;
}

module.exports = { pedirProductoDropi, construirMetafield, galeriaDe, CDN_DROPI };
