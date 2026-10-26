// País (tenant) de cada llamada: Chile, Guatemala o México.
//
// Antes cada función hacía `tenant === 'gt' ? GT : Chile`, así que cualquier
// otro valor ("guatemala", "mx", un typo) caía calladito en la tienda de Chile.
// Acá un país desconocido es un error; solo la falta de `tenant` sigue
// significando Chile, para no romper las llamadas viejas que no lo mandan.
//
// Uso:
//   const { paisDe } = require('./_tenant');
//   const T = paisDe(event.queryStringParameters, body);
//   if (T.error) return respond(400, { error: T.error });
//   T.shopifyToken, T.shopifyDomain, T.metaToken, T.dropiToken, T.dropiBase...

const PAISES = {
  chile: {
    codigo: 'chile', etiqueta: '', nombre: 'Chile',
    envShopifyToken: 'SHOPIFY_TOKEN', envShopifyDomain: 'SHOPIFY_DOMAIN',
    envMetaToken: 'META_ACCESS_TOKEN', envDropiToken: 'DROPI_TOKEN_CL',
    dropiBase: 'https://api.dropi.cl', dropiApp: 'https://app.dropi.cl',
    moneda: 'CLP', simbolo: '$', locale: 'es-CL', tz: 'America/Santiago',
    // Piso de precio publicado y precios de relleno que nunca se publican.
    pisoPrecio: 24990, preciosProhibidos: [],
    // Precio con que el importador crea el producto mientras no hay uno real.
    precioRelleno: 999,
    prefijoTelefono: '56',
  },
  gt: {
    codigo: 'gt', etiqueta: ' GT', nombre: 'Guatemala',
    envShopifyToken: 'SHOPIFY_TOKEN_GT', envShopifyDomain: 'SHOPIFY_DOMAIN_GT',
    envMetaToken: 'META_ACCESS_TOKEN_GT', envDropiToken: 'DROPI_TOKEN_GT',
    dropiBase: 'https://api.dropi.gt', dropiApp: 'https://app.dropi.gt',
    moneda: 'GTQ', simbolo: 'Q', locale: 'es-GT', tz: 'America/Guatemala',
    pisoPrecio: 169, preciosProhibidos: [999],
    precioRelleno: 999,
    prefijoTelefono: '502',
  },
  mx: {
    codigo: 'mx', etiqueta: ' MX', nombre: 'México',
    envShopifyToken: 'SHOPIFY_TOKEN_MX', envShopifyDomain: 'SHOPIFY_DOMAIN_MX',
    envMetaToken: 'META_ACCESS_TOKEN_MX', envDropiToken: 'DROPI_TOKEN_MX',
    dropiBase: 'https://api.dropi.mx', dropiApp: 'https://app.dropi.mx',
    moneda: 'MXN', simbolo: '$', locale: 'es-MX', tz: 'America/Mexico_City',
    // El piso de Chile (24.990 CLP) en pesos mexicanos, como pidió Benjamín
    // el 26 oct 2026 "hasta nuevo aviso". En México 999 es EL precio típico
    // de la competencia contra entrega, así que se permite: el relleno del
    // importador pasa a ser 1, que el piso frena solo.
    pisoPrecio: 479, preciosProhibidos: [],
    precioRelleno: 1,
    prefijoTelefono: '52',
    // Mientras el tema BENKOMX no este publicado, las plantillas van a ESE tema
    // y no al publicado (el de Fauno). Sin la variable, se usa el publicado.
    envThemeId: 'SHOPIFY_THEME_ID_MX',
  },
};

// "cl" se acepta como Chile. "cp" son las cuentas de Meta de otro BM: el panel
// manda ese tenant a los reportes y siempre se resolvió como Chile (tienda y
// token), así que se mantiene. Cualquier otro nombre es error a propósito:
// "guatemala" en vez de "gt" ya subió una vez landings de GT a la tienda de Chile.
const ALIAS = { cl: 'chile', cp: 'chile' };

const leer = n => String(process.env[n] || '').trim() || null;

function pais(codigo) {
  const c = String(codigo == null || codigo === '' ? 'chile' : codigo).trim().toLowerCase();
  const p = PAISES[ALIAS[c] || c];
  if (!p) return { error: 'País desconocido: "' + codigo + '". Usa tenant=chile, gt o mx.' };
  return {
    ...p,
    isGT: p.codigo === 'gt',
    isMX: p.codigo === 'mx',
    shopifyToken: leer(p.envShopifyToken),
    shopifyDomain: leer(p.envShopifyDomain),
    metaToken: leer(p.envMetaToken),
    dropiToken: leer(p.envDropiToken),
    themeId: p.envThemeId ? leer(p.envThemeId) : null,
  };
}

// Lee `tenant` del querystring o del body (en ese orden).
function paisDe(qs, body) {
  const raw = (qs && qs.tenant) || (body && body.tenant) || '';
  return pais(raw);
}

// Mensaje estándar cuando faltan las credenciales de Shopify del país.
function faltaShopify(T) {
  if (T.shopifyToken && T.shopifyDomain) return null;
  return 'Faltan credenciales Shopify' + T.etiqueta + ' (' + T.envShopifyToken + ' / ' + T.envShopifyDomain + ')';
}

// true si el precio no se puede publicar en ese país. Un valor que no es número
// pasa (igual que antes de este módulo): lo valida Shopify.
function precioInvalido(precio, T) {
  const n = Number(precio);
  if (!Number.isFinite(n)) return false;
  if (T.pisoPrecio == null) return true;
  return n < T.pisoPrecio || T.preciosProhibidos.includes(n);
}

function msgPrecio(precio, T) {
  if (T.pisoPrecio == null) {
    return 'Precio ' + precio + ' no permitido: todavía no está definido el piso de precio de ' + T.nombre + '.';
  }
  const prohibidos = T.preciosProhibidos.length ? ' y nunca ' + T.preciosProhibidos.join(', ') + ' de relleno' : '';
  return 'Precio ' + precio + ' no permitido: en ' + T.nombre + ' el mínimo es ' + T.simbolo + T.pisoPrecio.toLocaleString(T.locale) + prohibidos + '.';
}

module.exports = { PAISES, pais, paisDe, faltaShopify, precioInvalido, msgPrecio };
