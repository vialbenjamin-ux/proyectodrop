// Función agendada (Lun/Mié/Vie 7 AM Chile = 11 UTC).
// Llama a Apify para scrapear Meta Ad Library en MX/AR/BR con keywords del ADN.
// Filtra por fecha (7-50 días) + match con pilares + descarte de excluidos.
// Postea los winners a /api/bkdrop-capture (mismo endpoint que el bookmarklet).
//
// Es Background Function (-background.js) para tener hasta 15 min de timeout,
// que es lo que tarda Apify en completar el run sync.

const APIFY_ACTOR = 'curious_coder~facebook-ads-library-scraper';

// Top 50 productos del catálogo del usuario (excluyendo categorías descartadas).
// Generado del histórico Shopify último año. Si se agregan/cambian productos
// importantes, regenerar este array.
const USER_TOP_PRODUCTS = [
  "Mopa Vapor Pro – Limpieza Profesional y profunda",
  "Pack Fundas Auto Premium - Asientos impecables",
  "Cojín de Gel – Confort Ergonómico",
  "Pantalla Smart 10 pulgadas! – CarPlay & Android Auto",
  "Pantalla Smart 7 – CarPlay & Android Auto",
  "4x1 Luminaria Solar LED 30 Luces – Sensor Movimiento",
  "CocinaPro – 22 Cortes diferentes",
  "KatanaBlade – Filo de Acero Japonés – Cuchillo cocina",
  "Hidrolavadora Portátil – Autonomía Total – Inalámbrica",
  "Platinum 20 Sec: Elimina Rayones auto sin taller",
  "IronSeal: Bloquea y elimina el óxido",
  "Altavoz Magnético – Sonido Potente Bluetooth",
  "TurboSoplador PRO – Seca, limpia y desaloja polvo",
  "Billetera Moderna – AntiRobo",
  "Vapor Pro – Limpieza Profunda - Desinfecta",
  "FitPro – Entrenamiento completo – Sin gimnasio",
  "Aspiradora Sopladora 2 en 1 – Sin Cables",
  "MagPro Succión Pro – Soporte celular MagSafe",
  "Amoladora Angular 12V – Sin Escobillas",
  "Calentador Auto 2 en 1 – Desempaña y Calienta",
  "Cámara retroceso auto",
  "SoundLight Pro – Ritmo y Color – Altavoz LED",
  "Picadora Eléctrica USB – Cuchillas Inoxidable",
  "EasyStick: Vinilo MARMOL Adhesivo - 10 metros",
  "Cargador Inteligente para vehículo",
  "Botella Médica 3 en 1 – Hidratación",
  "Bandas PRO de ejercicio en pareja",
  "Rodillo Fitness PRO- Entrena en Casa",
  "Lampara Repelente Mata mosquitos",
  "Pinza Broches y botones para ropa",
  "Scratch 20 Sec: Elimina Rayones auto",
  "eTermo: Lonchera comida caliente",
  "Hidrolavadora Portátil Inalámbrica con 2 baterías",
  "PeelPro – Pelador Eléctrico Automático",
  "Spray Cerámico 3 en 1 – Auto sin agua",
  "Reloj Inteligente T500",
  "Kit Jardín Completo – Corte – 2 Baterias",
  "Pilates ProFit – Multifunción",
  "Tabla Inoxidable de cocina 20x30",
  "Set de cuchillos cocina 6 piezas",
  "BloqueoMax: Seguro Volante AntiRobo auto",
  "OLLAMIX AUTOMATICA - Olla Multifunción"
];

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
    page_id: String(ad.page_id || snap.page_id || ''),
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

function findExtraVideos(candidate, byPage) {
  const all = byPage.get(candidate.page_id) || [];
  const others = all.filter(a =>
    a.library_id && a.library_id !== candidate.library_id &&
    (a.media_url || a.thumb_url)
  );
  if (!others.length) return [];
  // Rangos progresivos: probar 7-30, después 7-50, 7-90, y por último cualquier fecha.
  const RANGES = [[7, 30], [7, 50], [7, 90], [0, 9999]];
  for (const [min, max] of RANGES) {
    const matches = others.filter(a =>
      a.days_active != null && a.days_active >= min && a.days_active <= max
    );
    if (matches.length >= 2) {
      return matches.slice(0, 2).map(a => ({
        library_id: a.library_id,
        thumb_url: a.thumb_url,
        media_url: a.media_url,
        source_url: a.source_url,
        started: a.started,
        days_active: a.days_active,
        text: (a.text || '').slice(0, 200)
      }));
    }
  }
  return others.slice(0, 2).map(a => ({
    library_id: a.library_id,
    thumb_url: a.thumb_url,
    media_url: a.media_url,
    source_url: a.source_url,
    started: a.started,
    days_active: a.days_active,
    text: (a.text || '').slice(0, 200)
  }));
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

async function checkNoveltyBatch(geminiKey, candidates, indexOffset) {
  // Una llamada a Gemini con un batch de candidatos. indexOffset permite reconstruir
  // los idx originales cuando hacemos varios batches.
  const catalog = USER_TOP_PRODUCTS.map((t, i) => `${i+1}. ${t}`).join('\n');
  const candList = candidates.map((c, i) => `[${i}] page="${c.page_name || ''}" text="${(c.text || '').slice(0, 220).replace(/\n/g,' ').replace(/\s+/g,' ').replace(/"/g,"'")}"`).join('\n');
  const prompt = `Catálogo del usuario (productos YA vendidos):
${catalog}

Evaluá cada uno de los ${candidates.length} candidatos nuevos. Para cada uno extraé:
- product_name: nombre corto y buscable del producto (3-7 palabras, sin marca de la tienda).
  Ej: "Hidrolavadora portátil 4200 PSI", "Cuchillo japonés Matsato", "Lámpara LED táctil recargable"
- novelty: 0-100 (100=nuevo total, 0=mismo producto exacto)
- similar_to: número del producto del catálogo más parecido (1-${USER_TOP_PRODUCTS.length}) o null
- reason: 1 frase muy corta (<60 chars)

REGLAS de novelty:
- Mismo producto exacto: 5-20
- Misma categoría/ángulo: 25-45
- Mismo nicho, ángulo distinto: 60-75
- Producto nuevo en el nicho: 80-100

Candidatos:
${candList}

JSON solamente, sin markdown:
[{"idx":0,"product_name":"...","novelty":NUM,"similar_to":NUM_O_NULL,"reason":"..."}]`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 32000,
        responseMimeType: 'application/json'
      }
    })
  });
  if (!r.ok) {
    console.error('Gemini HTTP error:', r.status, (await r.text()).slice(0,300));
    return null;
  }
  const json = await r.json();
  const finishReason = json.candidates?.[0]?.finishReason;
  const txt = (json.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  console.log(`Gemini batch: finish=${finishReason}, output=${txt.length}c`);
  let clean = txt.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start >= 0 && end > start) clean = clean.slice(start, end + 1);
  try {
    const arr = JSON.parse(clean);
    // Reasignar idx con offset
    return arr.map(x => ({ ...x, idx: (Number(x.idx) || 0) + indexOffset }));
  } catch (e) {
    console.error('Gemini parse failed:', e.message);
    console.error('Last 200 chars:', clean.slice(-200));
    // Fallback: parse parcial — extraer todos los JSON objects válidos
    const partial = [];
    const objMatches = clean.match(/\{[^{}]*"idx"[^{}]*\}/g);
    if (objMatches) {
      for (const m of objMatches) {
        try {
          const obj = JSON.parse(m);
          partial.push({ ...obj, idx: (Number(obj.idx) || 0) + indexOffset });
        } catch {}
      }
    }
    if (partial.length) {
      console.log('Partial recovery:', partial.length, 'items');
      return partial;
    }
    return null;
  }
}

async function checkNovelty(geminiKey, candidates) {
  // Procesa en batches de 15 para evitar truncamiento (la respuesta de Gemini Flash
  // a veces se corta a ~1500 chars con responseMimeType ausente).
  const BATCH_SIZE = 15;
  const all = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    console.log(`Novelty batch ${i / BATCH_SIZE + 1}: candidates ${i}-${i+batch.length-1}`);
    try {
      const result = await checkNoveltyBatch(geminiKey, batch, i);
      if (result && result.length) all.push(...result);
    } catch (e) {
      console.error('Batch failed:', e.message);
    }
  }
  return all.length ? all : null;
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

  // Construir mapa byPage para encontrar más ads del mismo advertiser después
  const byPage = new Map();
  for (const ad of raw) {
    const t = transformAd(ad);
    if (!t.page_id) continue;
    if (!byPage.has(t.page_id)) byPage.set(t.page_id, []);
    byPage.get(t.page_id).push(t);
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
  // Tomamos hasta 40 candidatos para mandarle a Gemini, después dejamos 30 después del scoring de novedad
  let top = candidates.slice(0, 40);

  if (!top.length) {
    console.log('No candidates passed filter.');
    return new Response('OK 0 candidates', { status: 200 });
  }

  // ── Filtro de NOVEDAD vía Gemini ──
  const GEMINI_KEY = Netlify.env.get('GEMINI_API_KEY');
  if (GEMINI_KEY) {
    console.log(`Calling Gemini for novelty scoring on ${top.length} candidates...`);
    try {
      const novelties = await checkNovelty(GEMINI_KEY, top);
      if (novelties && Array.isArray(novelties)) {
        const noveltyByIdx = new Map(novelties.map(n => [n.idx, n]));
        for (let i = 0; i < top.length; i++) {
          const n = noveltyByIdx.get(i);
          if (n) {
            top[i].novelty_score = Math.max(0, Math.min(100, Number(n.novelty) || 0));
            top[i].similar_to = (n.similar_to != null && n.similar_to >= 1 && n.similar_to <= USER_TOP_PRODUCTS.length)
              ? USER_TOP_PRODUCTS[n.similar_to - 1] : '';
            top[i].novelty_reason = String(n.reason || '').slice(0, 200);
            top[i].product_name = String(n.product_name || '').slice(0, 120);
          } else {
            top[i].novelty_score = 50; // default si Gemini no scoreó este
          }
          // Score combinado: ADN ponderado por novedad. Productos idénticos a los del catálogo bajan mucho.
          top[i].adn_score = Math.round(top[i].adn_score * (top[i].novelty_score / 100));
        }
        console.log(`Novelty scored. Sample: idx=0 novelty=${top[0]?.novelty_score} final=${top[0]?.adn_score}`);
      } else {
        console.warn('Novelty scoring failed, using ADN scores as-is.');
      }
    } catch (e) {
      console.error('Novelty error (continuing without):', e.message);
    }
  } else {
    console.warn('GEMINI_API_KEY not set, skipping novelty scoring.');
  }

  // Re-rank por adn_score combinado y dejar top 30
  top.sort((a, b) => b.adn_score - a.adn_score);
  // Filtrar candidatos demasiado similares al catálogo (novelty < 25)
  top = top.filter(c => c.novelty_score == null || c.novelty_score >= 25);

  // ── DEDUPLICACIÓN ──
  // Mismo advertiser + mismo producto = 1 sola entry (mantenemos la de score más alto).
  // Diferentes advertisers vendiendo el MISMO producto también colapsan via Gemini similar_to.
  function dedupeKey(c) {
    const text = (c.text || '').toLowerCase()
      .replace(/[^a-z0-9áéíóúñü ]/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    // primeras 6 palabras significativas del texto
    const words = text.split(' ').filter(w => w.length > 2).slice(0, 6).join(' ');
    return [(c.page_name || '').toLowerCase().trim(), words].join('||');
  }
  function productKey(c) {
    // Detectar mismo producto entre advertisers distintos: tomar primeras 4 palabras
    // significativas (>3 chars) — ej. "hidrolavadora portatil inalambrica..." matchean
    const text = (c.text || '').toLowerCase()
      .replace(/[^a-z0-9áéíóúñü ]/gi, ' ').replace(/\s+/g, ' ').trim();
    const words = text.split(' ').filter(w => w.length > 3).slice(0, 4).join(' ');
    return words;
  }

  const seen = new Set();
  const seenProduct = new Map();  // productKey -> count
  const PRODUCT_CAP = 2; // máx 2 advertisers diferentes mostrando el mismo producto
  const dedup = [];
  for (const c of top) {
    const dk = dedupeKey(c);
    if (seen.has(dk)) continue;
    seen.add(dk);
    const pk = productKey(c);
    const pCount = seenProduct.get(pk) || 0;
    if (pk && pCount >= PRODUCT_CAP) continue;
    if (pk) seenProduct.set(pk, pCount + 1);
    dedup.push(c);
  }

  console.log(`After dedup: ${dedup.length} candidates (was ${top.length})`);
  top = dedup.slice(0, 30);

  // Adjuntar 2 videos extras del mismo advertiser por candidato
  for (const c of top) {
    c.extra_videos = findExtraVideos(c, byPage);
  }
  console.log('Extra videos attached. Sample counts:', top.slice(0,3).map(c => c.extra_videos?.length || 0));

  if (!top.length) {
    console.log('No candidates passed novelty filter.');
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
