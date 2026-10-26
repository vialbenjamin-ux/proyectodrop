// Recrea en Dropi los pedidos de productos con variantes que la sincronizacion
// de Dropi rebota con "Esta orden no tiene productos dropi".
//
// Por que existe: entre el 5 y el 12 oct 2026 no entro solo NINGUN pedido con
// barcode de variante (<id>-<variacion>): rueda abdominal y camara en Chile,
// parche de cuero en Guatemala, 0 de 46. Crear la orden con dropi-create-order
// mandando el barcode funciona siempre, asi que esto hace a mano-automatica lo
// que se venia haciendo a mano.
//
// GET ?tenant=chile|gt [&dry=1] [&hours=48]
//   Crea UNA orden por llamada (la mas antigua pendiente): dropi-create-order
//   corta por rate limit si se le mandan seguidas. La llama en bucle, con 36 s
//   de pausa, dropi-auto-variantes-background, que el cron dispara cada 12 h.
//
// Solo toma pedidos que cumplen TODO esto:
//   - tag "Dropi Sync Error" y sin "Order sent to dropi"
//   - la nota de Dropi dice "no tiene productos dropi"
//   - todos los items traen barcode <id>-<variacion> del MISMO producto
//     (un pedido con upsell de otro producto no se toca: puede ser otra bodega)
//   - tiene direccion y ciudad
//   - tiene mas de 10 minutos (por si la sincronizacion normal lo alcanza)
//   - no esta en bkdrop_huerfanos_created y no fallo ya 3 veces
//
// Respuesta: { ok, tenant, candidatos, creado | pendiente | nada, ... }

const FS = 'https://firestore.googleapis.com/v1/projects/bkdrop-5c8df/databases/(default)/documents/';
const MAX_INTENTOS = 3;

const { pais } = require('./_tenant');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  const q = event.queryStringParameters || {};
  const P = pais(q.tenant);
  if (P.error) return respond(400, { ok: false, error: P.error });
  const tenant = P.codigo;
  const dry = q.dry === '1';
  const hours = Math.min(Math.max(parseInt(q.hours, 10) || 48, 1), 168);
  const origin = process.env.URL || 'https://bkdrop.netlify.app';

  try {
    const r = await fetch(`${origin}/.netlify/functions/shopify-orders-detailed?tenant=${tenant}&hours=${hours}`);
    const data = await r.json();
    const ahora = Date.now();
    const candidatos = (data.orders || [])
      .filter((o) => esRebotePorVariante(o) && ahora - new Date(o.created_at).getTime() > 10 * 60 * 1000)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const vistos = [];
    for (const o of candidatos) {
      const num = String(o.name || '').replace(/^#/, '');
      if (await existeDoc('bkdrop_huerfanos_created/' + num)) continue;
      const fallo = await leerDoc('bkdrop_huerfanos_auto/' + tenant + '-' + num);
      const intentos = fallo ? parseInt((fallo.fields.intentos || {}).integerValue || '0', 10) : 0;
      if (intentos >= MAX_INTENTOS) { vistos.push({ pedido: o.name, saltado: 'fallo ' + intentos + ' veces' }); continue; }

      if (dry) { vistos.push({ pedido: o.name, items: o.items.map((i) => i.barcode + ' x' + i.qty), total: o.total }); continue; }

      const partes = String(o.customer_name || '').trim().split(/\s+/);
      const body = {
        tenant,
        name: partes[0] || 'Cliente',
        surname: partes.slice(1).join(' ') || '-',
        phone: o.phone, email: o.email || '',
        dir: o.address, city: o.city, state: o.province,
        items: o.items.map((i) => ({ sku: i.sku || '', name: i.name, qty: i.qty, price: i.price, barcode: String(i.barcode) })),
        total: o.total,
        notes: 'Shopify #' + num,
      };
      const cr = await fetch(`${origin}/.netlify/functions/dropi-create-order`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const res = await cr.json().catch(() => ({}));

      if (cr.ok && res.ok) {
        await escribirDoc('bkdrop_huerfanos_created/' + num, {
          shopifyName: { stringValue: o.name },
          tenant: { stringValue: tenant },
          customerName: { stringValue: o.customer_name || '' },
          total: { integerValue: String(Math.round(o.total || 0)) },
          auto: { booleanValue: true },
          yaExistia: { booleanValue: res.yaExistia === true },
          createdAt: { timestampValue: new Date().toISOString() },
        });
        return respond(200, { ok: true, tenant, candidatos: candidatos.length, creado: o.name, yaExistia: res.yaExistia === true, warehouseUsed: res.warehouseUsed || null });
      }

      const motivo = String(res.error || res.hint || 'HTTP ' + cr.status).slice(0, 300);
      await escribirDoc('bkdrop_huerfanos_auto/' + tenant + '-' + num, {
        shopifyName: { stringValue: o.name },
        tenant: { stringValue: tenant },
        intentos: { integerValue: String(intentos + 1) },
        ultimoError: { stringValue: motivo },
        updatedAt: { timestampValue: new Date().toISOString() },
      });
      return respond(200, { ok: true, tenant, candidatos: candidatos.length, fallo: o.name, intentos: intentos + 1, motivo });
    }

    return respond(200, { ok: true, tenant, dry, candidatos: candidatos.length, pendientes: vistos, nada: !vistos.length });
  } catch (e) {
    return respond(500, { ok: false, tenant, error: e.message || String(e) });
  }
};

function esRebotePorVariante(o) {
  const tags = String(o.tags || '');
  if (!/Dropi Sync Error/.test(tags) || /Order sent to dropi/.test(tags)) return false;
  if (!/no tiene productos dropi/i.test(String(o.note || ''))) return false;
  if (!o.address || !o.city) return false;
  const items = o.items || [];
  if (!items.length) return false;
  if (!items.every((i) => /^\d+-\d+$/.test(String(i.barcode || '')))) return false;
  const base = String(items[0].barcode).split('-')[0];
  return items.every((i) => String(i.barcode).split('-')[0] === base);
}

async function leerDoc(path) {
  const r = await fetch(FS + path);
  return r.ok ? r.json() : null;
}

async function existeDoc(path) {
  return (await leerDoc(path)) !== null;
}

async function escribirDoc(path, fields) {
  await fetch(FS + path, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }),
  });
}

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
}

function respond(statusCode, body) {
  return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json' }, cors()), body: JSON.stringify(body) };
}
