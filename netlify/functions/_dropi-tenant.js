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
    token: isGT ? process.env.DROPI_TOKEN_GT : process.env.DROPI_TOKEN_CL,
    envName: isGT ? 'DROPI_TOKEN_GT' : 'DROPI_TOKEN_CL',
    moneda: isGT ? 'GTQ' : 'CLP',
  };
}

module.exports = { dropiTenant };
