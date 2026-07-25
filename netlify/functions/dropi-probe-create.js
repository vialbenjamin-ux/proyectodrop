// TEMPORAL: prueba varios endpoints candidatos de Dropi para crear ordenes.
// No crea nada real (body vacio o invalido a proposito). Solo mira las
// respuestas HTTP para descubrir cual endpoint existe y que espera.
// Borrar cuando terminemos la investigacion.

exports.handler = async (event) => {
  const token = process.env.DROPI_TOKEN_CL;
  if (!token) return respond(500, { error: 'Falta DROPI_TOKEN_CL' });

  const base = 'https://api.dropi.cl';
  const headers = {
    'dropi-integration-key': token,
    'Content-Type': 'application/json',
    'User-Agent': 'BKDROP-Probe/1.0',
  };

  // Candidatos comunes para "crear orden" en APIs REST
  const candidates = [
    { path: '/integrations/orders/myorder',        method: 'POST', body: {} },
    { path: '/integrations/orders/myorders',       method: 'POST', body: {} },
    { path: '/integrations/orders/create',         method: 'POST', body: {} },
    { path: '/integrations/orders',                method: 'POST', body: {} },
    // Tambien probamos GET al schema/products para saber qué IDs hay
    { path: '/integrations/products',              method: 'GET',  body: null },
    { path: '/integrations/products/myproducts',   method: 'GET',  body: null },
    { path: '/integrations/warehouse',             method: 'GET',  body: null },
    { path: '/integrations/warehouses',            method: 'GET',  body: null },
    { path: '/integrations/transports',            method: 'GET',  body: null },
    { path: '/integrations/carriers',              method: 'GET',  body: null },
  ];

  const results = [];
  for (const c of candidates) {
    try {
      const opts = { method: c.method, headers };
      if (c.body != null) opts.body = JSON.stringify(c.body);
      const resp = await fetch(base + c.path, opts);
      const txt = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt.slice(0, 300) }; }
      results.push({
        endpoint: c.method + ' ' + c.path,
        status: resp.status,
        response: parsed && typeof parsed === 'object' ? JSON.stringify(parsed).slice(0, 400) : String(parsed).slice(0, 400),
      });
    } catch (err) {
      results.push({
        endpoint: c.method + ' ' + c.path,
        status: 'fetch_error',
        response: err.message || 'unknown',
      });
    }
    // Delay entre requests para no gatillar rate limit
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
