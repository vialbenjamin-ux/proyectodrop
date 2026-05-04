// Lista las ad accounts disponibles con los tokens configurados.
// Soporta hasta 2 tokens (META_ACCESS_TOKEN y META_ACCESS_TOKEN_2) para
// poder mostrar cuentas de dos perfiles distintos en el mismo dropdown.
// Endpoint: GET /.netlify/functions/meta-ad-accounts
// Responde: { accounts: [{ id, name, currency, status, tokenIdx }] }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const tokens = [
    { tenant: 'chile', token: process.env.META_ACCESS_TOKEN },
    { tenant: 'gt',    token: process.env.META_ACCESS_TOKEN_GT },
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

  for (const { tenant, token } of tokensToUse) {
    const url = `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_status,currency&limit=200&access_token=${encodeURIComponent(token)}`;
    try {
      const resp = await fetch(url);
      const data = await resp.json();
      if (!resp.ok) {
        errors.push({ tenant, error: data?.error?.message || ('HTTP ' + resp.status) });
        continue;
      }
      (data.data || []).forEach(a => {
        allAccounts.push({
          id: a.id,
          name: a.name,
          currency: a.currency,
          status: a.account_status,
          tenant,
        });
      });
    } catch (err) {
      errors.push({ tenant, error: err.message || 'Error consultando Meta' });
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
