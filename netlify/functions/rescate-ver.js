// Panel del RESCATE DE NOVEDADES (ver _rescate.js). Todo con ?clave=...
//   GET  ?clave=                        lista para Solmelys (respuestas por resolver en Dropi)
//   GET  ?clave=&op=resumen             numeros del piloto A/B y ultima pasada (json)
//   POST ?clave=&op=hecho&id=PEDIDO     Solmelys marca el pedido como resuelto en Dropi
//   POST ?clave=&op=modo&valor=simulacion|real|apagado
//   POST ?clave=&op=crear-plantillas    pide a Meta las plantillas rescate_* que falten
//   POST ?clave=&op=prueba&tel=569XXXXXXXX&plantilla=rescate_no_estaba   envio de prueba a un numero

import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { PLANTILLAS, chatea, huella } from './_rescate.js';

export default async function handler(req) {
  const url = new URL(req.url);
  const qs = url.searchParams;
  const store = getStore({ name: 'bk-rescate', consistency: 'strong' });
  if (createHash('sha256').update(qs.get('clave') || '').digest('hex') !== (await huella(store))) return new Response('No autorizado', { status: 403 });
  const op = qs.get('op') || 'lista';
  const token = process.env.CHATEA_PRO_TOKEN;

  if (op === 'modo' && req.method === 'POST') {
    const v = qs.get('valor');
    if (!['simulacion', 'real', 'apagado'].includes(v)) return json({ error: 'valor invalido' }, 400);
    await store.set('modo', v);
    return json({ modo: v });
  }

  if (op === 'crear-plantillas' && req.method === 'POST') {
    const existentes = await chatea('POST', '/whatsapp-template/list?limit=100&name=rescate_', token).then((d) => (Array.isArray(d) ? d : d.data || [])).catch(() => []);
    const out = [];
    for (const [name, p] of Object.entries(PLANTILLAS)) {
      if (qs.get('solo') && qs.get('solo') !== name) continue;
      if (existentes.some((t) => t.name === name)) { out.push({ name, estado: 'ya existe' }); continue; }
      const components = [{ type: 'BODY', text: p.texto, example: { body_text: [p.ejemplo] } }];
      if (p.botones.length) components.push({ type: 'BUTTONS', buttons: p.botones.map((text) => ({ type: 'QUICK_REPLY', text })) });
      try { const r = await chatea('POST', '/whatsapp-template/create', token, { name, language: 'es', category: 'UTILITY', components }); out.push({ name, estado: 'enviada a Meta', r }); }
      catch (e) { out.push({ name, error: e.message }); }
    }
    return json(out);
  }

  if (op === 'prueba' && req.method === 'POST') {
    const tel = String(qs.get('tel') || '').replace(/\D/g, '');
    const name = qs.get('plantilla') || 'rescate_no_estaba';
    const pl = ((await store.get('plantillas', { type: 'json' })) || {})[name];
    if (!pl) return json({ error: 'plantilla no aprobada todavia (corre una pasada o espera a Meta)' }, 400);
    const r = await chatea('POST', '/subscriber/send-whatsapp-template-by-user-id', token, { user_id: tel, create_if_not_found: 'no', content: { ...pl, params: { 'BODY_{{1}}': 'Prueba', 'BODY_{{2}}': 'Organizador de zapatos' } } });
    return json({ ok: true, r });
  }

  const { blobs } = await store.list({ prefix: 'o_' });
  const regs = [];
  for (const b of blobs) { const r = await store.get(b.key, { type: 'json' }); if (r) regs.push(r); }

  if (op === 'hecho' && req.method === 'POST') {
    const r = regs.find((x) => String(x.id) === qs.get('id'));
    if (!r) return json({ error: 'no esta' }, 404);
    r.pendienteSolmelys = false; r.resueltoSolmelys = Date.now();
    await store.setJSON('o_' + r.id, r);
    return json({ ok: true });
  }

  if (op === 'resumen') {
    const g = { A: { total: 0, enviados: 0, respondieron: 0 }, B: { total: 0 } };
    for (const r of regs) { g[r.grupo].total++; if (r.grupo === 'A') { if (r.t_envio) g.A.enviados++; if (r.respuestas?.length) g.A.respondieron++; } }
    return json({ modo: (await store.get('modo')) || 'simulacion', activado_desde: new Date(Number(await store.get('activado_desde')) || 0).toISOString(), plantillas: await store.get('plantillas', { type: 'json' }), grupos: g, ultima_pasada: await store.get('ultima_pasada', { type: 'json' }) });
  }

  // Lista para Solmelys
  const pend = regs.filter((r) => r.pendienteSolmelys).sort((a, b) => a.t_envio - b.t_envio);
  const hechos = regs.filter((r) => r.resueltoSolmelys).sort((a, b) => b.resueltoSolmelys - a.resueltoSolmelys).slice(0, 20);
  const fmt = (t) => new Date(t).toLocaleString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const QUE = { Reintentar: 'Volver a ofrecer (Sacar a reparto)', 'Nueva dirección': 'Cambio de dirección con la dirección que escribió', 'Cambiar dirección': 'Espera la dirección nueva (aún no la escribe)', 'Otra respuesta': 'Leer el chat y decidir' };
  const fila = (r) => `<tr><td><b>${esc(r.id)}</b><br><small>guía ${esc(r.guia)}</small></td><td>${esc(r.comuna)}<br><small>${esc(r.mov)}</small></td><td>${esc(r.producto)}</td><td><b>${esc(r.solucion)}</b><br><small>${esc(QUE[r.solucion] || '')}</small></td><td>${(r.respuestas || []).map((x) => esc(x.texto)).join('<br>')}</td><td>${fmt(r.respuestas?.[r.respuestas.length - 1]?.t || r.t_envio)}</td>`;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rescate de novedades</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;color:#111;background:#fafafa}table{border-collapse:collapse;width:100%;background:#fff}td,th{border:1px solid #ddd;padding:8px;vertical-align:top;text-align:left}th{background:#f1f1f1}button{padding:6px 10px;cursor:pointer}small{color:#666}</style>
<h2>Rescate de novedades: por resolver en Dropi (${pend.length})</h2>
<p>Cada fila es un cliente que respondió al WhatsApp tras un intento fallido de Starken. Aplica la solución en Dropi (Novedades → Solucionar) y aprieta <b>Hecho</b>.</p>
<table><tr><th>Pedido</th><th>Comuna / fallo</th><th>Producto</th><th>Qué pidió</th><th>Lo que escribió</th><th>Cuándo</th><th></th></tr>
${pend.map((r) => fila(r) + `<td><button onclick="hecho(${r.id},this)">Hecho</button></td></tr>`).join('') || '<tr><td colspan=7>Nada pendiente 🙌</td></tr>'}</table>
<h3>Últimos resueltos</h3><table>${hechos.map((r) => fila(r) + `<td>✅ ${fmt(r.resueltoSolmelys)}</td></tr>`).join('') || '<tr><td>—</td></tr>'}</table>
<script>async function hecho(id,b){b.disabled=true;const r=await fetch(location.pathname+'?clave='+encodeURIComponent(new URLSearchParams(location.search).get('clave'))+'&op=hecho&id='+id,{method:'POST'});if(r.ok)b.closest('tr').style.opacity=.35;else{b.disabled=false;alert('No se pudo marcar')}}</script>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

const json = (o, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { 'Content-Type': 'application/json' } });
