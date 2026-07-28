// Sube un video a la Ads Library de TikTok via URL publica.
// TikTok descarga el archivo desde el URL provisto y lo procesa.
// Usar cuando el video ya esta hosteado en Drive/Cloudinary/S3/Vimeo/etc.
//
// Body:
//   {
//     advertiser_id: "123",
//     video_url: "https://drive.google.com/uc?export=download&id=..." (o similar),
//     video_signature: "optional_md5"   // TikTok lo prefiere pero es opcional
//   }
//
// TikTok Ads API v1.3:
//   POST /open_api/v1.3/file/video/ad/upload/
//   Body (multipart): upload_type=UPLOAD_BY_URL, advertiser_id, video_url
//
// Nota: El video URL debe ser publicamente accesible (sin auth). MP4 recomendado.

import { getStore } from '@netlify/blobs';

async function getActiveAuth(store) {
  try {
    const activeId = await store.get('tiktok_active', { type: 'json' });
    if (activeId) {
      const a = await store.get('tiktok_auth_' + activeId, { type: 'json' });
      if (a && a.access_token) return a;
    }
  } catch { /* fall through */ }
  return await store.get('tiktok_auth', { type: 'json' });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors() });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = await req.json(); }
  catch { return json(400, { error: 'JSON invalido' }); }

  const advertiserId = body.advertiser_id;
  const videoUrl = String(body.video_url || '').trim();
  const videoSignature = body.video_signature ? String(body.video_signature).trim() : null;

  if (!advertiserId) return json(400, { error: 'Falta advertiser_id' });
  if (!videoUrl) return json(400, { error: 'Falta video_url' });
  if (!/^https?:\/\//.test(videoUrl)) return json(400, { error: 'video_url debe ser HTTP(S)' });

  let token;
  try {
    const store = getStore({ name: 'bk-tokens', consistency: 'strong' });
    const auth = await getActiveAuth(store);
    if (!auth || !auth.access_token) return json(401, { error: 'NOT_CONNECTED' });
    token = auth.access_token;
  } catch (e) {
    return json(500, { error: 'Storage error: ' + (e.message || 'unknown') });
  }

  // TikTok /file/video/ad/upload/ acepta multipart/form-data.
  // Para UPLOAD_BY_URL enviamos form-data con los campos correspondientes.
  const form = new FormData();
  form.append('upload_type', 'UPLOAD_BY_URL');
  form.append('advertiser_id', String(advertiserId));
  form.append('video_url', videoUrl);
  if (videoSignature) form.append('video_signature', videoSignature);

  try {
    const resp = await fetch('https://business-api.tiktok.com/open_api/v1.3/file/video/ad/upload/', {
      method: 'POST',
      headers: {
        'Access-Token': token,
        // No fijamos Content-Type: fetch lo pone con boundary automatico.
      },
      body: form,
    });
    const data = await resp.json();
    if (!resp.ok || data.code !== 0) {
      return json(502, {
        error: 'TikTok video upload error',
        detail: data,
      });
    }
    // La respuesta contiene { data: [{ video_id, ... }] } segun docs
    const videos = Array.isArray(data.data) ? data.data : (data.data && data.data.list) || [];
    const first = videos[0] || null;
    return json(200, {
      ok: true,
      videoId: first ? (first.video_id || first.id) : null,
      videos,
      tiktokResponse: data,
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(502, { error: 'Fetch TikTok video upload fail: ' + (err.message || 'unknown') });
  }
}
