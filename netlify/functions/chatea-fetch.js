// Fetch subscribers + mensajes desde Chatea Pro (uChat).
// SOP referencia: seccion 1.1 (conexion).
// - Base: https://chateapro.app/api
// - Auth: Authorization: Bearer <CHATEA_PRO_TOKEN>
// - User-Agent obligatorio o 403.
// - Rate limit: 1000/h. OJO: a veces el 429 llega como HTTP 200 con body
//   { "message": "Too Many Attempts." } — verificar body ademas del status.
//
// Modos:
//   ?op=subscribers&page=N          → GET /subscribers?limit=100&page=N
//   ?op=messages&user_ns=X          → GET /subscriber/chat-messages?user_ns=X&include_bot=1&limit=100
//
// Respuesta:
//   subscribers: { subscribers: [...], page, count, hasMore, quotaWarn }
//   messages:    { messages: [...], count, user_ns, quotaWarn }

const CHATEA_BASE = 'https://chateapro.app/api';
const USER_AGENT  = 'BKDROP-Sync/1.0 curl/8.9.0';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const token = process.env.CHATEA_PRO_TOKEN;
  if (!token) return respond(500, { error: 'Falta CHATEA_PRO_TOKEN en env' });

  const qs = event.queryStringParameters || {};
  const op = (qs.op || 'subscribers').toLowerCase();

  try {
    if (op === 'subscribers') {
      const page = Math.max(parseInt(qs.page || '1', 10), 1);
      const url = CHATEA_BASE + '/subscribers?limit=100&page=' + page;
      const { data, quotaWarn } = await chateaGet(url, token);
      const subs = extractList(data);
      return respond(200, {
        subscribers: subs.map(compactSubscriber),
        page,
        count: subs.length,
        hasMore: subs.length === 100,
        quotaWarn,
        fetchedAt: new Date().toISOString(),
      });
    }

    if (op === 'messages') {
      const user_ns = qs.user_ns;
      if (!user_ns) return respond(400, { error: 'Falta user_ns' });
      const limit = Math.min(parseInt(qs.limit || '100', 10), 100);
      const url = CHATEA_BASE + '/subscriber/chat-messages'
        + '?user_ns=' + encodeURIComponent(user_ns)
        + '&include_bot=1&limit=' + limit;
      const { data, quotaWarn } = await chateaGet(url, token);
      const list = extractList(data);
      return respond(200, {
        messages: list.map(compactMessage),
        count: list.length,
        user_ns,
        quotaWarn,
        fetchedAt: new Date().toISOString(),
      });
    }

    return respond(400, { error: 'op invalido. Valores: subscribers | messages' });
  } catch (err) {
    return respond(502, { error: 'Chatea fetch fail: ' + (err.message || 'unknown') });
  }
};

// Wrapper con deteccion de rate limit encubierto (200 con body Too Many Attempts).
async function chateaGet(url, token) {
  const resp = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
  });

  const txt = await resp.text();
  let data;
  try { data = JSON.parse(txt); }
  catch { throw new Error('Chatea non-JSON response: ' + txt.slice(0, 200)); }

  // El SOP marca que a veces 200 llega con "Too Many Attempts" en el body
  if (data && typeof data.message === 'string' && /too many attempts/i.test(data.message)) {
    throw new Error('Rate limit Chatea (Too Many Attempts, en body 200)');
  }

  if (!resp.ok) {
    const msg = (data && data.message) || txt.slice(0, 200);
    throw new Error('Chatea API ' + resp.status + ': ' + msg);
  }

  return { data, quotaWarn: false };
}

function extractList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.subscribers)) return data.subscribers;
  if (data && Array.isArray(data.messages)) return data.messages;
  return [];
}

function compactSubscriber(s) {
  return {
    user_ns: s.user_ns || s.id || null,
    phone: s.phone || s.whatsapp || null,
    name: (s.first_name || '') + (s.last_name ? ' ' + s.last_name : '') || s.name || '',
    last_interaction: s.last_interaction || s.last_seen || s.updated_at || null,
    tags: Array.isArray(s.tags) ? s.tags.map(t => t.name || t) : [],
    labels: Array.isArray(s.labels) ? s.labels.map(l => l.name || l) : [],
    user_fields: s.user_fields || {},
    channel: s.channel || 'whatsapp',
  };
}

function compactMessage(m) {
  return {
    id: m.id || m.message_id || null,
    ts: m.created_at || m.timestamp || m.date || null,
    from_bot: !!(m.from_bot || m.is_bot || m.bot),
    from_agent: !!(m.from_agent || m.is_agent),
    text: (m.text || m.body || m.content || m.message || '').toString().slice(0, 2000),
    type: m.type || (m.text ? 'text' : 'other'),
  };
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
