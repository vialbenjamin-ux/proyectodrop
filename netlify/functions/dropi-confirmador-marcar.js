// Confirma los pedidos que Benjamin marca a mano en confirmador.html, de los que
// el confirmador dejo sin tocar. Es la unica via que salta las reglas, y solo
// acepta pedidos de la ultima pasada que sigan en PENDIENTE CONFIRMACION.
//
// POST /.netlify/functions/dropi-confirmador-marcar
// Body: { clave, ids: [123, ...] }
// Respuesta: { confirmados: [...], saltados: [...] }

import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

const HUELLA_CLAVE = '9e444ac260068bb9b9b3d58a77cbfcb227b0d67479990eb8b8c049910166770b';
const BASE = 'https://api.dropi.cl';
const PAGINAS = 5;
const MAX_IDS = 20;
// La funcion se corta a los 10 s. Lo que no alcance a leer no se confirma.
const TOPE_LECTURA_MS = 7000;

const responder = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

export default async function handler(req) {
  if (req.method !== 'POST') return responder(405, { error: 'Method not allowed' });
  const body = await req.json().catch(() => ({}));
  if (createHash('sha256').update(String(body.clave || '')).digest('hex') !== HUELLA_CLAVE) {
    return responder(403, { error: 'No autorizado' });
  }
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) return responder(400, { error: 'ids requerido' });
  if (ids.length > MAX_IDS) return responder(400, { error: 'Maximo ' + MAX_IDS + ' por envio' });

  const store = getStore({ name: 'bk-confirmador', consistency: 'strong' });
  const ultima = (await store.get('ultima', { type: 'json' })) || { pedidos: [] };
  const permitidos = new Set(ultima.pedidos.filter((p) => p.decision === 'no toca').map((p) => p.id));

  const token = String(process.env.DROPI_TOKEN_CL || '').trim();
  const estado = await leerEstados(token);
  const aConfirmar = ids.filter((id) => permitidos.has(id) && estado[id] === 'PENDIENTE CONFIRMACION');
  const saltados = ids.filter((id) => !aConfirmar.includes(id));

  if (aConfirmar.length) {
    const r = await fetch(`${BASE}/integrations/orders/myorder/masive`, {
      method: 'POST',
      headers: {
        'dropi-integration-key': token,
        'Content-Type': 'application/json',
        'User-Agent': 'BKDROP-Sync/1.0',
      },
      body: JSON.stringify(aConfirmar.map((id) => ({ id, status: 'PENDIENTE' }))),
    });
    if (!r.ok) return responder(502, { error: 'Dropi respondio HTTP ' + r.status });
  }

  // Para que al recargar la pagina no vuelvan a salir como indecisos.
  if (ultima.estado !== 'corriendo') {
    for (const p of ultima.pedidos) {
      if (aConfirmar.includes(p.id)) p.decision = 'confirmado a mano';
    }
    await store.setJSON('ultima', ultima);
  }
  await store.setJSON('manual_' + new Date().toISOString(), { confirmados: aConfirmar, saltados });
  return responder(200, { confirmados: aConfirmar, saltados });
}

async function leerEstados(token) {
  const inicio = Date.now();
  const estado = {};
  for (let p = 0; p < PAGINAS && Date.now() - inicio < TOPE_LECTURA_MS; p++) {
    const r = await fetch(`${BASE}/integrations/orders/myorders?start=${p * 100}&result_number=100`, {
      headers: { 'dropi-integration-key': token, 'User-Agent': 'BKDROP-Sync/1.0' },
    });
    if (!r.ok) break;
    const lote = (await r.json()).objects || [];
    for (const o of lote) estado[o.id] = o.status;
    if (lote.length < 100) break;
  }
  return estado;
}
