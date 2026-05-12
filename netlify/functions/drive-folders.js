// Gestiona carpetas en Google Drive para el workflow de videos de BKDROP.
// Usa Service Account auth (GOOGLE_DRIVE_SA_KEY env var) y crea las
// carpetas bajo una carpeta raíz fija compartida con el SA
// (GOOGLE_DRIVE_ROOT_FOLDER env var).
//
// Endpoints:
// - GET  ?op=ping                          → test conectividad + retorna info raíz
// - GET  ?op=list&folderId=X              → lista archivos de una carpeta
// - POST body { op:'ensure-product-folders', productHandle, productTitle }
//                                         → crea (idempotente) [producto] / {Brutos,Testeo,Escalado}
//                                            devuelve { productFolderId, brutosId, testeoId, escaladoId }
//
// Requiere:
// - GOOGLE_DRIVE_SA_KEY     = JSON completo del Service Account key
// - GOOGLE_DRIVE_ROOT_FOLDER = ID de la carpeta "BKDROP Videos" compartida con el SA

const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }

  const saKey = process.env.GOOGLE_DRIVE_SA_KEY;
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER;
  if (!saKey)        return respond(500, { error: 'Falta GOOGLE_DRIVE_SA_KEY' });
  if (!rootFolderId) return respond(500, { error: 'Falta GOOGLE_DRIVE_ROOT_FOLDER' });

  let credentials;
  try { credentials = JSON.parse(saKey); }
  catch (e) { return respond(500, { error: 'GOOGLE_DRIVE_SA_KEY no es JSON válido: ' + e.message }); }

  try {
    const token = await getAccessToken(credentials);
    const qs = event.queryStringParameters || {};

    if (event.httpMethod === 'GET') {
      const op = qs.op || 'ping';
      if (op === 'ping') {
        // Test: verifica que el SA puede acceder a la carpeta raíz
        const info = await driveGet(token, `files/${rootFolderId}?fields=id,name,mimeType,owners(emailAddress)`);
        return respond(200, { ok: true, root: info, sa: credentials.client_email });
      }
      if (op === 'list') {
        const folderId = qs.folderId;
        if (!folderId) return respond(400, { error: 'Falta folderId' });
        const files = await listFolder(token, folderId);
        return respond(200, { files });
      }
      return respond(400, { error: 'op no válido' });
    }

    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return respond(400, { error: 'JSON inválido' }); }

      if (body.op === 'ensure-product-folders') {
        const handle = (body.productHandle || '').trim();
        const title  = (body.productTitle  || handle).trim();
        if (!handle) return respond(400, { error: 'Falta productHandle' });
        const result = await ensureProductFolders(token, rootFolderId, handle, title);
        return respond(200, result);
      }

      return respond(400, { error: 'op POST no válido' });
    }

    return respond(405, { error: 'Método no permitido' });
  } catch (err) {
    return respond(500, { error: err.message || 'error desconocido' });
  }
};

// ── Auth: obtener access token via JWT firmado ─────────────────────────
async function getAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: credentials.token_uri,
    exp: now + 3600,
    iat: now,
  }));
  const signedInput = header + '.' + payload;
  const sig = crypto.createSign('RSA-SHA256');
  sig.update(signedInput);
  const signature = sig.sign(credentials.private_key, 'base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = signedInput + '.' + signature;

  const resp = await fetch(credentials.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Auth fail: ' + resp.status + ' ' + txt.slice(0, 200));
  }
  const data = await resp.json();
  return data.access_token;
}

function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// ── Drive API helpers ──────────────────────────────────────────────────
async function driveGet(token, path) {
  const resp = await fetch('https://www.googleapis.com/drive/v3/' + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Drive GET ' + path + ': ' + resp.status + ' ' + txt.slice(0, 200));
  }
  return resp.json();
}

async function drivePost(token, path, body) {
  const resp = await fetch('https://www.googleapis.com/drive/v3/' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Drive POST ' + path + ': ' + resp.status + ' ' + txt.slice(0, 200));
  }
  return resp.json();
}

async function listFolder(token, folderId) {
  // Solo archivos NO en papelera, dentro de la carpeta dada
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const fields = encodeURIComponent('files(id,name,mimeType,thumbnailLink,webViewLink,iconLink,createdTime,modifiedTime,size)');
  const data = await driveGet(token, `files?q=${q}&fields=${fields}&pageSize=1000&orderBy=createdTime desc`);
  return data.files || [];
}

async function findChildFolderByName(token, parentId, name) {
  const q = encodeURIComponent(
    `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(/'/g, "\\'")}' and trashed = false`
  );
  const data = await driveGet(token, `files?q=${q}&fields=files(id,name)&pageSize=10`);
  const matches = data.files || [];
  return matches[0] || null;
}

async function createFolder(token, parentId, name) {
  return drivePost(token, 'files?fields=id,name,webViewLink', {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId],
  });
}

// Idempotente: si las carpetas ya existen, las devuelve. Si no, las crea.
async function ensureProductFolders(token, rootId, handle, title) {
  // Nombre de carpeta del producto: usa title si está, sino el handle.
  // Trim a 100 chars por seguridad (Drive permite más pero queremos legible).
  const productFolderName = (title || handle).slice(0, 100);

  // 1. Buscar o crear carpeta del producto bajo la raíz
  let productFolder = await findChildFolderByName(token, rootId, productFolderName);
  if (!productFolder) {
    productFolder = await createFolder(token, rootId, productFolderName);
  }

  // 2. Buscar o crear las 3 subcarpetas
  const subnames = ['1 - Brutos', '2 - Testeo', '3 - Escalado'];
  const subs = {};
  for (const subname of subnames) {
    let sub = await findChildFolderByName(token, productFolder.id, subname);
    if (!sub) {
      sub = await createFolder(token, productFolder.id, subname);
    }
    subs[subname] = sub;
  }

  return {
    productFolder: { id: productFolder.id, name: productFolder.name },
    brutosId:   subs['1 - Brutos'].id,
    testeoId:   subs['2 - Testeo'].id,
    escaladoId: subs['3 - Escalado'].id,
    handle,
    title: productFolderName,
  };
}

// ── Helpers HTTP ───────────────────────────────────────────────────────
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
