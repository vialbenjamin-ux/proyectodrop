// Calculadora de precio: deriva los multiplicadores costo→precio
// observando los productos vendidos en los últimos 30 días en Shopify.
// Devuelve mediana de mult 1u/2u/3u y umbrales de costo para 2x1/3x1.

exports.handler = async function (event) {
  const tenant = String(((event && event.queryStringParameters || {}).tenant || 'chile')).toLowerCase();
  const isGT = (tenant === 'gt');
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) {
    return respond(500, { error: 'Faltan credenciales de Shopify' + (isGT ? ' GT' : '') });
  }

  const now = new Date();
  const sinceUTC = new Date(now.getTime() - 30 * 24 * 3600000);

  try {
    // 1. Traer órdenes últimos 30 días (líneas con product_id, variant_id)
    const orderUrl = `https://${domain}/admin/api/2024-10/orders.json?status=any`
      + `&created_at_min=${sinceUTC.toISOString()}`
      + `&limit=250&fields=id,line_items,cancelled_at,financial_status`;
    const allOrders = await fetchAllPages(orderUrl, token);
    const validOrders = allOrders.filter(o => !o.cancelled_at && o.financial_status !== 'voided');

    // 2. Recolectar product_ids únicos
    const productIds = new Set();
    for (const o of validOrders) {
      for (const li of (o.line_items || [])) {
        if (li.product_id) productIds.add(li.product_id);
      }
    }
    const productIdList = Array.from(productIds);

    if (productIdList.length === 0) {
      return respond(200, {
        sampleSize: 0,
        message: 'Sin productos vendidos en los últimos 30 días',
        updatedAt: now.toISOString()
      });
    }

    // 3. Fetch productos en lotes de 50 (param ?ids= soporta múltiples)
    const products = [];
    for (let i = 0; i < productIdList.length; i += 50) {
      const chunk = productIdList.slice(i, i + 50);
      const url = `https://${domain}/admin/api/2024-10/products.json?ids=${chunk.join(',')}&fields=id,title,variants&limit=250`;
      const data = await fetchJson(url, token);
      products.push(...(data.products || []));
    }

    // 4. Recolectar inventory_item_ids únicos
    const inventoryIds = new Set();
    for (const p of products) {
      for (const v of (p.variants || [])) {
        if (v.inventory_item_id) inventoryIds.add(v.inventory_item_id);
      }
    }
    const inventoryIdList = Array.from(inventoryIds);

    // 5. Fetch inventory_items en lotes (para sacar cost por variante)
    const costById = {};
    for (let i = 0; i < inventoryIdList.length; i += 100) {
      const chunk = inventoryIdList.slice(i, i + 100);
      const url = `https://${domain}/admin/api/2024-10/inventory_items.json?ids=${chunk.join(',')}&limit=250`;
      const data = await fetchJson(url, token);
      for (const it of (data.inventory_items || [])) {
        const c = parseFloat(it.cost);
        if (!isNaN(c) && c > 0) costById[it.id] = c;
      }
    }

    // 6. Para cada producto: identificar variante 1u, Pack 2, Pack 3
    //    Calcular multiplicadores y detectar 2x1/3x1
    const stats = {
      mults1u: [], mults2u: [], mults3u: [],
      cost2x1: [], cost3x1: [],
      costAll: [],
      productsWith1u: 0
    };

    for (const p of products) {
      const variants = p.variants || [];
      // Buscar variante 1u (parsePackQty == 1) y obtener su costo
      let v1u = null;
      let v2u = null;
      let v3u = null;
      for (const v of variants) {
        const qty = parsePackQty(v.title || v.option1 || '');
        if (qty === 1 && !v1u) v1u = v;
        else if (qty === 2 && !v2u) v2u = v;
        else if (qty >= 3 && !v3u) v3u = v;
      }

      if (!v1u) continue;
      const cost = costById[v1u.inventory_item_id];
      if (!cost) continue;

      const price1u = parseFloat(v1u.price || 0);
      if (price1u <= 0) continue;

      stats.productsWith1u += 1;
      stats.costAll.push(cost);
      stats.mults1u.push(price1u / cost);

      if (v2u) {
        const price2u = parseFloat(v2u.price || 0);
        if (price2u > 0) {
          // ¿Es 2x1? (precio 2u ≈ precio 1u, dentro de 10%)
          if (price2u <= price1u * 1.10) {
            stats.cost2x1.push(cost);
          } else {
            stats.mults2u.push(price2u / cost);
          }
        }
      }
      if (v3u) {
        const price3u = parseFloat(v3u.price || 0);
        if (price3u > 0) {
          // ¿Es 3x1? (precio 3u ≈ precio 1u)
          if (price3u <= price1u * 1.10) {
            stats.cost3x1.push(cost);
          } else {
            stats.mults3u.push(price3u / cost);
          }
        }
      }
    }

    // 7. Computar medianas y umbrales
    const result = {
      sampleSize: stats.productsWith1u,
      mult1u: median(stats.mults1u),
      mult2u: median(stats.mults2u),
      mult3u: median(stats.mults3u),
      sampleSize2u: stats.mults2u.length,
      sampleSize3u: stats.mults3u.length,
      // Umbral 2x1: máximo costo donde se aplica 2x1
      threshold2x1: stats.cost2x1.length ? Math.max(...stats.cost2x1) : null,
      threshold3x1: stats.cost3x1.length ? Math.max(...stats.cost3x1) : null,
      sampleSize2x1: stats.cost2x1.length,
      sampleSize3x1: stats.cost3x1.length,
      costRange: stats.costAll.length
        ? { min: Math.min(...stats.costAll), max: Math.max(...stats.costAll) }
        : null,
      updatedAt: now.toISOString()
    };

    return respond(200, result);
  } catch (err) {
    return respond(500, { error: err.message || 'Error procesando datos' });
  }
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function parsePackQty(variantTitle) {
  if (!variantTitle) return 1;
  const t = variantTitle.toLowerCase();
  if (t === 'default title' || t === '') return 1;
  let m;
  if ((m = t.match(/pack\s*(\d+)/))) return parseInt(m[1], 10);
  if ((m = t.match(/(\d+)\s*unidades?/))) return parseInt(m[1], 10);
  if ((m = t.match(/(\d+)\s*x/))) return parseInt(m[1], 10);
  if ((m = t.match(/^(\d+)$/))) return parseInt(m[1], 10);
  return 1;
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function fetchJson(url, token) {
  const r = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Shopify ' + r.status + ': ' + txt.slice(0, 200));
  }
  return r.json();
}

async function fetchAllPages(initialUrl, token, maxPages = 20) {
  const all = [];
  let url = initialUrl;
  let pages = 0;
  while (url && pages < maxPages) {
    const r = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    });
    if (!r.ok) throw new Error('Shopify ' + r.status);
    const data = await r.json();
    if (Array.isArray(data.orders)) all.push(...data.orders);
    const linkHeader = r.headers.get('Link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    pages++;
  }
  return all;
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}
