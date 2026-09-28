// Resuelve un producto a partir de su ID de Dropi y el pais, para que
// Landing Auto necesite solo esos dos datos.
//
// Dos fuentes, en este orden:
//
// 1. LA API DE DROPI: GET /integrations/products/v2/{id} con el header
//    dropi-integration-key. Da el nombre, el costo, el proveedor y las fotos
//    AUNQUE EL PRODUCTO NO ESTE EN SHOPIFY, que es lo que hace falta para
//    crearlo con solo el ID. Las fotos vienen en `photos` (no en `images` ni
//    `gallery`) y casi siempre con `url` vacia: hay que armar la URL pegando
//    el CDN delante de `urlS3` y codificando la ruta, o da 403.
//    Esta ruta no aparece en la documentacion publica; salio del instructivo
//    que paso Benjamin el 28 sep 2026. Antes se probaron 14 rutas
//    (/products/search, /products/list, /catalog...) y todas daban 400/404,
//    de ahi la idea equivocada de que Dropi no exponia productos.
//
// 2. SHOPIFY: el barcode de la variante es el ID de Dropi y el metafield
//    dropi._dropi_product trae el nombre del proveedor. Sirve para saber si el
//    producto YA esta importado y con que id de Shopify.
//
// GET /.netlify/functions/dropi-producto-por-id?tenant=chile&dropi_id=66774
//
// Respuesta:
//   { encontrado, enDropi, enShopify, tenant, dropiId, titulo, nombreDropi,
//     descripcion, fotos: [url], costo, proveedor, proveedorId, tipo,
//     variaciones, stock, shopifyId, handle, camposMetafield }

const CDN_DROPI = 'https://d39ru7awumhhs2.cloudfront.net/';

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

  let desdeDropi = await pedirADropi(isGT, dropiId);
  // Si Dropi esta bloqueando, se sigue con lo de Shopify pero avisando: no es
  // lo mismo "no existe" que "no pude preguntar".
  const dropiBloqueado = !!(desdeDropi && desdeDropi.bloqueado);
  if (dropiBloqueado) desdeDropi = null;

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
      // No esta en Shopify, pero si Dropi lo conoce alcanza para crearlo.
      if (desdeDropi) {
        return respond(200, {
          encontrado: true, enDropi: true, dropiBloqueado, enShopify: false,
          tenant, dropiId,
          shopifyId: null, handle: null, status: null,
          titulo: desdeDropi.nombre,
          nombreDropi: desdeDropi.nombre,
          descripcion: desdeDropi.descripcion,
          costo: desdeDropi.costo,
          proveedor: desdeDropi.proveedor,
          proveedorId: desdeDropi.proveedorId,
          tipo: desdeDropi.tipo,
          variaciones: desdeDropi.variaciones,
          stock: desdeDropi.stock,
          fotos: desdeDropi.fotos,
          fotoPrincipal: desdeDropi.fotos[0] || null,
          nota: 'Esta en Dropi pero todavia no en Shopify ' + (isGT ? 'GT' : 'Chile') + '.',
        });
      }
      return respond(200, {
        encontrado: false, enDropi: false, enShopify: false, dropiBloqueado, tenant, dropiId,
        motivo: dropiBloqueado
          ? 'Dropi esta bloqueando las consultas (Too Many Attempts). Espera un rato y reintenta.'
          : 'Ni Dropi ni Shopify ' + (isGT ? 'GT' : 'Chile') + ' conocen el ID ' + dropiId
              + '. Revisa que sea el ID del catalogo de ese pais.',
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

    // Lo de Dropi manda sobre lo del metafield: el metafield puede ser el corto
    // de 12 campos que escribe el importador de BKDROP.
    const fotos = (desdeDropi && desdeDropi.fotos.length ? desdeDropi.fotos
                  : (fotosDropi.length ? fotosDropi : fotosShopify)).slice(0, 12);

    return respond(200, {
      encontrado: true,
      enDropi: !!desdeDropi,
      dropiBloqueado,
      enShopify: true,
      tenant, dropiId,
      shopifyId: p.legacyResourceId || null,
      titulo: p.title || '',
      handle: p.handle || '',
      status: p.status || null,
      nombreDropi: (desdeDropi && desdeDropi.nombre) || (meta && meta.name) || '',
      descripcion: (desdeDropi && desdeDropi.descripcion) || (meta && meta.description) || '',
      costo: desdeDropi ? desdeDropi.costo : null,
      proveedor: (desdeDropi && desdeDropi.proveedor) || (meta && meta.user && meta.user.name) || null,
      proveedorId: desdeDropi ? desdeDropi.proveedorId : ((meta && meta.user && meta.user.id) || null),
      tipo: (desdeDropi && desdeDropi.tipo) || (meta && meta.type) || null,
      variaciones: desdeDropi ? desdeDropi.variaciones : ((meta && meta.variations) || []).length,
      stock: desdeDropi ? desdeDropi.stock : null,
      camposMetafield: meta ? Object.keys(meta).length : 0,
      fotos,
      fotoPrincipal: fotos[0] || (p.featuredImage && p.featuredImage.url) || null,
    });
  } catch (err) {
    return respond(502, { error: err.message || 'error desconocido' });
  }
};

// Le pregunta el producto a Dropi. Devuelve null si la llave no esta, si Dropi
// no lo conoce o si la llamada falla: la funcion sigue con lo de Shopify.
async function pedirADropi(isGT, dropiId) {
  const key = String((isGT ? process.env.DROPI_TOKEN_GT : process.env.DROPI_TOKEN_CL) || '').trim();
  if (!key) return null;
  const base = isGT ? 'https://api.dropi.gt' : 'https://api.dropi.cl';
  try {
    const r = await fetch(base + '/integrations/products/v2/' + encodeURIComponent(dropiId), {
      headers: { 'dropi-integration-key': key, 'User-Agent': 'BKDROP-Sync/1.0' },
    });
    if (!r.ok) {
      // 429 = "Too Many Attempts". Dropi corta por horas y devolver null aca
      // hace que el producto parezca inexistente: una auditoria de 100
      // consultas seguidas marcaba como rotos productos que estaban bien.
      if (r.status === 429) return { bloqueado: true };
      return null;
    }
    const j = await r.json();
    const o = j.objects || j.object || null;
    const p = Array.isArray(o) ? o[0] : o;
    if (!p || !p.id) return null;

    // Las fotos: la principal primero. `url` casi siempre viene vacia, asi que
    // se arma con el CDN + urlS3 codificado (sin codificar da 403).
    const fotos = [];
    const pics = (p.photos || []).slice().sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0));
    for (const g of pics) {
      let u = g.url || null;
      if (!u && g.urlS3) {
        u = CDN_DROPI + String(g.urlS3).split('/').map(encodeURIComponent).join('/');
      }
      if (u && !fotos.includes(u)) fotos.push(u);
    }

    return {
      nombre: p.name || '',
      descripcion: p.description || '',
      // Dropi llama `sale_price` al costo para el dropshipper.
      costo: Number(p.sale_price != null ? p.sale_price : p.price) || null,
      proveedor: (p.user && (p.user.name || p.user.store_name)) || null,
      proveedorId: (p.user && p.user.id) != null ? String(p.user.id) : null,
      tipo: p.type || null,
      variaciones: (p.variations || []).length,
      stock: p.stock != null ? Number(p.stock) : null,
      fotos,
    };
  } catch (_) {
    return null;
  }
}

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
