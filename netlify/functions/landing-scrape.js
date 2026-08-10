// Scrapea una URL de landing (Shopify u otros CMS) y devuelve el producto
// normalizado para reutilizar en el flujo de "Landing Automática" de BKDROP.
//
// GET /.netlify/functions/landing-scrape?url=https://...
// Respuesta:
//   { source: 'shopify'|'html', title, description, descriptionHtml, images: [], price?: number,
//     handle?, vendor?, tags?, currency?, url }
//
// Estrategia:
//   1) Si la URL parece Shopify producto (`/products/<handle>`) probamos primero
//      el JSON estándar `.json` que devuelve toda la data limpia.
//   2) Fallback a fetch HTML + parse: JSON-LD (schema.org Product), Open Graph,
//      canonical link, y galería de imágenes del DOM básico.
//
// Notas:
//   - Muchos sitios devuelven 403 sin User-Agent de browser, por eso mandamos uno.
//   - Cap 5 imágenes (principal + 4 más) para no explotar el payload.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });

  const rawUrl = String((event.queryStringParameters || {}).url || '').trim();
  if (!rawUrl) return respond(400, { error: 'Falta ?url=' });
  let url;
  try { url = new URL(rawUrl); } catch { return respond(400, { error: 'URL inválida' }); }
  if (!['http:', 'https:'].includes(url.protocol)) return respond(400, { error: 'Solo http/https' });

  // 1) Intento Shopify JSON
  try {
    if (looksLikeShopifyProductUrl(url)) {
      const jsonUrl = shopifyJsonUrl(url);
      const r = await fetch(jsonUrl, { headers: browserHeaders(), redirect: 'follow' });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        const prod = j && j.product ? j.product : null;
        if (prod) return respond(200, { ...shopifyToNormalized(prod, url.toString()), source: 'shopify' });
      }
    }
  } catch { /* seguimos al fallback */ }

  // 2) Fallback: HTML parse
  let html;
  try {
    const r = await fetch(url.toString(), { headers: browserHeaders(), redirect: 'follow' });
    if (!r.ok) return respond(502, { error: 'Fetch landing fail: HTTP ' + r.status });
    html = await r.text();
  } catch (err) {
    return respond(502, { error: 'Fetch landing fail: ' + (err.message || 'unknown') });
  }

  const parsed = parseHtmlProduct(html, url.toString());
  if (!parsed.title && parsed.images.length === 0) {
    return respond(422, { error: 'No pudimos extraer datos de esa URL', source: 'html', url: url.toString() });
  }
  return respond(200, { ...parsed, source: 'html' });
};

function looksLikeShopifyProductUrl(u) {
  return /\/products\/[^/?#]+/.test(u.pathname);
}

function shopifyJsonUrl(u) {
  const base = u.origin + u.pathname.replace(/\/?$/, '');
  return base + '.json';
}

function shopifyToNormalized(product, sourceUrl) {
  const bodyHtml = String(product.body_html || '');
  const images = (product.images || []).map(img => img.src).filter(Boolean).slice(0, 5);
  // Precio: primer variant, en unidad string -> parseFloat
  const firstVariant = (product.variants && product.variants[0]) || null;
  const price = firstVariant ? parseFloat(firstVariant.price) : null;
  return {
    title: product.title || '',
    description: stripHtml(bodyHtml).slice(0, 5000),
    descriptionHtml: bodyHtml.slice(0, 20000),
    images,
    price: isFinite(price) ? price : null,
    handle: product.handle || null,
    vendor: product.vendor || null,
    tags: Array.isArray(product.tags) ? product.tags : String(product.tags || '').split(',').map(t => t.trim()).filter(Boolean),
    productType: product.product_type || null,
    url: sourceUrl,
  };
}

function parseHtmlProduct(html, sourceUrl) {
  const out = { title: '', description: '', descriptionHtml: '', images: [], price: null, handle: null, vendor: null, tags: [], productType: null, url: sourceUrl };

  // Canonical
  const canonical = pick(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  if (canonical) out.url = canonical;

  // JSON-LD Product (más confiable si existe)
  const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1].trim());
      const products = [];
      const walk = (node) => {
        if (!node) return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (typeof node === 'object') {
          const t = node['@type'];
          if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) products.push(node);
          if (node['@graph']) walk(node['@graph']);
        }
      };
      walk(data);
      if (products.length > 0) {
        const p = products[0];
        if (!out.title && p.name) out.title = String(p.name);
        if (!out.description && p.description) out.description = stripHtml(String(p.description)).slice(0, 5000);
        if (p.image) {
          const imgs = Array.isArray(p.image) ? p.image : [p.image];
          for (const img of imgs) {
            const src = typeof img === 'string' ? img : (img && img.url);
            if (src && !out.images.includes(src)) out.images.push(src);
          }
        }
        if (!out.vendor && p.brand) {
          out.vendor = typeof p.brand === 'string' ? p.brand : (p.brand.name || null);
        }
        if (!out.price && p.offers) {
          const offers = Array.isArray(p.offers) ? p.offers : [p.offers];
          for (const o of offers) {
            const pv = parseFloat(o && (o.price || o.lowPrice));
            if (isFinite(pv)) { out.price = pv; break; }
          }
        }
      }
    } catch { /* ignorar bloques JSON-LD malformados */ }
  }

  // Open Graph fallback
  if (!out.title) out.title = pick(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || '';
  if (!out.description) out.description = pick(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || '';
  const ogImage = pick(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (ogImage && !out.images.includes(ogImage)) out.images.unshift(ogImage);

  // <title> como último recurso
  if (!out.title) out.title = pick(html, /<title[^>]*>([^<]+)<\/title>/i) || '';

  // Extraer imágenes <img> del contenido (heurística: >= 400px de ancho o srcset)
  if (out.images.length < 5) {
    const imgTags = [...html.matchAll(/<img[^>]+>/g)].map(m => m[0]);
    for (const tag of imgTags) {
      if (out.images.length >= 5) break;
      const src = pick(tag, /\bsrc=["']([^"']+)["']/i) || pick(tag, /\bdata-src=["']([^"']+)["']/i);
      if (!src) continue;
      const absolute = absoluteUrl(src, sourceUrl);
      if (!absolute) continue;
      if (out.images.includes(absolute)) continue;
      // Skip logos y sprites (heurística: url contiene 'logo' o 'sprite')
      if (/logo|sprite|icon|avatar|placeholder/i.test(absolute)) continue;
      out.images.push(absolute);
    }
  }

  out.images = out.images.slice(0, 5);
  return out;
}

function pick(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

function absoluteUrl(src, base) {
  try { return new URL(src, base).toString(); } catch { return null; }
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function browserHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-CL,es;q=0.9,en;q=0.8',
  };
}

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
