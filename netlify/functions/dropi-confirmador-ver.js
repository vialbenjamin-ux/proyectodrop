// Devuelve la ultima pasada del confirmador. Trae datos de clientes, por eso
// pide la clave.
//
// GET /.netlify/functions/dropi-confirmador-ver?clave=...

import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

const HUELLA_CLAVE = '9e444ac260068bb9b9b3d58a77cbfcb227b0d67479990eb8b8c049910166770b';

export default async function handler(req) {
  const clave = new URL(req.url).searchParams.get('clave') || '';
  if (createHash('sha256').update(clave).digest('hex') !== HUELLA_CLAVE) {
    return new Response('No autorizado', { status: 403 });
  }
  const store = getStore({ name: 'bk-confirmador', consistency: 'strong' });
  const ultima = await store.get('ultima', { type: 'json' });
  return new Response(JSON.stringify(ultima || { estado: 'sin pasadas' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
