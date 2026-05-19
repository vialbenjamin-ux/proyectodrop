// Helper compartido para llamadas a Meta Marketing API con protecciones anti-ban.
// Centraliza:
//  - Parse de error.code (368, 190, 17/32/613, 4, 10, 100, 80000, 80004) → throw específico.
//  - Intervalo mínimo entre llamadas (≥3s) cuando se hace una secuencia.
//  - Backoff exponencial con jitter en reintentos (errores 1/2 = API down, 100 = field unknown).
//  - Logging a console (visible en Netlify Functions Logs).
//
// USO TÍPICO:
//   const meta = require('./_meta-api');
//   try {
//     const data1 = await meta.fetchOne(url1);
//     await meta.delay();
//     const data2 = await meta.fetchOne(url2);
//   } catch (err) {
//     if (err.code === 368) return respond(503, { error: 'POLICY_VIOLATION', message: '...' });
//     if (err.isRateLimit)   return respond(429, { error: 'RATE_LIMIT', wait: err.retryAfter });
//     if (err.tokenInvalid)  return respond(401, { error: 'TOKEN_INVALID' });
//     throw err;
//   }

const META_API_VERSION = 'v21.0';
const MIN_INTERVAL_MS  = 3000;     // entre llamadas a Meta
const MAX_RETRIES      = 3;        // para errores transitorios (1, 2)
const BASE_BACKOFF_MS  = 2000;

// Mapa de códigos de error de Meta → cómo reaccionamos.
// Referencia: https://developers.facebook.com/docs/marketing-apis/error-reference/
const ERROR_TAXONOMY = {
  368:   { type: 'policy_violation',  retriable: false, message: 'Meta marcó esta cuenta. No continuamos.' },
  190:   { type: 'token_invalid',     retriable: false, message: 'El token expiró o fue revocado. Regenerá uno nuevo.' },
  10:    { type: 'permissions',       retriable: false, message: 'El token no tiene los permisos necesarios.' },
  17:    { type: 'rate_limit_user',   retriable: false, message: 'Meta pidió esperar antes de seguir.' },
  32:    { type: 'rate_limit_user',   retriable: false, message: 'Meta pidió esperar antes de seguir.' },
  613:   { type: 'rate_limit_user',   retriable: false, message: 'Meta pidió esperar antes de seguir.' },
  4:     { type: 'rate_limit_app',    retriable: false, message: 'Límite de la app alcanzado.' },
  341:   { type: 'rate_limit_app',    retriable: false, message: 'Límite de la app alcanzado.' },
  80000: { type: 'rate_limit_ads',    retriable: false, message: 'Meta pidió esperar antes de seguir.' },
  80004: { type: 'rate_limit_ads',    retriable: false, message: 'Meta pidió esperar antes de seguir.' },
  1:     { type: 'api_down',          retriable: true,  message: 'Meta tiene un problema temporal.' },
  2:     { type: 'api_down',          retriable: true,  message: 'Meta tiene un problema temporal.' },
  100:   { type: 'field_unknown',     retriable: false, message: 'Petición con campos inválidos.' },
};

// Lanza un error tipado con info útil para el handler. NO loggea el token.
function throwMetaError(payload, url) {
  const err = (payload && payload.error) || {};
  const code = Number(err.code);
  const subcode = Number(err.error_subcode);
  const tax = ERROR_TAXONOMY[code] || { type: 'unknown', retriable: false, message: err.message || 'Error de Meta' };
  const e = new Error(`Meta ${code}${subcode ? ('.' + subcode) : ''}: ${err.message || tax.message}`);
  e.code = code;
  e.subcode = subcode;
  e.type = tax.type;
  e.message_es = tax.message;
  e.retriable = tax.retriable;
  e.isPolicyViolation = code === 368;
  e.isRateLimit = ['rate_limit_user', 'rate_limit_app', 'rate_limit_ads'].includes(tax.type);
  e.tokenInvalid = code === 190 || code === 10;
  // Log sin URL completa (el token va en la URL — lo enmascaramos)
  console.error('[meta-api] Error:', e.message, 'url=', maskTokenInUrl(url));
  throw e;
}

function maskTokenInUrl(url) {
  if (!url) return '';
  return String(url).replace(/access_token=[^&]+/, 'access_token=***');
}

// fetch a Meta con parse de error + retries para errores 1/2.
async function fetchOne(url, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, opts);
      const data = await resp.json();
      if (!resp.ok || (data && data.error)) {
        // Meta a veces devuelve 200 con error.code en el body
        if (data && data.error) {
          try { throwMetaError(data, url); }
          catch (e) {
            if (!e.retriable) throw e;
            lastErr = e;
            // backoff con jitter
            const wait = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 1000;
            console.warn(`[meta-api] retry ${attempt + 1}/${MAX_RETRIES} en ${Math.round(wait)}ms (${e.type})`);
            await sleep(wait);
            continue;
          }
        }
        throw new Error('Meta HTTP ' + resp.status);
      }
      return data;
    } catch (e) {
      if (e.code === 368 || e.tokenInvalid || e.isRateLimit) throw e; // no reintentar
      lastErr = e;
      const wait = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 1000;
      console.warn(`[meta-api] retry ${attempt + 1}/${MAX_RETRIES} en ${Math.round(wait)}ms (${e.message})`);
      await sleep(wait);
    }
  }
  throw lastErr || new Error('Meta API: max retries excedido');
}

// Espera mínima entre llamadas a Meta (default 3s). Usar en secuencias.
function delay(ms = MIN_INTERVAL_MS) {
  return sleep(ms);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Convierte un error de Meta en un response HTTP apropiado para el frontend.
// Cualquier endpoint puede usarlo en su catch.
function metaErrorToResponse(err, respondFn) {
  if (err.isPolicyViolation) {
    return respondFn(503, {
      error: 'META_POLICY_VIOLATION',
      code: 368,
      message: 'Meta marcó esta cuenta como problemática. No podemos seguir consultándola por ahora. Revisá Business Manager → Configuración → Avisos.',
      action: 'STOP',
    });
  }
  if (err.tokenInvalid) {
    return respondFn(401, {
      error: 'META_TOKEN_INVALID',
      code: err.code,
      message: 'El token de Meta caducó o fue revocado. Regeneralo desde Business Manager → Usuarios del sistema.',
      action: 'REGENERATE_TOKEN',
    });
  }
  if (err.isRateLimit) {
    return respondFn(429, {
      error: 'META_RATE_LIMIT',
      code: err.code,
      message: 'Meta pidió esperar unos minutos antes de seguir consultando. Reintentá en 5-10 minutos.',
      action: 'WAIT',
    });
  }
  return respondFn(502, {
    error: 'META_ERROR',
    code: err.code || null,
    message: err.message || err.message_es || 'Error consultando Meta',
  });
}

module.exports = {
  META_API_VERSION,
  MIN_INTERVAL_MS,
  fetchOne,
  delay,
  sleep,
  metaErrorToResponse,
  maskTokenInUrl,
};
