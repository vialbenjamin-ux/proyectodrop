// Respuesta automática a reclamos en Chatea Pro (WhatsApp Chile, BENKOTIENDA).
//
// Nadie atiende Chatea a mano: el cliente que reclama (devolución, producto
// equivocado, falla, "estafa") queda sin respuesta y es quien bloquea o reporta
// el número. Cada 15 min esta función busca contactos cuyo último mensaje es
// del cliente, lleva 10+ min sin respuesta y suena a reclamo; les manda el
// mensaje fijo que los deriva a benkotienda@gmail.com y les pone el tag "Reclamo".
//
// - Una sola vez por conversación: si en los últimos mensajes ya está el correo,
//   no se repite.
// - send-text solo funciona dentro de la ventana de 24 h (el cliente acaba de
//   escribir, así que siempre está abierta).
// - Modo simulación: RECLAMOS_DRY=1 en env no manda ni etiqueta; queda en el
//   log de la función a quién le habría respondido.
//
// Endpoints Chatea Pro: GET /subscribers, GET /subscriber/chat-messages,
// POST /flow/create-tag, POST /subscriber/add-tags-by-name, POST /subscriber/send-text.

const CHATEA_BASE = 'https://chateapro.app/api';
const USER_AGENT = 'BKDROP-Sync/1.0 curl/8.9.0';
const TAG = 'Reclamo';
const CORREO = 'benkotienda@gmail.com';
const PAGINAS = 30;          // los contactos van por fecha de alta; el 11 nov, 91 de 98 activos del día estaban en las 30 primeras
const MIN_ESPERA_MIN = 10;   // dar tiempo al bot de Chatea a responder primero
const MAX_ESPERA_MIN = 60;   // corre cada 15 min: con 60 cubre pasadas fallidas sin revisar cientos de chats
const TOPE_POR_PASADA = 25;

export const MENSAJE = (nombre) =>
  `Hola${nombre ? ' ' + nombre : ''}, lamentamos el inconveniente 🙏 Para revisar tu caso y darte una solución, escríbenos a ${CORREO} con:\n` +
  `• Tu número de pedido o el teléfono con que compraste\n` +
  `• Qué pasó (producto equivocado, falla, devolución, etc.)\n` +
  `• Fotos o video del producto\n\n` +
  `Respondemos todos los correos dentro de 48 horas hábiles.`;

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Frases claras de reclamo. Se evalúan sobre el texto normalizado (sin tildes).
const PATRONES = [
  /\bdevol(ver|verlo|verla|verlos|ucion|uciones)\b/, /\bdevuelv(an|o|e|en)\b/, /\breembols/, /\bmi (dinero|plata)\b/,
  /\bestaf/, /\bsernac\b/, /\breclam(o|ar|ando)\b/, /\bqueja\b/,
  /no (es|era) (lo|el|la) que (pedi|compre|ped[ií]|encargue)/, /no (es|era) lo que (pedi|compre)/,
  /(me )?(llego|mandaron|enviaron|vino) (otro|otra|uno distinto|una distinta|mal|malo|mala|roto|rota|danad|quebrad|incomplet)/,
  /\b(viene|vino|llego) (roto|rota|danad|quebrad|defectuos|incomplet)/,
  /\bdefectuos/, /no (funciona|sirve|prende|enciende|carga|anda)\b/, /\bdejo de funcionar\b/,
  /\bmala calidad\b/, /\bpesim/, /\bengan(o|aron|an)\b/, /\bpublicidad engan/,
  /no (son|es) (las|los|la|lo|el) que (encargue|pedi|compre)/, /no sirven?\b/, /\brechaz(o|ar) (el|este|la|esta) (despacho|pedido|producto|envio)/,
  /muestran una cosa/, /\b(de )?(juguete|guguete|gujete)\b/, /\bfraud/, /\bburl(an|ando|aron)\b/, /\bdenuncia/, /\bsinverguenz/,
  /(jamas|nunca) (me )?llego/, /\bdecepcionad|\bdesepcionad|\bdesilusionad|\bdicilucionad/,
  /nadie (me )?(responde|contesta)/, /alguien (me )?(puede )?(responder|contestar)/,
];

// Respuestas de botón y frases que no son reclamo aunque contengan alguna palabra.
const IGNORAR = [/^confirmar pedido$/, /^modificar datos$/, /^coordinar entrega$/, /^hablar con asesor$/, /^si$/, /^no$/, /^ok$/];

export function esReclamo(textos) {
  const utiles = textos.map(norm).map((t) => t.trim()).filter((t) => t && !IGNORAR.some((r) => r.test(t)));
  const todo = utiles.join(' \n ');
  const hit = PATRONES.find((r) => r.test(todo));
  return hit ? hit.source : null;
}

// Mensajes vienen del más nuevo al más viejo. Devuelve los entrantes seguidos del final.
export function entrantesSinRespuesta(mensajes) {
  const out = [];
  for (const m of mensajes) {
    if (m.type === 'in' && !m.from_bot && !m.from_agent) out.push(m.text || '');
    else break;
  }
  return out.reverse();
}

export function yaDerivado(mensajes) {
  return mensajes.some((m) => m.type !== 'in' && (m.text || '').includes(CORREO));
}

// last_interaction viene en hora de Chile ("2026-11-11 11:09:04"); minutos transcurridos.
export function minutosDesde(lastInteraction, ahora = new Date()) {
  if (!lastInteraction) return null;
  const chile = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(ahora).replace(',', '');
  const a = Date.parse(chile.replace(' ', 'T') + 'Z');
  const b = Date.parse(lastInteraction.replace(' ', 'T') + 'Z');
  return (a - b) / 60000;
}

async function chatea(method, path, token, body) {
  const resp = await fetch(CHATEA_BASE + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await resp.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 200) }; }
  if (data && typeof data.message === 'string' && /too many attempts/i.test(data.message)) throw new Error('Rate limit Chatea');
  if (!resp.ok) throw new Error(`Chatea ${path} HTTP ${resp.status}: ${(data && data.message) || txt.slice(0, 200)}`);
  return data;
}

const lista = (d) => (Array.isArray(d) ? d : d?.data || d?.subscribers || d?.messages || []);

export async function pasada({ token, dry, ahora = new Date(), store = null }) {
  const t0 = Date.now();
  const candidatos = [];
  // Páginas de a 6 en paralelo para caber en los 30 s de una scheduled function.
  for (let p = 1; p <= PAGINAS; p += 6) {
    const lote = [];
    for (let q = p; q < p + 6 && q <= PAGINAS; q++) lote.push(chatea('GET', `/subscribers?limit=100&page=${q}`, token).then(lista));
    const paginas = await Promise.all(lote);
    for (const subs of paginas) for (const s of subs) {
      const min = minutosDesde(s.last_interaction, ahora);
      if (min != null && min >= MIN_ESPERA_MIN && min <= MAX_ESPERA_MIN) candidatos.push({ s, min });
    }
    if (paginas.some((subs) => subs.length < 100)) break;
  }

  const resultado = { dry, revisados: 0, respondidos: [], errores: [] };
  // Los más recientes primero; dejar margen al límite de 30 s de la función.
  candidatos.sort((a, b) => a.min - b.min);
  for (const { s, min } of candidatos) {
    if (Date.now() - t0 > 22000 || resultado.respondidos.length >= TOPE_POR_PASADA) break;
    const tags = (s.tags || []).map((t) => t.name || t);
    const user_ns = s.user_ns;
    const raw = lista(await chatea('GET', `/subscriber/chat-messages?user_ns=${encodeURIComponent(user_ns)}&include_bot=1&limit=30`, token));
    const mensajes = raw.map((m) => ({
      type: m.type, text: (m.text || m.body || m.content || m.message || '').toString(),
      from_bot: !!(m.from_bot || m.is_bot), from_agent: !!(m.from_agent || m.is_agent),
    }));
    resultado.revisados++;
    const pendientes = entrantesSinRespuesta(mensajes);
    if (!pendientes.length || yaDerivado(mensajes)) continue;
    const motivo = esReclamo(pendientes);
    if (!motivo) continue;
    // Registro propio: no repetir aunque Chatea tarde en mostrar el mensaje en el historial.
    if (store) {
      const prev = await store.get('enviado_' + user_ns, { type: 'json' }).catch(() => null);
      if (prev && Date.now() - prev.t < 7 * 24 * 3600e3) continue;
    }

    const nombre = (s.first_name || '').trim().split(/\s+/)[0] || '';
    const item = { user_ns, nombre, last_interaction: s.last_interaction, min: Math.round(min), motivo, cliente: pendientes.join(' / ').slice(0, 300), yaTag: tags.includes(TAG) };
    if (!dry) {
      try {
        // Chatea pide el texto en `content` (con `text` responde 422 "The content field is required").
        await chatea('POST', '/subscriber/send-text', token, { user_ns, content: MENSAJE(nombre) });
        if (store) await store.setJSON('enviado_' + user_ns, { t: Date.now() }).catch(() => {});
        item.enviado = true;
        try {
          await chatea('POST', '/flow/create-tag', token, { name: TAG }).catch(() => {});
          await chatea('POST', '/subscriber/add-tags-by-name', token, { user_ns, data: [{ tag_name: TAG }] });
        } catch (e) { item.tagError = e.message; }
      } catch (e) {
        resultado.errores.push({ user_ns, error: e.message });
        continue;
      }
    }
    resultado.respondidos.push(item);
  }
  resultado.candidatos = candidatos.length;
  resultado.ms = Date.now() - t0;
  return resultado;
}

export default async function handler() {
  const token = process.env.CHATEA_PRO_TOKEN;
  if (!token) return json({ error: 'Falta CHATEA_PRO_TOKEN' }, 500);
  const dry = process.env.RECLAMOS_DRY === '1';
  try {
    // Netlify a veces dispara dos pasadas casi juntas (11 nov, 15:45 UTC): candado de 60 s.
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({ name: 'chatea-reclamos', consistency: 'strong' });
    const lock = await store.get('lock', { type: 'json' }).catch(() => null);
    if (lock && Date.now() - lock.t < 60000) return json({ skip: 'otra pasada en curso' });
    await store.setJSON('lock', { t: Date.now() });
    const r = await pasada({ token, dry, store });
    console.log('chatea-reclamos', JSON.stringify({ dry: r.dry, candidatos: r.candidatos, revisados: r.revisados, errores: r.errores, respondidos: r.respondidos }));
    return json(r);
  } catch (e) {
    console.log('chatea-reclamos error', e.message);
    return json({ error: e.message }, 502);
  }
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

export const config = { schedule: '*/15 * * * *' };
