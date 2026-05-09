// Lectura/escritura de templates Shopify (Online Store 2.0 JSON) y
// upload de archivos al Files library global. Multi-tenant chile/gt.
//
// - GET  ?op=list                      → lista todos los themes (id, name, role)
// - GET  ?op=template&handle=foo       → lee templates/product.foo.json del theme MAIN
// - GET  ?op=template&assetKey=...     → lee cualquier asset del theme MAIN
// - GET  ?op=list-templates            → lista todos los templates product.*.json del MAIN
// - PUT  body { assetKey, value }      → escribe un asset al theme MAIN (requiere write_themes)
// - POST body { op:'upload-file', filename, mimeType, attachment(base64) }
//                                      → sube archivo al Files library (GraphQL stagedUploadsCreate + fileCreate)
//
// Requiere read_themes (+ write_themes para PUT, write_files para upload).

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

    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return respond(400, { error: 'JSON inválido' }); }
      if (body.op === 'upload-file') {
        if (!body.filename || !body.attachment) {
          return respond(400, { error: 'Falta filename o attachment(base64)' });
        }
        return await uploadFile(domain, headers, body);
      }
      return respond(400, { error: 'op POST no válido' });
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

// Upload a file al Files library global de Shopify. Flujo GraphQL en 3 pasos:
// 1. stagedUploadsCreate → URL pre-firmada (GCS o S3) + parameters
// 2. POST multipart al URL pre-firmada con el archivo binario
// 3. fileCreate → registra el archivo en Files
async function uploadFile(domain, headers, body) {
  const filename = body.filename;
  const mimeType = body.mimeType || 'image/jpeg';
  const fileBuffer = Buffer.from(body.attachment, 'base64');
  const fileSize = String(fileBuffer.length);

  const gqlUrl = `https://${domain}/admin/api/2024-10/graphql.json`;

  // Paso 1: stagedUploadsCreate
  const stageQuery = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }
  `;
  const stageResp = await fetch(gqlUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: stageQuery,
      variables: { input: [{ filename, mimeType, httpMethod: 'POST', resource: 'IMAGE', fileSize }] },
    }),
  });
  if (!stageResp.ok) {
    const txt = await stageResp.text();
    return respond(stageResp.status, { error: 'GraphQL stage ' + stageResp.status + ': ' + txt.slice(0, 300) });
  }
  const stageData = await stageResp.json();
  if (stageData.errors) {
    return respond(500, { error: 'GraphQL errors: ' + JSON.stringify(stageData.errors).slice(0, 300) });
  }
  const stage = stageData.data && stageData.data.stagedUploadsCreate;
  if (stage && stage.userErrors && stage.userErrors.length) {
    return respond(500, { error: 'Stage userErrors: ' + JSON.stringify(stage.userErrors).slice(0, 300) });
  }
  const target = stage && stage.stagedTargets && stage.stagedTargets[0];
  if (!target) return respond(500, { error: 'No staged target devuelto por Shopify' });

  // Paso 2: POST multipart al staged URL
  const formData = new FormData();
  for (const param of target.parameters) {
    formData.append(param.name, param.value);
  }
  // Importante: 'file' debe ser el ÚLTIMO field en el multipart
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), filename);

  const uploadResp = await fetch(target.url, {
    method: 'POST',
    body: formData,
    // sin headers custom: fetch genera Content-Type: multipart/form-data; boundary=...
  });
  if (!uploadResp.ok && uploadResp.status !== 201) {
    const txt = await uploadResp.text();
    return respond(uploadResp.status, { error: 'Upload staged ' + uploadResp.status + ': ' + txt.slice(0, 300) });
  }

  // Paso 3: fileCreate
  const createQuery = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          ... on MediaImage {
            id alt fileStatus createdAt
            image { url width height altText }
          }
          ... on GenericFile { id fileStatus url }
        }
        userErrors { field message }
      }
    }
  `;
  const createResp = await fetch(gqlUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: createQuery,
      variables: {
        files: [{ alt: body.alt || filename, contentType: 'IMAGE', originalSource: target.resourceUrl }],
      },
    }),
  });
  if (!createResp.ok) {
    const txt = await createResp.text();
    return respond(createResp.status, { error: 'GraphQL create ' + createResp.status + ': ' + txt.slice(0, 300) });
  }
  const createData = await createResp.json();
  if (createData.errors) {
    return respond(500, { error: 'GraphQL create errors: ' + JSON.stringify(createData.errors).slice(0, 300) });
  }
  const fc = createData.data && createData.data.fileCreate;
  if (fc && fc.userErrors && fc.userErrors.length) {
    return respond(500, { error: 'Create userErrors: ' + JSON.stringify(fc.userErrors).slice(0, 300) });
  }
  const file = fc && fc.files && fc.files[0];
  if (!file) return respond(500, { error: 'fileCreate no devolvió archivo' });

  // Construir referencia shopify://shop_images/<filename> usando el filename
  // que enviamos. Shopify lo preserva (puede agregarle un suffix si hay
  // colisión, pero en esos casos image.url es la fuente de verdad).
  const cdnUrl = file.image && file.image.url;
  let derivedFilename = filename;
  if (cdnUrl) {
    const m = cdnUrl.match(/\/files\/([^?]+)/);
    if (m) derivedFilename = decodeURIComponent(m[1]);
  }
  const shopifyRef = 'shopify://shop_images/' + derivedFilename;

  return respond(200, {
    file,
    filename: derivedFilename,
    cdnUrl: cdnUrl || null,
    shopifyRef,
  });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
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
