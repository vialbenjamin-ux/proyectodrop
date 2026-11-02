// Scheduled function que dispara el confirmador de pedidos cada 4 horas. Separado
// porque una scheduled function no aguanta los minutos que tarda la pasada.

import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

export default async function handler() {
  const origin = process.env.URL || 'https://bkdrop.netlify.app';
  const store = getStore({ name: 'bk-confirmador', consistency: 'strong' });
  const pase = randomUUID();
  await store.setJSON('pase_cron', { pase, t: Date.now() });
  const r = await fetch(`${origin}/.netlify/functions/dropi-confirmador-background?pase=${pase}`, { method: 'POST' });
  return new Response(JSON.stringify({ ok: r.ok, status: r.status }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const config = { schedule: '0 */4 * * *' };
