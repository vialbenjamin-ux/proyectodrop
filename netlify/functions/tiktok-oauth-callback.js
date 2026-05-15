// TikTok Marketing API OAuth callback.
// Flow: usuario hace click en "Conectar TikTok" en BKDROP → es redirigido a TikTok
// auth URL → autoriza → TikTok redirige acá con ?code=XXX&state=YYY.
// Acá intercambiamos el code por un access_token usando el secret del backend
// (que NUNCA viaja al cliente) y devolvemos un HTML que guarda el token en
// localStorage del frontend y redirige a la pestaña de TikTok Ads.

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const code = params.code || params.auth_code;
  const errorMsg = params.error || params.error_description;

  if (errorMsg) {
    return renderHtml('Error al autorizar TikTok', `<p>TikTok devolvió un error: <b>${escapeHtml(errorMsg)}</b></p><p>Intentá de nuevo desde BKDROP.</p>`);
  }
  if (!code) {
    return renderHtml('Falta el código de autorización', '<p>TikTok no envió el parámetro <code>code</code>. Reintentá la conexión desde BKDROP.</p>');
  }

  const appId  = process.env.TIKTOK_APP_ID;
  const secret = process.env.TIKTOK_APP_SECRET;
  if (!appId || !secret) {
    return renderHtml('Faltan credenciales', '<p>El servidor no tiene <code>TIKTOK_APP_ID</code> y/o <code>TIKTOK_APP_SECRET</code> configuradas.</p>');
  }

  try {
    const resp = await fetch('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, secret, auth_code: code }),
    });
    const data = await resp.json();

    // Estructura típica: { code: 0, message: "OK", data: { access_token, scope: [...], advertiser_ids: [...], ... } }
    if (!resp.ok || data.code !== 0 || !data.data || !data.data.access_token) {
      const msg = (data && (data.message || JSON.stringify(data))) || ('HTTP ' + resp.status);
      return renderHtml('No se pudo obtener el token', `<p>TikTok respondió:</p><pre>${escapeHtml(msg).slice(0,500)}</pre>`);
    }

    const payload = {
      access_token: data.data.access_token,
      advertiser_ids: data.data.advertiser_ids || [],
      scope: data.data.scope || [],
      connected_at: new Date().toISOString(),
    };

    // Embebemos el JSON en el HTML para que el frontend lo persista.
    // Usamos JSON.stringify dos veces para escapar bien dentro del <script>.
    const embedded = JSON.stringify(payload);
    const safeEmbedded = embedded.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

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
    var payload = ${safeEmbedded};
    localStorage.setItem('bkdrop_tiktok_auth', JSON.stringify(payload));
    // Volver a BKDROP con un flag para que el frontend sepa que se conectó
    setTimeout(function(){
      location.replace('/#reportes-tiktok-conectado');
    }, 1500);
  } catch (e) {
    document.getElementById('msg').textContent = 'Error guardando token: ' + (e.message || e);
  }
})();
</script>
</body></html>`;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: html,
    };
  } catch (err) {
    return renderHtml('Error de red', `<p>No pudimos contactar TikTok: <code>${escapeHtml(err.message || 'error')}</code></p>`);
  }
};

function renderHtml(title, bodyHtml) {
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
  return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html };
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
