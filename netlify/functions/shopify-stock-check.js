// Trae inventory levels de todos los productos activos de Shopify.
// Endpoint: GET /.netlify/functions/shopify-stock-check?threshold=5
// Responde: { products: [{ productId, productTitle, variantId, variantTitle,
//                          sku, stock, image, productHandle, alertLevel }],
//             fetchedAt, threshold }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });

  const domain = process.env.SHOPIFY_DOMAIN;
  const token  = process.env.SHOPIFY_TOKEN;
  if (!domain || !token) return respond(500, { error: 'Faltan credenciales de Shopify' });

  const params = event.queryStringParameters || {};
  const threshold = Math.max(0, parseInt(params.threshold || '5', 10));

  // GraphQL: traemos productos activos paginando con cursor (250 por página)
  const allVariants = [];
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 8; // 8 × 250 = 2000 productos máx (suficiente para tiendas típicas)

  while (pages < MAX_PAGES) {
    const query = `
      query GetProducts($cursor: String) {
        products(first: 250, after: $cursor, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              handle
              featuredImage { url }
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    sku
                    inventoryQuantity
                    inventoryItem { tracked }
                  }
                }
              }
            }
          }
        }
      }`;
    const resp = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { cursor } }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return respond(resp.status, { error: 'Shopify GraphQL: ' + errText.slice(0, 300) });
    }
    const data = await resp.json();
    if (data.errors) return respond(500, { error: 'GraphQL errors: ' + JSON.stringify(data.errors).slice(0, 300) });

    const products = data.data?.products;
    if (!products) break;

    for (const edge of (products.edges || [])) {
      const p = edge.node;
      for (const ve of (p.variants?.edges || [])) {
        const v = ve.node;
        // Solo incluir variantes con inventario rastreado
        if (!v.inventoryItem?.tracked) continue;
        allVariants.push({
          productId: p.id.replace('gid://shopify/Product/', ''),
          productTitle: p.title,
          productHandle: p.handle,
          image: p.featuredImage?.url || null,
          variantId: v.id.replace('gid://shopify/ProductVariant/', ''),
          variantTitle: v.title === 'Default Title' ? null : v.title,
          sku: v.sku || null,
          stock: v.inventoryQuantity ?? 0,
        });
      }
    }

    if (!products.pageInfo?.hasNextPage) break;
    cursor = products.pageInfo.endCursor;
    pages += 1;
  }

  // Clasificar por nivel de alerta
  const inAlert = allVariants
    .filter(v => v.stock <= threshold)
    .map(v => ({
      ...v,
      alertLevel: v.stock <= 0 ? 'critical' : 'warning',
    }))
    .sort((a, b) => a.stock - b.stock);

  return respond(200, {
    products: inAlert,
    totalTracked: allVariants.length,
    threshold,
    fetchedAt: new Date().toISOString(),
    domain,
  });
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
