// Endpoint que recibe ads capturados desde el bookmarklet de Meta Ad Library.
// Cola: cada captura se guarda como un blob en el store "bk-captures".
// BKDROP UI llama luego a /api/bkdrop-captures-list para drenar la cola y persistirlas en Firestore.

import { getStore } from '@netlify/blobs';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-BK-Capture-Token',
  };
}
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
function genId() {
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders() });
  if (request.method !== 'POST')   return jsonResponse(405, { error: 'Method not allowed' });

  const expected = Netlify.env.get('BKDROP_CAPTURE_TOKEN');
  if (!expected) return jsonResponse(500, { error: 'BKDROP_CAPTURE_TOKEN no configurado' });
  const got = request.headers.get('x-bk-capture-token');
  if (got !== expected) return jsonResponse(401, { error: 'Token inválido' });

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse(400, { error: 'JSON inválido' }); }

  const ads = Array.isArray(body.ads) ? body.ads : [body];
  if (!ads.length) return jsonResponse(400, { error: 'Faltan ads' });

  const now = Date.now();
  const cleaned = ads.map(a => ({
    id:           genId(),
    captured_at:  now,
    source_url:   String(a.source_url || '').slice(0, 600),
    page_url:     String(a.page_url   || '').slice(0, 600),
    library_id:   String(a.library_id || '').slice(0, 80),
    page_name:    String(a.page_name  || '').slice(0, 200),
    country:      String(a.country    || '').slice(0, 4),
    started:      String(a.started    || '').slice(0, 60),
    days_active:  (a.days_active != null ? Number(a.days_active) : null),
    media_type:   String(a.media_type || '').slice(0, 20),
    text:         String(a.text       || '').slice(0, 2000),
    media_url:    String(a.media_url  || '').slice(0, 600),
    thumb_url:    String(a.thumb_url  || '').slice(0, 600),
    cta_text:     String(a.cta_text   || '').slice(0, 80),
    link_url:     String(a.link_url   || '').slice(0, 600),
    collation_count: (a.collation_count != null ? Number(a.collation_count) : 1),
    raw_excerpt:  String(a.raw_excerpt|| '').slice(0, 1500),
    source:       String(a.source     || 'bookmarklet').slice(0, 40),
    status:       'new',
    adn_score:    (a.adn_score != null ? Number(a.adn_score) : null),
    adn_match:    String(a.adn_match  || '').slice(0, 60) || null,
    novelty_score:  (a.novelty_score != null ? Number(a.novelty_score) : null),
    similar_to:     String(a.similar_to    || '').slice(0, 200) || null,
    novelty_reason: String(a.novelty_reason || '').slice(0, 240) || null,
    product_name:   String(a.product_name  || '').slice(0, 120) || null,
    extra_videos:   Array.isArray(a.extra_videos) ? a.extra_videos.slice(0, 5).map(v => ({
      library_id: String(v.library_id || '').slice(0, 80),
      thumb_url:  String(v.thumb_url  || '').slice(0, 600),
      media_url:  String(v.media_url  || '').slice(0, 600),
      source_url: String(v.source_url || '').slice(0, 600),
      started:    String(v.started    || '').slice(0, 60),
      days_active:(v.days_active != null ? Number(v.days_active) : null),
      text:       String(v.text       || '').slice(0, 240)
    })) : [],
    saturation_chile: null,
    notes:        ''
  }));

  try {
    const store = getStore('bk-captures');
    for (const c of cleaned) {
      await store.setJSON(c.id, c);
    }
  } catch (e) {
    return jsonResponse(500, { error: 'Blob store: ' + e.message });
  }

  return jsonResponse(200, { ok: true, saved: cleaned.length, ids: cleaned.map(c => c.id) });
};

export const config = { path: '/api/bkdrop-capture' };
