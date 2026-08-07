// Crea ordenes en Dropi automaticamente para pedidos huerfanos de Shopify.
// Auto-descubre product_id + warehouse_id + shop_id buscando por SKU/nombre
// en las ultimas 200 ordenes cacheadas en Dropi (fetch en tiempo real, un
// solo request por create).
//
// Body esperado:
//   {
//     name, surname, phone, email,       // cliente
//     dir, city, state,                  // envio (city + state en MAYUSCULAS formato Dropi)
//     items: [{ sku, name, qty, price }],  // productos Shopify
//     total,                             // monto total
//     notes                              // opcional
//   }
//
// Respuesta:
//   { ok, dropiOrderId, warehouseUsed, productsMatched, dropiResponse }
//   O bien { error, detail } si algo fallo.
//
// SEGURIDAD: crea SIEMPRE con status "PENDIENTE CONFIRMACION" para que el
// call center las confirme antes de despachar.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const token = process.env.DROPI_TOKEN_CL;
  if (!token) return respond(500, { error: 'Falta DROPI_TOKEN_CL' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON invalido' }); }

  // Validar campos minimos
  const requiredFields = ['name', 'phone', 'dir', 'city', 'state', 'items', 'total'];
  for (const f of requiredFields) {
    if (!body[f]) return respond(400, { error: 'Falta campo requerido: ' + f });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return respond(400, { error: 'items debe ser array no vacio' });
  }

  const headers = {
    'dropi-integration-key': token,
    'Content-Type': 'application/json',
    'User-Agent': 'BKDROP-Sync/1.0',
  };

  // Modo manual override: si viene forcedProductId en el body, uso ese directo.
  const forcedProductId = body.forcedProductId ? parseInt(body.forcedProductId, 10) : null;
  const forcedWarehouseId = body.forcedWarehouseId ? parseInt(body.forcedWarehouseId, 10) : null;
  const forcedShopId = body.forcedShopId ? parseInt(body.forcedShopId, 10) : null;

  // Cheque previo: si TODOS los items del huerfano ya tienen 'barcode' (que
  // es el product_id de Dropi), saltamos el fetch de 500 ordenes. Solo
  // necesitamos buscar warehouse_id + shop_id.
  const allHaveBarcode = !forcedProductId &&
    Array.isArray(body.items) &&
    body.items.length > 0 &&
    body.items.every(it => it.barcode && /^\d+$/.test(String(it.barcode).trim()));

  // 1. Fetch ultimas 500 ordenes Dropi para descubrir warehouse_id + shop_id.
  //    SKIP si vino forcedProductId manual O si TODOS los items ya tienen
  //    barcode (product_id) - en ese caso usamos defaults 79/152458.
  //    Este skip es CRITICO para batch: cada create hace 5 fetches Dropi
  //    y en batches gatilla rate limit "Too Many Attempts".
  let dropiOrders = [];
  const needsFetch = !forcedProductId && !allHaveBarcode;
  if (needsFetch) {
    try {
      for (let start = 0; start < 500; start += 100) {
        const listResp = await fetch(
          'https://api.dropi.cl/integrations/orders/myorders?start=' + start + '&result_number=100',
          { method: 'GET', headers }
        );
        if (!listResp.ok) break;
        const data = await listResp.json();
        const objs = data.objects || [];
        if (objs.length === 0) break;
        dropiOrders = dropiOrders.concat(objs);
        await new Promise(r => setTimeout(r, 250));
      }
    } catch (err) {
      return respond(502, { error: 'Fetch ordenes Dropi fallo: ' + err.message });
    }
  }

  if (needsFetch && dropiOrders.length === 0) {
    return respond(500, { error: 'No se pudo cargar cache Dropi (0 ordenes)' });
  }

  // 2. Construir mapa de productos: { sku_o_nombre_normalizado: {product_id, warehouse_id, shop_id} }
  //    Ademas mapa por productId numerico (para match directo via 'barcode' Shopify).
  const productMap = {};
  const productMapById = {};   // { productId: {warehouse_id, shop_id} }
  for (const o of dropiOrders) {
    for (const od of (o.orderdetails || [])) {
      const p = od.product;
      if (!p || !p.id) continue;
      const info = {
        product_id: p.id,
        warehouse_id: o.warehouse_id,
        shop_id: o.shop_id,
      };
      if (p.sku) productMap[normalize(p.sku)] = info;
      if (p.name) productMap[normalize(p.name)] = info;
      productMapById[p.id] = { warehouse_id: o.warehouse_id, shop_id: o.shop_id };
    }
  }

  // 3. Matchear cada item del huerfano con product Dropi
  const dropiProducts = [];
  const unmatched = [];
  let warehouseUsed = null;
  let shopUsed = null;

  // Si viene forcedProductId, uso ese directo para todos los items
  if (forcedProductId) {
    for (const it of body.items) {
      dropiProducts.push({
        id: forcedProductId,
        product_id: forcedProductId,
        quantity: it.qty || 1,
        price: it.price || 0,
      });
    }
    warehouseUsed = forcedWarehouseId || 79;  // default RVG si no viene
    shopUsed = forcedShopId || 152458;
  } else {
    // Cache in-request de variantes por product_id (evitar consultas duplicadas en batch)
    const variantsCache = {};
    async function fetchDropiVariants(pid) {
      if (variantsCache[pid] !== undefined) return variantsCache[pid];
      try {
        // Endpoints candidatos para obtener variantes con stock de un producto Dropi
        const urls = [
          'https://api.dropi.cl/integrations/products/' + pid,
          'https://api.dropi.cl/integrations/products/get/' + pid,
        ];
        for (const url of urls) {
          try {
            const r = await fetch(url, { method: 'GET', headers });
            if (!r.ok) continue;
            const d = await r.json();
            // Formatos comunes: { attributes: [...] } | { variants: [...] } |
            // { object: { attributes: [...] } } | array directo
            let variants = null;
            if (Array.isArray(d.attributes)) variants = d.attributes;
            else if (Array.isArray(d.variants)) variants = d.variants;
            else if (d.object && Array.isArray(d.object.attributes)) variants = d.object.attributes;
            else if (d.object && Array.isArray(d.object.variants)) variants = d.object.variants;
            if (variants) {
              // Normalizar: { id, stock }
              const norm = variants.map(v => ({
                id: v.id || v.attribute_id || v.variant_id,
                stock: Number(v.stock ?? v.stock_quantity ?? v.available_stock ?? 0),
              })).filter(v => v.id != null);
              variantsCache[pid] = norm;
              return norm;
            }
          } catch { /* seguir con siguiente url */ }
        }
      } catch { /* swallow */ }
      variantsCache[pid] = null;
      return null;
    }

    for (const it of body.items) {
      // PRIORIDAD 1: barcode Shopify = product_id Dropi (match directo).
      // Formatos aceptados:
      //   "70842"          -> producto simple, product_id=70842
      //   "70842-37671"    -> producto Variable, product_id=70842, variant_id=37671
      const barcode = String(it.barcode || '').trim();
      const mSimple = /^\d+$/.test(barcode);
      const mVariant = /^(\d+)-(\d+)$/.exec(barcode);
      if (barcode && (mSimple || mVariant)) {
        const pid = mSimple ? parseInt(barcode, 10) : parseInt(mVariant[1], 10);
        let vid = mVariant ? parseInt(mVariant[2], 10) : null;

        // AUTO-VARIANT: si el producto tiene variantes, elegir la que tenga stock.
        // Si la variante del barcode está agotada, buscar otra con stock.
        // Si el barcode NO trae variant_id, elegir la primera con stock.
        const variants = await fetchDropiVariants(pid);
        let variantSwapped = null;
        if (variants && variants.length > 0) {
          const withStock = variants.filter(v => v.stock > 0);
          if (vid) {
            const chosen = variants.find(v => v.id === vid);
            const chosenHasStock = chosen && chosen.stock > 0;
            if (!chosenHasStock && withStock.length > 0) {
              // Swap: variante del barcode agotada → usar la primera disponible
              variantSwapped = { from: vid, to: withStock[0].id, reason: 'stock_zero' };
              vid = withStock[0].id;
            }
          } else if (withStock.length > 0) {
            // Sin variant en el barcode: elegir automáticamente la primera con stock
            vid = withStock[0].id;
            variantSwapped = { from: null, to: vid, reason: 'auto_pick' };
          }
        }

        const wh = productMapById[pid] || {};
        const prod = {
          id: pid,
          product_id: pid,
          quantity: it.qty || 1,
          price: it.price || 0,
        };
        if (vid) {
          // Nombres candidatos que Dropi puede aceptar para identificar la variante.
          // Enviamos varios; Dropi ignora los que no reconoce.
          prod.variant_id = vid;
          prod.id_variant = vid;
          prod.attribute_id = vid;
        }
        if (variantSwapped) prod._variantSwapped = variantSwapped; // debug info (no llega a Dropi si se filtra abajo)
        dropiProducts.push(prod);
        if (!warehouseUsed) warehouseUsed = wh.warehouse_id || null;
        if (!shopUsed) shopUsed = wh.shop_id || null;
        continue;
      }

      // PRIORIDAD 2: match por SKU normalizado.
      const skuKey = normalize(it.sku || '');
      const nameKey = normalize(it.name || '');
      let match = productMap[skuKey] || productMap[nameKey];

      // PRIORIDAD 3: match por contains en nombre.
      if (!match && nameKey) {
        for (const [key, info] of Object.entries(productMap)) {
          if (key.length > 10 && (key.includes(nameKey.slice(0, 15)) || nameKey.includes(key.slice(0, 15)))) {
            match = info;
            break;
          }
        }
      }

      if (!match) {
        unmatched.push({ sku: it.sku, name: it.name, barcode: it.barcode });
        continue;
      }
      dropiProducts.push({
        id: match.product_id,
        product_id: match.product_id,
        quantity: it.qty || 1,
        price: it.price || 0,
      });
      if (!warehouseUsed) warehouseUsed = match.warehouse_id;
      if (!shopUsed) shopUsed = match.shop_id;
    }
  }

  // Fallback warehouse/shop si no se encontraron en cache (raro con match por barcode).
  if (!warehouseUsed) warehouseUsed = 79;   // RVG default
  if (!shopUsed) shopUsed = 152458;

  // FIX descuentos/combos: Shopify manda line_items[].price que puede estar
  // mal para varios casos:
  //   - Combos 2x1/3x1: qty>1 con price=precio_original_por_unidad.
  //   - Upsells: qty=1 con price=precio_normal (real es descuento).
  //   - Descuentos globales aplicados.
  //
  // En todos los casos, el TOTAL real (body.total) es la fuente de verdad.
  // Ajustamos proporcionalmente TODOS los items para que sum(qty*price)
  // coincida con targetTotal. Los precios unitarios individuales pueden
  // no ser exactos vs Shopify, pero el TOTAL siempre queda correcto.
  const targetTotal = parseFloat(body.total || 0);
  if (targetTotal > 0 && dropiProducts.length > 0) {
    const rawSum = dropiProducts.reduce((s, p) => s + (p.quantity * p.price), 0);
    if (rawSum > 0 && Math.abs(rawSum - targetTotal) > 1) {
      const factor = targetTotal / rawSum;
      for (const p of dropiProducts) {
        p.price = Math.round(p.price * factor);
      }
    }
  }

  if (dropiProducts.length === 0) {
    // DEBUG: incluir mas info para diagnosticar
    const bodyItemsDebug = (body.items || []).map(it => ({ name: (it.name||'').slice(0,50), sku: it.sku, barcode: it.barcode }));
    const cacheProductIds = Object.keys(productMapById).slice(0, 20);
    const cacheSkuSamples = Object.keys(productMap).slice(0, 10);
    return respond(400, {
      error: 'Ningun producto matcheado en Dropi',
      unmatched,
      itemsRecibidos: bodyItemsDebug,
      cacheDropiPrimeros20ProductIds: cacheProductIds,
      cacheDropiPrimeros10SKUsNombres: cacheSkuSamples,
      hint: 'Verifica que los barcode/SKU coincidan con IDs Dropi validos.',
    });
  }

  // Extraer info de swaps (variant auto-picked) para incluirlo en la respuesta.
  // Después removerlo del body que se manda a Dropi.
  const variantSwaps = dropiProducts
    .filter(p => p._variantSwapped)
    .map(p => ({ product_id: p.product_id, ...p._variantSwapped }));
  const dropiProductsClean = dropiProducts.map(p => {
    const { _variantSwapped, ...rest } = p;
    return rest;
  });

  // 4. Construir body Dropi (schema validado 25-jul)
  const dropiBody = {
    name: String(body.name || '').split(' ')[0] || 'Cliente',
    surname: String(body.name || '').split(' ').slice(1).join(' ') || '',
    phone: normalizePhone(body.phone),
    client_email: String(body.email || ''),
    dir: String(body.dir || '').slice(0, 200),
    city: String(body.city || '').toUpperCase(),
    state: String(body.state || '').toUpperCase(),
    zip_code: null,
    colonia: null,
    notes: String(body.notes || 'Creada via BKDROP desde huerfano Shopify').slice(0, 300),
    type: 'FINAL_ORDER',
    status: 'PENDIENTE CONFIRMACION',
    rate_type: 'CON RECAUDO',
    warehouse_id: warehouseUsed,
    shop_id: shopUsed,
    distribution_company_id: 5,   // STARKEN por default
    shipping_company: 'STARKEN',
    total_order: parseFloat(body.total || 0),
    products: dropiProductsClean,
  };

  // 5. POST a Dropi
  let dropiResponse;
  try {
    const createResp = await fetch('https://api.dropi.cl/integrations/orders/myorders', {
      method: 'POST', headers, body: JSON.stringify(dropiBody)
    });
    const txt = await createResp.text();
    try { dropiResponse = JSON.parse(txt); } catch { dropiResponse = { raw: txt.slice(0, 500) }; }
    if (!createResp.ok || !dropiResponse.isSuccess) {
      return respond(502, {
        error: 'Dropi create fail',
        detail: dropiResponse,
        sentBody: dropiBody,
      });
    }
  } catch (err) {
    return respond(502, { error: 'Fetch Dropi create fail: ' + err.message });
  }

  return respond(200, {
    ok: true,
    dropiOrderId: (dropiResponse.object && dropiResponse.object.id) || null,
    warehouseUsed,
    shopUsed,
    productsMatched: dropiProducts.length,
    variantSwaps,   // info de swaps auto (variante agotada → disponible)
    unmatched,
    dropiResponse,
    createdAt: new Date().toISOString(),
  });
};

function normalize(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '');
}

function normalizePhone(p) {
  if (!p) return '';
  let s = String(p).replace(/\D/g, '');
  if (s.startsWith('56') && s.length >= 11) s = s.slice(2);
  return s;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...cors() },
    body: JSON.stringify(payload),
  };
}
