// Confirmador de pedidos de Dropi Chile, para los clientes que no le contestan a
// Chatea Pro. Las reglas estan en _confirmador-reglas.js. Lo que no cumple no se
// toca: aqui no hay ninguna cancelacion.
//
// Lo dispara dropi-confirmador-cron cada 4 horas. A mano:
//   POST /.netlify/functions/dropi-confirmador-background?clave=...          simula
//   POST /.netlify/functions/dropi-confirmador-background?clave=...&real=1   confirma
// Tarda minutos, por eso es background. El resultado se lee con dropi-confirmador-ver,
// que tambien lo apaga y lo prende.

import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import reglas from './_confirmador-reglas.js';

const HUELLA_CLAVE = '9e444ac260068bb9b9b3d58a77cbfcb227b0d67479990eb8b8c049910166770b';
const BASE = 'https://api.dropi.cl';
const PAGINAS = 5;
// 8 por minuto aguanto 100 consultas seguidas sin 429 (2 nov 2026).
const PAUSA_HISTORIAL_MS = 7000;
const MAX_HISTORIALES = 100;
// Netlify corta a los 15 minutos y al final falta releer y confirmar.
const TOPE_CONSULTAS_MS = 12 * 60 * 1000;
const HISTORIAL_VIGENTE_MS = 24 * 3600 * 1000;
const LOTE_CONFIRMAR = 20;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req) {
  const qs = new URL(req.url).searchParams;
  const store = getStore({ name: 'bk-confirmador', consistency: 'strong' });

  const conClave = createHash('sha256').update(qs.get('clave') || '').digest('hex') === HUELLA_CLAVE;
  const delCron = await paseDelCron(store, qs.get('pase'));
  if (!conClave && !delCron) return new Response('No autorizado', { status: 403 });

  const real = delCron || qs.get('real') === '1';
  if (real && (await store.get('apagado'))) {
    await store.setJSON('ultima_saltada', { fecha: new Date().toISOString() });
    return new Response('apagado');
  }

  const inicio = Date.now();
  const token = String(process.env.DROPI_TOKEN_CL || '').trim();
  const res = {
    modo: real ? 'real' : 'simulacion',
    origen: delCron ? 'cron' : 'manual',
    inicio: new Date(inicio).toISOString(),
    estado: 'corriendo',
    pedidos: [],
    errores: [],
  };

  try {
    const ordenes = await leerOrdenes(token, res);
    const ahora = Date.now();

    // Ordenes vivas por pedido de Shopify y por telefono + producto: una orden
    // repetida se despacharia dos veces. Las de Chatea Pro no traen nota, por eso
    // no basta con mirar la nota.
    const porNota = {};
    const porCompra = {};
    for (const o of ordenes) {
      if (o.status === 'CANCELADO') continue;
      const n = reglas.notaShopify(o.notes);
      if (n) porNota[n] = (porNota[n] || 0) + 1;
      const c = claveCompra(o);
      porCompra[c] = (porCompra[c] || 0) + 1;
    }

    const pendientes = ordenes.filter((o) => o.status === 'PENDIENTE CONFIRMACION');
    res.ordenesLeidas = ordenes.length;
    res.pendientes = pendientes.length;
    res.ordenMasVieja = ordenes.length ? ordenes[ordenes.length - 1].created_at : null;

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
      const dir = reglas.direccionOk(o.dir, o.city);
      if (!dir.ok && dir.motivo === 'no trae calle') {
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
      if (porCompra[claveCompra(o)] > 1) {
        fila.decision = 'no toca';
        fila.motivo = 'mismo telefono con otra orden viva del mismo producto';
        continue;
      }
      const tel = reglas.telefonoLocal(o.phone);
      if (!/^\d{8,12}$/.test(tel)) {
        fila.decision = 'no toca';
        fila.motivo = 'telefono invalido';
        continue;
      }

      let historial = await historialGuardado(store, tel);
      if (!historial) {
        if (consultas >= MAX_HISTORIALES || Date.now() - inicio > TOPE_CONSULTAS_MS) {
          fila.decision = 'no toca';
          fila.motivo = 'tope de consultas de esta pasada';
          continue;
        }
        if (consultas > 0) await esperar(PAUSA_HISTORIAL_MS);
        consultas++;
        historial = await leerHistorial(token, tel, res);
        // Un error no se guarda: se vuelve a preguntar en la proxima pasada.
        if (historial) await store.setJSON('hist_' + tel, { t: Date.now(), data: historial });
        if (consultas % 10 === 0) await store.setJSON('ultima', res);
      }
      const d = dir.ok
        ? reglas.decidirHistorial(historial, o.state)
        : reglas.decidirSinNumero(historial, dir.motivo);
      Object.assign(fila, d);
      fila.decision = d.confirma ? 'confirmaria' : 'no toca';
    }
    res.consultasHistorial = consultas;

    if (real) await confirmar(token, res);
    res.estado = 'terminado';
  } catch (e) {
    res.estado = 'fallo';
    res.errores.push(e.message || String(e));
  }
  res.fin = new Date().toISOString();
  await store.setJSON('ultima', res);
  if (real) await store.setJSON('pasada_' + res.inicio, res);
  return new Response('ok');
}

// El cliente pudo contestarle a Chatea Pro mientras corria la pasada, y confirmar
// una orden que ya avanzo la haria retroceder. Se relee todo justo antes, y lo que
// no aparezca o ya no este pendiente no se toca.
async function confirmar(token, res) {
  const candidatos = res.pedidos.filter((p) => p.decision === 'confirmaria');
  if (!candidatos.length) return;
  const estado = {};
  for (const o of await leerOrdenes(token, res)) estado[o.id] = o.status;

  const ids = [];
  for (const p of candidatos) {
    if (estado[p.id] === 'PENDIENTE CONFIRMACION') {
      ids.push(p.id);
    } else {
      p.decision = 'no toca';
      p.motivo = 'cambio de estado durante la pasada';
    }
  }
  for (let i = 0; i < ids.length; i += LOTE_CONFIRMAR) {
    const lote = ids.slice(i, i + LOTE_CONFIRMAR);
    let ok = false;
    try {
      const r = await fetch(`${BASE}/integrations/orders/myorder/masive`, {
        method: 'POST',
        headers: {
          'dropi-integration-key': token,
          'Content-Type': 'application/json',
          'User-Agent': 'BKDROP-Sync/1.0',
        },
        body: JSON.stringify(lote.map((id) => ({ id, status: 'PENDIENTE' }))),
      });
      ok = r.ok;
      if (!ok) res.errores.push(`confirmar: HTTP ${r.status}`);
    } catch (e) {
      res.errores.push('confirmar: ' + (e.message || 'error'));
    }
    for (const p of candidatos) {
      if (lote.includes(p.id)) p.decision = ok ? 'confirmado' : 'fallo al confirmar';
    }
    await esperar(2000);
  }
  res.confirmados = res.pedidos.filter((p) => p.decision === 'confirmado').length;
}

function claveCompra(o) {
  const producto = (((o.orderdetails || [])[0] || {}).product || {}).id || '';
  return reglas.telefonoLocal(o.phone) + '|' + producto;
}

// El cron deja un pase de un solo uso: no hay variable de entorno que configurar.
async function paseDelCron(store, pase) {
  if (!pase) return false;
  const guardado = await store.get('pase_cron', { type: 'json' });
  if (!guardado || guardado.pase !== pase || Date.now() - guardado.t > 5 * 60 * 1000) return false;
  await store.delete('pase_cron');
  return true;
}

async function historialGuardado(store, tel) {
  const h = await store.get('hist_' + tel, { type: 'json' });
  return h && Date.now() - h.t < HISTORIAL_VIGENTE_MS ? h.data : null;
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
    // 404 es un comprador sin registro: el panel de Dropi muestra "Sin registro".
    if (r.status === 404) return { found: false };
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
