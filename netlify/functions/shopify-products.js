// Endpoint multi-uso para productos Shopify (multi-tenant chile/gt).
// - GET  ?q=texto      → busca productos por título (devuelve {id,title,handle,image})
// - GET  ?id=123       → trae 1 producto completo
// - PUT  body { id, body_html, title?, tags? } → actualiza producto
//
// Requiere scope read_products + write_products en el SHOPIFY_TOKEN.

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }

  const qs = event.queryStringParameters || {};
  const tenant = String((qs.tenant || 'chile')).toLowerCase();
  const isGT = (tenant === 'gt');
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;

  if (!token || !domain) {
    return respond(500, { error: 'Faltan credenciales Shopify' + (isGT ? ' GT' : '') });
  }

  const headers = {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  try {
    if (event.httpMethod === 'GET') {
      if (qs.id) {
        return await getProduct(domain, headers, qs.id);
      }
      return await searchProducts(domain, headers, (qs.q || '').trim());
    }

    if (event.httpMethod === 'PUT') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return respond(400, { error: 'JSON inválido' }); }
      if (!body.id) return respond(400, { error: 'Falta id del producto' });
      return await updateProduct(domain, headers, body);
    }

    return respond(405, { error: 'Método no permitido' });
  } catch (err) {
    return respond(502, { error: err.message || 'error desconocido' });
  }
};

async function searchProducts(domain, headers, q) {
  // /admin/api/2024-10/products.json?title=foo (parcial)
  // Si no hay query, traemos los últimos 50.
  const params = new URLSearchParams({
    limit: '50',
    fields: 'id,title,handle,image,updated_at,status',
  });
  if (q) params.set('title', q);
  const url = `https://${domain}/admin/api/2024-10/products.json?${params}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const txt = await resp.text();
    return respond(resp.status, { error: 'Shopify ' + resp.status + ': ' + txt.slice(0, 200) });
  }
  const data = await resp.json();
  const products = (data.products || []).map(p => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    image: p.image && p.image.src ? p.image.src : null,
    status: p.status,
    updated_at: p.updated_at,
  }));
  return respond(200, { products });
}

async function getProduct(domain, headers, id) {
  const url = `https://${domain}/admin/api/2024-10/products/${encodeURIComponent(id)}.json`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const txt = await resp.text();
    return respond(resp.status, { error: 'Shopify ' + resp.status + ': ' + txt.slice(0, 200) });
  }
  const data = await resp.json();
  return respond(200, { product: data.product });
}

async function updateProduct(domain, headers, body) {
  const url = `https://${domain}/admin/api/2024-10/products/${encodeURIComponent(body.id)}.json`;
  const update = { id: body.id };
  if (typeof body.body_html === 'string') update.body_html = body.body_html;
  if (typeof body.title === 'string')     update.title     = body.title;
  if (Array.isArray(body.tags))           update.tags      = body.tags.join(', ');
  if (typeof body.tags === 'string')      update.tags      = body.tags;

  const resp = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ product: update }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    return respond(resp.status, { error: 'Shopify ' + resp.status + ': ' + txt.slice(0, 300) });
  }
  const data = await resp.json();
  return respond(200, { product: data.product, ok: true });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...cors() },
    body: JSON.stringify(payload),
  };
}
