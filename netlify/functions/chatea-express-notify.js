// Post-confirmacion Express: agrega tag y (opcional) envia mensaje al cliente.
// SOP referencia: seccion 1.1 + 5.2.
//
// Uso:
//   POST /.netlify/functions/chatea-express-notify
//   Body: {
//     user_ns: "f227799u850358277",     // requerido
//     tag: "[App] Confirmacion express", // opcional (default: este)
//     sendMessage: true,                  // opcional (default: false)
//     message: "..."                     // opcional (default: mensaje cortesia)
//   }
//
// Endpoints Chatea Pro usados:
//   POST /flow/create-tag {name}                        (idempotente: si existe, ok)
//   POST /subscriber/add-tags-by-name {user_ns, data}
//   POST /subscriber/send-text {user_ns, text}
//
// LIMITACION: send-text solo funciona dentro de la ventana 24h de WhatsApp.
// Si el cliente NO ha escrito en las ultimas 20h (margen), el mensaje falla.
// En ese caso devolvemos el error de Chatea sin propagarlo como falla del
// endpoint entero (el tag ya se agrego).

const CHATEA_BASE = 'https://chateapro.app/api';
const USER_AGENT  = 'BKDROP-Sync/1.0 curl/8.9.0';
const DEFAULT_TAG = '[App] Confirmacion express';
const DEFAULT_MSG = 'Hola! Tu pedido quedo confirmado. Si necesitas cambiar algo, escribenos aca. Gracias!';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const token = process.env.CHATEA_PRO_TOKEN;
  if (!token) return respond(500, { error: 'Falta CHATEA_PRO_TOKEN' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON invalido' }); }

  const user_ns = body.user_ns;
  if (!user_ns) return respond(400, { error: 'user_ns requerido' });

  const tagName = (body.tag || DEFAULT_TAG).slice(0, 60);
  const sendMessage = body.sendMessage === true;
  const message = (body.message || DEFAULT_MSG).slice(0, 1000);

  const result = { user_ns, tag: null, message: null };

  // Paso 1: asegurar que el tag existe (idempotente).
  try {
    await chateaPost('/flow/create-tag', { name: tagName }, token);
    // Si el tag ya existia, Chatea puede devolver error; lo ignoramos.
  } catch (_) { /* tag ya existe, seguir */ }

  // Paso 2: agregar tag al subscriber.
  try {
    const tagResp = await chateaPost('/subscriber/add-tags-by-name', {
      user_ns,
      data: [{ tag_name: tagName }],
    }, token);
    result.tag = { ok: true, response: tagResp };
  } catch (err) {
    result.tag = { ok: false, error: err.message || 'unknown' };
  }

  // Paso 3 (opcional): enviar mensaje.
  if (sendMessage) {
    try {
      const msgResp = await chateaPost('/subscriber/send-text', {
        user_ns,
        text: message,
      }, token);
      result.message = { ok: true, response: msgResp };
    } catch (err) {
      // Fuera de ventana 24h u otro error de send: NO falla el endpoint entero.
      result.message = { ok: false, error: err.message || 'unknown' };
    }
  }

  // Si el tag fallo Y no mandamos mensaje, es un failure real.
  const failed = !result.tag.ok && !sendMessage;
  return respond(failed ? 502 : 200, {
    ok: !failed,
    ...result,
    notifiedAt: new Date().toISOString(),
  });
};

async function chateaPost(pathname, body, token) {
  const resp = await fetch(CHATEA_BASE + pathname, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const txt = await resp.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 300) }; }

  // Rate limit encubierto (200 con message "Too Many Attempts")
  if (data && typeof data.message === 'string' && /too many attempts/i.test(data.message)) {
    throw new Error('Rate limit Chatea');
  }
  if (!resp.ok) {
    throw new Error('Chatea ' + pathname + ' HTTP ' + resp.status + ': ' + (data.message || txt.slice(0, 200)));
  }
  return data;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
