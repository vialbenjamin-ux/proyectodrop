// TikTok Marketing API OAuth callback (Netlify Functions v2).
// Flow: usuario hace click en "Conectar TikTok" en BKDROP → es redirigido a TikTok
// auth URL → autoriza → TikTok redirige acá con ?code=XXX&state=YYY.
// Intercambiamos el code por un access_token usando el secret del backend
// (que NUNCA viaja al cliente) y lo guardamos en Netlify Blobs ('bk-tokens')
// para que sea compartido entre browsers (AdsPower / Chrome normal).
//
// Multi-cuenta: cada conexión genera un id 'acct_<ts>' y se guarda en
//   tiktok_auth_<id>  → { access_token, advertiser_ids, scope, connected_at }
// El índice 'tiktok_accounts' lista todas las cuentas {id, label, advertiser_ids,
// connected_at} y 'tiktok_active' apunta a la activa. Si el usuario reconecta
// con los mismos advertisers, se actualiza el token de esa entrada (no duplica).
// Migración: si existe legacy 'tiktok_auth' y el índice está vacío, se agrega
// como "Cuenta 1" en el primer connect post-deploy.

import { getStore } from '@netlify/blobs';

export default async function handler(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code') || url.searchParams.get('auth_code');
  const errorMsg = url.searchParams.get('error') || url.searchParams.get('error_description');

  if (errorMsg) {
    return htmlResponse('Error al autorizar TikTok', `<p>TikTok devolvió un error: <b>${escapeHtml(errorMsg)}</b></p><p>Intentá de nuevo desde BKDROP.</p>`);
  }
  if (!code) {
    return htmlResponse('Falta el código de autorización', '<p>TikTok no envió el parámetro <code>code</code>. Reintentá la conexión desde BKDROP.</p>');
  }

  const appId  = process.env.TIKTOK_APP_ID;
  const secret = process.env.TIKTOK_APP_SECRET;
  if (!appId || !secret) {
    return htmlResponse('Faltan credenciales', '<p>El servidor no tiene <code>TIKTOK_APP_ID</code> y/o <code>TIKTOK_APP_SECRET</code> configuradas.</p>');
  }

  try {
    const resp = await fetch('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, secret, auth_code: code }),
    });
    const data = await resp.json();

    if (!resp.ok || data.code !== 0 || !data.data || !data.data.access_token) {
      const msg = (data && (data.message || JSON.stringify(data))) || ('HTTP ' + resp.status);
      return htmlResponse('No se pudo obtener el token', `<p>TikTok respondió:</p><pre>${escapeHtml(msg).slice(0,500)}</pre>`);
    }

    const payload = {
      access_token: data.data.access_token,
      advertiser_ids: data.data.advertiser_ids || [],
      scope: data.data.scope || [],
      connected_at: new Date().toISOString(),
    };

    let activeId = null;
    try {
      const store = getStore({ name: 'bk-tokens', consistency: 'strong' });

      // 1) Cargar índice de cuentas (o []), y migrar legacy si corresponde.
      let accounts = (await store.get('tiktok_accounts', { type: 'json' })) || [];
      if (accounts.length === 0) {
        const legacy = await store.get('tiktok_auth', { type: 'json' });
        if (legacy && legacy.access_token) {
          const legacyId = 'acct_' + (legacy.connected_at ? new Date(legacy.connected_at).getTime() : Date.now()) + '_legacy';
          await store.setJSON('tiktok_auth_' + legacyId, legacy);
          accounts.push({
            id: legacyId,
            label: 'Cuenta 1',
            advertiser_ids: legacy.advertiser_ids || [],
            connected_at: legacy.connected_at || new Date().toISOString(),
          });
        }
      }

      // 2) ¿Esta conexión coincide con una cuenta existente (mismos advertisers)?
      const sameSet = (a, b) => {
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length || a.length === 0) return false;
        const sa = [...a].sort(), sb = [...b].sort();
        return sa.every((x, i) => x === sb[i]);
      };
      const existing = accounts.find(c => sameSet(c.advertiser_ids, payload.advertiser_ids));

      if (existing) {
        // Refrescar token y connected_at de esa entrada.
        await store.setJSON('tiktok_auth_' + existing.id, payload);
        existing.connected_at = payload.connected_at;
        activeId = existing.id;
      } else {
        // Nueva cuenta.
        const newId = 'acct_' + Date.now();
        await store.setJSON('tiktok_auth_' + newId, payload);
        accounts.push({
          id: newId,
          label: 'Cuenta ' + (accounts.length + 1),
          advertiser_ids: payload.advertiser_ids,
          connected_at: payload.connected_at,
        });
        activeId = newId;
      }

      // 3) Persistir índice + activa. Mantenemos legacy 'tiktok_auth' como
      // fallback de solo lectura (no rompemos llamadas en vuelo).
      await store.setJSON('tiktok_accounts', accounts);
      await store.setJSON('tiktok_active', activeId);
      await store.setJSON('tiktok_auth', payload); // mantener legacy actualizado por seguridad
    } catch (e) {
      return htmlResponse('No se pudo guardar el token', `<p>Falló el storage del servidor: <code>${escapeHtml(e.message || 'error')}</code></p>`);
    }

    // Marca local en el browser (sin el token) para evitar pegarle al server en el first load.
    const meta = JSON.stringify({
      advertiser_ids: payload.advertiser_ids,
      connected_at: payload.connected_at,
      active_id: activeId,
    });
    const safeMeta = meta.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Conectando TikTok…</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1115;color:#e5e7eb;margin:0;padding:40px 20px;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
  .card{max-width:480px;background:#1a1d23;padding:32px 28px;border-radius:14px;border:1px solid #2a2f38}
  h1{font-size:20px;margin:0 0 12px;color:#fe2c55}
  p{font-size:14px;line-height:1.6;color:#9ca3af}
  .ok{color:#22c55e;font-weight:700}
</style>
</head><body>
<div class="card">
  <h1>🎉 TikTok conectado</h1>
  <p class="ok">Guardando autorización…</p>
  <p id="msg">En 2 segundos te redirigimos a BKDROP.</p>
</div>
<script>
(function(){
  try {
    var meta = ${safeMeta};
    // Si reconectaste con otra cuenta, el advertiser_id viejo ya no sirve.
    // Limpiar el cache obliga a que las vistas re-detecten desde el server.
    localStorage.removeItem('bkdrop_tiktok_advertiser');
    localStorage.setItem('bkdrop_tiktok_connected', JSON.stringify(meta));
    setTimeout(function(){ location.replace('/#reportes-tiktok-conectado'); }, 1500);
  } catch (e) {
    document.getElementById('msg').textContent = 'Error: ' + (e.message || e);
  }
})();
</script>
</body></html>`;

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    return htmlResponse('Error de red', `<p>No pudimos contactar TikTok: <code>${escapeHtml(err.message || 'error')}</code></p>`);
  }
}

function htmlResponse(title, bodyHtml) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1115;color:#e5e7eb;margin:0;padding:40px 20px;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{max-width:540px;background:#1a1d23;padding:32px 28px;border-radius:14px;border:1px solid #2a2f38;text-align:center}
  h1{font-size:20px;margin:0 0 14px;color:#fe2c55}
  p{font-size:14px;line-height:1.6;color:#cbd5e1;margin:8px 0}
  pre{background:#0f1115;padding:12px;border-radius:8px;overflow-x:auto;text-align:left;font-size:12px;color:#fca5a5}
  a{color:#fe2c55}
</style>
</head><body>
<div class="card">
  <h1>${escapeHtml(title)}</h1>
  ${bodyHtml}
  <p><a href="/">← Volver a BKDROP</a></p>
</div>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export const config = { path: '/.netlify/functions/tiktok-oauth-callback' };
