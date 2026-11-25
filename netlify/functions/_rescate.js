// RESCATE DE NOVEDADES (Chile). Piloto A/B desde el 25 nov 2026.
//
// Cuando Starken marca un intento fallido rescatable (sin moradores, nadie en
// casa, empresa cerrada, no se ubica, direccion incorrecta) se le escribe al
// cliente por WhatsApp con una plantilla propia. Solo pedidos con numero PAR
// (grupo A); los impares (grupo B) quedan de control, sin mensaje nuestro.
// Lo que el cliente responde queda etiquetado en Chatea ("[Rescate] ...") y en
// la lista de rescate-ver para que Solmelys lo resuelva en Dropi.
//
// No toca nada existente: plantillas, etiquetas y blobs propios ("rescate_",
// "[Rescate]", store bk-rescate). El agente de novedades de Chatea sigue igual.
// Solo fallos ocurridos DESPUES de la activacion (blob "activado_desde") y con
// menos de VENTANA_H horas: a pedidos que ya perdieron tiempo no se les escribe.

export const CHATEA_BASE = 'https://chateapro.app/api';
export const DROPI_BASE = 'https://api.dropi.cl';
const UA = 'BKDROP-Sync/1.0 curl/8.9.0';

export const VENTANA_H = 8;              // fallo con mas de 8 h ya no se escribe
export const RECORDATORIO_H = 4;         // sin respuesta en 4 h -> recordatorio (si la plantilla existe)
export const SEGUIR_RESPUESTAS_H = 48;   // se miran respuestas hasta 48 h despues del envio
export const HORARIO = [9, 21];          // solo se escribe entre 9:00 y 20:59 (hora Chile)

export const NO_ESTABA = /SIN MORADORES|NADIE EN CASA|EMPRESA CERRADA/;
export const DIRECCION = /NO SE UBICA|DIRECCION INCORRECTA/;
const CERRADO_MV = /^ENTREGAD|^DEVUELTO|DEVOLUCION A REMITENTE|DEV CONFIRMADA|DEVOLUCION ENTREGADA|EN ESPERA EN BOD\. DEV/;

export const PLANTILLAS = {
  rescate_no_estaba: {
    texto: 'Hola {{1}} 👋 Starken pasó hoy a entregar tu {{2}} y no encontró a nadie en casa 📦. ¿Cómo prefieres recibirlo? Lo reprogramamos sin costo.',
    ejemplo: ['Camila', 'Organizador de zapatos'],
    botones: ['Reintentar mañana', 'Cambiar dirección'],   // Starken no deja retirar en sucursal (25 nov)
    marca: 'no encontró a nadie en casa',
  },
  rescate_direccion: {
    texto: 'Hola {{1}} 👋 Starken no pudo ubicar la dirección de tu pedido {{2}}. Respóndenos con la dirección completa (calle, número, depto/casa y comuna) y lo enviamos de nuevo sin costo.',
    ejemplo: ['Camila', 'Organizador de zapatos'],
    botones: [],
    marca: 'no pudo ubicar la dirección',
  },
  rescate_recordatorio: {
    texto: 'Hola {{1}} 👋 Tu pedido {{2}} sigue esperando en Starken 📦. Si no lo reprogramamos hoy, vuelve a nuestra bodega. ¿Cómo lo recibes?',
    ejemplo: ['Camila', 'Organizador de zapatos'],
    botones: ['Reintentar mañana', 'Cambiar dirección'],   // Starken no deja retirar en sucursal (25 nov)
    marca: 'sigue esperando en Starken',
  },
};

// Respuestas automaticas tras el boton (dentro de la ventana de 24 h abierta por el cliente).
export const ACUSE = {
  Reintentar: (n) => `¡Listo${n ? ' ' + n : ''}! 🙌 Dejamos tu pedido para un nuevo intento de entrega. Te avisaremos cuando salga a reparto.`,
  'Cambiar dirección': () => 'Perfecto 👍 Escríbenos aquí la dirección completa (calle, número, depto/casa y comuna) y lo enviamos de nuevo.',
  'Nueva dirección': (n) => `¡Gracias${n ? ' ' + n : ''}! 🙌 Actualizamos la dirección y lo enviamos de nuevo.`,
};

export const HUELLA_CLAVE = '1a6553064ad1b8a510b2bb1d3209ec3e7d10f7adc89c752c8c603524cb08dc6e';
export async function huella(store) { return (await store.get('huella_clave')) || HUELLA_CLAVE; }

export const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

export async function chatea(method, path, token, body) {
  const r = await fetch(CHATEA_BASE + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 300) }; }
  if (data && typeof data.message === 'string' && /too many attempts/i.test(data.message)) throw new Error('Rate limit Chatea');
  if (!r.ok) throw new Error(`Chatea ${path} HTTP ${r.status}: ${(data && (data.message || JSON.stringify(data.errors || ''))) || txt.slice(0, 200)}`);
  return data;
}

// Fecha de Dropi ("2026-11-25T14:03:11", hora de Chile sin zona) -> epoch ms.
export function epochChile(s) {
  const guess = Date.parse(s + 'Z');
  const f = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const comoChile = Date.parse(f.format(new Date(guess)).replace(' ', 'T') + 'Z');
  return guess + (guess - comoChile);
}
export const horaChile = (t = Date.now()) => +new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Santiago', hour: '2-digit', hour12: false }).format(new Date(t));

// Telefono del pedido -> id de WhatsApp en Chatea (56 9 XXXXXXXX).
export function waId(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 9 && d[0] === '9') d = '56' + d;
  if (d.length === 8) d = '569' + d;
  return /^569\d{8}$/.test(d) ? d : null;
}

export function nombreCorto(n) { return String(n || '').trim().split(/\s+/)[0].replace(/^\w/, (c) => c.toUpperCase()).slice(0, 20); }
export function productoCorto(n) {
  return String(n || 'pedido').replace(/^\s*[A-Z]{1,3}\s*-\s*/, '').replace(/\(priv\)/ig, '').replace(/[🔥|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 45);
}

// Ultimo fallo rescatable del pedido, si sigue abierto (sin entrega ni devolucion despues).
export function falloRescatable(o) {
  if (/^ENTREGADO|^DEVOLUCI|EN DEVOLUCI|^CANCEL|INDEMNIZ/.test(o.status || '')) return null;
  const mv = (o.servientrega_movements || []).filter((m) => m.created_at).slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  let fallo = null;
  for (const m of mv) {
    const n = (m.nom_mov || '').trim();
    if (CERRADO_MV.test(n)) return null;
    if (NO_ESTABA.test(n) || DIRECCION.test(n)) fallo = { mov: n, t: epochChile(m.created_at), tipo: DIRECCION.test(n) ? 'direccion' : 'no_estaba' };
    else if (/RECHAZ|REHUZA/.test(n)) fallo = null;   // un rechazo posterior no se rescata
  }
  return fallo;
}

// Clasifica lo que respondio el cliente.
export function clasificar(texto, tipo) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/reintent|manana/.test(t)) return 'Reintentar';
  if (/cambiar direccion/.test(t)) return 'Cambiar dirección';
  if (/\d/.test(t) && t.replace(/\s/g, '').length >= 8) return 'Nueva dirección';   // calle con numero
  return 'Otra respuesta';
}
