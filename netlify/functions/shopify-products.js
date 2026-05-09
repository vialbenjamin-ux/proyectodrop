// Endpoint multi-uso para productos Shopify (multi-tenant chile/gt).
// - GET  ?q=texto      → busca productos por título (devuelve {id,title,handle,image})
// - GET  ?id=123       → trae 1 producto completo
// - PUT  body { id, body_html, title?, tags? } → actualiza producto
// - POST body { id, image:{filename,attachment(base64),alt?,position?} } → sube imagen
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

    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return respond(400, { error: 'JSON inválido' }); }
      if (!body.id) return respond(400, { error: 'Falta id del producto' });
      if (!body.image || !body.image.attachment) {
        return respond(400, { error: 'Falta image.attachment (base64)' });
      }
      return await addProductImage(domain, headers, body);
    }

    return respond(405, { error: 'Método no permitido' });
  } catch (err) {
    return respond(502, { error: err.message || 'error desconocido' });
  }
};

async function searchProducts(domain, headers, q) {
  // La API REST de Shopify usa `title=` como match EXACTO, no contiene.
  // Para que la búsqueda sea útil, paginamos hasta 500 productos y
  // filtramos del lado del servidor por substring case-insensitive
  // contra title y handle.
  const FIELDS = 'id,title,handle,image,updated_at,status';
  const PAGE_SIZE = 250; // máximo permitido por Shopify
  const MAX_PAGES = q ? 4 : 1; // con query: hasta 1000 productos. Sin query: 250.

  let all = [];
  let pageUrl = `https://${domain}/admin/api/2024-10/products.json?limit=${PAGE_SIZE}&fields=${FIELDS}`;
  let pages = 0;

  while (pageUrl && pages < MAX_PAGES) {
    const resp = await fetch(pageUrl, { headers });
    if (!resp.ok) {
      const txt = await resp.text();
      return respond(resp.status, { error: 'Shopify ' + resp.status + ': ' + txt.slice(0, 200) });
    }
    const data = await resp.json();
    all = all.concat(data.products || []);

    const link = resp.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    pageUrl = next ? next[1] : null;
    pages++;
  }

  let filtered = all;
  if (q) {
    const ql = q.toLowerCase();
    filtered = all.filter(p =>
      (p.title  && p.title.toLowerCase().includes(ql)) ||
      (p.handle && p.handle.toLowerCase().includes(ql))
    );
  }

  // Limitar a 100 resultados visibles para no saturar la UI
  const products = filtered.slice(0, 100).map(p => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    image: p.image && p.image.src ? p.image.src : null,
    status: p.status,
    updated_at: p.updated_at,
  }));

  return respond(200, {
    products,
    matched: filtered.length,
    searched: all.length,
  });
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

async function addProductImage(domain, headers, body) {
  const url = `https://${domain}/admin/api/2024-10/products/${encodeURIComponent(body.id)}/images.json`;
  const img = {
    attachment: body.image.attachment,
    filename: body.image.filename || ('bkdrop-' + Date.now() + '.jpg'),
  };
  if (body.image.alt) img.alt = body.image.alt;
  if (typeof body.image.position === 'number') img.position = body.image.position;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ image: img }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    return respond(resp.status, { error: 'Shopify ' + resp.status + ': ' + txt.slice(0, 300) });
  }
  const data = await resp.json();
  return respond(200, { image: data.image, ok: true });
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
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
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
