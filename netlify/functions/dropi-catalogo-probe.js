// TEMPORAL: prueba si la llave de integracion lee el catalogo del panel, para
// la foto de BENSTOCKY sin sesion. Solo lectura. Se borra despues de la prueba.
// GET /.netlify/functions/dropi-catalogo-probe?tenant=chile|gt

const PAISES = {
  chile: { api: 'https://api.dropi.cl', env: 'DROPI_TOKEN_CL' },
  gt: { api: 'https://api.dropi.gt', env: 'DROPI_TOKEN_GT' },
};

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const pais = PAISES[qs.tenant === 'gt' ? 'gt' : 'chile'];
  const token = process.env[pais.env];
  if (!token) return respond(500, { error: 'Falta ' + pais.env });

  const cuerpo = JSON.stringify({ privated_product: false, bod: null, stockmayor: null, no_count: true, order_by: 'id', order_type: 'asc', pageSize: 2, startData: 0, notNulldescription: false, userVerified: false, category: null, active: true, favorite: false, with_collection: true, get_stock: false, keywords: '' });
  const formas = {
    'x-authorization': { 'x-authorization': 'Bearer ' + token },
    authorization: { Authorization: 'Bearer ' + token },
    'dropi-integration-key': { 'dropi-integration-key': token },
  };

  const resultados = {};
  for (const [nombre, headers] of Object.entries(formas)) {
    try {
      const t0 = Date.now();
      const r = await fetch(pais.api + '/api/products/v4/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: cuerpo,
      });
      const texto = await r.text();
      let j = null;
      try { j = JSON.parse(texto); } catch (_) {}
      const objs = (j && j.objects) || [];
      const o = objs[0];
      resultados[nombre] = {
        status: r.status,
        ms: Date.now() - t0,
        productos: objs.length,
        mensaje: j && !objs.length ? String(j.message || '').slice(0, 120) : undefined,
        muestra: o ? { id: o.id, nombre: o.name, tieneBodegas: Array.isArray(o.warehouse_product), bodegas: (o.warehouse_product || []).length, tieneReservado: Array.isArray(o.private_product_inventories), tieneVariaciones: Array.isArray(o.variations) } : undefined,
      };
    } catch (e) {
      resultados[nombre] = { error: String(e.message || e).slice(0, 120) };
    }
    await espera(1500);
  }
  return respond(200, resultados);
};

function respond(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
