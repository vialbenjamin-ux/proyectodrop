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

// Keywords en español para LATAM (MX/AR/BR) + en inglés para US.
// Meta Ad Library usa AND entre palabras: keywords largas devuelven 0 resultados.
const KEYWORDS_LATAM = [
  // 🚗 Auto
  'hidrolavadora', 'lavado auto', 'dashcam', 'jump starter', 'inflador llantas',
  // 🧹 Limpieza
  'mopa vapor', 'aspiradora portatil', 'destapa cañerías', 'limpiador alfombra',
  // 💡 Iluminación
  'luz solar', 'tira led', 'ring light', 'proyector estrellas',
  // 🍳 Cocina
  'picadora electrica', 'accesorios airfryer', 'hervidor electrico', 'cafetera portatil',
  // 👔 Lifestyle
  'cojin lumbar', 'masajeador cuello',
  // 💪 Fitness
  'electroestimulador', 'masajeador percusion',
  // 🔊 Audio
  'parlante bluetooth',
  // 🔧 Herramientas
  'taladro inalambrico', 'soldador electrico',
  // 📦 Organización
  'organizador refrigerador', 'zapatero giratorio',
  // 📱 Móviles
  'power bank inalambrico'
];
const KEYWORDS_US = [
  // 🚗 Auto
  'pressure washer car', 'car detailer', 'dashcam', 'jump starter portable', 'tire inflator',
  // 🧹 Limpieza
  'steam mop', 'cordless shop vac', 'drain cleaner electric', 'carpet stain remover',
  // 💡 Iluminación
  'solar lights outdoor', 'led strip lights', 'ring light tripod', 'star projector', 'motion sensor light',
  // 🍳 Cocina
  'electric chopper', 'airfryer accessories', 'electric kettle portable', 'portable coffee maker',
  // 👔 Lifestyle
  'lumbar cushion', 'neck massager',
  // 💪 Fitness
  'ems abs trainer', 'massage gun',
  // 🔊 Audio
  'bluetooth speaker waterproof',
  // 🔧 Herramientas
  'cordless drill mini', 'soldering iron portable',
  // 📦 Organización
  'fridge organizer', 'shoe rack rotating',
  // 📱 Móviles
  'magsafe power bank wireless'
];
const COUNTRIES_LATAM = ['MX', 'AR', 'BR'];
const COUNTRIES_US = ['US'];
const LIMIT_PER_URL = 8;     // cap máximo por URL — bajado de 12 a 8 para
                              // que con 2 runs/semana entre dentro de los $5
                              // free credit de Apify (109 URLs × 8 = 872 max ads
                              // × $0.0009/ad ≈ $0.78/run × 8.6 runs/mes ≈ $6.7/mes
                              // pero el promedio real suele ser ~5 ads/URL = $4-5/mes).
const PER_PILLAR_TOP = 5;  // máximo N capturas por pilar en el resultado final
const FINAL_CAP = 30;

// Filtros ADN. ORDEN: pilares específicos PRIMERO, genéricos al final.
// Patterns reconocen español Y inglés (ahora scrapeamos US también).
const ADN_PATTERNS = [
  { pillar:'📱 Móviles',      re:/magsafe|power.?bank|bateria.*portatil|bateria.*externa|cargador.*inalambrico|cargador.*celular|cargador.*rapido|case.*celular|funda.*celular|usb.*c.*hub|adaptador.*celular|estacion.*carga.*celular|wireless charger|portable charger|phone mount(?!.*car)|phone stand|phone holder|charging station/i },
  { pillar:'🔧 Herramientas', re:/amoladora|taladro|perforador.*electric|destornillador|soldador|llave.*impacto|atornillador|impacto.*inalambrico|set.*herramienta|caja.*herramienta|nivel.*laser|cinta metrica|remachadora|pistola.*calor|pistola.*silicona|kit.*reparacion|cordless drill|soldering iron|screwdriver set|impact driver|tool kit|laser level|stud finder|multitool/i },
  { pillar:'🔊 Audio',        re:/altavoz|parlante|bluetooth.speaker|audifono|auricular|headphone|earbud|bocina.*portatil|sound.*bar|wireless.*earbud|bluetooth speaker|wireless headphones|portable speaker|noise cancel/i },
  { pillar:'💪 Fitness',      re:/electroestimulador|ems.*abdominal|masajeador.*percusion|pistola.*masaje|plataforma.*vibratoria|fitpro|fitness|gimnasio.*casa|resistance.band|jump.rope|massage gun|foam roller|elastico.*ejercicio|banda.*pilates|rodillo.*muscular|abdominal.*entrena|ems abs|abs trainer|workout|exercise band|home gym|pilates ring|massage tool|trigger point/i },
  { pillar:'👔 Lifestyle',    re:/cojin.*lumbar|cojin.*gel|memory.foam|lumbar.*soporte|soporte.*espalda|soporte.*cervical|postura.*correctora|cojin.*masaje|reposacabeza|almohada cervical|masajeador.*cuello|silla.*ergonomica|billetera|wallet|cinturon antirobo|lumbar cushion|neck massager|posture corrector|memory foam|seat cushion|back support|ergonomic.*chair|orthopedic/i },
  { pillar:'📦 Organización', re:/organizador.*refrigerador|organizador.*armario|organizador.*cocina|organizador.*ropa|estante.*plegable|colgador.*pared|zapatero|caja.*almacenaje|perchero|cajonera|drawer.organizer|closet.*organizador|easystick.*vinilo|fridge organizer|kitchen organizer|closet organizer|shoe rack|drawer divider|over.door|under.bed.*storage|stackable.*container|storage box/i },
  { pillar:'🍳 Cocina',       re:/cuchillo|katana|picador|cortador.*vegetal|pelador.*electric|rallador|airfryer|freidora|blender|mixer|kettle|cooker|hervidor|cafetera.*portatil|molde silicona|contenedor.*vacio|tabla.*cocina|set cuchillos|exprimidor|licuadora portatil|olla.*electrica|sarten.*ceramica|gadget.*cocina|utensilio.*cocina|knife set|kitchen shears|food chopper|vegetable peeler|airfryer accessories|electric kettle|portable coffee|silicone food|salad spinner|garlic press|electric can opener/i },
  { pillar:'💡 Iluminación',  re:/luz solar|luminaria.*solar|lampara.*recargable|sensor.*movimiento.*luz|foco.*led|linterna.*led|outdoor.*light|garden.*light|under.*cabinet|tira.*led|ring.*light|proyector.*estrella|veladora.*led|luz.*armario|night.*light|luz noche|sistema.*solar|panel.*solar|solar lights|led strip|motion sensor light|star projector|closet light|puck light|landscape light|pathway light|string lights/i },
  { pillar:'🧹 Limpieza',     re:/mopa.*vapor|aspirador|sopladora.*sin cable|destapa.*caño|destapa.*cano|destapa.*cañeria|limpia.*piso|limpieza.*profunda|scrubber|escoba.*electrica|trapeador|stain remover|dryer.*vent|alfombra.*limpia|desodorizador|extractor.*polvo|cepillo.*limpieza|steam mop|shop vac|wet dry vac|drain cleaner|carpet cleaner|power scrubber|cordless vacuum/i },
  { pillar:'🚗 Auto',         re:/(\bauto\b|\bcoche\b|\bvehiculo\b|\bcarro\b|\bcar\b|carplay|funda.*asiento|asiento.*auto|hidrolavadora|llanta|polish|rayon|wax|jump.starter|pressure.washer|tire.foam|interior.cleaner|dashcam|inflador.*llanta|carga.*auto|cargador.*vehiculo|ozonizador.*auto|soporte.*celular.*auto|lava.*auto|tu auto|del auto|para auto|en el auto|del coche|para coche|car wash|car detail|tire inflator|car vacuum|car seat cover|car charger|truck|vehicle|automotive)/i }
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
  /motorcycle.*battery|atv.*battery/i,
  // Plataformas de contenido / audiolibros / novelas / pódcast (ruido frecuente en MX/AR/BR)
  /pocket.?fm|pocketfm|noirpress|bestnovel|pasion ?novel|novelpasion|audiolibro|audionovela|story.?app|capítulo gratis|capitulo gratis|leer historia|escuchar historia/i,
  /el despegue|elevate.*app|trader|crypto|forex|inversiones|trading|invest.*app/i,
  /historia.*adicción|romance.*novela|fantasy.*novel|dramatic.*story/i,
  // SERVICIOS LOCALES — no son productos físicos para dropshipping
  /\bservicio.*(auto|car|domicilio|m[oó]vil|profesional|hogar|integral)\b/i,
  /\bservicios? de\b.*\b(limpieza|detallado|lavado|reparaci[oó]n|instalaci[oó]n|mantenci[oó]n|mantenimiento|afinaci[oó]n)\b/i,
  /\b(atendemos en|cobertura.*tu zona|cotiz[ao].*whatsapp|agenda.*cita|agenda.*servicio|agenda.*consulta|agenda.*visita|agenda tu)\b/i,
  /\b(afinaci[oó]n|mantenci[oó]n|reparaci[oó]n|instalaci[oó]n).*(auto|veh[ií]culo|hogar|profesional)\b/i,
  // Seguros y financieros (más estricto)
  /\b(cotiza|cotizar|cotizaci[oó]n) (tu )?seguro\b/i,
  /\bp[oó]liza\b|\bseguros? para auto\b|\bseguros? de auto\b|\bseguros? vehicular\b/i,
  /\bcorredora? de seguros\b|\bagente de seguros\b|\baseguradora\b|\bcompañ[íi]a de seguros\b/i,
  /\bcobertura (24\/7|completa|total) (de )?(auto|veh[ií]culo|tu coche)\b/i,
  /\btarjeta de cr[eé]dito\b|\bcr[eé]dito personal\b|\bpr[eé]stamo\b|\brefinanciaci[oó]n\b/i,
  /\bplan funerario\b|\bservicios? funerarios?\b|\bsepelio\b/i,
  // Servicios de utilities / energía / suscripciones
  /\bsistema solar residencial\b|\bpanel(es)? solar(es)?.*hogar\b|\binstalamos.*sistema solar\b|\bcotiz[áa].*panel(es)? solar\b/i,
  /\b(reduce|reducir|baja|paga menos).*(factura|tarifa).*(luz|electricidad|energ[íi]a|gas)\b/i,
  /\bahorro.*factura\b|\bgenera tu propia energ[íi]a\b/i,
  /\bplan.*(internet|telefon[íi]a|tv cable)\b|\bsuscripci[oó]n.*mensual\b/i,
  /\bdetailing|detalla(do|ndo) automotriz|estética automotriz|lavado.*a domicilio\b/i,
  /\b(consultor[íi]a|asesor[íi]a|capacitaci[oó]n|curso de|aprende a|gana dinero|ingresos pasivos)\b/i,
  /\bfree.*quote\b|\bbook.*appointment\b|\bschedule.*consultation\b|\bwe come to you\b|\bmobile.*service\b/i,
  /\bclínica|consultorio|veterinaria|peluquería|barber|spa\b/i,
  /\bbienes ra[ií]ces|inmobiliaria|propiedades en venta|departamentos en venta\b/i,
  /\b(restaurante|delivery|comida a domicilio|pedidos por)\b/i,
  /\bgimnasio.*membres[ií]a|clases.*online|membres[ií]a anual\b/i,
  // Ruido típico US: Mother's Day / regalos generic / TV remotes / pet-only
  /mother'?s? day|father'?s? day|valentine's? day|easter|halloween|christmas decoration|world cup|fifa|sticker collection/i,
  /tv remote|samsung remote|lg remote|roku remote|hisense remote|fire stick|streaming stick replacement/i,
  /dog (treat|food|chew|bed|collar|bark|rake|brush|waste bag)|cat (treat|food|fountain|litter|collar)|fish oil.*pet|omega.*pet/i,
  /book|kindle|magazine|movie/i
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
  // run-sync con timeout=600s = 10min, memory=4096MB, maxItems=1500 (cap de cobro).
  // El actor está en PAY_PER_EVENT y exige maxItems explícito.
  const r = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${token}&clean=true&timeout=600&memory=4096&maxItems=1500`,
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

// Umbral de precio MAX por país. Productos arriba de esto = fuera de rango dropshipping.
const PRICE_LIMIT = { MX: 1700, AR: 90000, BR: 500, US: 90, CL: 90000 };

function extractPrices(text) {
  const prices = [];
  const re = /\$\s?([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\b|\b([\d]{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?)\s*(pesos|peso|MXN|ARS|BRL|USD|CLP|mil)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] || m[2];
    if (!raw) continue;
    const lastSep = raw.match(/[.,](\d+)$/);
    let n;
    if (lastSep && lastSep[1].length <= 2) {
      const noThousands = raw.slice(0, raw.lastIndexOf(lastSep[0])).replace(/[.,]/g, '');
      n = parseFloat(noThousands + '.' + lastSep[1]);
    } else {
      n = parseInt(raw.replace(/[.,]/g, ''), 10);
    }
    if (m[3] && m[3].toLowerCase() === 'mil') n *= 1000;
    if (Number.isFinite(n) && n >= 50) prices.push(n);
  }
  return prices;
}

function isOverPriced(text, country) {
  const limit = PRICE_LIMIT[country];
  if (!limit) return false;
  const prices = extractPrices(text);
  if (!prices.length) return false;
  return Math.min(...prices) > limit;
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

async function checkNoveltyBatchWithRetry(geminiKey, batch, indexOffset, maxRetries = 3) {
  // Retry con backoff exponencial para errores 429/transitorios.
  let last;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await checkNoveltyBatch(geminiKey, batch, indexOffset);
      if (r && r.length) return r;
      last = null;
    } catch (e) {
      console.error('Batch attempt failed:', e.message);
      last = e;
    }
    if (attempt < maxRetries) {
      const wait = [4000, 12000, 30000][attempt] || 30000;
      console.log(`Backoff ${wait}ms before retry...`);
      await new Promise(rs => setTimeout(rs, wait));
    }
  }
  if (last) console.error('All retries failed:', last.message);
  return null;
}

async function checkNovelty(geminiKey, candidates) {
  // Procesa en batches de 20 con delay entre llamadas para no pegar el rate limit.
  // Gemini 2.5 Flash free tier = 15 RPM. Con delay de 5s estamos bajo el límite.
  const BATCH_SIZE = 20;
  const all = [];
  const numBatches = Math.ceil(candidates.length / BATCH_SIZE);
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchNum = i / BATCH_SIZE + 1;
    console.log(`Novelty batch ${batchNum}/${numBatches}: candidates ${i}-${i+batch.length-1}`);
    const result = await checkNoveltyBatchWithRetry(geminiKey, batch, i);
    if (result && result.length) all.push(...result);
    // Delay entre batches para evitar rate limit (excepto el último)
    if (i + BATCH_SIZE < candidates.length) {
      console.log('Waiting 5s before next batch...');
      await new Promise(rs => setTimeout(rs, 5000));
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
  for (const c of COUNTRIES_LATAM) for (const k of KEYWORDS_LATAM) urls.push(buildLibraryUrl(c, k));
  for (const c of COUNTRIES_US)    for (const k of KEYWORDS_US)    urls.push(buildLibraryUrl(c, k));
  console.log(`Total URLs: ${urls.length} (${COUNTRIES_LATAM.length} LATAM × ${KEYWORDS_LATAM.length} ES + ${COUNTRIES_US.length} US × ${KEYWORDS_US.length} EN)`);

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
  let droppedByPrice = 0;
  for (const ad of raw) {
    const t = transformAd(ad);
    if (!t.text) continue;
    if (isExcluded(t.text)) continue;
    const pillar = matchPillar(t.text);
    if (!pillar) continue;
    if (t.days_active != null && t.days_active > 90) continue;
    if (t.days_active != null && t.days_active < 3) continue;
    if (isOverPriced(t.text, t.country)) { droppedByPrice++; continue; }
    t.adn_match = pillar;
    t.adn_score = scoreAd(t, pillar);
    candidates.push(t);
  }
  console.log(`Dropped by price (>umbral): ${droppedByPrice}`);

  console.log(`Filtered: ${candidates.length} candidates`);
  candidates.sort((a, b) => b.adn_score - a.adn_score);
  // Hasta 60 candidatos a Gemini para tener variedad después de la estratificación.
  // Costo Gemini: 60 candidatos = 3 batches de 20 = ~$0.001/run. Negligible.
  let top = candidates.slice(0, 60);

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

  // ── ESTRATIFICACIÓN POR PILAR ──
  // Asegurar variedad: tomar hasta PER_PILLAR_TOP capturas de cada pilar antes del cap.
  // Sin esto, los pilares "fáciles" (Auto, Limpieza) acaparan todos los lugares.
  const byPillar = new Map();
  for (const c of dedup) {
    const p = c.adn_match || 'otros';
    if (!byPillar.has(p)) byPillar.set(p, []);
    byPillar.get(p).push(c);
  }
  // dedup ya viene ordenado por score; cada bucket también queda ordenado
  const stratified = [];
  for (const [pillar, list] of byPillar) {
    stratified.push(...list.slice(0, PER_PILLAR_TOP));
  }
  // Re-sort por score combinado, pero respetando que ya tenemos diversidad
  stratified.sort((a, b) => b.adn_score - a.adn_score);
  console.log(`Stratified by pillar: ${stratified.length} (pillars: ${[...byPillar.keys()].join(', ')})`);
  top = stratified.slice(0, FINAL_CAP);

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

// NOTA: antes esta función tenía `export const config = { schedule: '...' }`
// que la registraba como Scheduled Function. El efecto colateral era que las
// invocaciones HTTP devolvían 202 pero NO ejecutaban nada (Netlify Scheduled
// solo corre cuando dispara el cron). Lo quitamos para que sí responda a
// triggers manuales desde la UI ("Buscar productos winners ahora").
// El naming -background.js mantiene el timeout extendido (hasta 15 min).
// Si querés volver al cron Lun/Jue 7AM, agregar un archivo separado
// `bkdrop-discover-cron.js` que invoque esta función vía HTTP.
