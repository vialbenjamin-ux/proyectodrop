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

  try {
    const listResp = await fetch(base + '/integrations/orders/myorders?start=0&result_number=1', {
      method: 'GET', headers,
    });
    const listTxt = await listResp.text();
    const listData = JSON.parse(listTxt);
    const order = (listData.objects && listData.objects[0]) || null;
    if (!order) return respond(200, { error: 'No hay ordenes' });

    // Devolvemos toda la orden completa (sin filtrar) para ver todos los campos y el shape de orderdetails
    return respond(200, {
      probedAt: new Date().toISOString(),
      sampleOrder: order,
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
