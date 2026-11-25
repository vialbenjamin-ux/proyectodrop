// Dispara la pasada del RESCATE DE NOVEDADES cada 30 min (ver _rescate.js).
// Separado porque una scheduled function no aguanta lo que tarda leer Dropi.

import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

export default async function handler() {
  const origin = process.env.URL || 'https://bkdrop.netlify.app';
  const store = getStore({ name: 'bk-rescate', consistency: 'strong' });
  if ((await store.get('modo')) === 'apagado') return new Response('apagado');
  const pase = randomUUID();
  await store.setJSON('pase_cron', { pase, t: Date.now() });
  const r = await fetch(`${origin}/.netlify/functions/rescate-background?pase=${pase}`, { method: 'POST' });
  return new Response(JSON.stringify({ ok: r.ok, status: r.status }), { headers: { 'Content-Type': 'application/json' } });
}

export const config = { schedule: '*/30 * * * *' };
