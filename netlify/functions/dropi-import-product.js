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
  const price = Number(body.price) > 0 ? Number(body.price) : 999;
  const description = String(body.description || '').trim();
  const extraGallery = Array.isArray(body.gallery_urls) ? body.gallery_urls.filter(u => typeof u === 'string' && u).slice(0, 8) : [];

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

    // 2. Escaneo de productos Dropi existentes:
    //    - Buscar 'tokens' y 'shop_name' (por tienda, se hereda).
    //    - Si no vino user_id: resolverlo por user_name (match case-insensitive
    //      contra dropi_data.user.name).
    let dropiTokens = null;
    let dropiShopName = null;
    let tokensSource = null;
    let resolvedUserName = null;
    const wantResolveUserId = !userId || !/^\d+$/.test(userId);
    const targetName = userName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const suppliersSeen = new Map(); // Map<name_lower, {id, name}>
    const PAGE_SIZE = 250;
    const MAX_PAGES = 3;
    let pageUrl = API + '/products.json?limit=' + PAGE_SIZE + '&fields=id,title&status=any';
    let pages = 0;

    while (pageUrl && pages < MAX_PAGES && (!dropiTokens || wantResolveUserId)) {
      const listR = await fetch(pageUrl, { headers: H });
      if (!listR.ok) break;
      const listJ = await listR.json();
      for (const p of (listJ.products || [])) {
        const mR = await fetch(API + '/products/' + p.id + '/metafields.json?namespace=dropi', { headers: H });
        if (!mR.ok) continue;
        const mJ = await mR.json();
        const mfDropi = (mJ.metafields || []).find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
        if (!mfDropi) continue;
        try {
          const d = JSON.parse(mfDropi.value);
          if (!dropiTokens && d && d.tokens) {
            dropiTokens = d.tokens;
            dropiShopName = d.shop_name || null;
            tokensSource = { product_id: p.id, title: p.title };
          }
          if (d && d.user && d.user.id != null) {
            const uid = String(d.user.id);
            const uname = String(d.user.name || '').trim();
            const unameNorm = uname.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
            if (unameNorm && !suppliersSeen.has(unameNorm)) suppliersSeen.set(unameNorm, { id: uid, name: uname });
            if (wantResolveUserId && targetName && unameNorm === targetName && !userId) {
              userId = uid;
              resolvedUserName = uname;
            }
          }
        } catch (_) {}
        if (dropiTokens && (!wantResolveUserId || userId)) break;
      }
      if (dropiTokens && (!wantResolveUserId || userId)) break;
      const link = listR.headers.get('Link') || '';
      const nx = link.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = nx ? nx[1] : null;
      pages++;
    }

    if (!dropiTokens) {
      return respond(400, {
        error: 'No pude hallar tokens Dropi en ningun producto existente. Importá al menos 1 producto desde Dropi web primero (para que se emita el token de la tienda), después reintenta.',
      });
    }
    if (wantResolveUserId && !userId) {
      const suppliersList = Array.from(suppliersSeen.values()).sort((a, b) => a.name.localeCompare(b.name));
      return respond(400, {
        error: 'No encontré ningún producto de un proveedor llamado "' + userName + '". Verificá el nombre exacto o probá con user_id.',
        suppliersFound: suppliersList,
      });
    }

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
        id: parseInt(userId, 10),
        name: userName || null,
      },
      tokens: dropiTokens,
      shop_name: dropiShopName,
    };

    // 4. Crear el producto Shopify.
    const productPayload = {
      product: {
        title: name,
        body_html: description || '',
        status: 'draft',
        vendor: userName || 'Dropi',
        tags: 'bk-dropi-imported',
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
