// Resuelve host + token de Dropi segun el pais.
//
// Default 'chile' A PROPOSITO: las llamadas que no mandan `tenant` se
// comportan exactamente igual que antes de que esto fuera multi-tenant.
// Solo la seccion de Guatemala pasa tenant='gt'.
//
// Uso:  const { dropiTenant } = require('./_dropi-tenant');
//       const T = dropiTenant(event.queryStringParameters, body);
//       if (!T.token) return respond(500, { error: 'Falta ' + T.envName });
//       fetch(T.base + '/integrations/orders/myorders', ...)

function dropiTenant(qs, body) {
  const raw = (qs && qs.tenant) || (body && body.tenant) || 'chile';
  const isGT = String(raw).toLowerCase() === 'gt';
  return {
    tenant: isGT ? 'gt' : 'chile',
    isGT: isGT,
    base: isGT ? 'https://api.dropi.gt' : 'https://api.dropi.cl',
    app: isGT ? 'https://app.dropi.gt' : 'https://app.dropi.cl',
    // .trim(): pegar la key en Netlify suele arrastrar un salto de linea o un
    // espacio, y Dropi responde 401 sin decir que el token viene sucio.
    token: String((isGT ? process.env.DROPI_TOKEN_GT : process.env.DROPI_TOKEN_CL) || '').trim() || null,
    envName: isGT ? 'DROPI_TOKEN_GT' : 'DROPI_TOKEN_CL',
    moneda: isGT ? 'GTQ' : 'CLP',
  };
}

// Cuenta de Dropi a la que pertenece el token de la API (claim `sub` del JWT).
// Es la fuente de verdad de "cual es la cuenta buena": los productos cuyo
// metafield trae un token de OTRA cuenta rebotan con "no posee saldo
// suficiente en la wallet". Antes se adivinaba por mayoria entre productos de
// muestra, y con la tienda repartida mitad y mitad salia la cuenta vieja.
function cuentaDelToken(isGT) {
  const tok = String((isGT ? process.env.DROPI_TOKEN_GT : process.env.DROPI_TOKEN_CL) || '').trim();
  try {
    const parts = tok.split('.');
    if (parts.length < 2) return null;
    let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const p = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
    return p && p.sub != null ? String(p.sub) : null;
  } catch (_) {
    return null;
  }
}

module.exports = { dropiTenant, cuentaDelToken };
