// Publica automaticamente ofertas por cantidad + upsell 1-click en Releasit
// COD Form escribiendo los dos metafields de tienda que la app usa como
// fuente de verdad. Sin API publica de Releasit — el widget del checkout
// COD lee estos JSON tal cual estan.
//
// Metafields:
//   _rsi_cod_form_sf.quantity_offers_json  → ofertas 2u/3u
//   _rsi_cod_form_sf.tick_upsells_json     → upsell 1-click
//
// Patron: lee → fusiona → escribe. Nunca sobrescribe el array completo.
//
// POST body:
//   {
//     product_id: "8945311121650",   // Shopify product ID (base)
//     pack2_disc: 15,                // % descuento pack 2u (editable UI)
//     pack3_disc: 20,                // % descuento pack 3u (editable UI)
//     dry_run: true|false,           // true = no PUT, solo devuelve preview
//     tenant: 'chile'                // solo chile por ahora
//   }
//
// Response:
//   {
//     ok, product, supplier, ofertas: [3 tramos],
//     upsell: {...} | null, upsellReason: 'ok'|'no-candidates'|...,
//     metafieldsBefore, metafieldsAfter, applied
//   }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON invalido' }); }

  const productId = String(body.product_id || '').trim();
  const pack2Disc = Number(body.pack2_disc);
  const pack3Disc = Number(body.pack3_disc);
  const dryRun = body.dry_run !== false; // default true por seguridad
  const tenant = String(body.tenant || 'chile').toLowerCase();

  if (!productId) return respond(400, { error: 'Falta product_id' });
  if (!Number.isFinite(pack2Disc) || pack2Disc < 0 || pack2Disc > 90) {
    return respond(400, { error: 'pack2_disc debe ser 0-90' });
  }
  if (!Number.isFinite(pack3Disc) || pack3Disc < 0 || pack3Disc > 90) {
    return respond(400, { error: 'pack3_disc debe ser 0-90' });
  }
  if (tenant !== 'chile') return respond(400, { error: 'Solo tenant chile por ahora' });

  const token = process.env.SHOPIFY_TOKEN;
  const domain = process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' });

  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const API = 'https://' + domain + '/admin/api/2024-10';

  try {
    // 1. Traer producto base + su metafield dropi._dropi_product
    const [prodR, mfProdR] = await Promise.all([
      fetch(API + '/products/' + productId + '.json', { headers: H }),
      fetch(API + '/products/' + productId + '/metafields.json', { headers: H }),
    ]);
    if (!prodR.ok) return respond(prodR.status, { error: 'Fetch producto: ' + prodR.status });
    const prodJ = await prodR.json();
    const product = prodJ.product;
    if (!product) return respond(404, { error: 'Producto no encontrado' });

    const variant0 = (product.variants || [])[0] || {};
    const price = parseFloat(variant0.price || 0);
    if (!price || price <= 0) return respond(400, { error: 'Producto sin precio en variante 0' });

    // Extraer supplier del metafield dropi._dropi_product
    let supplier = { user_id: null, user_name: null };
    if (mfProdR.ok) {
      const mfProdJ = await mfProdR.json();
      const mfDropi = (mfProdJ.metafields || []).find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
      if (mfDropi && mfDropi.value) {
        try {
          const dropiData = JSON.parse(mfDropi.value);
          if (dropiData.user) {
            supplier.user_id = dropiData.user.id || null;
            supplier.user_name = dropiData.user.name || null;
          }
        } catch (_) {}
      }
    }

    // 2. Calcular los 3 tramos.
    //    nx1 = 1 (oferta base es 1 unidad). Formula del PDF:
    //    ds.v = round((1 - (1 - d/100)/nx1) * 100 * 100)
    //    Con nx1=1 se simplifica a: ds.v = round(d * 100)
    const round990 = n => {
      const r = Math.round(n / 1000) * 1000 - 10;
      return r > 0 ? r : Math.max(0, Math.round(n));
    };
    const fmt = n => '$' + Math.round(n).toLocaleString('es-CL');
    const fmtPerUnit = n => 'Solo ' + '$' + Math.round(n).toLocaleString('es-CL') + ' c/u';

    const p1 = price;
    const p2 = round990(price * 2 * (1 - pack2Disc / 100));
    const p3 = round990(price * 3 * (1 - pack3Disc / 100));

    const ofertas = [
      {
        pos: 1, title: '¡Llevo 1 unidad! (35% OFF)', qty: 1,
        ds: { t: 'percentage', v: 0 },
        priceTotal: p1, perUnit: p1, plaque: '',
      },
      {
        pos: 2, title: '¡Llevo 2 unidades! (' + Math.round(35 + pack2Disc) + '% OFF)', qty: 2,
        ds: { t: 'percentage', v: Math.round(pack2Disc * 100) },
        priceTotal: p2, perUnit: Math.round(p2 / 2),
        plaque: fmtPerUnit(p2 / 2),
      },
      {
        pos: 3, title: '¡Llevo 3 unidades! · PRECIO MAYORISTA', qty: 3,
        ds: { t: 'percentage', v: Math.round(pack3Disc * 100) },
        priceTotal: p3, perUnit: Math.round(p3 / 3),
        plaque: fmtPerUnit(p3 / 3),
      },
    ];

    // 3. Buscar upsell: producto draft del mismo user.id, precio <= 40% del base
    let upsell = null;
    let upsellReason = 'ok';
    if (!supplier.user_id) {
      upsellReason = 'no-supplier';
    } else {
      const candidatos = await buscarUpsellCandidato(API, H, {
        supplierUserId: supplier.user_id,
        excludeProductId: productId,
        basePrice: price,
      });
      if (!candidatos.length) {
        upsellReason = 'no-candidates';
      } else {
        // Primer candidato disponible (ya vienen ordenados por precio ascendente)
        const c = candidatos[0];
        // CLP no usa centavos: price = valor entero CLP directamente.
        // (En tiendas USD/EUR habria que multiplicar * 100).
        upsell = {
          product_id: String(c.id),
          variant_id: String(c.variantId),
          name: c.title,
          price_cents: Math.round(parseFloat(c.variantPrice)),
          price: parseFloat(c.variantPrice),
          imgUrl: c.image || '',
        };
      }
    }

    // 4. Leer metafields Releasit actuales de la TIENDA
    const mfShopR = await fetch(API + '/metafields.json?limit=250', { headers: H });
    if (!mfShopR.ok) return respond(502, { error: 'Fetch metafields tienda: ' + mfShopR.status });
    const mfShopJ = await mfShopR.json();
    const mfQO = (mfShopJ.metafields || []).find(m => m.namespace === '_rsi_cod_form_sf' && m.key === 'quantity_offers_json');
    const mfUP = (mfShopJ.metafields || []).find(m => m.namespace === '_rsi_cod_form_sf' && m.key === 'tick_upsells_json');
    if (!mfQO || !mfUP) {
      return respond(400, {
        error: 'Faltan metafields Releasit en la tienda. Guarda UNA oferta a mano en la app Releasit para que se creen, despues reintenta.',
        hint: 'quantity_offers_json exists=' + !!mfQO + ', tick_upsells_json exists=' + !!mfUP,
      });
    }

    // 5. Armar el nuevo grupo de quantity_offers
    const grupoNuevo = {
      id: Date.now(),
      type: 'quantity-offer',
      isActive: true,
      name: product.title,
      pIds: [String(productId)],
      offers: ofertas.map((o, i) => ({
        pos: o.pos,
        title: o.title,
        qty: o.qty,
        ds: o.ds,
        plaque: o.plaque,
        plaqueBgC: 'rgba(0,116,191,1)',
        imgUrl: '',
        bestDealBadge: {
          badgeContent: '🔥 Mejor Oferta',
          badgeBgC: null,
          badgeTC: 'rgba(255,255,255)',
          badgeBR: 12,
          animation: 'none',
          textAlign: 'left',
          show: i === ofertas.length - 1, // solo ultimo tramo
        },
      })),
      selBC: 'rgba(0,116,191,1)',
      selBgC: 'rgba(217,235,246,1)',
      prSize: 14,
      hideImg: false,
      hideVN: false,
      disableVariantsUseFirstVariant: true,
      noShowIfQuantityIsGreater: false,
      useComparePrice: false,
    };

    // 6. Armar entrada de upsell (si hay)
    const upsellNuevo = upsell ? {
      id: Date.now() + 1,
      name: 'UPSELL: ' + upsell.name,
      prods: [String(productId)],
      title: upsell.name,
      connP: upsell.product_id,
      connV: upsell.variant_id,
      price: upsell.price_cents,
      connDisc: 0,
      text: 'Agrega {title} por solo {price}',
      desc: '',
      imgUrl: upsell.imgUrl,
      ticked: false,
      isActive: true,
    } : null;

    // 7. Fusionar: filtrar grupos/entradas de ESTE producto y agregar nuevo
    let listaQO;
    try { listaQO = JSON.parse(mfQO.value); if (!Array.isArray(listaQO)) listaQO = []; }
    catch { listaQO = []; }
    let listaUP;
    try { listaUP = JSON.parse(mfUP.value); if (!Array.isArray(listaUP)) listaUP = []; }
    catch { listaUP = []; }

    const listaQOLimpia = listaQO.filter(g => !((g.pIds || []).map(String).includes(String(productId))));
    listaQOLimpia.push(grupoNuevo);

    const listaUPLimpia = listaUP.filter(u => !((u.prods || []).map(String).includes(String(productId))));
    if (upsellNuevo) listaUPLimpia.push(upsellNuevo);

    // 8. Escribir metafields (a menos que dry_run)
    let applied = false;
    let writeErrors = [];
    if (!dryRun) {
      // Escribir quantity_offers
      const wQO = await fetch(API + '/metafields/' + mfQO.id + '.json', {
        method: 'PUT', headers: H,
        body: JSON.stringify({ metafield: { id: mfQO.id, value: JSON.stringify(listaQOLimpia), type: 'json' } }),
      });
      if (!wQO.ok) {
        const t = await wQO.text();
        writeErrors.push({ metafield: 'quantity_offers_json', status: wQO.status, error: t.slice(0, 300) });
      }
      // Escribir tick_upsells (siempre, aunque no haya upsell, para reflejar el filtrado)
      const wUP = await fetch(API + '/metafields/' + mfUP.id + '.json', {
        method: 'PUT', headers: H,
        body: JSON.stringify({ metafield: { id: mfUP.id, value: JSON.stringify(listaUPLimpia), type: 'json' } }),
      });
      if (!wUP.ok) {
        const t = await wUP.text();
        writeErrors.push({ metafield: 'tick_upsells_json', status: wUP.status, error: t.slice(0, 300) });
      }
      applied = writeErrors.length === 0;
    }

    return respond(200, {
      ok: writeErrors.length === 0,
      product: { id: String(product.id), title: product.title, price: price, handle: product.handle, image: (product.image && product.image.src) || null },
      supplier,
      ofertas: ofertas.map(o => ({ ...o, priceLabel: fmt(o.priceTotal), perUnitLabel: fmt(o.perUnit) })),
      upsell,
      upsellReason,
      metafieldsBefore: { quantity_offers_count: listaQO.length, tick_upsells_count: listaUP.length },
      metafieldsAfter: { quantity_offers_count: listaQOLimpia.length, tick_upsells_count: listaUPLimpia.length },
      dryRun,
      applied,
      writeErrors: writeErrors.length ? writeErrors : undefined,
    });

  } catch (err) {
    return respond(502, { error: err.message || 'unknown' });
  }
};

// Busca productos DRAFT del mismo supplier user_id con precio <= 40% del base.
// Retorna sorted por precio ascendente (el mas barato primero como default).
async function buscarUpsellCandidato(API, H, { supplierUserId, excludeProductId, basePrice }) {
  const maxUpsellPrice = basePrice * 0.4;
  const PAGE_SIZE = 250;
  // 1 sola pagina para no reventar el timeout de Netlify (10s). Cada match
  // adicional cuesta un GET /metafields por candidato. Si se necesita mas
  // profundidad, activar paginacion aca.
  const MAX_PAGES = 1;
  const MAX_METAFIELD_LOOKUPS = 60; // techo duro para no colgar
  const candidatos = [];
  let lookups = 0;
  let pageUrl = API + '/products.json?limit=' + PAGE_SIZE + '&status=draft&fields=id,title,status,variants,image';
  let pages = 0;

  while (pageUrl && pages < MAX_PAGES) {
    const r = await fetch(pageUrl, { headers: H });
    if (!r.ok) break;
    const j = await r.json();
    const products = j.products || [];
    for (const p of products) {
      if (String(p.id) === String(excludeProductId)) continue;
      const v0 = (p.variants || [])[0];
      if (!v0) continue;
      const vPrice = parseFloat(v0.price || 0);
      if (!vPrice || vPrice <= 0 || vPrice > maxUpsellPrice) continue;
      if (lookups >= MAX_METAFIELD_LOOKUPS) break;
      // Filtro por supplier: leer metafield dropi._dropi_product
      lookups++;
      const mfR = await fetch(API + '/products/' + p.id + '/metafields.json?namespace=dropi', { headers: H });
      if (!mfR.ok) continue;
      const mfJ = await mfR.json();
      const mfDropi = (mfJ.metafields || []).find(m => m.namespace === 'dropi' && m.key === '_dropi_product');
      if (!mfDropi) continue;
      try {
        const dropiData = JSON.parse(mfDropi.value);
        if (dropiData.user && String(dropiData.user.id) === String(supplierUserId)) {
          candidatos.push({
            id: p.id,
            title: p.title,
            variantId: v0.id,
            variantPrice: v0.price,
            image: (p.image && p.image.src) || null,
          });
        }
      } catch (_) {}
      if (candidatos.length >= 5) break; // suficiente para el default
    }
    if (candidatos.length >= 5 || lookups >= MAX_METAFIELD_LOOKUPS) break;
    const link = r.headers.get('Link') || '';
    const nx = link.match(/<([^>]+)>;\s*rel="next"/);
    pageUrl = nx ? nx[1] : null;
    pages++;
  }
  candidatos.sort((a, b) => parseFloat(a.variantPrice) - parseFloat(b.variantPrice));
  return candidatos;
}

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
