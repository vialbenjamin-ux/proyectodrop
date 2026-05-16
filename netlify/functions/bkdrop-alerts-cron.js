// Scheduled function que dispara bkdrop-alerts (HTTP) cada 15 minutos.
// Separado del endpoint HTTP porque Netlify no permite tener `schedule` y
// `path` en el config de la misma función.

export default async function handler() {
  const origin = process.env.URL || 'https://bkdrop.netlify.app';
  try {
    const r = await fetch(`${origin}/.netlify/functions/bkdrop-alerts`);
    const text = await r.text();
    return new Response(JSON.stringify({ ok: r.ok, status: r.status, body: text.slice(0, 500) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message || 'fetch error' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export const config = { schedule: '*/15 * * * *' };
