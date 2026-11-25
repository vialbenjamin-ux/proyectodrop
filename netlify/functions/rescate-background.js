// Pasada del RESCATE DE NOVEDADES (ver _rescate.js). La dispara rescate-cron cada 30 min.
// A mano (con clave): POST /.netlify/functions/rescate-background?clave=...
// Modo (blob "modo"): "simulacion" (por defecto: detecta y registra, no escribe),
// "real" (escribe a los del grupo A) o "apagado".

import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import {
  DROPI_BASE, VENTANA_H, RECORDATORIO_H, SEGUIR_RESPUESTAS_H, HORARIO, PLANTILLAS, ACUSE,
  chatea, esperar, falloRescatable, huella, waId, nombreCorto, productoCorto, horaChile, clasificar,
} from './_rescate.js';

const PAGINAS_MAX = 25;   // ~2.500 pedidos: los fallos llegan entre el dia 1 y el 10

export default async function handler(req) {
  const qs = new URL(req.url).searchParams;
  const store = getStore({ name: 'bk-rescate', consistency: 'strong' });
  const conClave = createHash('sha256').update(qs.get('clave') || '').digest('hex') === (await huella(store));
  const delCron = await paseDelCron(store, qs.get('pase'));
  if (!conClave && !delCron) return new Response('No autorizado', { status: 403 });

  const modo = (await store.get('modo')) || 'simulacion';
  if (modo === 'apagado') return new Response('apagado');
  const ahora = Date.now();
  let desde = Number(await store.get('activado_desde'));
  if (!desde) { desde = ahora; await store.set('activado_desde', String(desde)); }

  const res = { inicio: new Date(ahora).toISOString(), modo, nuevos: [], enviados: 0, respuestas: [], recordatorios: 0, errores: [] };
  const dropi = String(process.env.DROPI_TOKEN_CL || '').trim();
  const token = process.env.CHATEA_PRO_TOKEN;
  const plantillas = await plantillasAprobadas(token, store, res);

  // 1) Fallos nuevos
  try {
    for (let p = 0; p < PAGINAS_MAX; p++) {
      const r = await fetch(`${DROPI_BASE}/integrations/orders/myorders?start=${p * 100}&result_number=100`, { headers: { 'dropi-integration-key': dropi, 'User-Agent': 'BKDROP-Sync/1.0' } });
      if (!r.ok) { res.errores.push(`dropi pagina ${p}: HTTP ${r.status}`); break; }
      const lote = (await r.json()).objects || [];
      for (const o of lote) {
        const f = falloRescatable(o);
        if (!f || f.t < desde || ahora - f.t > VENTANA_H * 3600e3) continue;
        const key = 'o_' + o.id;
        if (await store.get(key)) continue;
        const grupo = o.id % 2 === 0 ? 'A' : 'B';
        const det = (o.orderdetails || []).slice().sort((a, b) => (b.product?.sale_price || 0) * (b.quantity || 1) - (a.product?.sale_price || 0) * (a.quantity || 1))[0];
        const reg = { id: o.id, grupo, tipo: f.tipo, mov: f.mov, t_fallo: f.t, guia: o.shipping_guide || null, comuna: o.city || null, producto: productoCorto(det?.product?.name), registrado: ahora, modo };
        if (grupo === 'A' && modo === 'real') {
          const hora = horaChile(ahora);
          if (hora < HORARIO[0] || hora >= HORARIO[1]) continue;   // se reintenta en la proxima pasada (si sigue en ventana)
          const plantilla = f.tipo === 'direccion' ? 'rescate_direccion' : 'rescate_no_estaba';
          try {
            const uid = waId(o.phone);
            if (!uid) throw new Error('telefono no valido');
            const info = await chatea('GET', `/subscriber/get-info-by-user-id?user_id=${uid}`, token).catch(() => null);
            const sub = info && (info.data || info);
            if (!sub || !sub.user_ns) { reg.estado = 'sin contacto en Chatea'; }
            else if (!plantillas[plantilla]) { reg.estado = 'plantilla no aprobada'; }
            else {
              const nombre = nombreCorto(sub.first_name || o.name);
              await chatea('POST', '/subscriber/send-whatsapp-template-by-user-id', token, {
                user_id: uid, create_if_not_found: 'no',
                content: { ...plantillas[plantilla], params: { 'BODY_{{1}}': nombre || 'hola', 'BODY_{{2}}': reg.producto } },
              });
              Object.assign(reg, { estado: 'enviado', plantilla, user_ns: sub.user_ns, nombre, t_envio: Date.now() });
              await chatea('POST', '/flow/create-tag', token, { name: '[Rescate] Enviado' }).catch(() => {});
              await chatea('POST', '/subscriber/add-tags-by-name', token, { user_ns: sub.user_ns, data: [{ tag_name: '[Rescate] Enviado' }] }).catch(() => {});
              res.enviados++;
            }
          } catch (e) { reg.estado = 'error'; reg.error = e.message; res.errores.push(`pedido ${o.id}: ${e.message}`); }
        } else reg.estado = grupo === 'B' ? 'control' : 'simulado';
        await store.setJSON(key, reg);
        res.nuevos.push({ id: o.id, grupo, tipo: f.tipo, estado: reg.estado });
      }
      const masViejo = lote.length ? Date.parse(lote[lote.length - 1].created_at + 'Z') : 0;
      if (lote.length < 100 || ahora - masViejo > 14 * 864e5) break;
      await esperar(2500);
    }
  } catch (e) { res.errores.push('fallos: ' + e.message); }

  // 2) Respuestas y recordatorios de los enviados
  try {
    const { blobs } = await store.list({ prefix: 'o_' });
    for (const b of blobs) {
      const reg = await store.get(b.key, { type: 'json' });
      if (!reg || !reg.t_envio || reg.cerrado) continue;
      if (Date.now() - reg.t_envio > SEGUIR_RESPUESTAS_H * 3600e3) { reg.cerrado = true; await store.setJSON(b.key, reg); continue; }
      const msgs = await chatea('GET', `/subscriber/chat-messages?user_ns=${encodeURIComponent(reg.user_ns)}&include_bot=1&limit=30`, token).then((d) => (Array.isArray(d) ? d : d.data || []));
      // Vienen del mas nuevo al mas viejo: lo entrante antes de nuestra plantilla es respuesta.
      const marcas = [PLANTILLAS[reg.plantilla].marca, PLANTILLAS.rescate_recordatorio.marca];
      const nuevos = [];
      for (const m of msgs) {
        const txt = String(m.text || m.body || m.content || m.message || '');
        if (m.type !== 'in' && marcas.some((k) => txt.includes(k))) break;
        if (m.type === 'in') nuevos.unshift(txt);
      }
      const yaVistas = (reg.respuestas || []).length;
      const frescas = nuevos.slice(yaVistas);
      for (const txt of frescas) {
        const previa = reg.solucion;
        let sol = clasificar(txt, previa === 'Cambiar dirección' ? 'direccion' : reg.tipo);
        reg.respuestas = (reg.respuestas || []).concat({ t: Date.now(), texto: txt.slice(0, 300), sol });
        if (sol !== 'Otra respuesta' && (!previa || previa === 'Cambiar dirección' || previa === 'Otra respuesta')) {
          reg.solucion = sol; reg.pendienteSolmelys = true;
          const tag = '[Rescate] ' + sol;
          await chatea('POST', '/flow/create-tag', token, { name: tag }).catch(() => {});
          await chatea('POST', '/subscriber/add-tags-by-name', token, { user_ns: reg.user_ns, data: [{ tag_name: tag }] }).catch(() => {});
          if (ACUSE[sol] && !(reg.acuses || []).includes(sol)) {
            await chatea('POST', '/subscriber/send-text', token, { user_ns: reg.user_ns, content: ACUSE[sol](reg.nombre) }).catch((e) => res.errores.push(`acuse ${reg.id}: ${e.message}`));
            reg.acuses = (reg.acuses || []).concat(sol);
          }
        } else if (!reg.solucion) { reg.solucion = 'Otra respuesta'; reg.pendienteSolmelys = true; }
        res.respuestas.push({ id: reg.id, sol });
      }
      // Recordatorio: sin respuesta, 4 h despues, en horario y con plantilla aprobada.
      if (!reg.respuestas?.length && !reg.t_recordatorio && Date.now() - reg.t_envio > RECORDATORIO_H * 3600e3 && reg.tipo === 'no_estaba' && plantillas.rescate_recordatorio) {
        const h = horaChile();
        if (h >= HORARIO[0] && h < HORARIO[1]) {
          try {
            const info = await chatea('GET', `/subscriber/get-info?user_ns=${encodeURIComponent(reg.user_ns)}`, token);
            const uid = (info.data || info).user_id || (info.data || info).phone;
            await chatea('POST', '/subscriber/send-whatsapp-template-by-user-id', token, {
              user_id: String(uid).replace(/\D/g, ''), create_if_not_found: 'no',
              content: { ...plantillas.rescate_recordatorio, params: { 'BODY_{{1}}': reg.nombre || 'hola', 'BODY_{{2}}': reg.producto } },
            });
            reg.t_recordatorio = Date.now(); res.recordatorios++;
          } catch (e) { res.errores.push(`recordatorio ${reg.id}: ${e.message}`); }
        }
      }
      await store.setJSON(b.key, reg);
      await esperar(400);
    }
  } catch (e) { res.errores.push('respuestas: ' + e.message); }

  res.ms = Date.now() - ahora;
  await store.setJSON('ultima_pasada', res);
  console.log('rescate', JSON.stringify({ modo, nuevos: res.nuevos.length, enviados: res.enviados, respuestas: res.respuestas.length, errores: res.errores }));
  return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
}

// Plantillas propias aprobadas por Meta: { nombre: {namespace, name, lang} }.
async function plantillasAprobadas(token, store, res) {
  try {
    const d = await chatea('POST', '/whatsapp-template/list?limit=100&name=rescate_', token);
    const out = {};
    for (const t of (Array.isArray(d) ? d : d.data || [])) {
      if (!PLANTILLAS[t.name] || String(t.status || '').toUpperCase() !== 'APPROVED') continue;
      out[t.name] = { namespace: t.namespace, name: t.name, lang: t.lang || t.language };
    }
    await store.setJSON('plantillas', out);
    return out;
  } catch (e) { res.errores.push('plantillas: ' + e.message); return (await store.get('plantillas', { type: 'json' })) || {}; }
}

async function paseDelCron(store, pase) {
  if (!pase) return false;
  const g = await store.get('pase_cron', { type: 'json' });
  if (!g || g.pase !== pase || Date.now() - g.t > 5 * 60 * 1000) return false;
  await store.delete('pase_cron');
  return true;
}
