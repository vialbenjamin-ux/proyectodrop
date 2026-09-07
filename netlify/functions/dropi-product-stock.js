// Bodegas y stock ACTUALES de un producto Dropi, segun la cuenta del token.
//
// Existe porque el metafield dropi de Shopify guarda warehouse_product, pero es
// un snapshot del dia que se importo el producto: los ids de bodega pueden
// haber cambiado. Cuando Dropi rechaza una orden con "no posee stock en
// ninguna de sus bodegas" hay que comparar contra el estado de HOY.
//
// GET /.netlify/functions/dropi-product-stock?id=30925[&tenant=gt]
//
// Prueba pocos endpoints a proposito: la API de Dropi bloquea por horas con
// "Too Many Attempts", asi que no se hace shotgun. Corta en el primero que
// responda algo util.

const { dropiTenant } = require('./_dropi-tenant');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  const qs = event.queryStringParameters || {};
  const id = String(qs.id || '').trim();
  if (!/^\d+$/.test(id)) return respond(400, { error: 'Falta id numerico del producto Dropi' });

  const T = dropiTenant(qs);
  if (!T.token) return respond(500, { error: 'Falta ' + T.envName });
  const headers = {
    'dropi-integration-key': T.token,
    'Content-Type': 'application/json',
    'User-Agent': 'BKDROP-Sync/1.0',
  };

  const urls = [
    T.base + '/integrations/products/' + id,
    T.base + '/integrations/products/get/' + id,
    T.base + '/integrations/products/search?id=' + id,
  ];

  const intentos = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: 'GET', headers });
      const txt = await r.text();
      let d = null;
      try { d = JSON.parse(txt); } catch (_) { d = null; }
      const bodegas = extraerBodegas(d);
      intentos.push({ url, status: r.status, bodegas: bodegas ? bodegas.length : 0 });
      if (bodegas && bodegas.length) {
        return respond(200, { ok: true, id, tenant: T.tenant, url, bodegas, intentos });
      }
      // Si contesto 200 pero sin bodegas, devolver igual el cuerpo: sirve para
      // ver que forma tiene la respuesta sin gastar mas llamadas.
      if (r.ok && d) {
        return respond(200, { ok: true, id, tenant: T.tenant, url, bodegas: [], muestra: recortar(d), intentos });
      }
    } catch (err) {
      intentos.push({ url, error: err.message });
    }
  }
  return respond(502, { error: 'Ningun endpoint de Dropi devolvio el producto', intentos });
};

// warehouse_product es la lista de bodegas con stock; puede venir en la raiz,
// bajo object, o dentro del primer elemento de objects.
function extraerBodegas(d) {
  if (!d || typeof d !== 'object') return null;
  const candidatos = [d, d.object, Array.isArray(d.objects) ? d.objects[0] : null].filter(Boolean);
  for (const c of candidatos) {
    const wp = c.warehouse_product;
    if (Array.isArray(wp) && wp.length) {
      return wp.map((w) => ({
        warehouse_id: w.warehouse_id,
        stock: w.stock,
        nombre: (w.warehouse && w.warehouse.name) || null,
      }));
    }
  }
  return null;
}

function recortar(d) {
  const s = JSON.stringify(d);
  return s.length > 2000 ? s.slice(0, 2000) + '…' : d;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

function respond(statusCode, body) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
