// Fetch ordenes recientes de Shopify con detalles completos para el
// detector de huerfanos (Shopify -> Dropi). Devuelve los campos que
// necesita el flujo de creacion manual en Dropi: cliente, phone,
// direccion, comuna, producto, monto, fecha.
//
// Endpoint: GET /.netlify/functions/shopify-orders-detailed?hours=48
//   hours: ventana en horas (default 48, max 168).
//
// Filtros aplicados (mismos que shopify-report para consistencia):
//   - Excluye cancelled + voided.

exports.handler = async function (event) {
  const tenant = String(((event.queryStringParameters || {}).tenant || 'chile')).toLowerCase();
  const isGT = tenant === 'gt';
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) {
    return respond(500, { error: 'Faltan credenciales Shopify' + (isGT ? ' GT' : '') });
  }

  const qs = event.queryStringParameters || {};
  const hours = Math.min(parseInt(qs.hours || '48', 10) || 48, 168);
  const sinceUTC = new Date(Date.now() - hours * 3600 * 1000);

  const FIELDS = [
    'id','name','created_at','cancelled_at','financial_status',
    'total_price','current_subtotal_price',
    'customer','shipping_address','billing_address',
    'phone','contact_email',
    'line_items','note_attributes','landing_site','source_name',
    'tags','note',
  ].join(',');

  const url = 'https://' + domain + '/admin/api/2024-10/orders.json'
    + '?status=any'
    + '&created_at_min=' + sinceUTC.toISOString()
    + '&limit=250&fields=' + FIELDS;

  const allOrders = [];
  let pageUrl = url;
  const shopifyHeaders = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  try {
    while (pageUrl) {
      const resp = await fetch(pageUrl, { headers: shopifyHeaders });
      if (!resp.ok) return respond(502, { error: 'Shopify ' + resp.status });
      const data = await resp.json();
      for (const o of (data.orders || [])) {
        if (o.cancelled_at) continue;
        if (o.financial_status === 'voided') continue;
        allOrders.push(compact(o));
      }
      const link = resp.headers.get('Link') || '';
      const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = nextMatch ? nextMatch[1] : null;
    }
  } catch (err) {
    return respond(502, { error: 'Fetch fail: ' + (err.message || 'unknown') });
  }

  // Enriquecer con barcode de cada variant. Shopify NO trae li.barcode
  // en el line_item por default - hay que hacer lookup por variant_id.
  // Antes filtraba solo tag "Dropi Sync Error", pero usuarios usan otros tags
  // ("NO PASO", etc.). Ahora enriquece TODAS las ordenes con items sin barcode.
  // Cap 100 variants por request para no reventar rate limit Shopify.
  const variantIds = new Set();
  for (const o of allOrders) {
    for (const it of (o.items || [])) {
      if (it.variant_id && !it.barcode) variantIds.add(it.variant_id);
    }
    if (variantIds.size >= 100) break;
  }
  const variantBarcodes = {};
  for (const vid of variantIds) {
    try {
      const vResp = await fetch(
        'https://' + domain + '/admin/api/2024-10/variants/' + vid + '.json',
        { headers: shopifyHeaders }
      );
      if (vResp.ok) {
        const vData = await vResp.json();
        if (vData.variant && vData.variant.barcode) {
          variantBarcodes[vid] = String(vData.variant.barcode).trim();
        }
      }
    } catch (_) {}
  }
  // Aplicar barcodes
  for (const o of allOrders) {
    for (const it of (o.items || [])) {
      if (!it.barcode && it.variant_id && variantBarcodes[it.variant_id]) {
        it.barcode = variantBarcodes[it.variant_id];
      }
    }
  }

  return respond(200, {
    orders: allOrders,
    count: allOrders.length,
    variantsLookedUp: variantIds.size,
    hours,
    sinceUTC: sinceUTC.toISOString(),
    fetchedAt: new Date().toISOString(),
  });
};

// Codigos de region Chile (Shopify usa ISO abreviado) → nombre formal Dropi
const REGION_CODE_TO_DROPI = {
  'RM': 'METROPOLITANA DE SANTIAGO',
  'BI': 'BIO - BIO',
  'BB': 'BIO - BIO',
  'VS': 'VALPARAISO',
  'ML': 'MAULE',
  'AR': 'ARAUCANIA',
  'LL': 'LOS LAGOS',
  'LR': 'LOS RIOS',
  'NB': 'NUBLE',
  'CO': 'COQUIMBO',
  'AT': 'ATACAMA',
  'AN': 'ANTOFAGASTA',
  'TA': 'TARAPACA',
  'AP': 'ARICA Y PARINACOTA',
  'LI': 'OHIGGINS',
  'AI': 'AISEN DEL GENERAL CARLOS',
  'MA': 'MAGALLANES Y LA ANTARTICA',
};

// Busca en note_attributes por cualquiera de las claves (case-insensitive, contains)
function findAttr(attrs, patterns) {
  if (!Array.isArray(attrs)) return '';
  for (const a of attrs) {
    const name = String(a.name || '').toLowerCase().trim();
    for (const p of patterns) {
      if (name === p.toLowerCase() || name.includes(p.toLowerCase())) {
        return String(a.value || '').trim();
      }
    }
  }
  return '';
}

function compact(o) {
  const cust = o.customer || {};
  const ship = o.shipping_address || o.billing_address || {};
  const attrs = o.note_attributes || [];

  // Datos del Releasit COD Form (viven en note_attributes)
  const attrName    = findAttr(attrs, ['nombre y apellido', 'nombre completo', 'nombre']);
  const attrPhone   = findAttr(attrs, ['telefono', 'teléfono', 'whatsapp', 'phone']);
  const attrAddress = findAttr(attrs, ['direccion completa', 'dirección completa', 'direccion', 'dirección', 'address']);
  const attrCity    = findAttr(attrs, ['comuna', 'city', 'ciudad']);
  const attrRegion  = findAttr(attrs, ['region', 'región', 'departamento', 'state']);

  // Fallback: shipping_address estandar
  const phoneRaw = attrPhone || ship.phone || cust.phone || o.phone || '';
  const nameRaw = attrName || [cust.first_name, cust.last_name].filter(Boolean).join(' ') || [ship.first_name, ship.last_name].filter(Boolean).join(' ');
  const addressRaw = attrAddress || [ship.address1, ship.address2].filter(Boolean).join(' - ');
  const cityRaw = attrCity || ship.city || '';
  // Region: si es codigo (2 chars) mapeamos a nombre Dropi
  const regionRaw = attrRegion || ship.province_code || ship.province || '';
  const regionDropi = (regionRaw && regionRaw.length <= 3 && REGION_CODE_TO_DROPI[regionRaw.toUpperCase()])
    || (ship.province && ship.province.length > 4 ? ship.province.toUpperCase() : '')
    || regionRaw.toUpperCase();

  // City cleanup: Releasit a veces trae "SECTOR - COMUNA" (ej "PLACILLA - V DEL MAR").
  // Dropi solo reconoce la comuna real. Tomamos la ULTIMA parte del split y
  // aplicamos alias comunes.
  const cityCleaned = cleanCityForDropi(cityRaw);

  const lineItems = (o.line_items || []).map(li => ({
    name: li.title || '',
    variant: (li.variant_title && li.variant_title !== 'Default Title') ? li.variant_title : '',
    qty: li.quantity || 0,
    price: parseFloat(li.price || 0),
    sku: li.sku || '',
    variant_id: li.variant_id || null,
    // 'barcode' de Shopify = product_id de Dropi (validado 25-jul: el user
    // pone el ID Dropi en este campo para cada producto). El endpoint
    // enriquece este campo con lookup a /variants/{id}.json si viene vacio
    // del line_item.
    barcode: li.barcode || '',
  }));

  return {
    id: o.id,
    name: o.name,
    created_at: o.created_at,
    financial_status: o.financial_status,
    total: parseFloat(o.total_price || 0),
    subtotal: parseFloat(o.current_subtotal_price || 0),
    customer_name: nameRaw,
    phone: normalizePhone(phoneRaw),
    phone_raw: String(phoneRaw || ''),
    email: cust.email || o.contact_email || '',
    address: addressRaw,
    city: cityCleaned,
    city_raw: cityRaw.toUpperCase(),
    province: regionDropi,
    province_raw: regionRaw,
    zip: ship.zip || '',
    country: ship.country || 'Chile',
    items: lineItems,
    source: (o.source_name || '').toLowerCase(),
    tags: String(o.tags || ''),
    note: String(o.note || '').slice(0, 300),
  };
}

// Alias de comunas: Releasit COD Form a veces trae "SECTOR - COMUNA" o
// abreviaciones. Este mapa transforma a la comuna oficial que Dropi acepta.
const CITY_ALIASES = {
  'V DEL MAR': 'VINA DEL MAR',
  'VDELMAR': 'VINA DEL MAR',
  'VIÑA DEL MAR': 'VINA DEL MAR',
  'VINA': 'VINA DEL MAR',
  'CONCE': 'CONCEPCION',
  'CONCEPCIÓN': 'CONCEPCION',
  'VALPO': 'VALPARAISO',
  'VALPARAÍSO': 'VALPARAISO',
  'STGO': 'SANTIAGO',
  'SGTO': 'SANTIAGO',
};

function cleanCityForDropi(raw) {
  if (!raw) return '';
  let s = String(raw).toUpperCase().trim();
  // Si viene "SECTOR - COMUNA" quedarnos con la ultima parte
  if (s.includes(' - ')) {
    const parts = s.split(' - ').map(p => p.trim()).filter(Boolean);
    s = parts[parts.length - 1];
  }
  // Aplicar alias
  if (CITY_ALIASES[s]) s = CITY_ALIASES[s];
  // Quitar acentos
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return s;
}

function normalizePhone(p) {
  if (!p) return '';
  let s = String(p).replace(/\D/g, '');
  if (s.startsWith('56') && s.length >= 11) s = s.slice(2);
  return s;
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  };
}
