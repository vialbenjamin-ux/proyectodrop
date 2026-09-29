// Rubro de un producto: para que el upsell se PAREZCA a lo que se esta
// vendiendo y no sea simplemente lo mas barato del proveedor.
//
// Vivia dentro de dropi-supplier-shopify-products.js, donde solo lo usaba el
// buscador manual. El upsell AUTOMATICO de Releasit elegia por palabras
// repetidas en el titulo y, cuando no habia ninguna (el caso normal), se
// quedaba con el candidato mas barato: de ahi salian los upsells que no pegan
// con nada. Movido aca el 28 sep 2026 para que las dos rutas midan igual.
const RUBROS = {
  cocina: ['cocina', 'cocin', 'aliment', 'comida', 'refri', 'nevera', 'hervidor', 'olla', 'sarten', 'cuchill', 'tijera', 'rallador', 'pelador', 'picad', 'huevo', 'cafe', 'vaso', 'taza', 'botella', 'termo$', 'termos$', 'bolsa', 'sellador', 'hermetic', 'conserva', 'especia$', 'especias$', 'aceite', 'mezcl', 'batidor', 'licuad', 'exprim', 'jugo', 'balanza', 'horno', 'parrilla', 'asado', 'lavaloza', 'salpicadura', 'masas$', 'amasa', 'tortilla', 'sopaipilla', 'desmenuz'],
  limpieza: ['limpi', 'lavaloza', 'jabon', 'detergente', 'destap', 'caneria', 'antisarro', 'sarro', 'mancha', 'pelusa', 'escoba', 'trapeador', 'desinfect', 'espuma', 'quita', 'cepillo', 'lavadora'],
  bano: ['bano', 'ducha', 'inodoro', 'toalla', 'antimoho', 'moho'],
  // El cuidado bucal es su propio rubro: "cepillo" solo caia en limpieza y un
  // esterilizador de cepillos de dientes terminaba emparejado con escobas.
  dental: ['dental', 'diente', 'dientes', 'denti', 'dentif', 'bucal', 'boca$', 'encia', 'encias', 'sonrisa', 'ortodonc', 'enjuague', 'sarro', 'aliento'],
  organizacion: ['organiz', 'perchero', 'zapatero', 'colgador', 'tendedero', 'estante', 'repisa', 'gancho', 'cajon', 'almacen'],
  exterior: ['jardin', 'solar', 'guirnalda', 'exterior', 'planta$', 'plantas$', 'riego', 'manguera'],
  auto: ['auto$', 'autos$', 'automovil', 'carro', 'vehicul', 'asiento', 'volante', 'parabris'],
  mascota: ['mascota', 'perro', 'gato$', 'gatos$'],
  belleza: ['crema$', 'cremas$', 'piel', 'facial', 'cabello', 'pestana', 'maquill', 'cosmet', 'blanque', 'depil'],
  plagas: ['raton', 'ratones', 'roedor', 'plaga', 'insecto', 'mosca', 'mosquito', 'cucaracha', 'repelente', 'ultrasonic', 'ahuyent', 'trampa', 'zancud', 'polilla', 'hormig'],
  bienestar: ['dolor', 'masaj', 'postura', 'cervical', 'cuello', 'espalda', 'rodilla', 'insomnio', 'ronquido', 'ejercit', 'terapia', 'muscul', 'fascia', 'relaj'],
  tecnologia: ['bluetooth', 'audifon', 'parlante', 'cargador', 'usb', 'lampara', 'camara', 'tablet', 'celular'],
  ninos: ['bebe$', 'bebes$', 'nino', 'infantil', 'juguete', 'motriz'],
};

// Sin tildes y en minusculas. \p{Diacritic} en vez del rango de combinantes
// literal: el rango escrito a mano se corrompia al pasar el archivo por
// herramientas que no respetan UTF-8.
function normTxt(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

// Cada clave calza al COMIENZO de una palabra ("cocin" -> cocina, cocinar);
// con "$" al final tiene que ser la palabra exacta. Buscar en cualquier parte
// daba falsos positivos: "masa" en "masajeadora", "auto" en "automatico".
function rubrosDe(texto) {
  const palabras = normTxt(texto).split(/[^a-z0-9]+/).filter(Boolean);
  const calza = (k) => (k.slice(-1) === '$'
    ? palabras.indexOf(k.slice(0, -1)) !== -1
    : palabras.some((w) => w.indexOf(k) === 0));
  const out = [];
  for (const r of Object.keys(RUBROS)) if (RUBROS[r].some(calza)) out.push(r);
  return out;
}

// El titulo no alcanza para el rubro ("Bolsas Frescura Pro"); la descripcion
// y las categorias de Dropi, cuando existen, dicen mucho mas.
//
// Cuando NO existen si hay que caer al nombre de Dropi: el Esterilizador
// dental de Guatemala (22177) trae categories vacio y una descripcion que es
// una fila de guiones, asi que quedaba "sin rubro" y el upsell se decidia por
// precio -- eligio un suero antihongos teniendo DentiOK en la misma bodega
// (28 sep 2026). Ojo: es el nombre de DROPI ("Esterilizador dental"), no el
// titulo de Shopify, que lleva el sello y la promesa y no describe nada.
function textoDe(meta) {
  const cats = Array.isArray(meta && meta.categories)
    ? meta.categories.map((c) => (c && (c.name || c.title)) || (typeof c === 'string' ? c : '')).join(' ')
    : '';
  const desc = String((meta && meta.description) || '').replace(/<[^>]+>/g, ' ').slice(0, 1500);
  const texto = cats + ' ' + desc;
  if (/[a-zA-ZÀ-ɏ]{3}/.test(texto)) return texto;
  return String((meta && meta.name) || '');
}

// Un pack no sirve de upsell: el cliente ve "2x1" y Dropi despacha una unidad.
function esPack(titulo) {
  return /\b\d\s*x\s*\d\b/i.test(String(titulo || ''));
}

// Palabras propias del titulo, para medir parecido cuando el rubro no alcanza.
const STOP = new Set(['de', 'la', 'el', 'y', 'o', 'en', 'a', 'con', 'por', 'para', 'del', 'al',
  'un', 'una', 'los', 'las', 'sin', 'pack', 'set', 'x1', 'x2', 'x3', '2x1', '3x1',
  'oferta', 'nuevo', 'pro', 'plus', 'max', 'mini', 'mega', 'premium', 'original']);
function palabrasClave(titulo) {
  return normTxt(titulo).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
}

module.exports = { RUBROS, normTxt, rubrosDe, textoDe, esPack, palabrasClave, STOP };
