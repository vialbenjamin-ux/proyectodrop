// Lista los videos de la Ads Video Library del anunciante.
// Usa POST /open_api/v1.3/file/video/ad/search/ que devuelve tus videos con
// thumbnail + duracion + video_id.
//
// GET /.netlify/functions/tiktok-videos-list?advertiser_id=X&page=1&size=50
//
// Respuesta:
//   { videos: [{ video_id, name, cover_url, duration, width, height, size, created_at }], total }
//
// Requiere scope de LECTURA de Video Library. Puede ser parte del grupo
// "Video Management" (en review) o de un scope ya aprobado. Si TikTok
// devuelve permission error, mostramos mensaje claro al usuario.

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const url = new URL(req.url);
  const advertiserId = url.searchParams.get('advertiser_id');
  const page = Number(url.searchParams.get('page') || 1);
  const size = Math.min(Number(url.searchParams.get('size') || 50), 100);

  if (!advertiserId) return json(400, { error: 'Falta advertiser_id' });

  let token;
  try {
    const store = getStore({ name: 'bk-tokens', consistency: 'strong' });
    const auth = await getActiveAuth(store);
    if (!auth || !auth.access_token) return json(401, { error: 'NOT_CONNECTED' });
    token = auth.access_token;
  } catch (e) {
    return json(500, { error: 'Storage error: ' + (e.message || 'unknown') });
  }

  // TikTok /file/video/ad/search/ acepta POST con JSON body con filtros y paginacion.
  const body = {
    advertiser_id: String(advertiserId),
    page,
    page_size: size,
  };

  try {
    const resp = await fetch('https://business-api.tiktok.com/open_api/v1.3/file/video/ad/search/', {
      method: 'POST',
      headers: {
        'Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok || data.code !== 0) {
      // Codigo 40001 = permission error / scope insuficiente
      const isPermission = data.code === 40001 || /permission|scope/i.test(String(data.message || ''));
      return json(502, {
        error: isPermission ? 'SCOPE_MISSING' : 'TikTok API error',
        message: data.message || 'unknown',
        tiktokCode: data.code,
        hint: isPermission
          ? 'Necesita el scope "Read Video Library" (parte de Video Management). Sigue en review si lo aplicaste hoy — reintentar en 24-48h.'
          : 'Ver detail crudo.',
        detail: data,
      });
    }
    const list = (data.data && Array.isArray(data.data.list)) ? data.data.list : [];
    const videos = list.map(v => ({
      video_id: v.video_id || v.id,
      name: v.file_name || v.material_name || v.name || '',
      cover_url: v.video_cover_url || v.poster_url || v.cover_url || null,
      preview_url: v.preview_url || v.video_url || null,
      duration: v.duration || null,
      width: v.width || null,
      height: v.height || null,
      size: v.size || null,
      created_at: v.create_time || v.created_at || null,
    }));
    return json(200, {
      videos,
      total: (data.data && data.data.page_info && data.data.page_info.total_number) || videos.length,
      page,
      pageSize: size,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(502, { error: 'Fetch TikTok videos-list fail: ' + (err.message || 'unknown') });
  }
}
