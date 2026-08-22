// Endpoint OAuth callback para instalar la app BKDROPGT en la tienda GT.
// Captura el code de OAuth, hace el exchange con Shopify y muestra el
// access_token en pantalla para copiarlo a Netlify env vars.
//
// Requiere env vars en Netlify:
//   SHOPIFY_GT_CLIENT_ID
//   SHOPIFY_GT_CLIENT_SECRET
//
// TEMPORAL: borrar despues de obtener el token.

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const code = qs.code;
  const shop = qs.shop;

  const clientId = process.env.SHOPIFY_GT_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_GT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return html(
      '<h1>❌ Faltan env vars</h1>' +
      '<p>Configura en Netlify Site Settings → Environment Variables:</p>' +
      '<ul><li><code>SHOPIFY_GT_CLIENT_ID</code></li><li><code>SHOPIFY_GT_CLIENT_SECRET</code></li></ul>'
    );
  }

  if (!shop) {
    return html('<h1>Error: falta parametro shop</h1><pre>' + escapeHtml(JSON.stringify(qs, null, 2)) + '</pre>');
  }

  if (!code) {
    return html(
      '<h1>⚠️ Shopify no envio el codigo OAuth</h1>' +
      '<p>Esto pasa cuando la app YA esta instalada. Para forzar OAuth nuevo:</p>' +
      '<ol>' +
      '<li>Anda a <a href="https://admin.shopify.com/store/85yz4u-q5/settings/apps/installed">admin.shopify.com/store/85yz4u-q5/settings/apps/installed</a></li>' +
      '<li>Desinstala <b>BKDROPGT</b> (3 puntos ⋯ → Desinstalar)</li>' +
      '<li>Volve al dev dashboard y clic <b>Instalar app</b></li>' +
      '</ol>' +
      '<p style="color:#888;font-size:11px">Params recibidos:</p>' +
      '<pre>' + escapeHtml(JSON.stringify(qs, null, 2)) + '</pre>'
    );
  }

  try {
    const resp = await fetch('https://' + shop + '/admin/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: code }),
    });
    const data = await resp.json();

    if (!resp.ok) {
      return html(
        '<h1>❌ Error del exchange (HTTP ' + resp.status + ')</h1>' +
        '<pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>'
      );
    }

    const token = data.access_token || '(sin token)';
    const scopes = data.scope || '(sin scopes)';

    return html(
      '<h1 style="color:#D4A542">✅ Token obtenido</h1>' +
      '<p><b>Copialo y pegalo en el chat:</b></p>' +
      '<textarea readonly onclick="this.select();this.setSelectionRange(0,999)" ' +
      'style="width:100%;height:80px;font-family:monospace;font-size:16px;padding:12px;' +
      'border:2px solid #D4A542;border-radius:8px;background:#FCF2D6;color:#111">' +
      escapeHtml(token) + '</textarea>' +
      '<p style="margin-top:20px"><b>Scopes:</b> <code style="background:#eee;padding:4px 8px;border-radius:4px">' +
      escapeHtml(scopes) + '</code></p>' +
      '<p><b>Tienda:</b> <code>' + escapeHtml(shop) + '</code></p>'
    );
  } catch (err) {
    return html('<h1>❌ Error de red</h1><p>' + escapeHtml(err.message || 'unknown') + '</p>');
  }
};

function html(body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<!DOCTYPE html><html><head><meta charset="utf-8"><title>BKDROP GT OAuth</title></head>' +
      '<body style="font-family:system-ui,sans-serif;padding:40px;max-width:800px;margin:0 auto;background:#F7F4F0;color:#2D2A26">' +
      body + '</body></html>',
  };
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
