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

    // Leer los tokens Dropi de productos ya existentes en la tienda.
    //
    // IMPORTANTE: el token lleva embebido un JWT cuyo claim `sub` identifica
    // la CUENTA de Dropi que va a recibir el pedido. No alcanza con agarrar
    // el primero que aparezca: la tienda tiene productos viejos importados
    // desde otra cuenta, y heredar ESE token manda el pedido a la cuenta
    // ajena. Dropi lo rechaza con "no posee saldo suficiente en la wallet".
    //
    // Por eso: juntamos candidatos, decodificamos su `sub`, y nos quedamos
    // con la cuenta MAYORITARIA de la tienda (o la de DROPI_CUENTA_ESPERADA
    // si esta seteada). Si el unico token disponible es de otra cuenta,
    // fallamos en vez de crear un producto que no se va a poder despachar.
    const jwtSub = (tok) => {
      try {
        const parts = String(tok || '').split('.');
        if (parts.length < 2) return null;
        let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        const payload = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
        return payload && payload.sub != null ? String(payload.sub) : null;
      } catch (_) { return null; }
    };

    const leerTokensDe = async (productId, titulo) => {
      try {
        const mfR = await fetch(API + '/products/' + productId + '/metafields.json?namespace=dropi', { headers: H });
        if (!mfR.ok) return null;
        const mfJ = await mfR.json();
        const mfDropi = (mfJ.metafields || []).find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
        if (!mfDropi) return null;
        const d = JSON.parse(mfDropi.value);
        if (!d.tokens) return null;
        return {
          tokens: d.tokens,
          shopName: d.shop_name || null,
          cuenta: jwtSub(d.tokens),
          source: { product_id: String(productId), title: titulo || null },
        };
      } catch (_) { return null; }
    };

    // Candidatos: el sample del proveedor elegido primero, despues el resto.
    // Tope de 12 lecturas para no comerse el timeout de la function.
    const sampleId = chosen && chosen.sampleProductId;
    const aRevisar = [];
    if (sampleId) aRevisar.push({ id: sampleId, name: chosen.name });
    for (const s2 of suppliers) {
      if (!s2.sampleHasTokens || !s2.sampleProductId) continue;
      if (String(s2.sampleProductId) === String(sampleId)) continue;
      aRevisar.push({ id: s2.sampleProductId, name: s2.name });
      if (aRevisar.length >= 12) break;
    }

    const candidatos = [];
    for (const c of aRevisar) {
      const r = await leerTokensDe(c.id, c.name);
      if (r) candidatos.push(r);
    }

    if (!candidatos.length) {
      return respond(400, {
        error: 'No pude leer tokens Dropi de ningun producto existente. Reintentá; si persiste, avisá.',
      });
    }

    // Cuenta correcta: la forzada por env, o la mayoritaria entre los candidatos.
    const forzada = String(process.env.DROPI_CUENTA_ESPERADA || '').trim();
    let cuentaOk = forzada;
    if (!cuentaOk) {
      const conteo = {};
      for (const c of candidatos) if (c.cuenta) conteo[c.cuenta] = (conteo[c.cuenta] || 0) + 1;
      cuentaOk = (Object.entries(conteo).sort((a, b) => b[1] - a[1])[0] || [null])[0];
    }

    const elegido = candidatos.find(c => c.cuenta && c.cuenta === cuentaOk);
    if (!elegido) {
      const vistas = [...new Set(candidatos.map(c => c.cuenta || 'sin-jwt'))].join(', ');
      return respond(400, {
        error: 'Ningun producto de la tienda tiene un token de la cuenta Dropi esperada ('
             + (cuentaOk || '?') + '). Cuentas encontradas: ' + vistas
             + '. No creo el producto para que no quede apuntando a otra cuenta.',
      });
    }

    const dropiTokens   = elegido.tokens;
    const dropiShopName = elegido.shopName;
    const tokensSource  = { ...elegido.source, cuenta: elegido.cuenta };

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
