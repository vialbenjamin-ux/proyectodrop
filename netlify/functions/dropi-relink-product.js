// Cambia el PROVEEDOR / codigo Dropi de un producto ya existente en Shopify.
//
// Cambiar de proveedor toca DOS cosas, y hacer solo una deja el producto roto:
//   1. barcode de la variante            -> el ID del producto en Dropi
//   2. metafield dropi._dropi_product    -> id, name, sale_price y user{id,name}
// El metafield es el que decide a que proveedor y a que CUENTA de Dropi se
// despacha el pedido. Cambiar solo el barcode manda el pedido al proveedor
// viejo igual.
//
// El campo `tokens` del metafield NO se toca: identifica la cuenta de Dropi de
// la tienda, no al proveedor. Se informa su `sub` para poder detectar
// productos que apunten a una cuenta ajena.
//
// POST body:
//   { tenant?, product_id, dropi_id, user_name, user_id?, cost?,
//     fix_account?, dry_run? }
//
// fix_account: true reemplaza tambien el `tokens` por uno de la cuenta
// MAYORITARIA de la tienda. Sirve para productos viejos importados desde otra
// cuenta de Dropi, que rebotan con "no posee saldo suficiente en la wallet".
//
// Respuesta: { ok, antes, despues, cuenta, aviso, applied }

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Método no permitido' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON inválido' }); }

  const isGT = String(body.tenant || 'chile').toLowerCase() === 'gt';
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' + (isGT ? ' GT' : '') });

  const productId = String(body.product_id || '').trim();
  const dropiId   = String(body.dropi_id || '').trim();
  const userName  = String(body.user_name || '').trim();
  if (!productId) return respond(400, { error: 'Falta product_id' });
  if (!dropiId || !/^\d+$/.test(dropiId)) return respond(400, { error: 'dropi_id debe ser numérico' });
  if (!userName) return respond(400, { error: 'Falta user_name (nombre del proveedor)' });

  const API = 'https://' + domain + '/admin/api/2024-10';
  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const dryRun = body.dry_run === true;

  const jwtSub = (tok) => {
    try {
      const parts = String(tok || '').split('.');
      if (parts.length < 2) return null;
      let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      const p = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
      return p && p.sub != null ? String(p.sub) : null;
    } catch (_) { return null; }
  };

  // Busca en la tienda un token de la cuenta esperada. Reusa los productos de
  // muestra por proveedor (un solo scan) en vez de recorrer todo el catalogo.
  const buscarTokenDeLaCuenta = async () => {
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host = event.headers.host || '';
    const suppR = await fetch(proto + '://' + host + '/.netlify/functions/dropi-known-suppliers?tenant=' + (isGT ? 'gt' : 'chile'));
    if (!suppR.ok) return { error: 'no pude cargar proveedores de la tienda' };
    const suppliers = ((await suppR.json()).suppliers || []).filter(x => x.sampleHasTokens && x.sampleProductId);
    const vistos = [];
    for (const sup of suppliers.slice(0, 14)) {
      try {
        const r = await fetch(API + '/products/' + sup.sampleProductId + '/metafields.json?namespace=dropi', { headers: H });
        if (!r.ok) continue;
        const mfd = ((await r.json()).metafields || []).find(m => m.key === '_dropi_product');
        if (!mfd) continue;
        const v = JSON.parse(mfd.value);
        if (!v.tokens) continue;
        vistos.push({ tokens: v.tokens, shop_name: v.shop_name || null, sub: jwtSub(v.tokens), de: sup.name });
      } catch (_) {}
    }
    if (!vistos.length) return { error: 'ningun producto de la tienda tiene token legible' };
    const conteo = {};
    vistos.forEach(v => { if (v.sub) conteo[v.sub] = (conteo[v.sub] || 0) + 1; });
    const esperada = String(body.expected_account || '').trim()
      || (Object.entries(conteo).sort((a, b) => b[1] - a[1])[0] || [null])[0];
    const donante = vistos.find(v => v.sub && v.sub === esperada);
    if (!donante) return { error: 'no encontre token de la cuenta ' + (esperada || '?') + '. Vistas: ' + Object.keys(conteo).join(', ') };
    return { donante: donante, esperada: esperada };
  };

  try {
    // 1. Producto actual (para la variante y el titulo).
    const pR = await fetch(API + '/products/' + encodeURIComponent(productId) + '.json', { headers: H });
    if (!pR.ok) return respond(pR.status, { error: 'No pude leer el producto: ' + (await pR.text()).slice(0, 160) });
    const product = (await pR.json()).product;
    const variant = (product.variants || [])[0];
    if (!variant) return respond(400, { error: 'El producto no tiene variantes' });

    // 2. Metafield dropi actual.
    const mR = await fetch(API + '/products/' + encodeURIComponent(productId) + '/metafields.json?namespace=dropi', { headers: H });
    const mJ = mR.ok ? await mR.json() : { metafields: [] };
    const mf = (mJ.metafields || []).find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
    if (!mf) {
      return respond(400, {
        error: 'El producto no tiene metafield dropi._dropi_product. No fue importado desde Dropi, así que no hay proveedor que reemplazar.',
      });
    }
    let actual;
    try { actual = JSON.parse(mf.value); }
    catch { return respond(400, { error: 'El metafield dropi no es JSON válido' }); }

    const cuenta = jwtSub(actual.tokens);
    const antes = {
      barcode: variant.barcode || null,
      dropi_id: actual.id != null ? String(actual.id) : null,
      proveedor: (actual.user && actual.user.name) || null,
      user_id: (actual.user && actual.user.id != null) ? String(actual.user.id) : null,
    };

    // 3. Metafield nuevo. `tokens` y `shop_name` se conservan: son de la tienda,
    //    no del proveedor.
    const nuevo = Object.assign({}, actual, {
      id: parseInt(dropiId, 10),
      name: body.name || actual.name,
      user: {
        id: (body.user_id != null && String(body.user_id).trim() !== '') ? parseInt(body.user_id, 10) : null,
        name: userName,
      },
    });
    if (body.cost !== undefined && body.cost !== null && String(body.cost) !== '') {
      nuevo.sale_price = Number(body.cost);
    }

    const despues = {
      barcode: dropiId,
      dropi_id: dropiId,
      proveedor: userName,
      user_id: nuevo.user.id != null ? String(nuevo.user.id) : null,
    };

    const aviso = [];
    if (!nuevo.user.id) aviso.push('El proveedor queda sin user_id: Dropi lo asigna después, pero conviene completarlo si lo sabés.');
    if (!cuenta) aviso.push('No pude leer la cuenta de Dropi del token del producto.');

    // Reparar la cuenta: heredar un token de la cuenta mayoritaria.
    let cuentaNueva = cuenta;
    if (body.fix_account === true) {
      const res = await buscarTokenDeLaCuenta();
      if (res.error) return respond(400, { error: 'No pude reparar la cuenta: ' + res.error });
      if (res.esperada === cuenta) {
        aviso.push('El producto ya estaba en la cuenta ' + cuenta + ': no hacía falta repararlo.');
      } else {
        nuevo.tokens = res.donante.tokens;
        if (res.donante.shop_name) nuevo.shop_name = res.donante.shop_name;
        cuentaNueva = res.esperada;
        aviso.push('Cuenta de Dropi: ' + cuenta + ' → ' + res.esperada + ' (token heredado de "' + res.donante.de + '").');
      }
    }

    if (dryRun) return respond(200, { ok: true, applied: false, antes, despues, cuenta, cuentaNueva, aviso });

    // 4. Escribir: barcode y metafield.
    const vR = await fetch(API + '/variants/' + variant.id + '.json', {
      method: 'PUT', headers: H,
      body: JSON.stringify({ variant: { id: variant.id, barcode: dropiId } }),
    });
    if (!vR.ok) return respond(vR.status, { error: 'No pude actualizar el código de barras: ' + (await vR.text()).slice(0, 160) });

    const mW = await fetch(API + '/metafields/' + mf.id + '.json', {
      method: 'PUT', headers: H,
      body: JSON.stringify({ metafield: { id: mf.id, value: JSON.stringify(nuevo), type: 'json' } }),
    });
    if (!mW.ok) {
      return respond(mW.status, {
        error: 'Código de barras actualizado pero FALLÓ el metafield: ' + (await mW.text()).slice(0, 160)
             + ' — el producto quedó a medias, reintentá.',
      });
    }

    return respond(200, { ok: true, applied: true, titulo: product.title, antes, despues, cuenta, cuentaNueva, aviso });
  } catch (err) {
    return respond(502, { error: err.message || 'error desconocido' });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
