// Cruza, para los productos ya publicados, el COSTO que cobra Dropi contra el
// PRECIO al que Benjamin los vende. De ahi sale el patron con el que la app
// puede proponer sola el precio de un producto nuevo.
//
// El costo vive en el metafield dropi._dropi_product, campo `sale_price`: es
// lo que Dropi le cobra al dropshipper. El precio de venta es el de la primera
// variante, y `compare_at_price` es el "antes" tachado.
//
// GET /.netlify/functions/bkdrop-precios-historicos?tenant=chile&limite=40
//
// Respuesta: { tenant, moneda, n, productos: [{ titulo, dropiId, costo,
//              precio, antes, margen, multiplicador }], resumen }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });

  const qs = event.queryStringParameters || {};
  const tenant = String(qs.tenant || 'chile').toLowerCase();
  const isGT = tenant === 'gt';
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify de ' + tenant });

  const limite = Math.min(Math.max(parseInt(qs.limite, 10) || 30, 1), 100);

  // Solo los activos: los borradores todavia no tienen precio decidido.
  const query = `query($n: Int!) {
    products(first: $n, query: "status:active", sortKey: UPDATED_AT, reverse: true) {
      edges { node {
        title
        legacyResourceId
        metafield(namespace: "dropi", key: "_dropi_product") { value }
        variants(first: 1) { edges { node { price compareAtPrice barcode } } }
      } }
    }
  }`;

  try {
    const r = await fetch('https://' + domain + '/admin/api/2024-10/graphql.json', {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { n: limite } }),
    });
    if (!r.ok) {
      const txt = await r.text();
      return respond(502, { error: 'Shopify ' + r.status + ': ' + txt.slice(0, 200) });
    }
    const j = await r.json();
    if (j.errors) return respond(502, { error: 'GraphQL: ' + JSON.stringify(j.errors).slice(0, 200) });

    const productos = [];
    for (const e of (((j.data || {}).products || {}).edges) || []) {
      const p = e.node || {};
      const v = (((p.variants || {}).edges) || [])[0];
      if (!v) continue;
      const precio = Number((v.node || {}).price) || 0;
      const antes = Number((v.node || {}).compareAtPrice) || null;
      let costo = null;
      if (p.metafield && p.metafield.value) {
        try {
          const meta = JSON.parse(p.metafield.value);
          costo = Number(meta.sale_price) || null;
        } catch (_) { /* metafield roto: el producto sale sin costo */ }
      }
      if (!precio) continue;
      productos.push({
        titulo: p.title || '',
        shopifyId: p.legacyResourceId || null,
        dropiId: ((v.node || {}).barcode || '').split('-')[0] || null,
        costo,
        precio,
        antes,
        // Lo que gana sobre el costo, y cuantas veces el costo es el precio.
        margen: costo ? Math.round((precio - costo) * 100) / 100 : null,
        multiplicador: costo ? Math.round((precio / costo) * 100) / 100 : null,
      });
    }

    const conCosto = productos.filter(p => p.multiplicador);
    const mult = conCosto.map(p => p.multiplicador).sort((a, b) => a - b);
    const resumen = mult.length ? {
      n: mult.length,
      min: mult[0],
      mediana: mult[Math.floor(mult.length / 2)],
      max: mult[mult.length - 1],
      promedio: Math.round((mult.reduce((a, b) => a + b, 0) / mult.length) * 100) / 100,
    } : null;

    return respond(200, {
      tenant, moneda: isGT ? 'GTQ' : 'CLP',
      n: productos.length, conCosto: conCosto.length,
      resumen, productos,
    });
  } catch (err) {
    return respond(502, { error: err.message || 'error desconocido' });
  }
};

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
