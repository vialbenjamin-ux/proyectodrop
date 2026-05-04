// Bookmarklet BKDROP Capture — pega esto en la URL de un favorito.
// Source legible. Para usar, minificar y prefijar con "javascript:".
// Funciona en facebook.com/ads/library — captura los ads visibles en pantalla
// y los manda al endpoint BKDROP.

(function () {
  'use strict';
  var ENDPOINT = 'https://bkdrop.netlify.app/api/bkdrop-capture';
  var TOKEN = 'BKDROP_CAPTURE_TOKEN_PLACEHOLDER';

  // Toast helper
  function toast(msg, isError) {
    var t = document.getElementById('bk-toast');
    if (t) t.remove();
    t = document.createElement('div');
    t.id = 'bk-toast';
    t.style.cssText = [
      'position:fixed', 'top:20px', 'right:20px', 'z-index:2147483647',
      'background:' + (isError ? '#E88A8A' : '#5BA882'), 'color:#fff',
      'padding:14px 18px', 'border-radius:10px', 'font-family:system-ui,sans-serif',
      'font-size:14px', 'font-weight:600', 'box-shadow:0 6px 24px rgba(0,0,0,.25)',
      'max-width:340px', 'line-height:1.4'
    ].join(';');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 3500);
    setTimeout(function () { try { t.remove(); } catch (e) {} }, 4200);
  }

  // Verifica que estemos en Meta Ad Library
  if (!/facebook\.com\/ads\/library/i.test(location.href)) {
    toast('Abrí esto en facebook.com/ads/library', true);
    return;
  }

  // Country from URL params
  function getCountry() {
    var m = location.search.match(/[?&]country=([A-Z]{2})/i);
    return m ? m[1].toUpperCase() : '';
  }
  var country = getCountry();

  // Extracción heurística por bloque
  function extractFromBlock(el) {
    var text = (el.innerText || el.textContent || '').trim();
    if (!text) return null;

    // Library ID
    var libMatch = text.match(/(?:Library ID|ID de biblioteca|Identificador de la biblioteca)[:\s]+(\d{6,})/i);
    var library_id = libMatch ? libMatch[1] : '';

    // Started running on
    var startedMatch =
      text.match(/(?:Started running on|Empez(?:ó|o) a publicarse el|Comenzou a ser veiculado em)[:\s]+([^\n·]+?)(?=\s*[·\n]|$)/i) ||
      text.match(/(?:Active|Activo)[:\s]+(\d+\s+\w+)/i);
    var started = startedMatch ? startedMatch[1].trim().slice(0, 60) : '';

    // Page name (heurística): primer link no-trivial dentro del bloque
    var page_name = '';
    var page_url = '';
    var links = el.querySelectorAll('a[href*="facebook.com"]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var t = (a.innerText || a.textContent || '').trim();
      if (!t || t.length < 2 || t.length > 80) continue;
      if (/sponsored|patrocinado|library id/i.test(t)) continue;
      page_name = t;
      page_url = a.href;
      break;
    }

    // Imagen / video
    var thumb_url = '';
    var media_url = '';
    var media_type = '';
    var img = el.querySelector('img[src*="scontent"], img[src*="fbcdn"]');
    if (img) thumb_url = img.src;
    var vid = el.querySelector('video');
    if (vid) {
      media_type = 'video';
      media_url = vid.src || (vid.querySelector('source') && vid.querySelector('source').src) || '';
      if (!thumb_url && vid.poster) thumb_url = vid.poster;
    } else if (thumb_url) {
      media_type = 'image';
    }

    return {
      library_id: library_id,
      page_name: page_name,
      page_url: page_url,
      started: started,
      text: text.slice(0, 1500),
      thumb_url: thumb_url,
      media_url: media_url,
      media_type: media_type,
      source_url: location.href,
      country: country,
      raw_excerpt: text.slice(0, 1200)
    };
  }

  // Encuentra todos los ad cards visibles. Heurística por keyword "Library ID"
  // (multi-idioma) en el texto, y trepar al ancestro razonable.
  function findAdCards() {
    var bodyText = (document.body.innerText || '').toLowerCase();
    var hasIds = /(library id|id de biblioteca|identificador de la biblioteca)/.test(bodyText);
    if (!hasIds) return [];

    var all = document.querySelectorAll('div');
    var seen = new Set();
    var cards = [];
    for (var i = 0; i < all.length; i++) {
      var d = all[i];
      var t = (d.innerText || '').slice(0, 200).toLowerCase();
      if (!/(library id|id de biblioteca|identificador de la biblioteca)/.test(t)) continue;
      // trepar a un ancestro de tamaño razonable (entre 200 y 1500 px alto)
      var el = d;
      while (el && el !== document.body) {
        var r = el.getBoundingClientRect();
        if (r.height > 200 && r.height < 1800 && r.width > 200) break;
        el = el.parentElement;
      }
      if (!el || el === document.body) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      cards.push(el);
    }
    return cards;
  }

  var cards = findAdCards();
  if (!cards.length) {
    toast('No encontré ads en pantalla. Hacé scroll y volvé a clickear.', true);
    return;
  }

  var ads = [];
  for (var i = 0; i < cards.length; i++) {
    var data = extractFromBlock(cards[i]);
    if (data && (data.library_id || data.page_name)) ads.push(data);
  }

  if (!ads.length) {
    toast('No pude extraer datos de los ads visibles.', true);
    return;
  }

  toast('📤 Enviando ' + ads.length + ' ad' + (ads.length > 1 ? 's' : '') + ' a BKDROP...');

  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BK-Capture-Token': TOKEN },
    body: JSON.stringify({ ads: ads })
  })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (res.ok) toast('✅ ' + res.j.saved + ' ads guardados. Abrí BKDROP → Investigación → Sincronizar.');
      else toast('❌ Error: ' + (res.j.error || 'desconocido'), true);
    })
    .catch(function (e) { toast('❌ Network: ' + e.message, true); });
})();
