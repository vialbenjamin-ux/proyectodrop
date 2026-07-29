// Lista las ad accounts disponibles con los tokens configurados.
// Soporta hasta 3 tokens:
//   META_ACCESS_TOKEN         → BM Principal Chile
//   META_ACCESS_TOKEN_GT      → BM Principal Guatemala
//   META_ACCESS_TOKEN_ADSPOWER → BM AdsPower (Bm Chile Seguro), mercado Chile.
//     Las cuentas que trae este token se marcan con source:'adspower' para
//     que el frontend las diferencie visualmente (badge / color).
// Endpoint: GET /.netlify/functions/meta-ad-accounts
// Responde: { accounts: [{ id, name, currency, status, tenant, source }] }
//
// Anti-ban: secuencia los tokens con ≥3s entre llamadas, parsea error.code
// (368, 190, 17/32) y devuelve códigos específicos al frontend.

const meta = require('./_meta-api');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const tokens = [
    { tenant: 'chile', source: 'principal', token: process.env.META_ACCESS_TOKEN },
    { tenant: 'gt',    source: 'principal', token: process.env.META_ACCESS_TOKEN_GT },
    { tenant: 'chile', source: 'adspower',  token: process.env.META_ACCESS_TOKEN_ADSPOWER },
    { tenant: 'cp',    source: 'principal', token: process.env.META_ACCESS_TOKEN_CP },
  ].filter(t => t.token);

  if (!tokens.length) {
    return respond(500, { error: 'META_ACCESS_TOKEN no configurada en el servidor' });
  }

  const allAccounts = [];
  const errors = [];

  // Permite filtrar a un solo tenant si viene ?tenant=gt|chile
  const params = event.queryStringParameters || {};
  const filterTenant = (params.tenant || '').toLowerCase();
  const tokensToUse = filterTenant ? tokens.filter(t => t.tenant === filterTenant) : tokens;

  // Set de ids ya vistas para dedupe (un mismo ad account puede aparecer via
  // varios tokens si esta compartido). El primer token que la ve, gana; los
  // siguientes la saltan.
  const seenIds = new Set();

  // Si hay >1 token, secuenciamos con delay para no levantar alertas de Meta.
  for (let i = 0; i < tokensToUse.length; i++) {
    const { tenant, source, token } = tokensToUse[i];
    if (i > 0) await meta.delay(); // ≥3s entre llamadas a Meta
    const url = `https://graph.facebook.com/${meta.META_API_VERSION}/me/adaccounts?fields=id,name,account_status,currency&limit=200&access_token=${encodeURIComponent(token)}`;
    try {
      const data = await meta.fetchOne(url);
      (data.data || []).forEach(a => {
        if (seenIds.has(a.id)) return; // dedupe: ya la vio otro token
        seenIds.add(a.id);
        allAccounts.push({
          id: a.id,
          name: a.name,
          currency: a.currency,
          status: a.account_status,
          tenant,
          source,
        });
      });
    } catch (err) {
      // Antes: cortabamos al primer error crítico (368/190/rate). Problema:
      // si UN token caduca, el resto se pierde. Ahora acumulamos y seguimos.
      // Solo devolvemos error si TODOS fallaron y no hay accounts al final.
      errors.push({
        tenant,
        source,
        error: err.message || 'Error consultando Meta',
        code: err.code || null,
        type: err.type || null,
      });
    }
  }

  // Marcar como source:'adspower' las cuentas cuyos IDs estén en el env var
  // META_ADSPOWER_ACCOUNT_IDS (comma-separated). Ruta corta: en vez de crear
  // un token nuevo para el BM AdsPower, se comparte la cuenta al BM Principal
  // y solo se lista qué IDs pertenecen a AdsPower. El token existente ya la ve.
  const adsPowerIdsRaw = (process.env.META_ADSPOWER_ACCOUNT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const adsPowerIds = new Set();
  for (const id of adsPowerIdsRaw) {
    adsPowerIds.add(id);
    adsPowerIds.add(id.replace(/^act_/, '')); // tolerar con o sin prefijo
    adsPowerIds.add('act_' + id.replace(/^act_/, ''));
  }
  if (adsPowerIds.size > 0) {
    for (const a of allAccounts) {
      if (adsPowerIds.has(a.id) || adsPowerIds.has(String(a.id).replace(/^act_/, ''))) {
        a.source = 'adspower';
      }
    }
  }

  // Si TODOS los tokens fallaron, devolver error
  if (allAccounts.length === 0 && errors.length > 0) {
    return respond(500, { error: errors.map(e => `${e.tenant.toUpperCase()}: ${e.error}`).join(' · ') });
  }

  return respond(200, { accounts: allAccounts, errors });
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(payload),
  };
}
