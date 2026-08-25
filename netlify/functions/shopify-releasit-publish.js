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
  // nx1 = unidades por 'pack' del producto base (1 normal, 2 si es 2x1, 3 si 3x1).
  const nx1 = Math.max(1, Math.min(6, parseInt(body.nx1, 10) || 1));
  // price_override: si viene, se usa como precio base en vez del price del
  // producto Shopify. Permite armar la oferta con un precio distinto al que
  // esta publicado en Shopify (util cuando queres testear antes de actualizar).
  const priceOverride = body.price_override != null ? Number(body.price_override) : null;
  // upsell_index: 0-7, elige cual candidato usar (default 0).
  const upsellIndex = Math.max(0, Math.min(20, parseInt(body.upsell_index, 10) || 0));
  // upsell_override_price: pisa el price del upsell elegido (CLP entero).
  const upsellOverridePrice = body.upsell_override_price != null ? Number(body.upsell_override_price) : null;
  // upsell_manual: si viene, pisa TODO el upsell con estos datos (viene del
  // buscador manual del modal cuando el user quiere elegir uno especifico).
  //   { product_id, variant_id, name, imgUrl }
  const upsellManual = body.upsell_manual && body.upsell_manual.product_id ? body.upsell_manual : null;
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
    const shopifyPrice = parseFloat(variant0.price || 0);
    // Usar price_override si viene; sino el precio actual del producto Shopify.
    const price = (priceOverride && priceOverride > 0) ? priceOverride : shopifyPrice;
    if (!price || price <= 0) return respond(400, { error: 'Producto sin precio en variante y sin price_override' });

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
    //    Formula del PDF:
    //    ds.v = round((1 - (1 - d/100)/nx1) * 100 * 100)
    //    qty final = nx1 * k (k = 1, 2, 3)
    //    Precio por unidad = precioTotal / (nx1 * k)  (unidades reales que recibe)
    const round990 = n => {
      const r = Math.round(n / 1000) * 1000 - 10;
      return r > 0 ? r : Math.max(0, Math.round(n));
    };
    const fmt = n => '$' + Math.round(n).toLocaleString('es-CL');
    const fmtPerUnit = n => 'SÓLO ' + fmt(n) + ' POR UNIDAD!';
    const unitLabel = qty => qty === 1 ? 'unidad' : 'unidades';

    // Releasit SOLO soporta ds.t='percentage' o 'none' (confirmado leyendo
    // los items manuales de la tienda). El intento con 'amount' fallo:
    // Releasit lo ignoro y aplico descuento 0. Volvemos a 'percentage'.
    //
    // Formula del % que Releasit necesita para llegar al precio target,
    // con nx1 aplicado:
    //   dsV(qty, target) = round((1 - target / (price * qty)) * 10000)
    // El precio final que muestra Releasit sera:
    //   price * qty * (1 - dsV/10000)
    // No siempre termina en .990 exacto porque ds.v es entero, pero
    // usamos round990 como target y el resultado queda muy cerca.

    const p1 = price;
    const p2 = round990(price * 2 * (1 - pack2Disc / 100));
    const p3 = round990(price * 3 * (1 - pack3Disc / 100));

    // Calcula ds.v (formato Releasit: pct * 100) para llegar cerca del target.
    const dsVForTarget = (qty, target) => {
      if (!target || !price || qty <= 0) return 0;
      const raw = (1 - target / (price * qty)) * 10000;
      return Math.max(0, Math.round(raw));
    };
    const dsV2 = dsVForTarget(2, p2);
    const dsV3 = dsVForTarget(3, p3);

    // qty real que ve el cliente (con nx1 aplicado). Unidades reales.
    const uds1 = 1 * nx1;
    const uds2 = 2 * nx1;
    const uds3 = 3 * nx1;

    // Colores del plaque por tramo (verde/azul/morado).
    const COLOR_1 = 'rgba(34, 197, 94, 1)';    // verde
    const COLOR_2 = 'rgba(0, 116, 191, 1)';    // azul
    const COLOR_3 = 'rgba(139, 92, 246, 1)';   // morado

    // Plaque del tramo 1:
    //  - Si nx1 = 1  → "PRECIO OFERTA HOY!" (el precio SIN dividir; es solo la unidad base)
    //  - Si nx1 > 1 → "SÓLO $X POR UNIDAD!" (dividimos el precio entre nx1)
    const plaque1 = (nx1 === 1) ? 'PRECIO OFERTA HOY!' : fmtPerUnit(p1 / uds1);

    // % OFF combinado: (1 - (1 - offBase) * (1 - pack)) * 100
    //   offBase = 35% del compare_at_price al price (descuento base del hero)
    //   pack    = descuento extra al llevar 2 o 3 unidades
    // Ej: base 35% + pack 15% → 45% OFF (no 50), multiplicativo.
    const OFF_BASE = 35;
    const combinedOff = pack => Math.round((1 - (1 - OFF_BASE / 100) * (1 - pack / 100)) * 100);

    // Recalculamos el precio REAL que Releasit va a mostrar (con ds.v entero)
    // y basamos el plaque en ESO, no en el target. Asi el "SÓLO $X POR UNIDAD"
    // coincide con el precio total que se ve en la landing.
    const realPriceReleasit = (qty, dsV) => Math.round(price * qty * (1 - dsV / 10000));
    const p2Real = realPriceReleasit(2, dsV2);
    const p3Real = realPriceReleasit(3, dsV3);

    const ofertas = [
      {
        pos: 1, title: '¡Llevo ' + uds1 + ' ' + unitLabel(uds1) + '! (' + OFF_BASE + '% OFF)', qty: 1,
        ds: { t: 'percentage', v: 0 },
        priceTotal: p1, perUnit: Math.round(p1 / uds1),
        plaque: plaque1, plaqueBgC: COLOR_1,
      },
      {
        pos: 2, title: '¡Llevo ' + uds2 + ' ' + unitLabel(uds2) + '! (' + combinedOff(pack2Disc) + '% OFF)', qty: 2,
        ds: { t: 'percentage', v: dsV2 },
        priceTotal: p2Real, perUnit: Math.round(p2Real / uds2),
        plaque: fmtPerUnit(p2Real / uds2), plaqueBgC: COLOR_2,
      },
      {
        pos: 3, title: '¡Llevo ' + uds3 + ' ' + unitLabel(uds3) + '! · PRECIO MAYORISTA', qty: 3,
        ds: { t: 'percentage', v: dsV3 },
        priceTotal: p3Real, perUnit: Math.round(p3Real / uds3),
        plaque: fmtPerUnit(p3Real / uds3), plaqueBgC: COLOR_3,
      },
    ];

    // 3. Buscar upsell: primero drafts (regla del PDF), fallback a active.
    // Devolvemos hasta 5 candidatos con costo y foto.
    let upsell = null;
    let upsellCandidates = [];
    let upsellReason = 'ok';

    // Si vino upsell_manual, saltamos la busqueda automatica y usamos ese.
    if (upsellManual) {
      const finalPriceCents = upsellOverridePrice && upsellOverridePrice > 0
        ? Math.round(upsellOverridePrice * 100)
        : 0;
      upsell = {
        product_id: String(upsellManual.product_id),
        variant_id: String(upsellManual.variant_id),
        name: upsellManual.name || '',
        price: finalPriceCents / 100,
        price_cents: finalPriceCents,
        imgUrl: upsellManual.imgUrl || '',
        isManual: true,
      };
      upsellReason = 'manual';
    } else if (!supplier.user_id) {
      upsellReason = 'no-supplier';
    } else {
      let raw = await buscarUpsellCandidato(API, H, {
        supplierUserId: supplier.user_id,
        excludeProductId: productId,
        basePrice: price,
        status: 'draft',
      });
      let isDraft = true;
      if (!raw.length) {
        raw = await buscarUpsellCandidato(API, H, {
          supplierUserId: supplier.user_id,
          excludeProductId: productId,
          basePrice: price,
          status: 'active',
        });
        isDraft = false;
      }
      if (!raw.length) {
        upsellReason = 'no-candidates';
      } else {
        // Scoring por relacion semantica: palabras clave del producto base
        // presentes en el nombre del candidato. Los que matcheen mas van
        // primero. Ties se rompen por precio ascendente.
        const STOP = new Set(['de','la','el','y','o','en','a','con','por','para','del','al','un','una','los','las','sin','pack','set','x1','x2','x3','2x1','3x1','oferta','nuevo','pro','plus','max','mini','mega']);
        const kws = String(product.title || '').toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w));
        const score = (c) => {
          const t = String(c.title || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          return kws.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
        };
        raw.sort((a, b) => {
          const sd = score(b) - score(a);
          return sd !== 0 ? sd : (parseFloat(a.variantPrice) - parseFloat(b.variantPrice));
        });

        // Top 5 candidatos con costo (sale_price del metafield dropi).
        upsellCandidates = raw.slice(0, 5).map(c => ({
          product_id: String(c.id),
          variant_id: String(c.variantId),
          name: c.title,
          price: parseFloat(c.variantPrice),
          // Releasit espera price en CENTAVOS siempre (aunque CLP no los use).
          // Sin *100, muestra $100 en vez de $9.990.
          price_cents: Math.round(parseFloat(c.variantPrice) * 100),
          cost: c.costDropi != null ? Number(c.costDropi) : null,
          imgUrl: c.image || '',
          isDraft: isDraft,
          matchScore: score(c),
        }));
        // El upsell efectivo = el candidato elegido (default index 0),
        // con precio pisado si vino upsellOverridePrice (en pesos → *100).
        const chosenIdx = Math.min(upsellIndex, upsellCandidates.length - 1);
        const chosen = upsellCandidates[chosenIdx];
        const finalPriceCents = upsellOverridePrice && upsellOverridePrice > 0
          ? Math.round(upsellOverridePrice * 100)
          : chosen.price_cents;
        upsell = {
          ...chosen,
          price: finalPriceCents / 100, // display en pesos
          price_cents: finalPriceCents,  // lo que va al metafield
        };
        if (!isDraft) upsellReason = 'ok-active-warning';
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
        plaqueBgC: o.plaqueBgC,
        // Colores per-offer experimentales: por si Releasit los respeta.
        // Si no, prevalecen los del grupo (selBC/selBgC abajo).
        selBC: o.plaqueBgC,
        selBgC: 'rgba(255,255,255,1)',
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
      // Fallback del grupo si Releasit ignora los colores per-offer.
      // Uso el color del primer tramo (verde) para el border seleccionado.
      selBC: COLOR_1,
      selBgC: 'rgba(255,255,255,1)',
      prSize: 14,
      hideImg: false,
      hideVN: false,
      disableVariantsUseFirstVariant: true,
      noShowIfQuantityIsGreater: false,
      useComparePrice: false,
    };

    // 6. Armar entrada de upsell (si hay).
    //    Reverse-engineered de items manuales que SI muestran foto: el
    //    campo clave es imgUrl (los aliases image/imageUrl/pImg no se
    //    usan). Ademas se requieren campos de STYLE (bgC/c/bW/bC/bR/bSty/
    //    tC/plT/descC) para que el widget renderice el "modo tarjeta" con
    //    foto. Sin esos, muestra el modo minimalista sin foto.
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
      descC: 'rgba(89,89,89,1)',
      imgUrl: upsell.imgUrl || '',
      // Estilo visual del checkbox (copiado de items manuales que si muestran foto):
      bgC: 'rgba(255,255,255,1)',       // fondo blanco
      c: 'rgba(0,0,0,1)',               // color texto principal
      bW: 2,                            // border width 2px
      bC: 'rgba(29, 158, 6, 1)',        // border color verde
      bR: 8,                            // border radius 8px
      bSty: 'dashed-animated',          // estilo borde animado punteado (como el ejemplo)
      tC: 'rgba(2,117,255,1)',          // color titulo azul
      plT: '',                          // plaque title vacio
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
      product: { id: String(product.id), title: product.title, price: price, shopifyPrice: shopifyPrice, handle: product.handle, image: (product.image && product.image.src) || null },
      supplier,
      ofertas: ofertas.map(o => ({ ...o, priceLabel: fmt(o.priceTotal), perUnitLabel: fmt(o.perUnit) })),
      upsell,
      upsellCandidates,
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
async function buscarUpsellCandidato(API, H, { supplierUserId, excludeProductId, basePrice, status }) {
  // 60% del base para tener mas pool de candidatos (antes 40%). Ajuste
  // basado en que muchos productos base tienen precio bajo (~$27.990) y
  // el cap 40% dejaba muy pocos candidatos disponibles.
  const maxUpsellPrice = basePrice * 0.6;
  const PAGE_SIZE = 250;
  const MAX_PAGES = 2; // hasta 500 productos escaneados (antes 250)
  const MAX_METAFIELD_LOOKUPS = 120; // antes 60
  const candidatos = [];
  let lookups = 0;
  const statusFilter = (status && ['draft', 'active', 'archived', 'any'].includes(status)) ? status : 'draft';
  let pageUrl = API + '/products.json?limit=' + PAGE_SIZE + '&status=' + statusFilter + '&fields=id,title,status,variants,image';
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
      // Ir a por hasta 8 candidatos (antes 5) para poblar top 5 mostrando 5 opciones.
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
            // Costo Dropi (sale_price) para mostrar en el UI.
            costDropi: dropiData.sale_price != null ? Number(dropiData.sale_price) : null,
          });
        }
      } catch (_) {}
      if (candidatos.length >= 8) break;
    }
    if (candidatos.length >= 8 || lookups >= MAX_METAFIELD_LOOKUPS) break;
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
