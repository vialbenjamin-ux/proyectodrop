// Scheduled function que dispara dropi-auto-variantes-background dos veces al
// dia (08:00 y 20:00 de Chile), una vez por pais. Separado del endpoint HTTP
// porque Netlify no permite tener `schedule` y `path` en el config de la misma
// función. Cada 12 horas alcanza: son pocos los productos con variantes.

export default async function handler() {
  const origin = process.env.URL || 'https://bkdrop.netlify.app';
  const out = {};
  await Promise.all(['chile', 'gt'].map(async (tenant) => {
    try {
      const r = await fetch(`${origin}/.netlify/functions/dropi-auto-variantes-background?tenant=${tenant}`);
      out[tenant] = r.status;
    } catch (e) {
      out[tenant] = 'error: ' + (e.message || 'fetch error');
    }
  }));
  return new Response(JSON.stringify({ ok: true, out }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const config = { schedule: '0 11,23 * * *' };
