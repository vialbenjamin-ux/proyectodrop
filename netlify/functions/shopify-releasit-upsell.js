// Activa, desactiva o elimina un upsell 1-click de Releasit.
//
// Existe porque un upsell mete un segundo producto en el carrito, y si ese
// producto esta en otra bodega de Dropi la orden no se puede crear: una orden
// de Dropi tiene UNA bodega. Sacar el upsell era entrar a Releasit a mano.
//
// POST { tenant?, product_id, upsell_id?, action: "off" | "on" | "delete" | "set",
//        connect_product_id?, price?, activar?, dry_run? }
//   set: conecta otro producto (connect_product_id) a price pesos. Queda
//        apagado salvo activar: true.
//   product_id: producto de Shopify donde vive el upsell (campo `prods`).
//   upsell_id : cual, si el producto tiene mas de uno. Si hay uno solo, opcional.
//
// Respuesta: { ok, applied, afectados: [{id, name, isActive}], quedan }

exports.handler = async (event) => {
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
  const upsellId  = String(body.upsell_id || '').trim();
  const action    = String(body.action || '').toLowerCase();
  const dryRun    = body.dry_run === true;
  if (!productId) return respond(400, { error: 'Falta product_id' });
  if (['off', 'on', 'delete', 'set'].indexOf(action) === -1) {
    return respond(400, { error: 'action debe ser "off", "on", "delete" o "set"' });
  }
  // set: cambia QUE producto ofrece el upsell, conservando su diseño (colores,
  // borde, texto "Agrega {title} por solo {price}"). Titulo, variante e imagen
  // se leen del producto conectado para no escribirlos a mano.
  const connectId = String(body.connect_product_id || '').trim();
  const precioPesos = body.price != null && String(body.price) !== '' ? Number(body.price) : null;
  if (action === 'set') {
    if (!connectId) return respond(400, { error: 'Falta connect_product_id (producto que se ofrece)' });
    if (precioPesos == null || !(precioPesos > 0)) return respond(400, { error: 'Falta price en pesos (ej. 5990)' });
  }

  const API = 'https://' + domain + '/admin/api/2024-10';
  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' };

  try {
    const r = await fetch(API + '/metafields.json?limit=250', { headers: H });
    if (!r.ok) return respond(502, { error: 'Fetch metafields: ' + r.status });
    const j = await r.json();
    const mfUP = (j.metafields || []).find(m => m.namespace === '_rsi_cod_form_sf' && m.key === 'tick_upsells_json');
    if (!mfUP) return respond(404, { error: 'La tienda no tiene metafield tick_upsells_json' });

    let lista;
    try { lista = JSON.parse(mfUP.value); }
    catch { return respond(500, { error: 'tick_upsells_json no es JSON válido' }); }
    if (!Array.isArray(lista)) return respond(500, { error: 'tick_upsells_json no es una lista' });

    const esDelProducto = (u) => (u && Array.isArray(u.prods) ? u.prods.map(String) : []).indexOf(productId) !== -1;
    const objetivo = (u) => esDelProducto(u) && (!upsellId || String(u.id) === upsellId);

    const encontrados = lista.filter(objetivo);
    if (!encontrados.length) {
      return respond(404, {
        error: 'No hay upsell para ese producto' + (upsellId ? ' con ese id' : ''),
        delProducto: lista.filter(esDelProducto).map(u => ({ id: u.id, name: u.name })),
      });
    }
    if (encontrados.length > 1 && !upsellId) {
      return respond(400, {
        error: 'Ese producto tiene ' + encontrados.length + ' upsells. Indicá cuál con upsell_id.',
        opciones: encontrados.map(u => ({ id: u.id, name: u.name, isActive: u.isActive })),
      });
    }

    const afectados = encontrados.map(u => ({ id: u.id, name: u.name, isActive: u.isActive }));
    let cambios = null;
    if (action === 'set') {
      const pr = await fetch(API + '/products/' + encodeURIComponent(connectId) + '.json', { headers: H });
      if (!pr.ok) return respond(pr.status, { error: 'No pude leer el producto a ofrecer: ' + (await pr.text()).slice(0, 160) });
      const prod = (await pr.json()).product || {};
      const v0 = (prod.variants || [])[0];
      if (!v0) return respond(400, { error: 'El producto a ofrecer no tiene variantes' });
      if (String(prod.status) !== 'active') return respond(400, { error: 'El producto a ofrecer no esta activo (' + prod.status + ')' });
      cambios = {
        name: 'UPSELL: ' + prod.title,
        title: prod.title,
        connP: String(prod.id),
        connV: String(v0.id),
        imgUrl: (prod.image && prod.image.src) || '',
        // Releasit guarda el precio en centavos: 5990 pesos = 599000.
        price: Math.round(precioPesos * 100),
        isActive: body.activar === true,
      };
    }
    let nueva;
    if (action === 'set') {
      nueva = lista.map(u => (objetivo(u) ? Object.assign({}, u, cambios) : u));
    } else if (action === 'delete') {
      nueva = lista.filter(u => !objetivo(u));
    } else {
      const activo = action === 'on';
      nueva = lista.map(u => (objetivo(u) ? Object.assign({}, u, { isActive: activo }) : u));
    }

    if (dryRun) {
      return respond(200, { ok: true, applied: false, action, afectados, cambios, quedan: nueva.length });
    }

    const w = await fetch(API + '/metafields/' + mfUP.id + '.json', {
      method: 'PUT', headers: H,
      body: JSON.stringify({ metafield: { id: mfUP.id, value: JSON.stringify(nueva), type: 'json' } }),
    });
    if (!w.ok) {
      const t = await w.text();
      return respond(502, { error: 'No pude escribir tick_upsells_json: ' + t.slice(0, 300) });
    }

    return respond(200, { ok: true, applied: true, action, afectados, cambios, quedan: nueva.length });
  } catch (err) {
    return respond(502, { error: err.message || 'unknown' });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
