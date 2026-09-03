// Auditoria: detecta productos Shopify cuyo metafield dropi._dropi_product
// apunta a OTRA cuenta de Dropi.
//
// Cada producto importado lleva embebido un JWT en `tokens`. El claim `sub`
// identifica la cuenta Dropi que recibira el pedido. Si un producto arrastra
// el token de una cuenta ajena (pasa con productos importados hace tiempo o
// copiados de otra tienda), el pedido se despacha contra esa otra cuenta y
// Dropi responde "no posee saldo suficiente en la wallet".
//
// GET /.netlify/functions/dropi-audit-products?tenant=chile[&expected=357617]
//   expected: cuenta correcta. Si no se pasa, se asume la mayoritaria.
//
// Responde: { total, conMetafield, cuentas:{sub:n}, esperada, desalineados:[...] }
//
// Usa GraphQL para traer producto + metafield en lotes de 250 (con REST seria
// una llamada por producto y no entra en el timeout de la function).

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Método no permitido' });

  const qs = event.queryStringParameters || {};
  const isGT = String(qs.tenant || 'chile').toLowerCase() === 'gt';
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' });

  const gql = 'https://' + domain + '/admin/api/2024-10/graphql.json';
  const headers = {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  const QUERY = `query($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        status
        variantsCount { count }
        metafield(namespace: "dropi", key: "_dropi_product") { value }
      }
    }
  }`;

  // Decodifica el payload de un JWT sin validar firma (solo lectura de claims).
  const jwtPayload = (tok) => {
    try {
      const parts = String(tok || '').split('.');
      if (parts.length < 2) return null;
      let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      return JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
    } catch (_) { return null; }
  };

  try {
    const items = [];
    let cursor = null;
    // Tope de seguridad: 20 paginas = 5000 productos.
    for (let page = 0; page < 20; page++) {
      const resp = await fetch(gql, {
        method: 'POST', headers,
        body: JSON.stringify({ query: QUERY, variables: { cursor } }),
      });
      if (!resp.ok) {
        const t = await resp.text();
        return respond(resp.status, { error: 'Shopify ' + resp.status + ': ' + t.slice(0, 200) });
      }
      const j = await resp.json();
      if (j.errors) return respond(502, { error: JSON.stringify(j.errors).slice(0, 300) });
      const conn = j.data && j.data.products;
      if (!conn) break;
      for (const n of (conn.nodes || [])) {
        const raw = n.metafield && n.metafield.value;
        if (!raw) continue;
        let v = null;
        try { v = JSON.parse(raw); } catch (_) { continue; }
        const p = jwtPayload(v.tokens);
        items.push({
          id: String(n.id || '').split('/').pop(),
          title: n.title,
          handle: n.handle,
          status: String(n.status || '').toLowerCase(),
          dropiProductId: v.id != null ? String(v.id) : null,
          proveedor: (v.user && v.user.name) || null,
          userId: (v.user && v.user.id != null) ? String(v.user.id) : null,
          cuenta: p && p.sub != null ? String(p.sub) : null,
          variantes: (n.variantsCount && n.variantsCount.count != null) ? n.variantsCount.count : null,
          tipo: v.type || null,
          variaciones: Array.isArray(v.variations) ? v.variations.length
                     : (v.variations && typeof v.variations === 'object' ? Object.keys(v.variations).length : null),
          clavesMetafield: Object.keys(v || {}),
          emitido: p && p.iat ? new Date(p.iat * 1000).toISOString().slice(0, 10) : null,
        });
      }
      if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }

    // Cuenta esperada: la que pase el usuario, si no la mayoritaria.
    const cuentas = {};
    for (const it of items) if (it.cuenta) cuentas[it.cuenta] = (cuentas[it.cuenta] || 0) + 1;
    const esperada = String(qs.expected || '').trim()
      || (Object.entries(cuentas).sort((a, b) => b[1] - a[1])[0] || [null])[0];

    const desalineados = items.filter(it => it.cuenta !== esperada || !it.userId);
    // ?variantes=1 devuelve solo los productos con mas de una variante: sirve
    // para ver como modela Dropi los productos con colores.
    if (qs.variantes === '1') {
      const conVar = items.filter(it => (it.variantes || 1) > 1);
      return respond(200, { conMetafield: items.length, conVariantes: conVar.length, productos: conVar.slice(0, 40) });
    }

    return respond(200, {
      conMetafield: items.length,
      cuentas,
      esperada,
      desalineados: desalineados.sort((a, b) => (a.status === 'active' ? -1 : 1) - (b.status === 'active' ? -1 : 1)),
    });
  } catch (err) {
    return respond(502, { error: err.message || 'error desconocido' });
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
