// Endpoint multi-uso para productos Shopify (multi-tenant chile/gt).
// - GET  ?q=texto      → busca productos por título (devuelve {id,title,handle,image})
// - GET  ?id=123       → trae 1 producto completo
// - GET  ?scopes=1     → diagnostico: lista los scopes del token (no expone el token)
// - PUT  body { id, body_html, title?, tags?, status? } → actualiza producto
//        status:'active' publica ademas en el canal "Tienda online"
// - POST body { id, image:{filename,attachment(base64),alt?,position?} } → sube imagen
// - DELETE body { id, image_id } → borra UNA imagen del producto (por id explicito)
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
      if (qs.scopes) {
        return await getAccessScopes(domain, headers);
      }
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

    if (event.httpMethod === 'DELETE') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return respond(400, { error: 'JSON inválido' }); }
      if (!body.id) return respond(400, { error: 'Falta id del producto' });
      if (!body.image_id) return respond(400, { error: 'Falta image_id' });
      return await deleteProductImage(domain, headers, body.id, body.image_id);
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

// Diagnostico read-only: devuelve los scopes que trae el token cargado en
// Netlify. NO expone el token. Sirve para confirmar si un permiso agregado en
// la config de la app llego efectivamente al token (los scopes se congelan al
// emitirlo: si no se reinstalo la app, el token sigue con la lista vieja).
// Uso: GET /.netlify/functions/shopify-products?scopes=1&tenant=chile
async function getAccessScopes(domain, headers) {
  // Este endpoint NO lleva version de API.
  const resp = await fetch(`https://${domain}/admin/oauth/access_scopes.json`, { headers });
  if (!resp.ok) {
    const txt = await resp.text();
    return respond(resp.status, { error: 'Shopify ' + resp.status + ': ' + txt.slice(0, 200) });
  }
  const data = await resp.json();
  const granted = (data.access_scopes || []).map(x => x.handle).filter(Boolean).sort();

  // Que app emitio este token. Evita tener que adivinar cual de las apps del
  // Dev Dashboard hay que editar para agregar un scope.
  let app = null;
  try {
    const gq = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
      method: 'POST', headers,
      body: JSON.stringify({ query: '{ currentAppInstallation { app { title handle } } }' }),
    });
    const gj = await gq.json();
    const a = gj && gj.data && gj.data.currentAppInstallation && gj.data.currentAppInstallation.app;
    if (a) app = { title: a.title, handle: a.handle };
    else if (gj && gj.errors) app = { error: JSON.stringify(gj.errors).slice(0, 160) };
  } catch (e) { app = { error: e.message || '?' }; }
  const needed = [
    'read_products', 'write_products',
    'read_publications', 'write_publications',   // publicar en el canal Tienda online
    'read_inventory', 'write_inventory',         // costo del producto
    'read_locations',                            // conectar inventario a las sucursales
    'read_themes', 'write_themes',               // plantillas de landing
  ];
  const missing = needed.filter(n => !granted.includes(n));
  return respond(200, {
    domain,
    app,
    granted,
    needed,
    missing,
    ok: missing.length === 0,
    nota: missing.length
      ? 'Faltan scopes en el TOKEN. Si ya los aprobaste en la app, hay que reinstalarla / regenerar el token y actualizarlo en Netlify.'
      : 'El token trae todos los scopes necesarios.',
  });
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
  if (typeof body.status === 'string' && ['active','draft','archived'].includes(body.status)) update.status = body.status;

  // Activar un producto NO lo publica en el canal "Tienda online": en Shopify
  // son dos cosas distintas. Un producto creado por API puede quedar `active`
  // con el canal desmarcado (y por lo tanto invisible en la tienda).
  // `published:true` lo publica en el Online Store en el mismo PUT.
  const wantsPublish = (update.status === 'active') || body.published === true;
  if (wantsPublish) update.published = true;
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
  const sideResults = { cost_updated: 0, locations_connected: 0, online_store_published: null, errors: [] };

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

  // 3. Publicacion en el canal "Tienda online".
  // El `published:true` del PUT cubre el caso normal. Si aun asi el producto
  // vuelve con published_at:null (pasa cuando nunca tuvo publicaciones),
  // caemos a GraphQL publishablePublish contra el canal Online Store.
  if (wantsPublish) {
    if (data.product && data.product.published_at) {
      sideResults.online_store_published = true;
    } else {
      const pub = await publishToOnlineStore(domain, headers, body.id);
      sideResults.online_store_published = pub.ok;
      if (!pub.ok) sideResults.errors.push('tienda online: ' + pub.error);
    }
  }

  return respond(200, { product: data.product, ok: true, sideResults });
}

// Publica el producto en el canal "Tienda online" via GraphQL.
// Fallback para cuando el `published:true` del REST no alcanza.
// Requiere scopes read_publications + write_publications.
async function publishToOnlineStore(domain, headers, productId) {
  const gqlUrl = `https://${domain}/admin/api/2024-10/graphql.json`;
  try {
    const listResp = await fetch(gqlUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: '{ publications(first: 25) { edges { node { id name } } } }' }),
    });
    const listJson = await listResp.json();
    if (listJson.errors) return { ok: false, error: JSON.stringify(listJson.errors).slice(0, 140) };
    const edges = (listJson.data && listJson.data.publications && listJson.data.publications.edges) || [];
    const online = edges.find(e => /online store|tienda online/i.test((e.node && e.node.name) || ''));
    if (!online) return { ok: false, error: 'no encontre el canal Online Store' };

    const mutResp = await fetch(gqlUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: 'mutation P($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }',
        variables: {
          id: 'gid://shopify/Product/' + productId,
          input: [{ publicationId: online.node.id }],
        },
      }),
    });
    const mutJson = await mutResp.json();
    if (mutJson.errors) return { ok: false, error: JSON.stringify(mutJson.errors).slice(0, 140) };
    const ue = (mutJson.data && mutJson.data.publishablePublish && mutJson.data.publishablePublish.userErrors) || [];
    if (ue.length) return { ok: false, error: ue.map(u => u.message).join('; ').slice(0, 140) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'network' };
  }
}

// Borra UNA imagen del producto, por id explicito. A proposito NO acepta
// patrones ni un "borrar todas": el cliente decide cuales y las manda de a
// una, asi no hay forma de vaciar un producto por accidente.
async function deleteProductImage(domain, headers, productId, imageId) {
  const url = `https://${domain}/admin/api/2024-10/products/${encodeURIComponent(productId)}/images/${encodeURIComponent(imageId)}.json`;
  const resp = await fetch(url, { method: 'DELETE', headers });
  if (!resp.ok) {
    const txt = await resp.text();
    return respond(resp.status, { error: 'Shopify ' + resp.status + ': ' + txt.slice(0, 200) });
  }
  return respond(200, { ok: true, deleted: String(imageId) });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
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
