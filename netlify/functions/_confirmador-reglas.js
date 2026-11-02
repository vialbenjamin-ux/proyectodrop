// Reglas del confirmador de pedidos de Dropi, para los clientes que no le
// contestan a Chatea Pro. Las fijo Benjamin el 2 nov 2026:
//   - 2 horas o mas en PENDIENTE CONFIRMACION y direccion con calle y numero.
//   - Sin historial o de 1 a 4 pedidos: se confirma.
//   - De 5 a 10 pedidos: mas de 30% de entregados.
//   - Mas de 10 pedidos: 65% o mas de entregados. En la Region Metropolitana,
//     mas de 50%, porque el envio es mas barato.
//   - % = entregados / (entregados + devueltos), sin contar los en transito.
//   - Lo que no cumple no se toca.

const HORAS_MINIMAS = 2;

// Sin numero no se puede llegar. "Sin numero" pasa aunque traiga otro digito
// (un depto, un km), porque el cliente esta diciendo que la calle no tiene.
function direccionOk(dir) {
  const d = String(dir || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (/\bsin\s*(n|num|numero|nro|no|#)\b|\bs\s*\/\s*n\b|\bsn\b/.test(d) || /sin\s*n°/.test(d)) {
    return { ok: false, motivo: 'dice sin numero' };
  }
  if (!/[a-zñ]{3,}/.test(d)) return { ok: false, motivo: 'no trae calle' };
  if (!/\d/.test(d)) return { ok: false, motivo: 'no trae numero' };
  return { ok: true };
}

// Dropi manda created_at sin zona y en hora de Chile. Se lee como UTC-3, que en
// invierno (UTC-4) deja el pedido una hora mas nuevo: se espera de mas, nunca de
// menos.
function horasDesde(createdAt, ahora) {
  const t = Date.parse(String(createdAt) + '-03:00');
  if (isNaN(t)) return null;
  return (ahora - t) / 3600000;
}

// `historial` es el `data` de bff/customers/fingerprint/v2. Si no es una
// respuesta valida NO se asume "sin historial": un error de lectura no puede
// terminar confirmando un pedido.
function decidirHistorial(historial, region) {
  if (!historial || typeof historial !== 'object' || typeof historial.found !== 'boolean') {
    return { confirma: false, motivo: 'no pude leer el historial' };
  }
  if (!historial.found) return { confirma: true, motivo: 'sin historial', pedidos: 0 };

  const t = ((historial.context_analysis || {}).all_shops) || null;
  if (!t || typeof t.period_orders !== 'number') {
    return { confirma: false, motivo: 'no pude leer el historial' };
  }
  const pedidos = t.period_orders;
  const entregados = Number(t.period_delivered) || 0;
  const devueltos = Number(t.period_returned) || 0;
  const base = entregados + devueltos;
  const pct = base > 0 ? Math.round((entregados / base) * 1000) / 10 : null;
  const datos = { pedidos, entregados, devueltos, enTransito: Number(t.period_transit) || 0, pct };

  if (pedidos <= 0) return { confirma: true, motivo: 'sin historial', ...datos };
  if (pedidos < 5) return { confirma: true, motivo: 'menos de 5 pedidos', ...datos };
  if (pct === null) return { confirma: false, motivo: 'sin entregas ni devoluciones todavia', ...datos };
  if (pedidos <= 10) {
    return pct > 30
      ? { confirma: true, motivo: '5 a 10 pedidos con mas de 30%', ...datos }
      : { confirma: false, motivo: '5 a 10 pedidos con 30% o menos', ...datos };
  }
  if (esRM(region)) {
    return pct > 50
      ? { confirma: true, motivo: 'mas de 10 pedidos en la RM con mas de 50%', ...datos }
      : { confirma: false, motivo: 'mas de 10 pedidos en la RM con 50% o menos', ...datos };
  }
  return pct >= 65
    ? { confirma: true, motivo: 'mas de 10 pedidos con 65% o mas', ...datos }
    : { confirma: false, motivo: 'mas de 10 pedidos con menos de 65%', ...datos };
}

// Dropi la escribe METROPOLITANA DE SANTIAGO.
function esRM(region) {
  return /METROPOLITANA/i.test(String(region || ''));
}

// El numero de Shopify de la nota. Una orden repetida se despacharia dos veces.
function notaShopify(notes) {
  const m = String(notes || '').match(/#\s*(\d{3,})/);
  return m ? m[1] : null;
}

function telefonoLocal(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.length === 11 && p.startsWith('56')) p = p.slice(2);
  return p;
}

module.exports = { HORAS_MINIMAS, direccionOk, horasDesde, decidirHistorial, notaShopify, telefonoLocal };
