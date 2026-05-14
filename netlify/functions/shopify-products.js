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
      if (!body.image || (!body.image.attachment && !body.image.src)) {
        return respond(400, { error: 'Falta image.attachment (base64) o image.src (URL)' });
      }
      return await addProductImage(domain, headers, body);
    }

    return respond(405, { error: 'Método no permitido' });
  } catch (err) {
    return respond(502, { error: err.message || 'error desconocido' });
  }
};

// Normaliza para búsqueda accent-insensitive y case-insensitive.
// "Estación" → "estacion", "ÁRBOL" → "arbol", "ñ" → "n".
function normalizeForSearch(s) {
  return String(s || '')
    .normalize('NFD')                  // descompone los acentos
    .replace(/[̀-ͯ]/g, '')   // remueve los diacríticos
    .replace(/ñ/gi, 'n')               // ñ → n
    .toLowerCase()
    .trim();
}

async function searchProducts(domain, headers, q) {
  // La API REST de Shopify usa `title=` como match EXACTO, no contiene.
  // Para que la búsqueda sea útil, paginamos y filtramos del lado del servidor
  // por substring case-insensitive + accent-insensitive contra title y handle.
  const FIELDS = 'id,title,handle,image,updated_at,status';
  const PAGE_SIZE = 250;
  const MAX_PAGES = q ? 8 : 1; // con query: hasta 2000 productos (antes 1000).

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
    // Normalizar el query: quitar acentos, ñ → n, case-fold.
    const ql = normalizeForSearch(q);
    // Soportar múltiples palabras: TODAS deben aparecer (AND).
    const terms = ql.split(/\s+/).filter(Boolean);
    filtered = all.filter(p => {
      const hayTitle  = normalizeForSearch(p.title);
      const hayHandle = normalizeForSearch(p.handle);
      const hay = hayTitle + ' ' + hayHandle;
      return terms.every(t => hay.includes(t));
    });
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
  const img = {};
  if (body.image.attachment) {
    img.attachment = body.image.attachment;
    img.filename = body.image.filename || ('bkdrop-' + Date.now() + '.jpg');
  } else if (body.image.src) {
    img.src = body.image.src;
  }
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
  if (typeof body.body_html === 'string')       update.body_html       = body.body_html;
  if (typeof body.title === 'string')           update.title           = body.title;
  if (typeof body.template_suffix === 'string') update.template_suffix = body.template_suffix;
  if (Array.isArray(body.tags))           update.tags      = body.tags.join(', ');
  if (typeof body.tags === 'string')      update.tags      = body.tags;

  // Si llegan price, compare_at_price o inventory_policy, hay que
  // actualizar los variants (esos campos viven en variants[], no en
  // el producto). Hacemos fetch del producto para conseguir los IDs.
  let variants = [];
  const needsVariantFetch =
    body.price !== undefined ||
    body.compare_at_price !== undefined ||
    body.inventory_policy !== undefined ||
    body.cost !== undefined ||
    body.mark_all_locations === true;

  if (needsVariantFetch) {
    const fetchUrl = `https://${domain}/admin/api/2024-10/products/${encodeURIComponent(body.id)}.json`;
    const fetchResp = await fetch(fetchUrl, { headers });
    if (!fetchResp.ok) {
      const txt = await fetchResp.text();
      return respond(fetchResp.status, { error: 'No se pudo leer el producto: ' + txt.slice(0, 200) });
    }
    const prod = await fetchResp.json();
    variants = (prod.product && prod.product.variants) || [];
    if (!variants.length) {
      return respond(400, { error: 'El producto no tiene variants' });
    }
    if (body.price !== undefined || body.compare_at_price !== undefined || body.inventory_policy !== undefined) {
      update.variants = variants.map(v => {
        const u = { id: v.id };
        if (body.price !== undefined)            u.price            = String(body.price);
        if (body.compare_at_price !== undefined) u.compare_at_price = body.compare_at_price ? String(body.compare_at_price) : null;
        if (body.inventory_policy !== undefined) u.inventory_policy = body.inventory_policy; // 'continue' = vender sin stock
        return u;
      });
    }
  }

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

  // Side effects extra (después del main PUT):
  const sideResults = { cost_updated: 0, locations_connected: 0, errors: [] };

  // 1. Costo del producto (inventory_item.cost) — requiere PUT a otro endpoint
  if (body.cost !== undefined && variants.length) {
    for (const v of variants) {
      if (!v.inventory_item_id) continue;
      try {
        const costResp = await fetch(`https://${domain}/admin/api/2024-10/inventory_items/${v.inventory_item_id}.json`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ inventory_item: { id: v.inventory_item_id, cost: String(body.cost) } }),
        });
        if (costResp.ok) sideResults.cost_updated++;
        else { const t = await costResp.text(); sideResults.errors.push('cost: ' + costResp.status + ' ' + t.slice(0, 100)); }
      } catch (e) { sideResults.errors.push('cost network: ' + (e.message || '?')); }
    }
  }

  // 2. Conectar a todas las sucursales activas
  if (body.mark_all_locations === true && variants.length) {
    try {
      const locResp = await fetch(`https://${domain}/admin/api/2024-10/locations.json`, { headers });
      if (!locResp.ok) {
        const t = await locResp.text();
        sideResults.errors.push('locations fetch: ' + locResp.status + ' ' + t.slice(0, 100));
      } else {
        const locData = await locResp.json();
        const locations = (locData.locations || []).filter(l => l.active);
        for (const v of variants) {
          if (!v.inventory_item_id) continue;
          for (const loc of locations) {
            try {
              const cResp = await fetch(`https://${domain}/admin/api/2024-10/inventory_levels/connect.json`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  inventory_item_id: v.inventory_item_id,
                  location_id: loc.id,
                  relocate_if_necessary: true,
                }),
              });
              if (cResp.ok || cResp.status === 422) {
                // 422 suele ser "already connected" → contar igual
                sideResults.locations_connected++;
              } else {
                const t = await cResp.text();
                sideResults.errors.push('loc ' + loc.id + ': ' + cResp.status + ' ' + t.slice(0, 80));
              }
            } catch (e) { sideResults.errors.push('loc network: ' + (e.message || '?')); }
          }
        }
      }
    } catch (e) { sideResults.errors.push('locations network: ' + (e.message || '?')); }
  }

  return respond(200, { product: data.product, ok: true, sideResults });
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
