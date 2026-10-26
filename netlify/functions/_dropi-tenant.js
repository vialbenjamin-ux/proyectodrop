// Resuelve host + token de Dropi segun el pais (chile, gt o mx).
//
// Sin `tenant` sigue siendo Chile, para que las llamadas viejas se comporten
// igual. Un tenant desconocido ya NO cae en Chile: vuelve con `error` y el
// llamador responde 400 (ver _tenant.js).
//
// Uso:  const { dropiTenant } = require('./_dropi-tenant');
//       const T = dropiTenant(event.queryStringParameters, body);
//       if (T.error) return respond(400, { error: T.error });
//       if (!T.token) return respond(500, { error: 'Falta ' + T.envName });
//       fetch(T.base + '/integrations/orders/myorders', ...)

const { paisDe, pais } = require('./_tenant');

function armar(P) {
  if (P.error) return { error: P.error, token: null, envName: 'tenant valido' };
  return {
    ...P,
    tenant: P.codigo,
    base: P.dropiBase,
    app: P.dropiApp,
    // _tenant.js ya hace .trim(): pegar la key en Netlify suele arrastrar un
    // salto de linea, y Dropi responde 401 sin decir que el token viene sucio.
    token: P.dropiToken,
    envName: P.envDropiToken,
  };
}

function dropiTenant(qs, body) {
  return armar(paisDe(qs, body));
}

// Acepta el codigo del pais ('chile' | 'gt' | 'mx') o, por compatibilidad,
// el viejo booleano isGT.
function codigoDe(x) {
  if (x === true) return 'gt';
  if (x === false || x == null) return 'chile';
  return x;
}

// Cuenta de Dropi a la que pertenece el token de la API (claim `sub` del JWT).
// Es la fuente de verdad de "cual es la cuenta buena": los productos cuyo
// metafield trae un token de OTRA cuenta rebotan con "no posee saldo
// suficiente en la wallet". Antes se adivinaba por mayoria entre productos de
// muestra, y con la tienda repartida mitad y mitad salia la cuenta vieja.
function cuentaDelToken(paisOIsGT) {
  const P = pais(codigoDe(paisOIsGT));
  const tok = P.error ? '' : String(P.dropiToken || '');
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

module.exports = { dropiTenant, cuentaDelToken, codigoDe };
