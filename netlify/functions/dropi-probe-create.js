// PROBE iter 4: traer 1 orden real completa para ver el shape exacto.

exports.handler = async (event) => {
  const token = process.env.DROPI_TOKEN_CL;
  if (!token) return respond(500, { error: 'Falta DROPI_TOKEN_CL' });

  const base = 'https://api.dropi.cl';
  const headers = {
    'dropi-integration-key': token,
    'Content-Type': 'application/json',
    'User-Agent': 'BKDROP-Probe/1.0',
  };

  const qs = event.queryStringParameters || {};

  // Modo distinct: listar distribution_company_ids unicos de mis ordenes
  if (qs.distinct === 'YES') {
    const listResp = await fetch(base + '/integrations/orders/myorders?start=0&result_number=100', {
      method: 'GET', headers,
    });
    const listData = JSON.parse(await listResp.text());
    const orders = listData.objects || [];
    const dcIds = {};
    for (const o of orders) {
      if (o.distribution_company_id) {
        const key = o.distribution_company_id + ':' + (o.shipping_company || '?');
        dcIds[key] = (dcIds[key] || 0) + 1;
      }
    }
    const warehouses = {};
    for (const o of orders) {
      if (o.warehouse_id) warehouses[o.warehouse_id + ':' + (o.warehouse && o.warehouse.name || '?')] = (warehouses[o.warehouse_id + ':' + (o.warehouse && o.warehouse.name || '?')] || 0) + 1;
    }
    return respond(200, {
      totalOrders: orders.length,
      distributionCompanies: dcIds,
      warehouses,
    });
  }

  // Modo cloneStarken: buscar una orden STARKEN reciente y clonarla (con phone falso)
  if (qs.cloneStarken === 'YES') {
    const listResp = await fetch(base + '/integrations/orders/myorders?start=0&result_number=50', {
      method: 'GET', headers,
    });
    const listData = JSON.parse(await listResp.text());
    const orders = listData.objects || [];
    const starken = orders.find(o => o.distribution_company_id === 5);
    if (!starken) return respond(200, { error: 'No hay ordenes STARKEN recientes' });
    const firstProd = (starken.orderdetails && starken.orderdetails[0]) || null;
    if (!firstProd) return respond(200, { error: 'Orden STARKEN sin orderdetails' });
    const body = {
      name: 'TEST BKDROP',
      surname: 'PROBE STARKEN',
      phone: '999999999',
      dir: 'Prueba API - NO DESPACHAR',
      city: starken.city,
      state: starken.state,
      zip_code: null,
      colonia: null,
      notes: 'ORDEN API PROBE - CANCELAR',
      type: 'FINAL_ORDER',
      rate_type: 'CON RECAUDO',
      warehouse_id: starken.warehouse_id,
      shop_id: starken.shop_id,
      distribution_company_id: 5,
      shipping_company: 'STARKEN',
      total_order: starken.total_order,
      products: [{ id: firstProd.product_id, product_id: firstProd.product_id, quantity: 1, price: starken.total_order }],
    };
    try {
      const resp = await fetch(base + '/integrations/orders/myorders', {
        method: 'POST', headers, body: JSON.stringify(body)
      });
      const txt = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt.slice(0, 500) }; }
      return respond(200, { clonedFrom: starken.id, sentBody: body, httpStatus: resp.status, response: parsed });
    } catch (err) {
      return respond(500, { error: err.message });
    }
  }

  // Modo POST: solo si viene ?post=YES
  if (qs.post === 'YES') {
    const body = {
      name: 'TEST BKDROP',
      surname: 'PROBE',
      phone: '999999999',
      dir: 'Direccion API - NO DESPACHAR',
      city: 'COLINA',
      state: 'METROPOLITANA DE SANTIAGO',
      zip_code: null,
      colonia: null,
      notes: 'ORDEN API PROBE - CANCELAR',
      type: 'FINAL_ORDER',
      rate_type: 'CON RECAUDO',
      warehouse_id: 79,
      shop_id: 152458,
      total_order: 1000,
      distribution_company_id: 5,
      shipping_company: 'STARKEN',
      products: [{ id: 15053, product_id: 15053, quantity: 1, price: 1000 }],
    };
    try {
      const resp = await fetch(base + '/integrations/orders/myorders', {
        method: 'POST', headers, body: JSON.stringify(body)
      });
      const txt = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt.slice(0, 500) }; }
      return respond(200, { sentBody: body, httpStatus: resp.status, response: parsed });
    } catch (err) {
      return respond(500, { error: err.message });
    }
  }

  // Modo default: solo mostrar sample
  try {
    const listResp = await fetch(base + '/integrations/orders/myorders?start=0&result_number=1', {
      method: 'GET', headers,
    });
    const listTxt = await listResp.text();
    const listData = JSON.parse(listTxt);
    const order = (listData.objects && listData.objects[0]) || null;
    if (!order) return respond(200, { error: 'No hay ordenes' });

    return respond(200, {
      probedAt: new Date().toISOString(),
      sampleOrder: order,
      note: 'Agrega ?post=YES a la URL para intentar CREAR una orden de prueba.',
    });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload, null, 2),
  };
}
