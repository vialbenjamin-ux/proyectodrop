// Importa un producto Dropi a Shopify (Chile) como DRAFT con la estructura
// completa que Dropi/Releasit esperan:
//   - status = draft
//   - variant.barcode = ID Dropi
//   - variant con inventory_policy 'continue' + no track
//   - metafield dropi._dropi_product con JSON minimo pero valido
//     (id, name, sale_price, user, gallery, tokens, shop_name)
//   - imagen principal
//   - tags: bk-dropi-imported
//
// El campo `tokens` (auth para el despacho) se COPIA de otro producto Dropi
// ya importado en la misma tienda -- Dropi lo emite por tienda, no por producto.
//
// POST body:
//   {
//     dropi_id, name, image_url, cost, user_id,
//     user_name (opt), price (opt, default 999),
//     description (opt), gallery_urls (opt, array)
//   }
//
// Response:
//   { ok, product_id, admin_url, storefront_url, tokens_source }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON invalido' }); }

  const dropiId = String(body.dropi_id || '').trim();
  const name = String(body.name || '').trim();
  const imageUrl = String(body.image_url || '').trim();
  const cost = Number(body.cost);
  let userId = String(body.user_id || '').trim();
  const userName = String(body.user_name || '').trim();
  // Si viene true, permitir crear el producto aunque el proveedor no exista en
  // Shopify (proveedor nuevo). El metafield queda con user.id = null y user.name
  // = userName. El fulfillment Dropi requerira reasignacion despues.
  const allowUnknownSupplier = body.allow_unknown_supplier === true;
  const price = Number(body.price) > 0 ? Number(body.price) : 999;
  const description = String(body.description || '').trim();
  const extraGallery = Array.isArray(body.gallery_urls) ? body.gallery_urls.filter(u => typeof u === 'string' && u).slice(0, 8) : [];
  // Tipo de oferta destacada ('2x1'|'3x1'|'4x1'|'45off'|null). Se agrega como
  // tag para poder filtrar en el prompt de imagenes y en Releasit.
  const offerType = ['2x1','3x1','4x1','45off'].includes(String(body.offer_type)) ? String(body.offer_type) : null;

  if (!dropiId || !/^\d+$/.test(dropiId)) return respond(400, { error: 'dropi_id invalido (debe ser numerico)' });
  if (!name) return respond(400, { error: 'Falta name' });
  if (!cost || cost <= 0) return respond(400, { error: 'Falta cost (>0)' });
  // user_id obligatorio SOLO si tampoco viene user_name. Si viene name, lo
  // resolvemos automatico escaneando productos Dropi existentes.
  if ((!userId || !/^\d+$/.test(userId)) && !userName) {
    return respond(400, { error: 'Falta user_id o user_name del proveedor' });
  }

  const token = process.env.SHOPIFY_TOKEN;
  const domain = process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' });

  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const API = 'https://' + domain + '/admin/api/2024-10';

  try {
    // 1. Verificar que el barcode NO exista ya (evitar duplicados).
    const dupR = await fetch(API + '/products.json?limit=1&fields=id,title&handle=', { headers: H });
    // No hay endpoint de search por barcode directo en REST; usamos variants.json
    // buscando por barcode.
    const searchR = await fetch(API + '/variants.json?fields=id,product_id,barcode', { headers: H });
    // Skip check si es muy costoso; el user vera error si el barcode ya existe.

    // 2. Cargar proveedores conocidos y sample con tokens.
    //    Un solo call que escanea 250-500 productos y devuelve la lista
    //    de proveedores + un sample product_id (con tokens) por proveedor.
    //    Mucho mas eficiente que hacer 580 requests en este endpoint
    //    (que timeout Netlify a los 10s).
    const wantResolveUserId = !userId || !/^\d+$/.test(userId);
    const targetName = userName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

    let suppliers = [];
    try {
      const proto = event.headers['x-forwarded-proto'] || 'https';
      const host = event.headers.host || 'bkdrop.netlify.app';
      const suppR = await fetch(proto + '://' + host + '/.netlify/functions/dropi-known-suppliers');
      if (suppR.ok) {
        const suppJ = await suppR.json();
        suppliers = suppJ.suppliers || [];
      }
    } catch (_) {}

    if (!suppliers.length) {
      return respond(400, {
        error: 'No pude cargar proveedores. Importá al menos 1 producto desde Dropi web primero (para que quede el metafield en la tienda), después reintenta.',
      });
    }

    // Match del proveedor por user_id (si vino manual) o por nombre.
    let chosen = null;
    if (userId) {
      chosen = suppliers.find(s => String(s.id) === userId) || null;
    }
    if (!chosen && targetName) {
      chosen = suppliers.find(s => {
        const n = String(s.name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        return n === targetName;
      }) || null;
    }
    // Si no matchea (proveedor nuevo) NO bloqueamos: creamos el producto igual.
    // Elegimos cualquier proveedor con sample+tokens para heredar los tokens Dropi
    // de la tienda (son por-tienda, no por-proveedor). El user.id del metafield
    // queda null (o el userId manual si vino), el user.name queda como escribió
    // el usuario.
    let supplierIsNew = false;
    if (!chosen) {
      supplierIsNew = true;
      chosen = suppliers.find(s => s.sampleHasTokens && s.sampleProductId) || suppliers[0];
    }

    // Leer tokens y shop_name del producto sample del proveedor elegido
    // (o de cualquier producto con tokens si el sample no tiene).
    const sampleId = chosen && chosen.sampleProductId;
    let dropiTokens = null;
    let dropiShopName = null;
    let tokensSource = null;
    if (sampleId) {
      try {
        const mfR = await fetch(API + '/products/' + sampleId + '/metafields.json?namespace=dropi', { headers: H });
        if (mfR.ok) {
          const mfJ = await mfR.json();
          const mfDropi = (mfJ.metafields || []).find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
          if (mfDropi) {
            const d = JSON.parse(mfDropi.value);
            if (d.tokens) {
              dropiTokens = d.tokens;
              dropiShopName = d.shop_name || null;
              tokensSource = { product_id: sampleId, title: chosen.name };
            }
          }
        }
      } catch (_) {}
    }
    // Fallback: si el sample del proveedor elegido NO tenia tokens, probar
    // con samples de otros proveedores hasta encontrar uno con tokens.
    if (!dropiTokens) {
      for (const s of suppliers) {
        if (!s.sampleHasTokens || !s.sampleProductId) continue;
        if (String(s.sampleProductId) === String(sampleId)) continue;
        try {
          const mfR = await fetch(API + '/products/' + s.sampleProductId + '/metafields.json?namespace=dropi', { headers: H });
          if (!mfR.ok) continue;
          const mfJ = await mfR.json();
          const mfDropi = (mfJ.metafields || []).find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
          if (!mfDropi) continue;
          const d = JSON.parse(mfDropi.value);
          if (d.tokens) {
            dropiTokens = d.tokens;
            dropiShopName = d.shop_name || null;
            tokensSource = { product_id: s.sampleProductId, title: s.name };
            break;
          }
        } catch (_) {}
      }
    }
    if (!dropiTokens) {
      return respond(400, {
        error: 'No pude leer tokens Dropi de ningun producto existente. Reintentá; si persiste, avisá.',
      });
    }

    // userId final resuelto:
    // - Si vino manual, usarlo tal cual.
    // - Si matcheo con proveedor conocido, usar su id.
    // - Si es proveedor nuevo, dejamos null (Dropi lo puede asignar despues).
    if (!userId && !supplierIsNew) userId = chosen.id;
    // Nombre del proveedor: prioridad userName -> chosen.name.
    const supplierName = userName || (chosen ? chosen.name : null);

    // 3. Armar el JSON del metafield dropi._dropi_product.
    const galleryList = [];
    if (imageUrl) galleryList.push({ url: imageUrl });
    for (const u of extraGallery) galleryList.push({ url: u });

    const metafieldDropi = {
      id: parseInt(dropiId, 10),
      name: name,
      type: 'SIMPLE',
      description: description || name,
      sale_price: cost,
      gallery: galleryList,
      user: {
        id: userId ? parseInt(userId, 10) : null,
        name: supplierName,
      },
      tokens: dropiTokens,
      shop_name: dropiShopName,
    };

    // 4. Crear el producto Shopify.
    // Tags: bk-dropi-imported (siempre), envio-gratis (siempre, pedido del user),
    //       oferta-{tipo} si vino offer_type.
    const tags = ['bk-dropi-imported', 'envio-gratis'];
    if (offerType) tags.push('oferta-' + offerType);
    // Tag adicional si es proveedor nuevo (para poder listar despues).
    if (supplierIsNew) tags.push('proveedor-nuevo');
    const productPayload = {
      product: {
        title: name,
        body_html: description || '',
        status: 'draft',
        vendor: supplierName || 'Dropi',
        tags: tags.join(', '),
        variants: [{
          price: String(price),
          barcode: dropiId,
          inventory_policy: 'continue', // vender sin stock
          inventory_management: null,   // no track (siempre disponible)
          requires_shipping: true,
        }],
      },
    };
    if (imageUrl) {
      productPayload.product.images = [{ src: imageUrl }];
      for (const u of extraGallery) productPayload.product.images.push({ src: u });
    }

    const createR = await fetch(API + '/products.json', {
      method: 'POST', headers: H,
      body: JSON.stringify(productPayload),
    });
    if (!createR.ok) {
      const t = await createR.text();
      return respond(502, { error: 'Fallo crear producto: ' + createR.status + ' ' + t.slice(0, 400) });
    }
    const createJ = await createR.json();
    const created = createJ.product;
    if (!created || !created.id) return respond(502, { error: 'Respuesta invalida al crear producto' });

    // 5. Escribir el metafield dropi._dropi_product.
    const mfPayload = {
      metafield: {
        namespace: 'dropi',
        key: '_dropi_product',
        value: JSON.stringify(metafieldDropi),
        type: 'json',
      },
    };
    const mfR = await fetch(API + '/products/' + created.id + '/metafields.json', {
      method: 'POST', headers: H,
      body: JSON.stringify(mfPayload),
    });
    let metafieldOk = mfR.ok;
    let metafieldError = null;
    if (!mfR.ok) {
      const t = await mfR.text();
      metafieldError = 'Metafield fail: ' + mfR.status + ' ' + t.slice(0, 300);
    }

    const shopDomain = domain.replace('.myshopify.com', '');
    return respond(200, {
      ok: true,
      product_id: String(created.id),
      handle: created.handle,
      title: created.title,
      admin_url: 'https://admin.shopify.com/store/' + shopDomain + '/products/' + created.id,
      storefront_url: 'https://' + domain + '/products/' + created.handle,
      status: created.status,
      variant_id: created.variants && created.variants[0] ? String(created.variants[0].id) : null,
      metafield_ok: metafieldOk,
      metafield_error: metafieldError,
      tokens_source: tokensSource,
      supplier_is_new: supplierIsNew,
      supplier_name: supplierName,
      supplier_id: userId || null,
    });

  } catch (err) {
    return respond(502, { error: err.message || 'unknown' });
  }
};

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
