// Función agendada (Lun/Mié/Vie 7 AM Chile = 11 UTC).
// Llama a Apify para scrapear Meta Ad Library en MX/AR/BR con keywords del ADN.
// Filtra por fecha (7-50 días) + match con pilares + descarte de excluidos.
// Postea los winners a /api/bkdrop-capture (mismo endpoint que el bookmarklet).
//
// Es Background Function (-background.js) para tener hasta 15 min de timeout,
// que es lo que tarda Apify en completar el run sync.

const APIFY_ACTOR = 'curious_coder~facebook-ads-library-scraper';

// Keywords del ADN del usuario, en español, 10 totales
const KEYWORDS = [
  // 🚗 Auto
  'hidrolavadora portatil', 'limpia auto', 'fundas asiento auto', 'rayon auto remover',
  // 🧹 Limpieza
  'mopa vapor electrica', 'aspiradora sopladora portatil',
  // 💡 Iluminación
  'luz solar exterior sensor', 'lampara recargable led',
  // 🍳 Cocina
  'picadora electrica usb', 'cuchillo japones cocina'
];
const COUNTRIES = ['MX', 'AR', 'BR'];
const LIMIT_PER_URL = 12;

// Filtros ADN (matchear título/copy contra estos pilares)
const ADN_PATTERNS = [
  { pillar:'🚗 Auto',         re:/auto|coche|vehiculo|carro|carplay|seat|asiento|hidrolavadora|tire|llanta|polish|rayon|wax|detail|jump.starter|pressure.washer|tire.foam|interior.cleaner/i },
  { pillar:'🧹 Limpieza',     re:/mopa|vapor|aspirador|sopladora|hidrolavadora|limpia.*piso|limpieza.*profunda|scrubber|escoba|trapeador|stain remover|dryer.*vent/i },
  { pillar:'💡 Iluminación',  re:/led|luz solar|luminaria|lampara|sensor.*movimiento|foco|linterna|recargable|outdoor.*light|garden.*light|under.*cabinet/i },
  { pillar:'🍳 Cocina',       re:/cocina|cortador|picador|katana|cuchillo|pelador|rallador|olla|sarten|airfryer|freidora|blender|mixer|kettle|cooker/i },
  { pillar:'👔 Lifestyle',    re:/cojin|gel.*ergonomic|memory.foam|billetera|wallet|cinturon/i },
  { pillar:'💪 Fitness',      re:/fitness|entrenamiento|gimnasio|resistance.band|jump.rope|massage gun|foam roller/i },
  { pillar:'🔊 Audio',        re:/altavoz|parlante|bluetooth.speaker|audifono/i },
  { pillar:'🔧 Herramientas', re:/amoladora|taladro|perforador|destornillador|sierra/i },
  { pillar:'📦 Organización', re:/organizador|estante|colgador|storage shelf|rack/i }
];
const EXCLUDED = [
  /skin.?care|crema.*piel|maquillaje|cosmetiquero|beauty|mascara|lipstick|moisturizer|wrinkle|anti.?aging|serum.*facial/i,
  /removedor.*verruga|byewart|byehongos|chaohongos|dermahong|hongos.*una|antihemorroide|cortador.*una|reductora.*cuerpo|aero.*care.*respira/i,
  /juguete|montessori|hada voladora|fly nova|magnetic.*kids|nino|nina|infantil/i,
  /lentes hd|maxvision|gafas hd|conduccion.*lentes/i,
  /guantes termicos|invierno.*calefactor/i,
  /dog (food|treat|chew|bed|collar|bark)|cat (food|fountain|litter|treat)/i,
  /diaper|pacifier|breast.pump|nursing|baby/i,
  /supplement|vitamin|protein.powder|collagen/i,
  /motorcycle.*battery|atv.*battery/i
];

function buildLibraryUrl(country, keyword) {
  const params = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country,
    q: keyword,
    search_type: 'keyword_unordered',
    media_type: 'video'
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

async function apifyRun(token, urls, limit) {
  const input = {
    urls: urls.map(u => ({ url: u })),
    limitPerSource: limit,
    'scrapePageAds.activeStatus': 'active',
    'scrapePageAds.sortBy': 'impressions_desc'
  };
  // run-sync-get-dataset-items: triggers run and waits, returns dataset
  const r = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${token}&clean=true`,
    { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(input) }
  );
  if (!r.ok) throw new Error('Apify HTTP ' + r.status + ': ' + (await r.text()).slice(0,300));
  return r.json();
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const t = Number(dateStr) ? new Date(Number(dateStr)*1000) : new Date(dateStr);
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t.getTime()) / (1000*60*60*24));
}

function matchPillar(text) {
  if (!text) return null;
  for (const p of ADN_PATTERNS) if (p.re.test(text)) return p.pillar;
  return null;
}
function isExcluded(text) {
  if (!text) return false;
  return EXCLUDED.some(re => re.test(text));
}

function detectCountry(ad) {
  // 1. Direct field
  const tc = ad.targeted_or_reached_countries;
  if (Array.isArray(tc) && tc.length) return tc[0];
  // 2. From URL params (ad_library_url o url)
  const urls = [ad.ad_library_url, ad.url].filter(Boolean);
  for (const u of urls) {
    const m = String(u).match(/[?&]country=([A-Z]{2})/i);
    if (m) return m[1].toUpperCase();
  }
  return '';
}

function transformAd(ad) {
  const snap = ad.snapshot || {};
  const card = (snap.cards && snap.cards[0]) || {};
  const text = [
    snap.title, snap.body?.text, snap.caption,
    card.title, card.body, card.link_description,
    snap.page_name
  ].filter(Boolean).join(' ');
  const days = daysSince(ad.start_date);
  return {
    library_id: String(ad.ad_archive_id || ''),
    page_name: snap.page_name || '',
    page_url: snap.page_profile_uri || '',
    country: detectCountry(ad),
    started: ad.start_date_formatted || '',
    days_active: days,
    media_type: card.video_hd_url || card.video_sd_url ? 'video' : (card.original_image_url ? 'image' : ''),
    text: text.slice(0, 1500),
    media_url: card.video_hd_url || card.video_sd_url || '',
    thumb_url: card.original_image_url || card.video_preview_image_url || snap.page_profile_picture_url || '',
    source_url: ad.ad_library_url || ad.url || '',
    cta_text: card.cta_text || '',
    link_url: card.link_url || '',
    collation_count: ad.collation_count || 1,
    raw_excerpt: text.slice(0, 1200),
    source: 'apify-discover'
  };
}

function scoreAd(ad, pillar) {
  let score = 50;
  // Bonus por colación (cuántos creativos similares = popularidad)
  if (ad.collation_count > 1) score += Math.min(20, ad.collation_count * 5);
  // Sweet spot 7-50 días
  if (ad.days_active != null) {
    if (ad.days_active >= 7 && ad.days_active <= 50) score += 20;
    else if (ad.days_active < 7) score += 8;
    else if (ad.days_active <= 90) score += 5;
  }
  // Pilares más fuertes (top 4 del ADN del usuario) reciben más bonus
  const strongPillars = ['🚗 Auto','🧹 Limpieza','💡 Iluminación','🍳 Cocina'];
  if (strongPillars.includes(pillar)) score += 10;
  return Math.min(100, score);
}

async function postCapture(captureUrl, captureToken, ads) {
  const r = await fetch(captureUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BK-Capture-Token': captureToken },
    body: JSON.stringify({ ads })
  });
  if (!r.ok) throw new Error('Capture HTTP ' + r.status + ': ' + (await r.text()).slice(0,200));
  return r.json();
}

export default async (req) => {
  const APIFY_TOKEN = Netlify.env.get('APIFY_TOKEN');
  const CAPTURE_TOKEN = Netlify.env.get('BKDROP_CAPTURE_TOKEN');
  if (!APIFY_TOKEN || !CAPTURE_TOKEN) {
    console.error('Missing APIFY_TOKEN or BKDROP_CAPTURE_TOKEN');
    return new Response('Missing tokens', { status: 500 });
  }

  console.log('Building search URLs...');
  const urls = [];
  for (const c of COUNTRIES) for (const k of KEYWORDS) urls.push(buildLibraryUrl(c, k));
  console.log(`Total URLs: ${urls.length} (${COUNTRIES.length} countries × ${KEYWORDS.length} keywords)`);

  let raw;
  try {
    console.log('Calling Apify...');
    raw = await apifyRun(APIFY_TOKEN, urls, LIMIT_PER_URL);
    console.log(`Apify returned ${raw.length} ads`);
  } catch (e) {
    console.error('Apify failed:', e.message);
    return new Response('Apify error: ' + e.message, { status: 500 });
  }

  const candidates = [];
  for (const ad of raw) {
    const t = transformAd(ad);
    if (!t.text) continue;
    if (isExcluded(t.text)) continue;
    const pillar = matchPillar(t.text);
    if (!pillar) continue;
    if (t.days_active != null && t.days_active > 90) continue; // descarta ads viejos
    if (t.days_active != null && t.days_active < 3) continue;  // descarta ads ultra nuevos sin track record
    t.adn_match = pillar;
    t.adn_score = scoreAd(t, pillar);
    candidates.push(t);
  }

  console.log(`Filtered: ${candidates.length} candidates`);
  candidates.sort((a, b) => b.adn_score - a.adn_score);
  const top = candidates.slice(0, 30);

  if (!top.length) {
    console.log('No candidates passed filter.');
    return new Response('OK 0 candidates', { status: 200 });
  }

  // Postear al endpoint capture (ya en producción)
  console.log(`Posting top ${top.length} to capture endpoint...`);
  const captureUrl = (req.url ? new URL('/api/bkdrop-capture', req.url).toString() : 'https://bkdrop.netlify.app/api/bkdrop-capture');
  try {
    const res = await postCapture(captureUrl, CAPTURE_TOKEN, top);
    console.log('Posted:', JSON.stringify(res).slice(0, 200));
    return new Response('OK ' + top.length + ' candidates posted', { status: 200 });
  } catch (e) {
    console.error('Post capture failed:', e.message);
    return new Response('Post failed: ' + e.message, { status: 500 });
  }
};

export const config = {
  schedule: '0 11 * * 1,3,5'  // Lun/Mié/Vie 11:00 UTC = 7:00 AM Chile (winter UTC-4)
};
