// Lista productos Shopify que pertenecen al mismo proveedor Dropi
// (metafield dropi._dropi_product.user.id === supplier_id).
//
// Usado por el buscador manual del modal de Releasit para filtrar upsells
// del mismo proveedor Dropi -- garantiza que el pedido se despache desde
// UNA sola bodega (regla dura del PDF).
//
// Antes recorria /products.json y pedia el metafield producto por producto.
// Con ese techo (2 paginas, 150 lookups) solo se veian los primeros ~500
// productos del catalogo y siempre aparecian los mismos: los recien creados
// nunca entraban. Ahora GraphQL trae el metafield en la misma consulta, asi
// que se puede recorrer el catalogo entero.
//
// GET /.netlify/functions/dropi-supplier-shopify-products?supplier_id=1001&q=texto&limit=30
//   &tenant=gt para Guatemala.
//
// Response:
//   { products: [ { id, title, handle, image, price, variantId, cost, status } ],
//     scanned, matched, truncated }

const { cuentaDelToken } = require('./_dropi-tenant');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });

  const qs = event.queryStringParameters || {};
  const supplierId = String(qs.supplier_id || '').trim();
  const q = String(qs.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(qs.limit, 10) || 30, 1), 50);
  const excludeId = String(qs.exclude_product_id || '').trim();
  // Bodega: el proveedor no alcanza. Dos productos del MISMO proveedor pueden
  // estar en bodegas distintas, y una orden de Dropi tiene UNA bodega, asi que
  // ese upsell hace imposible crear el pedido.
  const baseId = String(qs.match_warehouse_of || '').trim();
  const soloMisma = String(qs.solo_misma_bodega || '') === '1';
  // sugerir=1: rankea candidatos a upsell (cuenta, bodega, rubro, costo) con
  // el motivo de cada uno. Usa match_warehouse_of como producto base.
  const sugerir = String(qs.sugerir || '') === '1';

  if (!supplierId) return respond(400, { error: 'Falta supplier_id' });

  const isGT = String(qs.tenant || 'chile').toLowerCase() === 'gt';
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return respond(500, { error: 'Faltan credenciales Shopify' + (isGT ? ' GT' : '') });

  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const GQL = 'https://' + domain + '/admin/api/2024-10/graphql.json';

  const normalize = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const terms = normalize(q).split(/\s+/).filter(Boolean);

  const QUERY = [
    'query($cursor: String) {',
    '  products(first: 250, after: $cursor) {',
    '    pageInfo { hasNextPage endCursor }',
    '    edges { node {',
    '      id title handle status totalInventory',
    '      featuredImage { url }',
    '      variants(first: 1) { edges { node { id price } } }',
    '      metafield(namespace: "dropi", key: "_dropi_product") { value }',
    '    } }',
    '  }',
    '}',
  ].join('\n');

  const MAX_PAGES = 8;   // 2000 productos: alcanza para el catalogo completo
  let scanned = 0;
  let cursor = null;
  let pages = 0;
  let truncated = false;
  let baseBodegas = null;
  let baseInfo = null;
  const results = [];

  try {
    while (pages < MAX_PAGES) {
      const r = await fetch(GQL, {
        method: 'POST', headers: H,
        body: JSON.stringify({ query: QUERY, variables: { cursor } }),
      });
      if (!r.ok) return respond(502, { error: 'GraphQL ' + r.status + ': ' + (await r.text()).slice(0, 200) });
      const j = await r.json();
      if (j.errors) return respond(502, { error: 'GraphQL: ' + JSON.stringify(j.errors).slice(0, 300) });

      const conn = ((j.data || {}).products) || {};
      const edges = conn.edges || [];
      scanned += edges.length;

      for (const e of edges) {
        const n = e.node || {};
        const id = String(n.id || '').split('/').pop();
        if (!id) continue;
        if (!n.metafield || !n.metafield.value) continue;

        let meta;
        try { meta = JSON.parse(n.metafield.value); } catch (_) { continue; }

        // El producto base puede aparecer antes o despues; se anota igual.
        if (baseId && id === baseId) {
          baseBodegas = bodegasDe(meta);
          baseInfo = { title: n.title || '', texto: (n.title || '') + ' ' + textoDe(meta) };
        }
        if (excludeId && id === excludeId) continue;
        if (!meta.user || String(meta.user.id) !== supplierId) continue;

        if (terms.length) {
          const hay = normalize((n.title || '') + ' ' + (n.handle || ''));
          if (!terms.every((t) => hay.includes(t))) continue;
        }

        const v0 = (((n.variants || {}).edges || [])[0] || {}).node || null;
        if (!v0) continue;

        results.push({
          id,
          title: n.title,
          handle: n.handle,
          status: String(n.status || '').toLowerCase(),
          image: (n.featuredImage && n.featuredImage.url) || null,
          price: parseFloat(v0.price || 0),
          variantId: String(v0.id || '').split('/').pop(),
          cost: meta.sale_price != null ? Number(meta.sale_price) : null,
          dropiId: meta.id || null,
          bodegas: bodegasDe(meta),
          stock: n.totalInventory != null ? n.totalInventory : null,
          _cuenta: cuentaDeTokens(meta.tokens),
          _texto: (n.title || '') + ' ' + textoDe(meta),
        });
      }

      if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
      pages++;
      if (pages >= MAX_PAGES) truncated = true;
    }
  } catch (err) {
    return respond(502, { error: err.message || 'unknown' });
  }

  if (sugerir) {
    return respond(200, sugerirUpsells(results, baseId, baseBodegas, baseInfo, cuentaDelToken(isGT), limit, scanned));
  }
  for (const p of results) { delete p._cuenta; delete p._texto; }

  // Comparar bodegas contra el producto base. 'si' comparten al menos una,
  // 'no' si no comparten ninguna, '?' si alguno no declara bodegas (hay
  // productos con warehouse_product vacio: ahi no se puede saber).
  const baseSet = baseBodegas && baseBodegas.length ? baseBodegas : null;
  for (const p of results) {
    if (!baseId) { p.comparteBodega = null; continue; }
    if (!baseSet || !p.bodegas || !p.bodegas.length) { p.comparteBodega = '?'; continue; }
    p.comparteBodega = p.bodegas.some((w) => baseSet.indexOf(w) !== -1) ? 'si' : 'no';
  }

  let finales = results;
  if (baseId && soloMisma) finales = results.filter((p) => p.comparteBodega === 'si');

  // Primero los que comparten bodega, despues los dudosos, al final los que
  // seguro no. Dentro de cada grupo, activos antes que borradores.
  const rank = { si: 0, '?': 1, no: 2 };
  finales.sort((a, b) => {
    const ra = rank[a.comparteBodega] != null ? rank[a.comparteBodega] : 1;
    const rb = rank[b.comparteBodega] != null ? rank[b.comparteBodega] : 1;
    if (ra !== rb) return ra - rb;
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });

  return respond(200, {
    supplierId,
    query: q || null,
    scanned,
    matched: finales.length,
    truncated,
    baseProductId: baseId || null,
    baseBodegas: baseBodegas,
    products: finales.slice(0, limit),
  });
};

// ── Sugerencias de upsell ────────────────────────────────────────────────────
// Replica el criterio que se usaba a mano: 1) que el pedido pase (cuenta
// Dropi correcta y misma bodega, porque una orden de Dropi tiene UNA bodega),
// 2) que combine con el producto base (mismo rubro), 3) barato, para que
// sumarlo sea impulso. Los listados "2x1"/"3x1" se excluyen: como upsell el
// cliente ve "2x1" y Dropi despacha una unidad.
const RUBROS = {
  cocina: ['cocina', 'cocin', 'aliment', 'comida', 'refri', 'nevera', 'hervidor', 'olla', 'sarten', 'cuchill', 'tijera', 'rallador', 'pelador', 'picad', 'huevo', 'cafe', 'vaso', 'taza', 'botella', 'termo', 'bolsa', 'sellador', 'hermetic', 'conserva', 'especia', 'aceite', 'mezcl', 'batidor', 'licuad', 'exprim', 'jugo', 'balanza', 'horno', 'parrilla', 'asado', 'lavaloza', 'salpicadura', 'masas$', 'amasa', 'tortilla', 'sopaipilla', 'desmenuz'],
  limpieza: ['limpi', 'lavaloza', 'jabon', 'detergente', 'destap', 'caneria', 'antisarro', 'sarro', 'mancha', 'pelusa', 'escoba', 'trapeador', 'desinfect', 'espuma', 'quita', 'cepillo', 'lavadora'],
  bano: ['bano', 'ducha', 'inodoro', 'toalla', 'antimoho', 'moho'],
  organizacion: ['organiz', 'perchero', 'zapatero', 'colgador', 'tendedero', 'estante', 'repisa', 'gancho', 'cajon', 'almacen'],
  exterior: ['jardin', 'solar', 'guirnalda', 'exterior', 'planta', 'riego', 'manguera'],
  auto: ['auto$', 'autos$', 'automovil', 'carro', 'vehicul', 'asiento', 'volante', 'parabris'],
  mascota: ['mascota', 'perro', 'gato'],
  belleza: ['crema', 'piel', 'facial', 'cabello', 'pestana', 'maquill', 'cosmet', 'blanque', 'depil'],
  bienestar: ['dolor', 'masaj', 'postura', 'cervical', 'cuello', 'espalda', 'rodilla', 'insomnio', 'ronquido', 'ejercit', 'terapia'],
  tecnologia: ['bluetooth', 'audifon', 'parlante', 'cargador', 'usb', 'lampara', 'camara', 'tablet', 'celular'],
  ninos: ['bebe$', 'bebes$', 'nino', 'infantil', 'juguete', 'motriz'],
};

function normTxt(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Cada clave calza al COMIENZO de una palabra ("cocin" -> cocina, cocinar);
// con "$" al final tiene que ser la palabra exacta. Buscar en cualquier parte
// daba falsos positivos: "masa" en "masajeadora", "auto" en "automatico".
function rubrosDe(texto) {
  const palabras = normTxt(texto).split(/[^a-z0-9]+/).filter(Boolean);
  const calza = (k) => (k.slice(-1) === '$'
    ? palabras.indexOf(k.slice(0, -1)) !== -1
    : palabras.some((w) => w.indexOf(k) === 0));
  const out = [];
  for (const r of Object.keys(RUBROS)) if (RUBROS[r].some(calza)) out.push(r);
  return out;
}

// El titulo no alcanza para el rubro ("Bolsas Frescura Pro"); la descripcion
// y las categorias de Dropi, cuando existen, dicen mucho mas.
function textoDe(meta) {
  const cats = Array.isArray(meta && meta.categories)
    ? meta.categories.map((c) => (c && (c.name || c.title)) || (typeof c === 'string' ? c : '')).join(' ')
    : '';
  const desc = String((meta && meta.description) || '').replace(/<[^>]+>/g, ' ').slice(0, 1500);
  return cats + ' ' + desc;
}

function cuentaDeTokens(tok) {
  try {
    const parts = String(tok || '').split('.');
    if (parts.length < 2) return null;
    let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const p = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
    return p && p.sub != null ? String(p.sub) : null;
  } catch (_) {
    return null;
  }
}

function sugerirUpsells(todos, baseId, baseBodegas, baseInfo, cuentaOk, limit, scanned) {
  const esPack = (t) => /\b\d\s*x\s*\d\b/i.test(String(t || ''));
  // Bodega principal del proveedor: la mas repetida entre sus productos. Si el
  // base no declara bodegas (todo lo creado con el importador), es la mejor
  // apuesta.
  const uso = {};
  for (const p of todos) for (const w of (p.bodegas || [])) uso[w] = (uso[w] || 0) + 1;
  const principal = Object.keys(uso).sort((a, b) => uso[b] - uso[a])[0];
  const principalId = principal != null ? Number(principal) : null;
  const baseSet = baseBodegas && baseBodegas.length ? baseBodegas : null;
  const baseRubros = baseInfo ? rubrosDe(baseInfo.texto) : [];

  let excluidosPack = 0;
  const cand = [];
  for (const p of todos) {
    if (p.status !== 'active') continue;
    if (esPack(p.title)) { excluidosPack++; continue; }
    const razones = [];
    let bodega;
    if (!p.bodegas || !p.bodegas.length) {
      bodega = '?';
      razones.push('bodega sin dato');
    } else if (baseSet) {
      const comun = p.bodegas.filter((w) => baseSet.indexOf(w) !== -1);
      bodega = comun.length ? 'si' : 'no';
      razones.push(comun.length ? 'comparte bodega (' + comun.join(', ') + ')' : 'OTRA bodega (' + p.bodegas.join(', ') + ')');
    } else if (principalId != null && p.bodegas.indexOf(principalId) !== -1) {
      bodega = 'probable';
      razones.push('bodega principal del proveedor (' + principalId + ')');
    } else {
      bodega = 'no';
      razones.push('fuera de la bodega principal (' + p.bodegas.join(', ') + ')');
    }
    const cuentaBuena = !cuentaOk || !p._cuenta || p._cuenta === cuentaOk;
    if (!cuentaBuena) razones.unshift('cuenta Dropi vieja (' + p._cuenta + '): el pedido rebotaria por saldo');
    const rub = rubrosDe(p._texto).filter((r) => baseRubros.indexOf(r) !== -1);
    if (rub.length) razones.push('mismo rubro: ' + rub.join(', '));
    if (p.cost != null) razones.push('costo Dropi $' + Math.round(p.cost).toLocaleString('es-CL'));
    cand.push({
      id: p.id, title: p.title, handle: p.handle, image: p.image, price: p.price,
      cost: p.cost, variantId: p.variantId, bodegas: p.bodegas, stock: p.stock,
      sugerencia: { bodega, cuentaOk: cuentaBuena, rubros: rub, razones },
    });
  }
  const rankB = { si: 0, probable: 1, '?': 2, no: 3 };
  cand.sort((a, b) => {
    const A = a.sugerencia, B = b.sugerencia;
    if (A.cuentaOk !== B.cuentaOk) return A.cuentaOk ? -1 : 1;
    if (rankB[A.bodega] !== rankB[B.bodega]) return rankB[A.bodega] - rankB[B.bodega];
    if (A.rubros.length !== B.rubros.length) return B.rubros.length - A.rubros.length;
    const ca = a.cost != null ? a.cost : Infinity, cb = b.cost != null ? b.cost : Infinity;
    return ca - cb;
  });
  return {
    modo: 'sugerir',
    baseProductId: baseId || null,
    baseBodegas: baseBodegas,
    baseRubros,
    bodegaPrincipal: principalId,
    cuentaEsperada: cuentaOk || null,
    scanned,
    candidatos: cand.length,
    excluidosPack,
    products: cand.slice(0, limit),
  };
}

// Ids de bodega declarados en el metafield. Puede venir vacio: hay productos
// importados por otra via que no traen warehouse_product.
function bodegasDe(meta) {
  const wp = (meta && meta.warehouse_product) || [];
  if (!Array.isArray(wp)) return [];
  const out = [];
  for (const w of wp) {
    if (w && w.warehouse_id != null) {
      const id = Number(w.warehouse_id);
      if (out.indexOf(id) === -1) out.push(id);
    }
  }
  return out;
}

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
