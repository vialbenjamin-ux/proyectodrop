// Debug: lee los metafields de tienda de Releasit COD Form y devuelve
// items filtrados por product_id (para comparar el JSON de un upsell
// hecho a mano en la app Releasit vs uno generado por nuestro auto-publish).
//
// GET /.netlify/functions/shopify-releasit-debug?product_id=8945311121650
// GET /.netlify/functions/shopify-releasit-debug (devuelve TODOS los items)

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };

  const qs = event.queryStringParameters || {};
  const productId = String(qs.product_id || '').trim();

  const token = process.env.SHOPIFY_TOKEN;
  const domain = process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' });

  const H = { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' };
  const API = 'https://' + domain + '/admin/api/2024-10';

  try {
    const r = await fetch(API + '/metafields.json?limit=250', { headers: H });
    if (!r.ok) return respond(502, { error: 'Fetch metafields: ' + r.status });
    const j = await r.json();
    const mfQO = (j.metafields || []).find(m => m.namespace === '_rsi_cod_form_sf' && m.key === 'quantity_offers_json');
    const mfUP = (j.metafields || []).find(m => m.namespace === '_rsi_cod_form_sf' && m.key === 'tick_upsells_json');

    let quantityOffers = [];
    let tickUpsells = [];
    try { quantityOffers = mfQO ? JSON.parse(mfQO.value) : []; } catch (_) {}
    try { tickUpsells = mfUP ? JSON.parse(mfUP.value) : []; } catch (_) {}

    if (productId) {
      quantityOffers = quantityOffers.filter(g => (g.pIds || []).map(String).includes(productId));
      tickUpsells = tickUpsells.filter(u => (u.prods || []).map(String).includes(productId));
    }

    // Para tick_upsells, listar TODAS las keys que aparecen (para ver campos
    // que la app Releasit usa y nosotros no conocemos).
    const allKeys = new Set();
    for (const u of tickUpsells) Object.keys(u || {}).forEach(k => allKeys.add(k));

    return respond(200, {
      productIdFilter: productId || null,
      quantityOffersCount: quantityOffers.length,
      tickUpsellsCount: tickUpsells.length,
      tickUpsellsKeys: Array.from(allKeys).sort(),
      tickUpsells,
      quantityOffers,
    });
  } catch (err) {
    return respond(502, { error: err.message || 'unknown' });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
