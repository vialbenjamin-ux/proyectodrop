// Drena la cola de capturas: lista todos los blobs, los devuelve, y los borra.
// Lo llama el cliente BKDROP cuando el usuario hace click en "🔄 Sincronizar"
// para mover las capturas de la cola a state.investigacion_capturas (Firestore).

import { getStore } from '@netlify/blobs';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-BK-Capture-Token',
  };
}
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders() });

  const expected = Netlify.env.get('BKDROP_CAPTURE_TOKEN');
  if (!expected) return jsonResponse(500, { error: 'BKDROP_CAPTURE_TOKEN no configurado' });
  const got = request.headers.get('x-bk-capture-token');
  if (got !== expected) return jsonResponse(401, { error: 'Token inválido' });

  const url = new URL(request.url);
  const peek = url.searchParams.get('peek') === '1' || request.method === 'GET';

  try {
    const store = getStore('bk-captures');
    const list = await store.list();
    const keys = (list.blobs || list || []).map(b => b.key || b);
    const items = [];
    for (const k of keys) {
      const obj = await store.get(k, { type: 'json' });
      if (obj) items.push(obj);
    }
    if (!peek) {
      // Borrar después de leer
      for (const k of keys) {
        await store.delete(k);
      }
    }
    items.sort((a, b) => (a.captured_at || 0) - (b.captured_at || 0));
    return jsonResponse(200, { ok: true, count: items.length, items, drained: !peek });
  } catch (e) {
    return jsonResponse(500, { error: 'Blob store: ' + e.message });
  }
};

export const config = { path: '/api/bkdrop-captures-drain' };
