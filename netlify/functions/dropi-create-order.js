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

  // 1. Fetch ultimas 200 ordenes Dropi para descubrir product_id + warehouse_id + shop_id
  //    por SKU/nombre. Es 2 requests paginados (100 x 2).
  let dropiOrders = [];
  try {
    for (let start = 0; start < 200; start += 100) {
      const listResp = await fetch(
        'https://api.dropi.cl/integrations/orders/myorders?start=' + start + '&result_number=100',
        { method: 'GET', headers }
      );
      if (!listResp.ok) break;
      const data = await listResp.json();
      const objs = data.objects || [];
      if (objs.length === 0) break;
      dropiOrders = dropiOrders.concat(objs);
      // pequeño delay para no gatillar rate limit
      if (start === 0) await new Promise(r => setTimeout(r, 300));
    }
  } catch (err) {
    return respond(502, { error: 'Fetch ordenes Dropi fallo: ' + err.message });
  }

  if (dropiOrders.length === 0) {
    return respond(500, { error: 'No se pudo cargar cache Dropi (0 ordenes)' });
  }

  // 2. Construir mapa de productos: { sku_o_nombre_normalizado: {product_id, warehouse_id, shop_id} }
  const productMap = {};
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
    }
  }

  // 3. Matchear cada item del huerfano con product Dropi
  const dropiProducts = [];
  const unmatched = [];
  let warehouseUsed = null;
  let shopUsed = null;
  for (const it of body.items) {
    const skuKey = normalize(it.sku || '');
    const nameKey = normalize(it.name || '');
    let match = productMap[skuKey] || productMap[nameKey];

    // Si no hay match exacto, intentar contains (para variantes de nombre)
    if (!match && nameKey) {
      for (const [key, info] of Object.entries(productMap)) {
        if (key.length > 10 && (key.includes(nameKey.slice(0, 15)) || nameKey.includes(key.slice(0, 15)))) {
          match = info;
          break;
        }
      }
    }

    if (!match) {
      unmatched.push({ sku: it.sku, name: it.name });
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

  if (dropiProducts.length === 0) {
    return respond(400, {
      error: 'Ningun producto matcheado en Dropi',
      unmatched,
      hint: 'Los productos Shopify no aparecen en las ultimas 200 ordenes Dropi. Verifica SKU/nombre.',
    });
  }

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
    products: dropiProducts,
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
