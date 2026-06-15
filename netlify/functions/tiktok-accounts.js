// Gestión de cuentas TikTok conectadas (multi-account).
//
// GET  → { accounts: [{id, label, advertiser_ids, connected_at}], active }
// POST → body: { action: 'activate'|'rename'|'delete', id, label? }
//        - activate: setea tiktok_active = id
//        - rename:   cambia label de la cuenta
//        - delete:   borra tiktok_auth_<id> + saca del índice. Si era la
//          activa, elige otra (la primera disponible) como nueva activa.
//
// Storage en Netlify Blobs 'bk-tokens':
//   tiktok_accounts  [{id, label, advertiser_ids, connected_at}]
//   tiktok_active    <id>
//   tiktok_auth_<id> { access_token, advertiser_ids, scope, connected_at }
//   tiktok_auth      legacy (sólo lectura como fallback)

import { getStore } from '@netlify/blobs';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

  let store;
  try {
    store = getStore({ name: 'bk-tokens', consistency: 'strong' });
  } catch (e) {
    return json(500, { error: 'Storage error: ' + (e.message || 'unknown') });
  }

  // Helper: leer estado, ejecutando migración lazy si hay legacy sin índice.
  async function loadState() {
    let accounts = (await store.get('tiktok_accounts', { type: 'json' })) || [];
    let active = await store.get('tiktok_active', { type: 'json' });
    if (accounts.length === 0) {
      const legacy = await store.get('tiktok_auth', { type: 'json' });
      if (legacy && legacy.access_token) {
        const legacyId = 'acct_' + (legacy.connected_at ? new Date(legacy.connected_at).getTime() : Date.now()) + '_legacy';
        await store.setJSON('tiktok_auth_' + legacyId, legacy);
        accounts = [{
          id: legacyId,
          label: 'Cuenta 1',
          advertiser_ids: legacy.advertiser_ids || [],
          connected_at: legacy.connected_at || new Date().toISOString(),
        }];
        active = legacyId;
        await store.setJSON('tiktok_accounts', accounts);
        await store.setJSON('tiktok_active', active);
      }
    }
    if (!active && accounts.length > 0) {
      active = accounts[0].id;
      await store.setJSON('tiktok_active', active);
    }
    return { accounts, active };
  }

  if (req.method === 'GET') {
    try {
      const { accounts, active } = await loadState();
      return json(200, { accounts, active });
    } catch (e) {
      return json(500, { error: e.message || 'load error' });
    }
  }

  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = await req.json(); }
  catch { return json(400, { error: 'Body JSON inválido' }); }

  const { action, id, label } = body || {};
  if (!action || !id) return json(400, { error: 'Faltan action e id' });

  try {
    let { accounts, active } = await loadState();
    const idx = accounts.findIndex(c => c.id === id);
    if (idx === -1) return json(404, { error: 'Cuenta no encontrada' });

    if (action === 'activate') {
      active = id;
      await store.setJSON('tiktok_active', active);
    } else if (action === 'rename') {
      const lbl = String(label || '').trim().slice(0, 60);
      if (!lbl) return json(400, { error: 'Label vacío' });
      accounts[idx].label = lbl;
      await store.setJSON('tiktok_accounts', accounts);
    } else if (action === 'delete') {
      const wasActive = (active === id);
      accounts.splice(idx, 1);
      try { await store.delete('tiktok_auth_' + id); } catch { /* best-effort */ }
      await store.setJSON('tiktok_accounts', accounts);
      if (wasActive) {
        active = accounts.length > 0 ? accounts[0].id : null;
        if (active) await store.setJSON('tiktok_active', active);
        else { try { await store.delete('tiktok_active'); } catch { /* */ } }
      }
    } else {
      return json(400, { error: 'action inválida: ' + action });
    }

    return json(200, { accounts, active, ok: true });
  } catch (e) {
    return json(500, { error: e.message || 'error' });
  }
}

export const config = { path: '/.netlify/functions/tiktok-accounts' };
