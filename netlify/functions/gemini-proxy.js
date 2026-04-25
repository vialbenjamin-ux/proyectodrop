// Proxy a Gemini con streaming response (Netlify Functions V2).
// Usa streamGenerateContent de Gemini con SSE → reenvía el stream
// directo al frontend. Esto evita el timeout de 26s de las funciones
// sync (Netlify mantiene la conexión mientras llegan datos).
//
// Endpoint: POST /.netlify/functions/gemini-proxy
// Body: { prompt, fileUri?, mimeType?, model? }
// Respuesta: text/event-stream con chunks SSE de Gemini.

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const apiKey = Netlify.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    return jsonResponse(500, { error: 'GEMINI_API_KEY no configurada' });
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse(400, { error: 'JSON inválido' }); }

  const prompt = (body.prompt || '').trim();
  if (!prompt) return jsonResponse(400, { error: 'Falta el campo "prompt"' });

  const model = body.model || 'gemini-2.5-flash';

  const parts = [];
  if (body.fileUri && body.mimeType) {
    parts.push({ fileData: { mimeType: body.mimeType, fileUri: body.fileUri } });
  }
  parts.push({ text: prompt });

  const maxOutputTokens = body.fileUri ? 16384 : 8192;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${apiKey}`;

  let geminiResp;
  try {
    geminiResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.7, maxOutputTokens },
      }),
    });
  } catch (err) {
    return jsonResponse(500, { error: 'No se pudo contactar a Gemini: ' + err.message });
  }

  if (!geminiResp.ok) {
    const errText = await geminiResp.text();
    let msg = errText;
    try { const j = JSON.parse(errText); msg = j?.error?.message || errText; } catch {}
    return jsonResponse(geminiResp.status, { error: 'Gemini: ' + String(msg).slice(0, 400) });
  }

  // Reenvía el stream SSE de Gemini directo al cliente.
  return new Response(geminiResp.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      ...corsHeaders(),
    },
  });
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
