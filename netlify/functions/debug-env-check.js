// Endpoint diagnostico TEMPORAL: verifica si estan cargadas las env vars
// del SOP Chatea+Dropi sin exponer los valores. Se borra despues de validar.
// Uso: GET /.netlify/functions/debug-env-check
// Responde: presencia (bool) y longitud (para detectar copia truncada).

exports.handler = async () => {
  const wanted = ['CHATEA_PRO_TOKEN', 'DROPI_TOKEN_CL'];
  const report = {};
  for (const k of wanted) {
    const v = process.env[k];
    report[k] = { set: !!v, length: v ? v.length : 0, preview: v ? (v.slice(0, 4) + '...' + v.slice(-4)) : null };
  }

  // Listar TODAS las env vars que empiecen con CHATEA_ o DROPI_ para detectar typos
  const relatedKeys = Object.keys(process.env)
    .filter(k => k.startsWith('CHATEA_') || k.startsWith('DROPI_') || k.startsWith('CHATE') || k.startsWith('DROP'))
    .sort();
  const related = {};
  for (const k of relatedKeys) {
    const v = process.env[k];
    related[k] = { length: v ? v.length : 0, preview: v ? (v.slice(0, 4) + '...' + v.slice(-4)) : null };
  }

  // Claims de los JWT de Dropi (solo el payload; ni el secreto ni la firma).
  // Sirve para ver de que cuenta y de que tipo de integracion es cada token.
  const jwt = {};
  for (const k of ['DROPI_TOKEN_CL', 'DROPI_TOKEN_GT']) {
    const v = String(process.env[k] || '').trim();
    if (!v) { jwt[k] = 'sin valor'; continue; }
    try {
      const parts = v.split('.');
      if (parts.length < 2) { jwt[k] = 'no parece JWT'; continue; }
      let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      const c = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
      jwt[k] = {
        iss: c.iss || null,
        sub: c.sub != null ? String(c.sub) : null,
        aud: c.aud || null,
        token_type: c.token_type || null,
        integration_type: c.integration_type || null,
        emitido: c.iat ? new Date(c.iat * 1000).toISOString().slice(0, 10) : null,
        expira: c.exp ? new Date(c.exp * 1000).toISOString().slice(0, 10) : null,
        vencido: c.exp ? (c.exp * 1000 < Date.now()) : null,
      };
    } catch (e) { jwt[k] = 'no pude decodificar: ' + (e.message || '?'); }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ report, related, jwt, timestamp: new Date().toISOString() }, null, 2),
  };
};
