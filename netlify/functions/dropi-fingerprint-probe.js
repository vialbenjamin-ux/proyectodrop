// Prueba si el historial del comprador de Dropi (el que muestra el panel) acepta
// la llave de integracion, para decidir si el confirmador puede correr en servidor.
//
// GET /.netlify/functions/dropi-fingerprint-probe?phone=912345678
//
// Solo lee, y devuelve el status y los NOMBRES de los campos: ningun valor, para
// no publicar el historial de un cliente. Se borra cuando se decida el camino.

const { dropiTenant, cuentaDelToken } = require('./_dropi-tenant');

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const phone = String(qs.phone || '').trim();
  if (!/^\d{8,12}$/.test(phone)) return respond(400, { error: 'phone invalido' });

  const T = dropiTenant({ tenant: 'chile' });
  if (T.error) return respond(400, { error: T.error });
  if (!T.token) return respond(500, { error: 'Falta ' + T.envName });

  const url = 'https://api-v2.dropi.cl/bff/customers/fingerprint/v2?country_code=CL'
    + '&user_id=' + cuentaDelToken('chile') + '&phone=' + phone + '&months=0';

  try {
    const r = await fetch(url, {
      headers: { 'dropi-integration-key': T.token, 'User-Agent': 'BKDROP-Sync/1.0' },
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (_) {}
    return respond(200, {
      status: r.status,
      is_successful: j ? j.is_successful : null,
      status_reason: j ? j.status_reason : null,
      campos: j ? campos(j.data) : null,
    });
  } catch (err) {
    return respond(502, { error: err.message || 'error desconocido' });
  }
};

// Arbol con los nombres de los campos, sin ningun valor.
function campos(o) {
  if (Array.isArray(o)) return o.length ? [campos(o[0])] : [];
  if (o && typeof o === 'object') {
    const s = {};
    for (const k of Object.keys(o)) s[k] = campos(o[k]);
    return s;
  }
  return typeof o;
}

function respond(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
