// Reescribe el metafield dropi._dropi_product de un producto que ya existe en
// Shopify, con el objeto COMPLETO que devuelve la API de Dropi.
//
// Para que sirve: los productos creados por el importador de BKDROP quedaron
// con un metafield de 7 a 9 campos. Dropi espera bastante mas y, cuando no los
// encuentra, no sincroniza el pedido: cae entero en DROPITEA y hay que pasarlo
// a mano. Esta funcion los repara sin tocar el producto en si -- ni el titulo,
// ni el precio, ni las fotos, ni el barcode.
//
// Lo que NO se pisa nunca:
//   tokens / shop_name  -> identifican la CUENTA de Dropi de la tienda. Se
//                          conservan los que ya tenia el producto.
//   variationstoimport / chose_variations -> si alguien eligio variaciones a
//                          mano, esa eleccion manda.
//
// GET  ?tenant=gt&product_id=123            -> muestra el antes y el despues
// POST { tenant, product_id, dry_run }      -> uno solo
// POST { tenant, todos: true, max, dry_run } -> todos los que tengan el
//        metafield corto (menos de `minimo` campos, por defecto 15)
//
// Respuesta: { ok, revisados, reparados, detalle: [...] }

const { pedirProductoDropi, construirMetafield } = require('./_dropi-metafield');

// Debajo de esto el metafield es el corto del importador. Un metafield escrito
// por la app de Dropi anda en 30 y tantos campos; el del importador, en 9.
const MINIMO_SANO = 15;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };

  const qs = event.queryStringParameters || {};
  let body = {};
  if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body || '{}'); }
    catch { return respond(400, { error: 'JSON invalido' }); }
  }

  const tenant = String(body.tenant || qs.tenant || 'chile').toLowerCase();
  const isGT = tenant === 'gt';
  const token = isGT ? process.env.SHOPIFY_TOKEN_GT : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify de ' + tenant });

  const API = 'https://' + domain + '/admin/api/2024-10';
  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' };

  // En GET siempre se mira, nunca se escribe.
  const dryRun = event.httpMethod === 'GET' ? true : (body.dry_run === true);
  const minimo = Math.max(1, parseInt(body.minimo || qs.minimo, 10) || MINIMO_SANO);
  const productId = String(body.product_id || qs.product_id || '').trim();
  const todos = body.todos === true || qs.todos === '1';
  // Tope bajo a proposito: cada producto son dos llamadas a Shopify y una a
  // Dropi, y Dropi corta con "Too Many Attempts" si se le pide de golpe.
  const max = Math.min(Math.max(parseInt(body.max || qs.max, 10) || 10, 1), 25);

  if (!productId && !todos) return respond(400, { error: 'Falta product_id (o todos:true)' });

  try {
    const objetivos = productId
      ? [{ id: productId }]
      : await cortosDelCatalogo(domain, H, minimo, max);

    if (!objetivos.length) {
      return respond(200, { ok: true, tenant, revisados: 0, reparados: 0, dryRun,
        nota: 'No encontre productos con el metafield corto.' });
    }

    const detalle = [];
    let reparados = 0;
    let bloqueado = false;
    for (const o of objetivos) {
      const r = await repararUno(API, H, isGT, String(o.id), dryRun, minimo);
      detalle.push(r);
      if (r.reparado) reparados++;
      // Dropi aguanta unas siete consultas seguidas y despues corta con "Too
      // Many Attempts". Seguir intentando no sirve de nada: la primera corrida
      // de 19 productos quemo 12 contra la pared. Se para en seco y se avisa
      // cuantos quedaron, para volver mas tarde.
      if (String(r.error || '').indexOf('Too Many Attempts') >= 0) { bloqueado = true; break; }
      if (objetivos.length > 1) await new Promise((s) => setTimeout(s, 1200));
    }

    const quedan = objetivos.length - detalle.length;
    return respond(200, {
      ok: true, tenant, dryRun, revisados: detalle.length, reparados, bloqueado,
      ...(bloqueado ? { nota: 'Dropi corto por exceso de consultas. Quedaron ' + (quedan + 1)
        + ' sin revisar de esta tanda: volve a correrlo en un rato.' } : {}),
      detalle,
    });
  } catch (err) {
    return respond(502, { error: err.message || 'error desconocido' });
  }
};

// Un producto: lee su metafield, le pide el objeto a Dropi y lo reescribe.
async function repararUno(API, H, isGT, productId, dryRun, minimo) {
  const mfR = await fetch(API + '/products/' + encodeURIComponent(productId) + '/metafields.json?namespace=dropi', { headers: H });
  if (!mfR.ok) return { productId, error: 'no pude leer los metafields: ' + mfR.status };
  const mf = ((await mfR.json()).metafields || []).find((m) => m.key === '_dropi_product');

  // Sin metafield no se sabe el id de Dropi por ahi: se saca del barcode.
  let previo = null;
  let dropiId = null;
  if (mf && mf.value) {
    try { previo = JSON.parse(mf.value); } catch (_) { previo = null; }
    if (previo && previo.id != null) dropiId = String(previo.id).split('-')[0];
  }
  if (!dropiId) {
    const pR = await fetch(API + '/products/' + encodeURIComponent(productId) + '.json?fields=id,title,variants', { headers: H });
    if (pR.ok) {
      const v0 = (((await pR.json()).product || {}).variants || [])[0];
      const b = String((v0 || {}).barcode || '').trim();
      if (/^\d/.test(b)) dropiId = b.split('-')[0];
    }
  }
  if (!dropiId) return { productId, error: 'no pude deducir el id de Dropi (sin metafield y sin barcode)' };

  const campoAntes = previo ? Object.keys(previo).length : 0;

  const producto = await pedirProductoDropi(isGT, dropiId);
  if (producto && producto.bloqueado) {
    return { productId, dropiId, campoAntes, error: 'Dropi esta bloqueando las consultas (Too Many Attempts): reintenta en un rato' };
  }
  if (!producto) return { productId, dropiId, campoAntes, error: 'Dropi no conoce el id ' + dropiId };

  const nuevo = construirMetafield(producto, previo, {});
  const campoDespues = Object.keys(nuevo).length;

  // Si el metafield ya venia completo no se toca: reescribirlo por reescribirlo
  // solo arriesga perder algo que la app de Dropi haya puesto.
  //
  // El corte usa `minimo` y no la constante: tras un relink el metafield queda
  // con MUCHOS campos pero del producto viejo (bodega, costo y proveedor del
  // anterior), y contarlos lo daba por sano. Subiendo `minimo` por encima de
  // los campos que tiene se lo puede forzar a traer el del producto correcto.
  const corte = Number(minimo) > 0 ? Number(minimo) : MINIMO_SANO;
  if (campoAntes >= campoDespues && campoAntes >= corte) {
    return { productId, dropiId, campoAntes, campoDespues, reparado: false, nota: 'ya estaba completo' };
  }
  // Sin tokens el pedido no se despacha: mejor avisar que escribir un metafield
  // completo pero mudo.
  const avisos = [];
  if (!nuevo.tokens) avisos.push('el producto no tenia tokens: Dropi no va a poder despachar hasta que se le copien de otro producto');

  // En un VARIABLE la app de Dropi deja en cada variante de Shopify el SKU de
  // la variacion de Dropi. Las que arma BKDROP llevan un SKU inventado con el
  // titulo: se alinean, usando el barcode <producto>-<variacion> para saber
  // cual es cual.
  const skus = await planDeSkus(API, H, productId, dropiId, nuevo);

  if (dryRun) {
    return { productId, dropiId, campoAntes, campoDespues, reparado: false, dryRun: true,
      nuevosCampos: Object.keys(nuevo).filter((k) => !previo || !(k in previo)), skus, avisos };
  }

  const cuerpo = { metafield: { namespace: 'dropi', key: '_dropi_product', value: JSON.stringify(nuevo), type: 'json' } };
  let wR;
  if (mf && mf.id) {
    cuerpo.metafield.id = mf.id;
    wR = await fetch(API + '/metafields/' + mf.id + '.json', { method: 'PUT', headers: H, body: JSON.stringify(cuerpo) });
  } else {
    wR = await fetch(API + '/products/' + encodeURIComponent(productId) + '/metafields.json', { method: 'POST', headers: H, body: JSON.stringify(cuerpo) });
  }
  if (!wR.ok) return { productId, dropiId, campoAntes, error: 'no pude escribir el metafield: ' + (await wR.text()).slice(0, 200) };

  for (const s of skus) {
    const sR = await fetch(API + '/variants/' + s.variantId + '.json', {
      method: 'PUT', headers: H, body: JSON.stringify({ variant: { id: Number(s.variantId), sku: s.despues } }),
    });
    s.aplicado = sR.ok;
    if (!sR.ok) avisos.push('no pude cambiar el SKU de la variante ' + s.variantId + ': ' + sR.status);
  }

  return { productId, dropiId, campoAntes, campoDespues, reparado: true,
    nuevosCampos: Object.keys(nuevo).filter((k) => !previo || !(k in previo)), skus, avisos };
}

// Que variantes de Shopify tienen un SKU distinto al de su variacion en Dropi.
// Solo para productos VARIABLE; en un simple devuelve [].
async function planDeSkus(API, H, productId, dropiId, meta) {
  if (String(meta.type || '').toUpperCase() !== 'VARIABLE') return [];
  const skuDropi = new Map((meta.variations || []).filter((v) => v.sku).map((v) => [String(v.id), String(v.sku)]));
  if (!skuDropi.size) return [];
  const pR = await fetch(API + '/products/' + encodeURIComponent(productId) + '.json?fields=id,variants', { headers: H });
  if (!pR.ok) return [];
  const plan = [];
  for (const v of (((await pR.json()).product || {}).variants || [])) {
    const m = String(v.barcode || '').trim().match(/^(\d+)-(\d+)$/);
    if (!m || m[1] !== String(dropiId)) continue;
    const esperado = skuDropi.get(m[2]);
    if (esperado && esperado !== v.sku) plan.push({ variantId: String(v.id), variante: v.title, antes: v.sku, despues: esperado });
  }
  return plan;
}

// Los productos cuyo metafield tiene menos de `minimo` campos. Se recorre con
// GraphQL para traer el metafield en la misma consulta.
async function cortosDelCatalogo(domain, H, minimo, max) {
  const GQL = 'https://' + domain + '/admin/api/2024-10/graphql.json';
  const QUERY = [
    'query($cursor: String) {',
    '  products(first: 250, after: $cursor) {',
    '    pageInfo { hasNextPage endCursor }',
    '    edges { node {',
    '      id title',
    '      metafield(namespace: "dropi", key: "_dropi_product") { value }',
    '    } }',
    '  }',
    '}',
  ].join('\n');

  const out = [];
  let cursor = null;
  for (let pagina = 0; pagina < 8; pagina++) {
    const r = await fetch(GQL, { method: 'POST', headers: H, body: JSON.stringify({ query: QUERY, variables: { cursor } }) });
    if (!r.ok) throw new Error('GraphQL ' + r.status);
    const j = await r.json();
    if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors).slice(0, 200));
    const conn = ((j.data || {}).products) || {};
    for (const e of (conn.edges || [])) {
      const n = e.node || {};
      if (!n.metafield || !n.metafield.value) continue;   // sin vinculo: es otro problema
      let o; try { o = JSON.parse(n.metafield.value); } catch (_) { continue; }
      if (Object.keys(o).length >= minimo) continue;
      out.push({ id: String(n.id).split('/').pop(), title: n.title, campos: Object.keys(o).length });
      if (out.length >= max) return out;
    }
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

function respond(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
