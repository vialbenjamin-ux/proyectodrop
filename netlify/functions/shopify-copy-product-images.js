// Copia las imagenes de PRODUCTO (carrusel principal en la pagina Shopify)
// desde un producto en un tenant hacia otro producto en otro tenant.
// Aplica al flujo "Replicar landing CL -> GT" para completar las imagenes
// del producto en GT (el clonarImagenesDelTemplate solo cubre las que estan
// EN EL TEMPLATE JSON, no las del product.images).
//
// POST /.netlify/functions/shopify-copy-product-images
// Body:
//   {
//     source_product_id: "123",
//     target_product_id: "456",
//     source_tenant: "chile",         // default: chile
//     target_tenant: "gt",            // default: gt
//     mode: "if_empty" | "replace"    // default: if_empty (skip si target ya tiene)
//   }
//
// Respuesta:
//   { ok, sourceCount, targetHadCount, uploaded: [...], skipped: [...], errors: [...] }
//
// Notas:
//   - Usamos image.src (URL CDN de Shopify) - Shopify descarga y guarda solo.
//     No hace falta base64 ni descarga previa.
//   - Preservamos position y alt.

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON invalido' }); }

  const sourceId = String(body.source_product_id || '').trim();
  const targetId = String(body.target_product_id || '').trim();
  const sourceTenant = String(body.source_tenant || 'chile').toLowerCase();
  const targetTenant = String(body.target_tenant || 'gt').toLowerCase();
  const mode = String(body.mode || 'if_empty').toLowerCase();

  if (!sourceId) return respond(400, { error: 'Falta source_product_id' });
  if (!targetId) return respond(400, { error: 'Falta target_product_id' });
  if (!['if_empty', 'replace'].includes(mode)) return respond(400, { error: 'mode invalido' });

  const sourceCreds = credsForTenant(sourceTenant);
  const targetCreds = credsForTenant(targetTenant);
  if (!sourceCreds) return respond(500, { error: 'Faltan credenciales Shopify source (' + sourceTenant + ')' });
  if (!targetCreds) return respond(500, { error: 'Faltan credenciales Shopify target (' + targetTenant + ')' });

  try {
    // 1. Fetch imagenes del source
    const sImgR = await fetch('https://' + sourceCreds.domain + '/admin/api/2024-10/products/' + sourceId + '/images.json', {
      headers: { 'X-Shopify-Access-Token': sourceCreds.token }
    });
    if (!sImgR.ok) return respond(502, { error: 'Fetch imagenes source: ' + sImgR.status });
    const sImgData = await sImgR.json();
    const sourceImages = sImgData.images || [];

    // 2. Fetch imagenes del target (para decidir mode)
    const tImgR = await fetch('https://' + targetCreds.domain + '/admin/api/2024-10/products/' + targetId + '/images.json', {
      headers: { 'X-Shopify-Access-Token': targetCreds.token }
    });
    if (!tImgR.ok) return respond(502, { error: 'Fetch imagenes target: ' + tImgR.status });
    const tImgData = await tImgR.json();
    const targetImages = tImgData.images || [];

    // 3. Decidir accion segun mode
    if (mode === 'if_empty' && targetImages.length > 0) {
      return respond(200, {
        ok: true,
        sourceCount: sourceImages.length,
        targetHadCount: targetImages.length,
        uploaded: [],
        skipped: sourceImages.map(i => i.src),
        message: 'Target ya tiene ' + targetImages.length + ' imagenes. Mode=if_empty -> skip.',
      });
    }

    // Si mode=replace, borrar las existentes primero
    const deleted = [];
    if (mode === 'replace') {
      for (const img of targetImages) {
        try {
          const delR = await fetch('https://' + targetCreds.domain + '/admin/api/2024-10/products/' + targetId + '/images/' + img.id + '.json', {
            method: 'DELETE',
            headers: { 'X-Shopify-Access-Token': targetCreds.token }
          });
          if (delR.ok) deleted.push(img.id);
        } catch (_) { /* seguir */ }
        await sleep(200);
      }
    }

    // 4. Copiar cada imagen source al target
    const uploaded = [];
    const errors = [];
    for (const img of sourceImages) {
      try {
        const uploadBody = {
          image: {
            src: img.src,
            alt: img.alt || '',
            position: img.position || undefined,
          },
        };
        const upR = await fetch('https://' + targetCreds.domain + '/admin/api/2024-10/products/' + targetId + '/images.json', {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': targetCreds.token, 'Content-Type': 'application/json' },
          body: JSON.stringify(uploadBody),
        });
        const upData = await upR.json().catch(() => ({}));
        if (!upR.ok) {
          errors.push({ src: img.src, status: upR.status, error: (upData.errors || upData.error || 'HTTP ' + upR.status) });
        } else {
          uploaded.push({ src: img.src, newId: upData.image?.id, position: upData.image?.position });
        }
        await sleep(300); // rate limit safety
      } catch (err) {
        errors.push({ src: img.src, error: err.message || 'unknown' });
      }
    }

    return respond(200, {
      ok: errors.length === 0,
      sourceCount: sourceImages.length,
      targetHadCount: targetImages.length,
      uploaded,
      deleted,
      errors,
    });
  } catch (err) {
    return respond(502, { error: err.message || 'unknown' });
  }
};

function credsForTenant(t) {
  const isGT = t === 'gt';
  const token  = isGT ? process.env.SHOPIFY_TOKEN_GT  : process.env.SHOPIFY_TOKEN;
  const domain = isGT ? process.env.SHOPIFY_DOMAIN_GT : process.env.SHOPIFY_DOMAIN;
  if (!token || !domain) return null;
  return { token, domain };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function respond(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify(payload) };
}
