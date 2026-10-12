// Background function (hasta 15 min): vacia la cola de dropi-auto-variantes de
// un pais llamando al endpoint HTTP de a un pedido, con 36 s entre llamadas.
// dropi-create-order corta por rate limit si se le mandan seguidos ("No se pudo
// cargar cache Dropi"); con 35 s pasaron siempre.
//
// GET ?tenant=chile|gt   -> responde 202 al tiro y sigue trabajando.

const MAX_PEDIDOS = 18;

exports.handler = async (event) => {
  const tenant = (event.queryStringParameters || {}).tenant === 'gt' ? 'gt' : 'chile';
  const origin = process.env.URL || 'https://bkdrop.netlify.app';
  for (let i = 0; i < MAX_PEDIDOS; i++) {
    let res = {};
    try {
      const r = await fetch(`${origin}/.netlify/functions/dropi-auto-variantes?tenant=${tenant}`);
      res = await r.json();
    } catch (e) {
      console.log(tenant, 'error', e.message);
      break;
    }
    console.log(tenant, JSON.stringify(res).slice(0, 300));
    if (!res.creado && !res.fallo) break;
    await new Promise((ok) => setTimeout(ok, 36000));
  }
  return { statusCode: 200, body: '' };
};
