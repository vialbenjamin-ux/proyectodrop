// Endpoint diagnóstico TEMPORAL para investigar descuadre BKDROP vs Shopify UI.
// Devuelve el listado crudo de órdenes de un día (Santiago) con los campos
// mínimos para poder comparar orden-a-orden con Shopify Admin > Orders.
// Uso: GET /.netlify/functions/shopify-debug-orders?date=YYYY-MM-DD&tenant=chile
// TODO: borrar este archivo cuando terminemos el diagnóstico.

exports.handler = async function (event) {
  const qs = event.queryStringParameters || {};
  const tenant = String((qs.tenant || 'chile')).toLowerCase();
  const isGT = (tenant === 'gt');
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  const date = qs.date;

  if (!token || !domain) {
    return respond(500, { error: 'Faltan credenciales de Shopify' });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return respond(400, { error: 'Falta ?date=YYYY-MM-DD' });
  }

  function getSantiagoOffsetHours(d) {
    const utcStr = d.toLocaleString('en-US', { timeZone: 'UTC' });
    const santiStr = d.toLocaleString('en-US', { timeZone: 'America/Santiago' });
    return (new Date(utcStr) - new Date(santiStr)) / 3600000;
  }

  const refDate = new Date(date + 'T12:00:00Z');
  const off = getSantiagoOffsetHours(refDate);
  const startUTC = new Date(date + 'T' + String(off).padStart(2, '0') + ':00:00Z');
  const endUTC   = new Date(startUTC.getTime() + 24 * 3600000);

  const FIELDS = 'id,name,created_at,cancelled_at,financial_status,fulfillment_status,source_name,landing_site,referring_site,current_subtotal_price,total_price,note_attributes,test,tags';
  const baseUrl = 'https://' + domain + '/admin/api/2024-10/orders.json?status=any'
    + '&created_at_min=' + startUTC.toISOString()
    + '&created_at_max=' + endUTC.toISOString()
    + '&limit=250&fields=' + FIELDS;

  const allOrdersRaw = [];
  let pageUrl = baseUrl;
  try {
    while (pageUrl) {
      const resp = await fetch(pageUrl, {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
      });
      if (!resp.ok) throw new Error('Shopify API ' + resp.status);
      const data = await resp.json();
      for (const o of (data.orders || [])) allOrdersRaw.push(o);
      const linkHeader = resp.headers.get('Link') || '';
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = nextMatch ? nextMatch[1] : null;
    }
  } catch (err) {
    return respond(502, { error: err.message || 'fetch error' });
  }

  function utmOf(o) {
    const attrs = o.note_attributes || [];
    const a = attrs.find(x => x.name && x.name.toLowerCase() === 'utm source');
    if (a && a.value) return String(a.value).toLowerCase().trim();
    for (const f of [o.landing_site, o.referring_site]) {
      if (!f) continue;
      try {
        const u = new URL(f.startsWith('http') ? f : 'https://x.com' + f);
        const s = u.searchParams.get('utm_source');
        if (s) return s.toLowerCase();
        if (u.searchParams.get('fbclid')) return 'fbclid';
        if (u.searchParams.get('ttclid')) return 'ttclid';
      } catch (_) {}
    }
    return (o.source_name || '').toLowerCase() || '(none)';
  }

  const list = allOrdersRaw.map(o => ({
    id: o.id,
    name: o.name,
    created_at: o.created_at,
    created_santiago: new Date(o.created_at).toLocaleString('es-CL', { timeZone: 'America/Santiago' }),
    cancelled_at: o.cancelled_at,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
    source_name: o.source_name,
    utm: utmOf(o),
    total_price: o.total_price,
    test: !!o.test,
    tags: o.tags,
    counted_by_bkdrop: !o.cancelled_at && o.financial_status !== 'voided'
  }));

  const counts = {
    total_raw: list.length,
    counted_by_bkdrop: list.filter(x => x.counted_by_bkdrop).length,
    cancelled: list.filter(x => x.cancelled_at).length,
    voided: list.filter(x => x.financial_status === 'voided').length,
    pending: list.filter(x => x.financial_status === 'pending').length,
    paid: list.filter(x => x.financial_status === 'paid').length,
    refunded: list.filter(x => x.financial_status === 'refunded').length,
    partially_refunded: list.filter(x => x.financial_status === 'partially_refunded').length,
    tests: list.filter(x => x.test).length,
    by_source_name: list.reduce((acc, x) => { acc[x.source_name || '(none)'] = (acc[x.source_name || '(none)']||0)+1; return acc; }, {}),
    by_utm: list.reduce((acc, x) => { acc[x.utm] = (acc[x.utm]||0)+1; return acc; }, {}),
  };

  return respond(200, { date, tenant, startUTC, endUTC, counts, orders: list });

  function respond(statusCode, payload) {
    return {
      statusCode,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload, null, 2)
    };
  }
};
