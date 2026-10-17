// Scheduled function que dispara dropi-auto-variantes-background dos veces al
// dia (08:00 y 20:00 de Chile), una vez por pais. Separado del endpoint HTTP
// porque Netlify no permite tener `schedule` y `path` en el config de la misma
// función. Cada 12 horas alcanza: son pocos los productos con variantes.
// En la misma pasada revisa que los upsells de Releasit cobren lo ofrecido.

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
  // Red de seguridad de los upsells de Releasit: si alguno quedo con connDisc
  // mal (se cobra el precio de lista en vez del ofrecido, #32117 del 17 oct
  // 2026), fix_disc lo recalcula. Corre en cada pasada, en las dos tiendas.
  await Promise.all(['chile', 'gt'].map(async (tenant) => {
    try {
      const r = await fetch(`${origin}/.netlify/functions/shopify-releasit-upsell`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant, action: 'fix_disc' }),
      });
      const j = await r.json().catch(() => ({}));
      out['upsell_' + tenant] = { status: r.status, corregidos: (j.cambios || []).length, problemasActivos: (j.problemas || []).filter((p) => p.isActive).length };
    } catch (e) {
      out['upsell_' + tenant] = 'error: ' + (e.message || 'fetch error');
    }
  }));
  return new Response(JSON.stringify({ ok: true, out }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const config = { schedule: '0 11,23 * * *' };
