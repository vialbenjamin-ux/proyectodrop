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

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ report, related, timestamp: new Date().toISOString() }, null, 2),
  };
};
