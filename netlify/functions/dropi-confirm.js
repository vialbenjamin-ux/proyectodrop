// Confirma ordenes en Dropi Chile (PENDIENTE CONFIRMACION -> PENDIENTE).
// Silencioso: no manda notificacion al cliente.
// SOP referencia: seccion 1.2 + 5.2 (Confirmacion Express).
//
// Endpoint Dropi: POST /integrations/orders/myorder/masive
// Body: [{"id": 123, "status": "PENDIENTE"}, ...]
//
// Uso desde BKDROP frontend:
//   POST /.netlify/functions/dropi-confirm
//   Body: { orderIds: [123, 456, ...] }
//   Respuesta: { confirmed: [...], failed: [...], count }
//
// SEGURIDAD: este endpoint mueve plata real. Cap de 50 ordenes por request
// para evitar catastrofes por bug. Si necesitas mas, hace multiples calls.

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
  if (orderIds.length > 50) {
    return respond(400, { error: 'Cap de 50 ordenes por request. Fracciona.' });
  }

  // Sanitizar: solo IDs numericos o strings de digitos
  const cleanIds = orderIds
    .map(id => (typeof id === 'number' ? id : parseInt(String(id), 10)))
    .filter(id => Number.isInteger(id) && id > 0);

  if (cleanIds.length === 0) {
    return respond(400, { error: 'Ningun orderId valido despues de sanitizar' });
  }

  // Body para Dropi: array de objetos {id, status: "PENDIENTE"}
  const dropiBody = cleanIds.map(id => ({ id, status: 'PENDIENTE' }));

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

    // Dropi devuelve estructura variable. Algunos response incluyen "success" o
    // "confirmed" arrays. Devolvemos todo tal cual + un resumen simple.
    return respond(200, {
      ok: true,
      attempted: cleanIds,
      count: cleanIds.length,
      dropiResponse: data,
      confirmedAt: new Date().toISOString(),
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
