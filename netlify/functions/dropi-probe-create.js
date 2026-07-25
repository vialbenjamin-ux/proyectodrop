// TEMPORAL: descubre schema del body para POST /integrations/orders/myorders
// Envia bodies incrementales y captura qué campo pide en cada iteracion.

exports.handler = async (event) => {
  const token = process.env.DROPI_TOKEN_CL;
  if (!token) return respond(500, { error: 'Falta DROPI_TOKEN_CL' });

  const base = 'https://api.dropi.cl';
  const headers = {
    'dropi-integration-key': token,
    'Content-Type': 'application/json',
    'User-Agent': 'BKDROP-Probe/1.0',
  };

  // Iteracion: cada body agrega un campo mas para ver qué error nuevo aparece.
  const bodies = [
    { label: 'solo products vacio', body: { products: [] } },
    { label: 'products con item basico', body: { products: [{ id: 1, quantity: 1 }] } },
    { label: 'products + client basico', body: {
      products: [{ id: 1, quantity: 1 }],
      client: { name: 'Test', phone: '900000000' }
    } },
    { label: 'products + shipping', body: {
      products: [{ id: 1, quantity: 1 }],
      client_name: 'Test',
      client_phone: '900000000',
      client_address: 'Calle Test 123',
      client_city: 'Santiago',
      client_department: 'Region Metropolitana',
    } },
    { label: 'todos los campos comunes', body: {
      products: [{ id: 1, quantity: 1, price: 25000 }],
      client_name: 'Test',
      client_phone: '900000000',
      client_email: 'test@test.cl',
      client_address: 'Calle Test 123',
      client_city: 'Santiago',
      client_department: 'Region Metropolitana',
      transport: 'STARKEN',
      total: 25000,
      total_order: 25000,
    } },
  ];

  const results = [];
  for (const b of bodies) {
    try {
      const resp = await fetch(base + '/integrations/orders/myorders', {
        method: 'POST', headers, body: JSON.stringify(b.body)
      });
      const txt = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt.slice(0, 300) }; }
      results.push({
        label: b.label,
        sentBody: b.body,
        status: resp.status,
        response: parsed && typeof parsed === 'object' ? JSON.stringify(parsed).slice(0, 500) : String(parsed).slice(0, 500),
      });
    } catch (err) {
      results.push({ label: b.label, status: 'fetch_error', response: err.message });
    }
    await new Promise(r => setTimeout(r, 600));
  }

  // Tambien probamos algunos GET para productos/transportadoras
  const gets = [
    '/integrations/products/myproducts?id=1',
    '/integrations/products/myproducts?product_id=1',
    '/integrations/orders/myorder/1',
    '/integrations/config',
    '/integrations/integrations',
  ];
  for (const p of gets) {
    try {
      const resp = await fetch(base + p, { method: 'GET', headers });
      const txt = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt.slice(0, 200) }; }
      results.push({
        label: 'GET ' + p,
        status: resp.status,
        response: parsed && typeof parsed === 'object' ? JSON.stringify(parsed).slice(0, 400) : String(parsed).slice(0, 400),
      });
    } catch (err) {
      results.push({ label: 'GET ' + p, status: 'fetch_error', response: err.message });
    }
    await new Promise(r => setTimeout(r, 400));
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
