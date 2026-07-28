// Autogenera 5 copys TikTok Ads leyendo la landing page del producto.
// Scrapea el HTML, extrae titulo/meta/h1/primera copy, y llama a Claude
// para producir 5 variantes de max 100 chars (limite ad_text TikTok).
//
// Body:
//   { landing_url: "https://benkotienda.com/products/mopa-titanio" }
//
// Respuesta:
//   { ok, copys: ["...","...","...","...","..."], productInfo: {...} }
//
// Requiere: ANTHROPIC_API_KEY en env vars de Netlify.

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

// Extrae info util del HTML de la landing (sin dependencias).
function parseLanding(html) {
  const info = { title: '', description: '', h1: '', bodySample: '', productName: '' };
  const pick = (re, s) => { const m = s.match(re); return m ? m[1].trim().replace(/\s+/g,' ') : ''; };

  info.title = pick(/<title[^>]*>([^<]+)<\/title>/i, html);
  info.description = pick(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i, html) ||
                     pick(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i, html);
  info.h1 = pick(/<h1[^>]*>([^<]+)<\/h1>/i, html);

  // og:title es lo mas confiable para nombre de producto en Shopify
  info.productName = pick(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i, html) ||
                     info.h1 || info.title;

  // Extraer parrafos de descripcion (sin tags)
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ')
    .trim();

  // Sample: encontrar donde aparece el nombre del producto y tomar los ~1500 chars siguientes
  const anchor = info.productName ? stripped.toLowerCase().indexOf(info.productName.toLowerCase()) : -1;
  const start = anchor >= 0 ? anchor : 0;
  info.bodySample = stripped.slice(start, start + 1800);
  return info;
}

async function callClaude(prompt, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('Claude ' + resp.status + ': ' + t.slice(0, 200));
  }
  const data = await resp.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  return text;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors() });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'Falta ANTHROPIC_API_KEY en env de Netlify' });

  let body;
  try { body = await req.json(); }
  catch { return json(400, { error: 'JSON invalido' }); }

  const landingUrl = String(body.landing_url || '').trim();
  if (!landingUrl) return json(400, { error: 'Falta landing_url' });
  if (!/^https?:\/\//.test(landingUrl)) return json(400, { error: 'landing_url debe ser HTTP(S)' });

  // 1. Fetch landing
  let html;
  try {
    const r = await fetch(landingUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 BKDROP-CopyGen/1.0' },
    });
    if (!r.ok) return json(502, { error: 'Landing fetch fail: ' + r.status });
    html = await r.text();
  } catch (e) {
    return json(502, { error: 'Landing fetch error: ' + (e.message || 'unknown') });
  }

  const info = parseLanding(html);
  if (!info.productName && !info.description && !info.bodySample) {
    return json(422, { error: 'No se pudo extraer info del landing', info });
  }

  // 2. Prompt Claude
  const prompt = `Eres un copywriter de TikTok Ads con foco en Chile. Necesito 5 copys DISTINTOS para probar en un anuncio de TikTok.

REGLAS ESTRICTAS:
- Cada copy MAXIMO 90 caracteres (limite duro TikTok es 100, deja margen).
- Espanol chileno neutro, sin modismos regionales fuertes.
- Estilo TikTok: informal, hook rapido, tono como si fuera un usuario recomendando.
- Los 5 DEBEN atacar angulos distintos: dolor, curiosidad, prueba social, oferta, humor/impacto.
- NADA de emojis (los limita TikTok).
- NADA de mayusculas gritadas.
- NO uses "Descubre" ni "Increible" (banal). Usa lenguaje concreto y visual.
- NO menciones "TikTok" ni "descuento porcentaje". Enfocate en el resultado del producto.

INFO DEL PRODUCTO (extraida del landing):
Producto: ${info.productName}
Meta descripcion: ${info.description}
H1: ${info.h1}
Extracto de la pagina: ${info.bodySample}

FORMATO DE RESPUESTA:
Devuelve SOLO un JSON valido con este shape exacto (nada mas):
{
  "copys": [
    {"angulo": "dolor", "texto": "..."},
    {"angulo": "curiosidad", "texto": "..."},
    {"angulo": "prueba_social", "texto": "..."},
    {"angulo": "oferta", "texto": "..."},
    {"angulo": "humor_impacto", "texto": "..."}
  ]
}`;

  let claudeText;
  try {
    claudeText = await callClaude(prompt, apiKey);
  } catch (e) {
    return json(502, { error: 'Claude call fail: ' + (e.message || 'unknown') });
  }

  // 3. Parsear respuesta Claude
  let parsed;
  try {
    // Aislar JSON (Claude a veces envuelve en ```json)
    const cleaned = claudeText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) throw new Error('sin JSON en respuesta');
    parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
  } catch (e) {
    return json(502, {
      error: 'No pude parsear respuesta Claude',
      claudeText: claudeText.slice(0, 500),
      parseError: e.message,
    });
  }

  const copys = Array.isArray(parsed.copys) ? parsed.copys : [];
  if (copys.length === 0) return json(502, { error: 'Claude devolvio 0 copys', claudeText: claudeText.slice(0, 500) });

  // Validar cada copy < 100 chars
  const safeCopys = copys.map(c => ({
    angulo: String(c.angulo || 'general').slice(0, 30),
    texto: String(c.texto || '').slice(0, 100),
  })).filter(c => c.texto.length > 0);

  return json(200, {
    ok: true,
    copys: safeCopys,
    productInfo: {
      productName: info.productName,
      title: info.title,
      description: info.description,
    },
    generatedAt: new Date().toISOString(),
  });
}
