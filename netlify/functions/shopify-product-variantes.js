// Convierte un producto Shopify SIMPLE en uno con variantes (colores, tallas)
// enlazadas a las variaciones de Dropi.
//
// Por que hace falta: el importador de BKDROP siempre crea productos simples,
// porque la API de Dropi no expone los productos y no hay de donde sacar los
// ids de las variaciones. Si el producto en Dropi SI tiene variantes, el
// pedido llega sin decir cual y Dropi no puede descontar stock: rebota con
// "no posee stock en ninguna de sus bodegas". Le paso al triciclo 46226 y a la
// Prensa Masas 68523.
//
// El modelo lo copia de los productos que ya funcionan (importados con la app
// de Dropi): una opcion de Shopify, una variante por variacion, y el barcode
// con el formato <id producto Dropi>-<id variacion>. Ejemplo real:
//   Cubre Colchon 28879 -> barcodes 28879-9388, 28879-9387, 28879-9390...
//
// POST {
//   tenant?, product_id,
//   opcion?: 'Color',
//   variaciones: [{ nombre: 'Negro', variation_id: 9388, precio? }],
//   dry_run?
// }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Método no permitido' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON inválido' }); }

  const isGT = String(body.tenant || 'chile').toLowerCase() === 'gt';
  const token = isGT ? process.env.SHOPIFY_TOKEN_GT : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' + (isGT ? ' GT' : '') });

  const productId = String(body.product_id || '').trim();
  const opcion = String(body.opcion || 'Color').trim() || 'Color';
  const dryRun = body.dry_run === true;
  if (!productId) return respond(400, { error: 'Falta product_id' });

  const variaciones = Array.isArray(body.variaciones) ? body.variaciones : [];
  if (variaciones.length < 2) {
    return respond(400, { error: 'Mandá al menos 2 variaciones (nombre + variation_id)' });
  }
  for (const v of variaciones) {
    if (!v || !String(v.nombre || '').trim()) return respond(400, { error: 'Cada variación necesita nombre' });
    if (!/^\d+$/.test(String(v.variation_id || ''))) {
      return respond(400, { error: 'variation_id debe ser numérico (variación "' + v.nombre + '")' });
    }
  }
  const nombres = variaciones.map((v) => String(v.nombre).trim().toLowerCase());
  if (new Set(nombres).size !== nombres.length) return respond(400, { error: 'Hay nombres de variación repetidos' });
  const ids = variaciones.map((v) => String(v.variation_id));
  if (new Set(ids).size !== ids.length) return respond(400, { error: 'Hay variation_id repetidos' });

  const API = 'https://' + domain + '/admin/api/2024-10';
  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' };

  try {
    // 1. Producto + metafield dropi (de ahí sale el id del producto en Dropi).
    const pR = await fetch(API + '/products/' + encodeURIComponent(productId) + '.json', { headers: H });
    if (!pR.ok) return respond(pR.status, { error: 'No pude leer el producto: ' + (await pR.text()).slice(0, 160) });
    const product = (await pR.json()).product;
    const vActual = (product.variants || [])[0];
    if (!vActual) return respond(400, { error: 'El producto no tiene variantes' });
    if ((product.variants || []).length > 1) {
      return respond(400, {
        error: 'El producto ya tiene ' + product.variants.length + ' variantes. Esta herramienta solo convierte productos simples.',
      });
    }

    const mR = await fetch(API + '/products/' + encodeURIComponent(productId) + '/metafields.json?namespace=dropi', { headers: H });
    const mJ = mR.ok ? await mR.json() : { metafields: [] };
    const mf = (mJ.metafields || []).find((m) => m.namespace === 'dropi' && m.key === '_dropi_product');
    if (!mf) return respond(400, { error: 'El producto no tiene metafield dropi: no fue importado desde Dropi.' });
    let meta;
    try { meta = JSON.parse(mf.value); }
    catch { return respond(400, { error: 'El metafield dropi no es JSON válido' }); }

    // El id del producto en Dropi manda; el barcode actual sirve de respaldo.
    const parent = String(meta.id != null ? meta.id : (vActual.barcode || '')).split('-')[0];
    if (!/^\d+$/.test(parent)) return respond(400, { error: 'No pude determinar el id del producto en Dropi' });

    const precioBase = vActual.price;
    const nuevasVariantes = variaciones.map((v, i) => ({
      option1: String(v.nombre).trim(),
      price: (v.precio != null && String(v.precio) !== '') ? String(v.precio) : String(precioBase),
      sku: String(product.title || '').slice(0, 60) + '-' + String(v.nombre).trim().toLowerCase(),
      barcode: parent + '-' + String(v.variation_id),
      // Dropi despacha: Shopify no debe frenar la venta por stock propio.
      inventory_management: null,
      inventory_policy: 'continue',
      taxable: false,
      position: i + 1,
    }));

    const plan = {
      producto: { id: String(product.id), title: product.title, variantesActuales: (product.variants || []).length },
      dropi: { id: parent, tipoActual: meta.type || null },
      opcion,
      variantes: nuevasVariantes.map((v) => ({ nombre: v.option1, barcode: v.barcode, precio: v.price, sku: v.sku })),
      avisos: [
        'La variante actual se reemplaza: su id cambia. Si esta variante estaba usada como upsell en Releasit, hay que volver a elegirla.',
      ],
    };
    if (dryRun) return respond(200, { ok: true, applied: false, plan });

    // 2. Reemplazar opciones y variantes.
    const uR = await fetch(API + '/products/' + encodeURIComponent(productId) + '.json', {
      method: 'PUT', headers: H,
      body: JSON.stringify({ product: {
        id: Number(productId),
        options: [{ name: opcion, position: 1 }],
        variants: nuevasVariantes,
      } }),
    });
    if (!uR.ok) return respond(uR.status, { error: 'No pude crear las variantes: ' + (await uR.text()).slice(0, 300) });
    const actualizado = (await uR.json()).product;

    // 3. Metafield: pasa a VARIABLE con sus variaciones, como los que funcionan.
    const metaNuevo = Object.assign({}, meta, {
      type: 'VARIABLE',
      variations: variaciones.map((v) => ({
        id: Number(v.variation_id),
        name: String(v.nombre).trim(),
        attribute_values: [{ value: String(v.nombre).trim() }],
      })),
      variationstoimport: variaciones.map((v) => String(v.variation_id)),
      chose_variations: variaciones.map((v) => String(v.variation_id)),
    });
    const mW = await fetch(API + '/metafields/' + mf.id + '.json', {
      method: 'PUT', headers: H,
      body: JSON.stringify({ metafield: { id: mf.id, value: JSON.stringify(metaNuevo), type: 'json' } }),
    });
    if (!mW.ok) {
      return respond(502, {
        error: 'Las variantes se crearon pero no pude actualizar el metafield: ' + (await mW.text()).slice(0, 300),
        hint: 'El producto queda con variantes en Shopify pero como SIMPLE en Dropi. Reintentá.',
      });
    }

    return respond(200, {
      ok: true, applied: true, plan,
      variantesCreadas: (actualizado.variants || []).map((v) => ({
        id: String(v.id), nombre: v.title, barcode: v.barcode, precio: v.price,
      })),
    });
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
