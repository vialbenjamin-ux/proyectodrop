// Cancela ordenes en Dropi Chile (a status CANCELADO).
// ACCION DESTRUCTIVA: si el algoritmo se equivoca, perdes la venta entera.
// Por eso: cap 20 ordenes/request (mas chico que dropi-confirm que era 50).
// SOP referencia: seccion 1.2 + 5.3.
//
// Uso:
//   POST /.netlify/functions/dropi-cancel
//   Body: { orderIds: [123, 456, ...] }
//
// Respuesta: { ok, attempted, count, dropiResponse, cancelledAt }

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

  const orderIds = Array.isArray(body.orderIds) ? body.orderIds : [];
  if (orderIds.length === 0) return respond(400, { error: 'orderIds requerido (array)' });
  if (orderIds.length > 20) {
    return respond(400, { error: 'Cap 20 ordenes por request (cancelacion es destructiva). Fracciona.' });
  }

  const cleanIds = orderIds
    .map(id => (typeof id === 'number' ? id : parseInt(String(id), 10)))
    .filter(id => Number.isInteger(id) && id > 0);

  if (cleanIds.length === 0) {
    return respond(400, { error: 'Ningun orderId valido' });
  }

  const dropiBody = cleanIds.map(id => ({ id, status: 'CANCELADO' }));

  try {
    const resp = await fetch('https://api.dropi.cl/integrations/orders/myorder/masive', {
      method: 'POST',
      headers: {
        'dropi-integration-key': token,
        'Content-Type': 'application/json',
        'User-Agent': 'BKDROP-Sync/1.0',
      },
      body: JSON.stringify(dropiBody),
    });

    const txt = await resp.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 500) }; }

    if (!resp.ok) {
      return respond(502, {
        error: 'Dropi API ' + resp.status,
        detail: data,
        attempted: cleanIds,
      });
    }

    return respond(200, {
      ok: true,
      attempted: cleanIds,
      count: cleanIds.length,
      dropiResponse: data,
      cancelledAt: new Date().toISOString(),
    });
  } catch (err) {
    return respond(502, { error: 'Fetch Dropi fail: ' + (err.message || 'unknown') });
  }
};

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
