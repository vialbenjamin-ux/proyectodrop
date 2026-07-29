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

// Extrae keywords "de producto" del nombre de una campaña Ads.
// Ejemplos:
//   "0522 GUIRNALDAS 3M"                    -> ["guirnaldas", "3m"]
//   "0609 GUIRNALDAS 3M BDCAP 4500-5250"    -> ["guirnaldas", "3m"]
//   "0723 ALUMINIO COCINA BDCAP 35-45"      -> ["aluminio", "cocina"]
//   "0728 PATINES NIÑO"                     -> ["patines", "niño"]
// Reglas:
//   - Quitar prefijo numérico inicial (ej "0522 ")
//   - Cortar todo lo que venga después de BDCAP/BCAP/CAP (rangos de precio)
//   - Ignorar tokens muy cortos (< 2 chars) excepto "3m", "4m" y similares
//   - Ignorar tokens meramente numéricos (fechas, rangos)
function extractCampaignKeywords(name) {
  let s = String(name || '').toLowerCase().trim();
  s = s.replace(/^\d+\s+/, '');                         // quitar "0522 "
  s = s.replace(/\s+(bdcap|bcap|cap)\s+.*$/i, '');       // quitar " BDCAP 4500-5250"
  s = s.replace(/\s*\(\d+\)\s*$/, '');                   // quitar sufijo " (5)"
  s = s.replace(/[^\w\sáéíóúñü]/gi, ' ');                // caracteres especiales -> espacio
  s = s.replace(/\s+/g, ' ').trim();
  // Stopwords: prefijos/siglas comunes que aparecen en nombres de campana pero
  // NO en nombres de producto Shopify. Se excluyen del match. Editar aca si
  // aparecen otros patterns (ej "TEST", "PRUEBA", etc.)
  const STOPWORDS = new Set(['ap','cp','bk','ba','v1','v2','v3','v4','v5','av','ad','ads']);
  const tokens = s.split(' ').filter(t => {
    if (t.length < 2) return false;
    if (/^\d+$/.test(t)) return false;                    // puros números
    if (/^\d+[a-z]$/i.test(t)) return true;               // 3m, 4g, 5v ok
    if (STOPWORDS.has(t)) return false;                    // AP, CP, etc.
    // Tokens de 2 letras puras (no num+letra) suelen ser siglas → excluir
    if (t.length < 3 && !/^\d/.test(t)) return false;
    return true;
  });
  return tokens;
}

// Devuelve el campaign_id de la campaña que "posee" el producto de la orden,
// según fuzzy match entre los keywords del nombre de la campaña y los títulos
// de line_items de la orden.
//   - Si UNA sola campaña matchea → return { id, name, score }
//   - Si múltiples matchean con score similar → return null (ambiguo)
//   - Si ninguna → return null
// Score = cantidad de keywords de la campaña presentes en algún line_item.
function matchOrderToCampaignByProduct(order, campaignsList) {
  const lineTitles = (order.line_items || [])
    .map(li => String(li.title || li.name || '').toLowerCase())
    .filter(Boolean);
  if (lineTitles.length === 0 || campaignsList.length === 0) return null;

  const matches = [];
  for (const c of campaignsList) {
    const kw = extractCampaignKeywords(c.name);
    if (kw.length === 0) continue;
    // Score: keywords presentes en algún line_item
    let score = 0;
    for (const w of kw) {
      if (lineTitles.some(t => t.includes(w))) score++;
    }
    // Requiere que TODOS los keywords estén presentes (match completo).
    // Para campañas con 1 solo keyword ("zapatera"), 1/1 es válido.
    // Para "guirnaldas 3m", exige "guirnaldas" Y "3m".
    if (score === kw.length) matches.push({ id: c.id, name: c.name, score, kwCount: kw.length });
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Ambigüedad: múltiples campañas matchean el mismo producto.
  // Preferir la que tenga MÁS keywords (más específica). Si empatan, ambigua.
  matches.sort((a, b) => b.kwCount - a.kwCount);
  if (matches[0].kwCount > matches[1].kwCount) return matches[0];
  return null;
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
  extractCampaignKeywords,
  matchOrderToCampaignByProduct,
  computeOrderRevenue,
  getRefundedQty,
  computeDateRange,
  fmtChileDate,
  getChileOffsetHours,
};
