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

// Dropi sirve los archivos de cada pais desde un CloudFront DISTINTO. Hasta el
// 29 sep 2026 se usaba el de Chile para los dos, y por eso TODA foto de
// Guatemala daba 403 AccessDenied: la llave (urlS3) existe, pero en el otro
// bucket. Con el host correcto la misma llave devuelve 200 image/jpeg.
const CDN_DROPI = 'https://d39ru7awumhhs2.cloudfront.net/';
const CDN_DROPI_GT = 'https://d2ob47cxeawi8a.cloudfront.net/';

// El pais sale de la propia llave ("guatemala/products/..."), asi que no hay
// que arrastrar el tenant hasta aca: cualquier llamador acierta el host.
function urlFoto(urlS3) {
  const k = String(urlS3 || '');
  const host = /^guatemala\//i.test(k) ? CDN_DROPI_GT : CDN_DROPI;
  return host + k.split('/').map(encodeURIComponent).join('/');
}

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
    if (!u && g.urlS3) u = urlFoto(g.urlS3);
    if (u && !out.some((x) => x.url === u)) out.push({ url: u });
  }
  return out;
}

// Deja la parte de variantes como la escribe la app de Dropi al importar.
//
// Los productos VARIABLE armados desde BKDROP no sincronizaban ni uno: la
// camara 173462 reboto 15 de 15 pedidos con "Esta orden no tiene productos
// dropi", igual que el triciclo 46226, aunque el resto del metafield era el
// mismo que el de productos simples que si pasan. Comparado contra uno
// importado por la app (Cubre Colchon 28879), diferian tres cosas, y aca se
// igualan las tres porque no hay forma de probar cual es la que mira Dropi:
//   attributes        -> la lista de atributos del producto. La API v2 no la
//                        manda suelta, pero viene anidada en cada variacion.
//   attribute_values  -> la app guarda `attribute_name` al lado del valor.
//   chose_variations  -> [{ "54040": null }], no ["54040"].
function formaDeLaAppDropi(meta) {
  const atributos = new Map();
  for (const v of (meta.variations || [])) {
    for (const av of (v.attribute_values || [])) {
      const attr = av.attribute || {};
      const attrId = av.attribute_id != null ? av.attribute_id : attr.id;
      if (av.attribute_name == null && attr.description != null) av.attribute_name = attr.description;
      if (attrId == null) continue;
      if (!atributos.has(attrId)) {
        atributos.set(attrId, {
          id: attrId,
          description: av.attribute_name != null ? av.attribute_name : null,
          product_id: attr.product_id != null ? attr.product_id : meta.id,
          isVariation: attr.isVariation != null ? attr.isVariation : true,
          deleted_at: null,
          values: [],
        });
      }
      const valores = atributos.get(attrId).values;
      if (av.id != null && !valores.some((x) => x.id === av.id)) {
        valores.push({ id: av.id, value: av.value, attribute_id: attrId,
          attribute_name: av.attribute_name != null ? av.attribute_name : null, deleted_at: null });
      }
    }
  }
  if (!(meta.attributes && meta.attributes.length) && atributos.size) meta.attributes = [...atributos.values()];

  meta.chose_variations = (meta.chose_variations || []).map((x) =>
    (x && typeof x === 'object') ? x : { [String(x)]: null });
}

// Los campos que la app de Dropi escribe y la API v2 NO devuelve.
//
// 11 oct 2026. En 7 dias NINGUNA orden con barcode de variante entro a Dropi:
// 42 de 42 rebotaron con "Esta orden no tiene productos dropi" (Rueda
// Abdominal 28052, Camara 173462, Parche de Cuero GT 16114). Comparando
// contra el Cubre Colchon 28879 -- VARIABLE importado con la app de Dropi,
// que si sincroniza -- la unica diferencia que quedaba era el tamano del
// objeto: 33 campos el de la app, 24 el nuestro. La API v2 simplemente no
// manda estos 14, asi que hay que ponerlos nosotros.
//
// A nivel de variacion faltaban dos mas: `stock` y
// `private_product_inventories_rest`. El de la app los trae en cada
// variacion; los nuestros traian `created_at`/`updated_at` y ningun stock.
//
// No se sabe cual de todos es el que Dropi mira. Se igualan todos porque
// probar de a uno cuesta un pedido real cada vez.
function camposDeLaAppDropi(meta) {
  const sumaBodegas = (lista) => (lista || [])
    .reduce((a, w) => a + Number((w && w.stock) || 0), 0);

  // Stock por variacion: la API v2 lo deja solo dentro de
  // warehouse_product_variation, no como campo suelto.
  for (const v of (meta.variations || [])) {
    if (v.stock == null) v.stock = sumaBodegas(v.warehouse_product_variation);
    if (v.private_product_inventories_rest == null) v.private_product_inventories_rest = 0;
  }

  const esVariable = String(meta.type || '').toUpperCase() === 'VARIABLE';
  if (meta.stock == null) {
    meta.stock = esVariable
      ? (meta.variations || []).reduce((a, v) => a + Number(v.stock || 0), 0)
      : sumaBodegas(meta.warehouse_product);
  }

  if (meta.suggested_price_to_show == null) {
    const pr = meta.suggested_price != null ? meta.suggested_price : meta.sale_price;
    meta.suggested_price_to_show = pr != null ? Number(pr).toFixed(2) : null;
  }

  const porDefecto = {
    productaction: 'NEW',
    external_id: null,
    import_list: [],
    add_stock_in_return: null,
    dropi_percent_product_supplier: null,
    dropi_product_supplier_increment_fixed: false,
    dropi_percent_product_drops: null,
    // Los sob_* son "sobreescribir": que campos manda el proveedor y cuales
    // el vendedor. Copiados tal cual del metafield de referencia.
    sob_nombre: true,
    sob_descripcion: true,
    sob_precio: false,
    sob_barcode: false,
    sob_images: true,
  };
  for (const k of Object.keys(porDefecto)) {
    if (meta[k] === undefined || meta[k] === null) meta[k] = porDefecto[k];
  }
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
    meta.variationstoimport = ((p.variationstoimport && p.variationstoimport.length)
      ? p.variationstoimport : ids).map((x) => String(x));
    meta.chose_variations = (p.chose_variations && p.chose_variations.length)
      ? p.chose_variations : ids;
    formaDeLaAppDropi(meta);
  }

  // Va para los dos tipos: al SIMPLE tambien le faltaban los 14 campos.
  camposDeLaAppDropi(meta);

  // Nunca dejar el metafield sin la cuenta: sin tokens el pedido no se despacha.
  for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
  return meta;
}

module.exports = { pedirProductoDropi, construirMetafield, camposDeLaAppDropi, galeriaDe, CDN_DROPI, CDN_DROPI_GT, urlFoto };
