// Helper compartido para cruzar campañas Ads (TikTok/Meta) con órdenes Shopify
// vía UTMs. Reutilizado desde tiktok-report.js y meta-campaigns-list.js.
//
// Reglas de match:
//   - utm_source normalizado: 'meta' cubre {facebook, instagram, fb, meta}.
//                             'tiktok' cubre {tiktok}.
//   - Fallback: si hay fbclid → 'meta'. Si hay ttclid → 'tiktok'.
//   - utm_campaign: string plano normalizado (+, %20, espacios, lowercase).
//
// Timezone: Shopify guarda created_at en UTC. Para leer "hoy Chile" hay que
// convertir el rango YYYY-MM-DD de Chile a UTC restando el offset. getChileOffsetHours
// devuelve el offset actual (negativo, -3 o -4 según DST).

const TZ_CL = 'America/Santiago';

function fmtChileDate(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ_CL }).format(d);
}

function getChileOffsetHours() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ_CL,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t) => parseInt(parts.find(p => p.type === t).value, 10);
  const chileAsUTCms = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((chileAsUTCms - now.getTime()) / 3600000);
}

async function fetchShopifyOrders(domain, token, startDateISO, endDateISO) {
  const FIELDS = 'id,line_items,landing_site,referring_site,source_name,cancelled_at,financial_status,refunds,created_at,current_subtotal_price,note_attributes';
  const offset = getChileOffsetHours();
  const startUTC = new Date(startDateISO + 'T00:00:00Z');
  startUTC.setUTCHours(startUTC.getUTCHours() - offset);
  const endUTC = new Date(endDateISO + 'T23:59:59Z');
  endUTC.setUTCHours(endUTC.getUTCHours() - offset);
  const start = startUTC.toISOString();
  const end = endUTC.toISOString();
  let url = `https://${domain}/admin/api/2024-10/orders.json?status=any&created_at_min=${start}&created_at_max=${end}&limit=250&fields=${FIELDS}`;
  let all = [];
  while (url) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
    if (!resp.ok) throw new Error('Shopify API error ' + resp.status);
    const data = await resp.json();
    const filtered = (data.orders || []).filter(o => !o.cancelled_at && o.financial_status !== 'voided');
    all = all.concat(filtered);
    const linkHeader = resp.headers.get('Link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }
  return all;
}

function extractUtmSource(order) {
  const attrs = order.note_attributes || [];
  const utmAttr = attrs.find(a => a.name && a.name.toLowerCase().replace(/_/g, ' ') === 'utm source');
  if (utmAttr && utmAttr.value) {
    const s = utmAttr.value.toLowerCase().trim();
    if (['facebook', 'instagram', 'fb', 'meta'].includes(s)) return 'meta';
    if (s === 'tiktok') return 'tiktok';
    return s;
  }
  for (const field of [order.landing_site, order.referring_site]) {
    if (!field) continue;
    try {
      const u = new URL(field.startsWith('http') ? field : 'https://x.com' + field);
      const src = u.searchParams.get('utm_source');
      if (src) {
        const s = src.toLowerCase();
        if (['facebook', 'instagram', 'fb', 'meta'].includes(s)) return 'meta';
        if (s === 'tiktok') return 'tiktok';
        return s;
      }
      if (u.searchParams.get('ttclid')) return 'tiktok';
      if (u.searchParams.get('fbclid')) return 'meta';
    } catch (_) { /* ignore */ }
  }
  const sn = (order.source_name || '').toLowerCase().trim();
  if (sn === 'tiktok') return 'tiktok';
  return 'directo';
}

function extractUtmCampaign(order) {
  const attrs = order.note_attributes || [];
  const utmAttr = attrs.find(a => a.name && a.name.toLowerCase().replace(/_/g, ' ') === 'utm campaign');
  if (utmAttr && utmAttr.value) return utmAttr.value.trim();
  for (const field of [order.landing_site, order.referring_site]) {
    if (!field) continue;
    try {
      const u = new URL(field.startsWith('http') ? field : 'https://x.com' + field);
      const camp = u.searchParams.get('utm_campaign');
      if (camp) return camp;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function getRefundedQty(order, lineItemId) {
  if (!order.refunds) return 0;
  let qty = 0;
  for (const refund of order.refunds)
    for (const ri of (refund.refund_line_items || []))
      if (ri.line_item_id === lineItemId) qty += ri.quantity || 0;
  return qty;
}

function computeOrderRevenue(order) {
  let revenue = parseFloat(order.current_subtotal_price || 0);
  if (!isFinite(revenue) || revenue < 0) revenue = 0;
  return revenue;
}

function normalizeCampaignName(s) {
  return String(s || '')
    .replace(/\+/g, ' ')
    .replace(/%20/gi, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// Convierte un date_preset (today / yesterday / last_7d / this_month …) a un
// rango { start, end } en formato YYYY-MM-DD alineado a calendario Chile.
function computeDateRange(preset) {
  const today = fmtChileDate(new Date());
  const minus = (yyyyMmDd, days) => {
    const base = new Date(yyyyMmDd + 'T12:00:00Z');
    base.setUTCDate(base.getUTCDate() - days);
    return fmtChileDate(base);
  };
  switch (preset) {
    case 'today':     return { start: today, end: today };
    case 'yesterday': { const y = minus(today, 1); return { start: y, end: y }; }
    case 'last_3d':   return { start: minus(today, 3),  end: minus(today, 1) };
    case 'last_7d':   return { start: minus(today, 7),  end: minus(today, 1) };
    case 'last_14d':  return { start: minus(today, 14), end: minus(today, 1) };
    case 'last_28d':  return { start: minus(today, 28), end: minus(today, 1) };
    case 'last_30d':  return { start: minus(today, 30), end: minus(today, 1) };
    case 'last_90d':  return { start: minus(today, 90), end: minus(today, 1) };
    case 'this_month': {
      const [y, m] = today.split('-');
      return { start: `${y}-${m}-01`, end: today };
    }
    case 'last_month': {
      const [y, m] = today.split('-');
      const monthNum = parseInt(m, 10);
      const prevYear = monthNum === 1 ? parseInt(y, 10) - 1 : parseInt(y, 10);
      const prevMonth = monthNum === 1 ? 12 : monthNum - 1;
      const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
      const mm = String(prevMonth).padStart(2, '0');
      return { start: `${prevYear}-${mm}-01`, end: `${prevYear}-${mm}-${String(lastDay).padStart(2, '0')}` };
    }
    case 'maximum':   return { start: minus(today, 365), end: today };
    default:          return { start: today, end: today };
  }
}

module.exports = {
  fetchShopifyOrders,
  extractUtmSource,
  extractUtmCampaign,
  normalizeCampaignName,
  computeOrderRevenue,
  getRefundedQty,
  computeDateRange,
  fmtChileDate,
  getChileOffsetHours,
};
