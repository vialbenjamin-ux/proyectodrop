// Endpoint diagnostico TEMPORAL: verifica si estan cargadas las env vars
// del SOP Chatea+Dropi sin exponer los valores. Se borra despues de validar.
// Uso: GET /.netlify/functions/debug-env-check
// Responde: presencia (bool) y longitud (para detectar copia truncada).

exports.handler = async () => {
  const checks = {
    CHATEA_PRO_TOKEN: process.env.CHATEA_PRO_TOKEN,
    DROPI_TOKEN_CL:   process.env.DROPI_TOKEN_CL,
  };

  const report = {};
  for (const [k, v] of Object.entries(checks)) {
    report[k] = {
      set: !!v,
      length: v ? v.length : 0,
      preview: v ? (v.slice(0, 4) + '...' + v.slice(-4)) : null,
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ report, timestamp: new Date().toISOString() }, null, 2),
  };
};
