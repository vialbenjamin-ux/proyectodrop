// Build-time: escribe GOOGLE_DRIVE_SA_KEY (env var) a un archivo empaquetado
// con las Netlify Functions. Permite mantener el scope de la env var SOLO
// en "builds" (no en runtime), sacando ~2.3KB del limite 4KB de AWS Lambda.
// El archivo generado (_generated-sa.json) NO se comitea a git.

const fs = require('fs');
const path = require('path');

let saKey = process.env.GOOGLE_DRIVE_SA_KEY;
const target = path.join(__dirname, 'netlify', 'functions', '_generated-sa.json');

if (!saKey) {
  console.log('[build-sa-key] GOOGLE_DRIVE_SA_KEY no seteada - creando archivo vacio');
  fs.writeFileSync(target, '{}');
  process.exit(0);
}

// Sanitizar: quitar BOM U+FEFF (se agrega si se escribio el valor con
// PowerShell Set-Content -Encoding UTF8) y whitespace/newlines en bordes.
if (saKey.charCodeAt(0) === 0xFEFF) saKey = saKey.slice(1);
saKey = saKey.trim();

try {
  JSON.parse(saKey);
} catch (e) {
  console.error('[build-sa-key] ERROR: GOOGLE_DRIVE_SA_KEY no es JSON valido:', e.message);
  console.error('[build-sa-key] Primeros 60 chars:', JSON.stringify(saKey.slice(0, 60)));
  console.error('[build-sa-key] charCodes[0..3]:', [0,1,2,3].map(i => saKey.charCodeAt(i)));
  process.exit(1);
}

fs.writeFileSync(target, saKey);
console.log('[build-sa-key] SA escrita en ' + target + ' (' + saKey.length + ' bytes)');
