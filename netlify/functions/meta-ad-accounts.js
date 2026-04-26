// Lista las ad accounts disponibles con el token configurado.
// Endpoint: GET /.netlify/functions/meta-ad-accounts
// Responde: { accounts: [{ id, name, currency, status }] }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: 'Method not allowed' });
  }

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    return respond(500, { error: 'META_ACCESS_TOKEN no configurada en el servidor' });
  }

  const url = `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_status,currency&limit=200&access_token=${encodeURIComponent(token)}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) {
      return respond(resp.status, { error: data?.error?.message || 'Error consultando Meta' });
    }
    const accounts = (data.data || []).map(a => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      // 1=ACTIVE, 2=DISABLED, 3=UNSETTLED, 7=PENDING_RISK_REVIEW, 8=PENDING_SETTLEMENT,
      // 9=IN_GRACE_PERIOD, 100=PENDING_CLOSURE, 101=CLOSED, 201=ANY_ACTIVE, 202=ANY_CLOSED
      status: a.account_status,
    }));
    return respond(200, { accounts });
  } catch (err) {
    return respond(500, { error: err.message || 'Error consultando Meta' });
  }
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
