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
