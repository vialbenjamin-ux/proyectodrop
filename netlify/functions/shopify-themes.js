// Lectura/escritura de templates Shopify (Online Store 2.0 JSON).
// Multi-tenant chile/gt.
//
// - GET  ?op=list                      → lista todos los themes (id, name, role)
// - GET  ?op=template&handle=foo       → lee templates/product.foo.json del theme MAIN
// - GET  ?op=template&assetKey=...     → lee cualquier asset del theme MAIN
// - GET  ?op=list-templates            → lista todos los templates product.*.json del MAIN
// - PUT  body { assetKey, value }      → escribe un asset al theme MAIN (requiere write_themes)
//
// Requiere read_themes (+ write_themes para PUT) en el SHOPIFY_TOKEN.

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }

  const qs = event.queryStringParameters || {};
  const tenant = String((qs.tenant || 'chile')).toLowerCase();
  const isGT = (tenant === 'gt');
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;

  if (!token || !domain) {
    return respond(500, { error: 'Faltan credenciales Shopify' + (isGT ? ' GT' : '') });
  }

  const headers = {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  try {
    if (event.httpMethod === 'GET') {
      const op = qs.op || 'list';
      if (op === 'list') return await listThemes(domain, headers);
      if (op === 'list-templates') return await listProductTemplates(domain, headers);
      if (op === 'template') {
        const assetKey = qs.assetKey
          || (qs.handle ? 'templates/product.' + qs.handle + '.json' : null);
        if (!assetKey) return respond(400, { error: 'Falta handle o assetKey' });
        return await readAsset(domain, headers, assetKey);
      }
      return respond(400, { error: 'op no válido (list, list-templates, template)' });
    }

    if (event.httpMethod === 'PUT') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return respond(400, { error: 'JSON inválido' }); }
      if (!body.assetKey || typeof body.value !== 'string') {
        return respond(400, { error: 'Falta assetKey o value (string)' });
      }
      return await writeAsset(domain, headers, body.assetKey, body.value);
    }

    return respond(405, { error: 'Método no permitido' });
  } catch (err) {
    return respond(502, { error: err.message || 'error desconocido' });
  }
};

async function listThemes(domain, headers) {
  const url = `https://${domain}/admin/api/2024-10/themes.json`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const txt = await resp.text();
    return respond(resp.status, { error: 'Shopify ' + resp.status + ': ' + txt.slice(0, 300) });
  }
  const data = await resp.json();
  const themes = (data.themes || []).map(t => ({
    id: t.id, name: t.name, role: t.role, theme_store_id: t.theme_store_id,
    previewable: t.previewable, processing: t.processing, updated_at: t.updated_at,
  }));
  return respond(200, { themes });
}

async function getMainThemeId(domain, headers) {
  const url = `https://${domain}/admin/api/2024-10/themes.json?role=main`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('No se pudo listar themes: ' + resp.status + ' ' + txt.slice(0, 200));
  }
  const data = await resp.json();
  const main = (data.themes || []).find(t => t.role === 'main');
  if (!main) throw new Error('No hay theme con role=main');
  return main.id;
}

async function listProductTemplates(domain, headers) {
  const themeId = await getMainThemeId(domain, headers);
  const url = `https://${domain}/admin/api/2024-10/themes/${themeId}/assets.json`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const txt = await resp.text();
    return respond(resp.status, { error: 'Shopify ' + resp.status + ': ' + txt.slice(0, 300) });
  }
  const data = await resp.json();
  const templates = (data.assets || [])
    .filter(a => /^templates\/product\..+\.json$/.test(a.key))
    .map(a => ({
      key: a.key,
      handle: a.key.replace(/^templates\/product\./, '').replace(/\.json$/, ''),
      updated_at: a.updated_at,
      size: a.size,
    }))
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return respond(200, { themeId, templates, total: templates.length });
}

async function readAsset(domain, headers, assetKey) {
  const themeId = await getMainThemeId(domain, headers);
  const url = `https://${domain}/admin/api/2024-10/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(assetKey)}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const txt = await resp.text();
    return respond(resp.status, { error: 'Shopify ' + resp.status + ': ' + txt.slice(0, 300) });
  }
  const data = await resp.json();
  const asset = data.asset || {};
  return respond(200, {
    themeId,
    key: asset.key,
    value: asset.value,
    updated_at: asset.updated_at,
    size: asset.size,
  });
}

async function writeAsset(domain, headers, assetKey, value) {
  const themeId = await getMainThemeId(domain, headers);
  const url = `https://${domain}/admin/api/2024-10/themes/${themeId}/assets.json`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ asset: { key: assetKey, value } }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    return respond(resp.status, { error: 'Shopify ' + resp.status + ': ' + txt.slice(0, 400) });
  }
  const data = await resp.json();
  return respond(200, { themeId, asset: data.asset, ok: true });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...cors() },
    body: JSON.stringify(payload),
  };
}
