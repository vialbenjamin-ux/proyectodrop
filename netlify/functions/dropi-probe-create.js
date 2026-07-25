// PROBE iter 3: descubrir campo state + como listar mis productos.

exports.handler = async (event) => {
  const token = process.env.DROPI_TOKEN_CL;
  if (!token) return respond(500, { error: 'Falta DROPI_TOKEN_CL' });

  const base = 'https://api.dropi.cl';
  const headers = {
    'dropi-integration-key': token,
    'Content-Type': 'application/json',
    'User-Agent': 'BKDROP-Probe/1.0',
  };

  const results = [];

  // BLOQUE A: Iterar creacion con distintas ubicaciones del "state"
  const orderBodies = [
    { label: 'A1: state top-level', body: {
      products: [{ id: 1, quantity: 1, price: 25000 }],
      client_name: 'Test', client_phone: '900000000',
      client_email: 'test@test.cl',
      client_address: 'Calle Test 123',
      client_city: 'Santiago',
      state: 'Region Metropolitana',
      total: 25000, total_order: 25000,
    } },
    { label: 'A2: state en cada product', body: {
      products: [{ id: 1, quantity: 1, price: 25000, state: 'PENDIENTE' }],
      client_name: 'Test', client_phone: '900000000',
      client_address: 'Calle Test 123', client_city: 'Santiago',
      total: 25000,
    } },
    { label: 'A3: address obj con state', body: {
      products: [{ id: 1, quantity: 1, price: 25000 }],
      client: { name: 'Test', phone: '900000000', email: 't@t.cl' },
      address: { line1: 'Calle Test 123', city: 'Santiago', state: 'Region Metropolitana' },
      total: 25000,
    } },
    { label: 'A4: state como status de orden', body: {
      products: [{ id: 1, quantity: 1, price: 25000 }],
      client_name: 'Test', client_phone: '900000000',
      client_address: 'Calle Test 123', client_city: 'Santiago',
      state: 'PENDIENTE CONFIRMACION',
      total: 25000,
    } },
  ];
  for (const b of orderBodies) {
    try {
      const resp = await fetch(base + '/integrations/orders/myorders', {
        method: 'POST', headers, body: JSON.stringify(b.body)
      });
      const txt = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt.slice(0, 250) }; }
      const errorMsg = (parsed && parsed.error) ? String(parsed.error).slice(0, 200) : (parsed && parsed.message ? parsed.message : null);
      results.push({
        label: b.label,
        status: resp.status,
        error: errorMsg,
      });
    } catch (err) {
      results.push({ label: b.label, status: 'fetch_error', error: err.message });
    }
    await new Promise(r => setTimeout(r, 600));
  }

  // BLOQUE B: Descubrir como listar productos propios
  const productProbes = [
    { m: 'POST', p: '/integrations/products', body: {} },
    { m: 'POST', p: '/integrations/products', body: { start: 0, result_number: 10 } },
    { m: 'POST', p: '/integrations/products/myproducts', body: {} },
    { m: 'POST', p: '/integrations/products/myproducts', body: { start: 0, result_number: 10 } },
    { m: 'GET',  p: '/integrations/products/list' },
    { m: 'GET',  p: '/integrations/myproducts' },
  ];
  for (const p of productProbes) {
    try {
      const opts = { method: p.m, headers };
      if (p.body != null) opts.body = JSON.stringify(p.body);
      const resp = await fetch(base + p.p, opts);
      const txt = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt.slice(0, 200) }; }
      results.push({
        label: p.m + ' ' + p.p + (p.body ? ' + body' : ''),
        status: resp.status,
        preview: parsed && typeof parsed === 'object' ? JSON.stringify(parsed).slice(0, 350) : String(parsed).slice(0, 350),
      });
    } catch (err) {
      results.push({ label: p.m + ' ' + p.p, status: 'fetch_error', preview: err.message });
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // BLOQUE C: Mirar una orden existente para ver la estructura completa que Dropi maneja
  try {
    // Traer 1 orden reciente
    const listResp = await fetch(base + '/integrations/orders/myorders?start=0&result_number=1', {
      method: 'GET', headers,
    });
    const listTxt = await listResp.text();
    let listData = null;
    try { listData = JSON.parse(listTxt); } catch {}
    if (listData && Array.isArray(listData.objects) && listData.objects.length > 0) {
      const firstOrder = listData.objects[0];
      results.push({
        label: 'C: sample order keys (para saber shape)',
        status: 200,
        keys: Object.keys(firstOrder),
      });
      // Ver keys del primer product si existe
      const firstProduct = (firstOrder.products || [])[0];
      if (firstProduct) {
        results.push({
          label: 'C: sample product keys',
          status: 200,
          keys: Object.keys(firstProduct),
        });
      }
    }
  } catch (err) {
    results.push({ label: 'C: sample order', status: 'error', error: err.message });
  }

  return respond(200, { probedAt: new Date().toISOString(), results });
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
