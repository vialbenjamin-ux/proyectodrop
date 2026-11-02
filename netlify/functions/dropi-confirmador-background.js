// Confirmador de pedidos de Dropi Chile, EN SIMULACION: lee y decide, pero no
// confirma nada. Aqui no hay ninguna llamada que cambie una orden; se agrega
// cuando Benjamin revise la lista, junto con el cron de cada 4 horas.
//
// POST /.netlify/functions/dropi-confirmador-background?clave=...
// Tarda minutos, por eso es background. El resultado se lee con dropi-confirmador-ver.

import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import reglas from './_confirmador-reglas.js';

const HUELLA_CLAVE = '9e444ac260068bb9b9b3d58a77cbfcb227b0d67479990eb8b8c049910166770b';
const BASE = 'https://api.dropi.cl';
const PAGINAS = 5;
// No se sabe cuanto aguanta el historial antes de cortar; la llave de
// integraciones corta cerca de 10 por minuto, asi que se parte bajo eso.
const PAUSA_HISTORIAL_MS = 7000;
const MAX_HISTORIALES = 100;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req) {
  const clave = new URL(req.url).searchParams.get('clave') || '';
  if (createHash('sha256').update(clave).digest('hex') !== HUELLA_CLAVE) {
    return new Response('No autorizado', { status: 403 });
  }
  const token = String(process.env.DROPI_TOKEN_CL || '').trim();
  const store = getStore({ name: 'bk-confirmador', consistency: 'strong' });
  const res = { modo: 'simulacion', inicio: new Date().toISOString(), estado: 'corriendo', pedidos: [], errores: [] };

  try {
    const ordenes = await leerOrdenes(token, res);
    const ahora = Date.now();

    // Cuantas ordenes vivas tiene cada pedido de Shopify.
    const porNota = {};
    for (const o of ordenes) {
      const n = reglas.notaShopify(o.notes);
      if (n && o.status !== 'CANCELADO') porNota[n] = (porNota[n] || 0) + 1;
    }

    const pendientes = ordenes.filter((o) => o.status === 'PENDIENTE CONFIRMACION');
    res.ordenesLeidas = ordenes.length;
    res.pendientes = pendientes.length;
    res.ordenMasVieja = ordenes.length ? ordenes[ordenes.length - 1].created_at : null;

    const cache = {};
    let consultas = 0;
    for (const o of pendientes) {
      const fila = {
        id: o.id,
        creado: o.created_at,
        cliente: `${o.name || ''} ${o.surname || ''}`.trim(),
        telefono: o.phone || '',
        direccion: o.dir || '',
        ciudad: o.city || '',
        producto: (((o.orderdetails || [])[0] || {}).product || {}).name || '',
        nota: o.notes || '',
      };
      res.pedidos.push(fila);

      const horas = reglas.horasDesde(o.created_at, ahora);
      fila.horas = horas === null ? null : Math.round(horas * 10) / 10;
      if (horas === null || horas < reglas.HORAS_MINIMAS) {
        fila.decision = 'espera';
        fila.motivo = 'lleva menos de 2 horas';
        continue;
      }
      const dir = reglas.direccionOk(o.dir);
      if (!dir.ok) {
        fila.decision = 'no toca';
        fila.motivo = 'direccion: ' + dir.motivo;
        continue;
      }
      const n = reglas.notaShopify(o.notes);
      if (n && porNota[n] > 1) {
        fila.decision = 'no toca';
        fila.motivo = 'pedido de Shopify con otra orden viva en Dropi';
        continue;
      }
      const tel = reglas.telefonoLocal(o.phone);
      if (!/^\d{8,12}$/.test(tel)) {
        fila.decision = 'no toca';
        fila.motivo = 'telefono invalido';
        continue;
      }
      if (!(tel in cache)) {
        if (consultas >= MAX_HISTORIALES) {
          fila.decision = 'no toca';
          fila.motivo = 'tope de consultas de esta pasada';
          continue;
        }
        if (consultas > 0) await esperar(PAUSA_HISTORIAL_MS);
        consultas++;
        cache[tel] = await leerHistorial(token, tel, res);
        if (consultas % 10 === 0) await store.setJSON('ultima', res);
      }
      const d = reglas.decidirHistorial(cache[tel]);
      Object.assign(fila, d);
      fila.decision = d.confirma ? 'confirmaria' : 'no toca';
    }
    res.consultasHistorial = consultas;
    res.estado = 'terminado';
  } catch (e) {
    res.estado = 'fallo';
    res.errores.push(e.message || String(e));
  }
  res.fin = new Date().toISOString();
  await store.setJSON('ultima', res);
  return new Response('ok');
}

// De la mas nueva a la mas vieja. Si una pagina falla se corta: la lista queda
// corta y el resultado lo dice.
async function leerOrdenes(token, res) {
  let todas = [];
  for (let p = 0; p < PAGINAS; p++) {
    const r = await fetch(`${BASE}/integrations/orders/myorders?start=${p * 100}&result_number=100`, {
      headers: { 'dropi-integration-key': token, 'User-Agent': 'BKDROP-Sync/1.0' },
    });
    if (!r.ok) {
      res.errores.push(`ordenes pagina ${p}: HTTP ${r.status}`);
      break;
    }
    const lote = (await r.json()).objects || [];
    todas = todas.concat(lote);
    if (lote.length < 100) break;
    await esperar(2000);
  }
  return todas;
}

async function leerHistorial(token, tel, res) {
  try {
    const r = await fetch(
      `https://api-v2.dropi.cl/bff/customers/fingerprint/v2?country_code=CL&user_id=357617&phone=${tel}&months=0`,
      { headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'BKDROP-Sync/1.0' } },
    );
    if (!r.ok) {
      res.errores.push(`historial: HTTP ${r.status}`);
      return null;
    }
    return (await r.json()).data || null;
  } catch (e) {
    res.errores.push('historial: ' + (e.message || 'error'));
    return null;
  }
}
