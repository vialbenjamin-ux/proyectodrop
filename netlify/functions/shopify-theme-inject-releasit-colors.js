// Inyecta CSS en el theme Shopify Chile para pintar los precios grandes
// de las quantity offers de Releasit COD Form del mismo color que el badge
// (verde/azul/morado por tramo).
//
// Selectores reverse-engineered de un widget renderizado (2026-08):
//   ._rsi-quantity-offers-offer[data-offer-pos="0"] → tramo 1 (Llevo 1)
//   ._rsi-quantity-offers-offer[data-offer-pos="1"] → tramo 2 (Llevo 2)
//   ._rsi-quantity-offers-offer[data-offer-pos="2"] → tramo 3 (Llevo 3)
//   ._rsi-quantity-offers-new-price → el precio grande de ese tramo
//
// Colores (match con COLOR_1/2/3 de shopify-releasit-publish.js):
//   verde  rgba(34, 197, 94, 1)
//   azul   rgba(0, 116, 191, 1)
//   morado rgba(139, 92, 246, 1)
//
// POST /.netlify/functions/shopify-theme-inject-releasit-colors
//   Body opcional: { tenant: 'chile' } — solo chile por ahora.
// Response: { ok, action: 'created'|'updated'|'already-in-place', assetKey }
//
// Estrategia:
// 1. Crear/actualizar el asset assets/bk-releasit-colors.css con el CSS.
// 2. Modificar theme.liquid para incluir el <link> si no está.

// El CSS solo aplica cuando el <html> tiene data-bk-releasit-colors="on".
// Ese data-attr solo se setea (por Liquid en theme.liquid) si el producto
// tiene el tag 'bk-releasit-colors'. Asi los productos viejos (sin tag) NO
// se ven afectados — solo los que publiquemos de aca en adelante.
const CSS_CONTENT = `/* BKDROP — colores de precios Releasit por tramo. Solo aplica a productos con tag 'bk-releasit-colors'. NO editar a mano. */
[data-bk-releasit-colors="on"] ._rsi-quantity-offers-offer[data-offer-pos="0"] ._rsi-quantity-offers-new-price {
  color: rgba(34, 197, 94, 1) !important;
}
[data-bk-releasit-colors="on"] ._rsi-quantity-offers-offer[data-offer-pos="1"] ._rsi-quantity-offers-new-price {
  color: rgba(0, 116, 191, 1) !important;
}
[data-bk-releasit-colors="on"] ._rsi-quantity-offers-offer[data-offer-pos="2"] ._rsi-quantity-offers-new-price {
  color: rgba(139, 92, 246, 1) !important;
}
[data-bk-releasit-colors="on"] ._rsi-quantity-offers-offer[data-offer-pos="3"] ._rsi-quantity-offers-new-price {
  color: rgba(230, 138, 46, 1) !important;
}
`;

const ASSET_KEY = 'assets/bk-releasit-colors.css';
const INCLUDE_MARKER_START = '<!-- BK_RELEASIT_COLORS_START -->';
const INCLUDE_MARKER_END = '<!-- BK_RELEASIT_COLORS_END -->';
// Insertamos:
//  1) <link> al CSS
//  2) Un <script> Liquid condicional que setea data-bk-releasit-colors="on"
//     en <html> SOLO si el producto tiene el tag 'bk-releasit-colors'.
// El script JS es la solucion mas robusta: pinta los precios directamente
// con style.setProperty('color', X, 'important'), lo que gana sobre el
// inline color: rgba(...) que setea el widget de Releasit sin !important.
// El CSS + data-attr no funciono por race condition de timing con el widget.
// Nota: este <script> se inyecta DENTRO del <head> (antes de </head>).
// En ese momento document.body todavia no existe. Por eso el bootstrap
// espera 'DOMContentLoaded' o el body listo antes de arrancar el paint.
const PAINT_SCRIPT = '<script>\n' +
  '(function(){\n' +
  '  var COLORS = ["rgba(34,197,94,1)","rgba(0,116,191,1)","rgba(139,92,246,1)","rgba(230,138,46,1)"];\n' +
  '  function paint(){\n' +
  '    // El elemento con data-offer-pos es _rsi-quantity-offers-offer-container.\n' +
  '    // Usamos [data-offer-pos] para ser robustos ante renombres de clase.\n' +
  '    var offers = document.querySelectorAll("[data-offer-pos]");\n' +
  '    if(!offers.length) return false;\n' +
  '    var didAny = false;\n' +
  '    offers.forEach(function(o){\n' +
  '      var pos = parseInt(o.getAttribute("data-offer-pos"),10);\n' +
  '      if(isNaN(pos) || pos < 0 || pos >= COLORS.length) return;\n' +
  '      o.querySelectorAll("._rsi-quantity-offers-new-price").forEach(function(el){\n' +
  '        el.style.setProperty("color", COLORS[pos], "important");\n' +
  '        didAny = true;\n' +
  '      });\n' +
  '    });\n' +
  '    return didAny;\n' +
  '  }\n' +
  '  function start(){\n' +
  '    if(window.location && window.location.pathname && window.location.pathname.indexOf("/products/") === -1) return;\n' +
  '    var tries = 0;\n' +
  '    var iv = setInterval(function(){\n' +
  '      tries++;\n' +
  '      paint();\n' +
  '      if(tries > 120) clearInterval(iv);\n' +  // 30s total (120 x 250ms)
  '    }, 250);\n' +
  '    try{\n' +
  '      var obs = new MutationObserver(function(){ paint(); });\n' +
  '      obs.observe(document.body, {childList:true, subtree:true, attributes:true, attributeFilter:["class","style"]});\n' +
  '    }catch(e){}\n' +
  '  }\n' +
  '  if(document.readyState === "loading"){\n' +
  '    document.addEventListener("DOMContentLoaded", start);\n' +
  '  } else {\n' +
  '    start();\n' +
  '  }\n' +
  '})();\n' +
  '</script>';

const INCLUDE_TAG = INCLUDE_MARKER_START + '\n' +
  '<link rel="stylesheet" href="{{ \'bk-releasit-colors.css\' | asset_url }}">\n' +
  '{% if template contains "product" and product.tags contains "bk-releasit-colors" %}\n' +
  '<script>document.documentElement.setAttribute("data-bk-releasit-colors","on");</script>\n' +
  PAINT_SCRIPT + '\n' +
  '{% endif %}\n' +
  INCLUDE_MARKER_END;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  const token = process.env.SHOPIFY_TOKEN;
  const domain = process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' });
  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const API = 'https://' + domain + '/admin/api/2024-10';

  try {
    // 1. Encontrar el theme main.
    const themesR = await fetch(API + '/themes.json', { headers: H });
    if (!themesR.ok) return respond(502, { error: 'Fetch themes: ' + themesR.status });
    const themesJ = await themesR.json();
    const mainTheme = (themesJ.themes || []).find(t => t.role === 'main');
    if (!mainTheme) return respond(400, { error: 'No hay theme main en la tienda' });

    // 2. Subir el asset CSS (crea si no existe, updatea si sí).
    const assetR = await fetch(API + '/themes/' + mainTheme.id + '/assets.json', {
      method: 'PUT', headers: H,
      body: JSON.stringify({ asset: { key: ASSET_KEY, value: CSS_CONTENT } }),
    });
    const assetJ = await assetR.json();
    if (!assetR.ok) return respond(502, { error: 'PUT asset ' + assetR.status + ': ' + JSON.stringify(assetJ).slice(0, 300) });

    // 3. Leer theme.liquid.
    const layoutR = await fetch(API + '/themes/' + mainTheme.id + '/assets.json?asset[key]=layout/theme.liquid', { headers: H });
    if (!layoutR.ok) return respond(502, { error: 'Fetch theme.liquid: ' + layoutR.status });
    const layoutJ = await layoutR.json();
    const themeLiquid = (layoutJ.asset && layoutJ.asset.value) || '';
    if (!themeLiquid) return respond(400, { error: 'theme.liquid vacio o no encontrado' });

    // 4. Si ya está el include, REEMPLAZAR el bloque (para re-instalar con
    //    scripts/CSS actualizados). Sino, insertarlo antes de </head>.
    let newLiquid;
    let action;
    if (themeLiquid.includes(INCLUDE_MARKER_START) && themeLiquid.includes(INCLUDE_MARKER_END)) {
      // Reemplazar el bloque completo entre markers (incluyendolos).
      const re = new RegExp(escapeRegex(INCLUDE_MARKER_START) + '[\\s\\S]*?' + escapeRegex(INCLUDE_MARKER_END), 'g');
      newLiquid = themeLiquid.replace(re, INCLUDE_TAG);
      action = 'updated';
    } else {
      if (!themeLiquid.includes('</head>')) {
        return respond(400, { error: 'theme.liquid no tiene </head>, no se puede inyectar' });
      }
      newLiquid = themeLiquid.replace('</head>', INCLUDE_TAG + '\n</head>');
      action = 'created';
    }

    const writeR = await fetch(API + '/themes/' + mainTheme.id + '/assets.json', {
      method: 'PUT', headers: H,
      body: JSON.stringify({ asset: { key: 'layout/theme.liquid', value: newLiquid } }),
    });
    const writeJ = await writeR.json();
    if (!writeR.ok) return respond(502, { error: 'PUT theme.liquid: ' + writeR.status + ' ' + JSON.stringify(writeJ).slice(0, 300) });

    return respond(200, {
      ok: true,
      action,
      assetKey: ASSET_KEY,
      themeId: mainTheme.id,
      themeName: mainTheme.name,
    });
  } catch (err) {
    return respond(502, { error: err.message || 'unknown' });
  }
};

function escapeRegex(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
