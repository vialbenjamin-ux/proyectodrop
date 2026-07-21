// Build-time: escribe GOOGLE_DRIVE_SA_KEY (env var) a un archivo empaquetado
// con las Netlify Functions. Permite mantener el scope de la env var SOLO
// en "builds" (no en runtime), sacando ~2.3KB del limite 4KB de AWS Lambda.
// El archivo generado (_generated-sa.json) NO se comitea a git.

const fs = require('fs');
const path = require('path');

const saKey = process.env.GOOGLE_DRIVE_SA_KEY;
const target = path.join(__dirname, 'netlify', 'functions', '_generated-sa.json');

if (!saKey) {
  console.log('[build-sa-key] GOOGLE_DRIVE_SA_KEY no seteada - creando archivo vacio');
  fs.writeFileSync(target, '{}');
  process.exit(0);
}

try {
  JSON.parse(saKey);
} catch (e) {
  console.error('[build-sa-key] ERROR: GOOGLE_DRIVE_SA_KEY no es JSON valido:', e.message);
  process.exit(1);
}

fs.writeFileSync(target, saKey);
console.log('[build-sa-key] SA escrita en ' + target + ' (' + saKey.length + ' bytes)');
