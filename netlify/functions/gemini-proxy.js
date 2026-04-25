// Proxy a Gemini con streaming response + heartbeat (Netlify Functions V2).
// Resuelve dos problemas:
//  1) El timeout de 26s de Functions sync — usamos streaming para mantener
//     la conexión abierta mientras llegan datos.
//  2) El timeout de 26s "hasta el primer byte" — enviamos comentarios SSE
//     (heartbeats) cada 5s mientras esperamos la respuesta inicial de Gemini.
//     Apenas Gemini responde, paramos heartbeats y reenviamos su stream real.
//
// Endpoint: POST /.netlify/functions/gemini-proxy
// Body: { prompt, fileUri?, mimeType?, model? }
// Respuesta: text/event-stream con comentarios SSE de heartbeat + chunks de Gemini.

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
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const geminiBody = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 0.7, maxOutputTokens },
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let heartbeatInterval = null;
      const safeEnqueue = (chunk) => {
        try { controller.enqueue(chunk); } catch {}
      };
      // Primer heartbeat inmediato para forzar el primer byte y disipar el timeout
      safeEnqueue(encoder.encode(': start\n\n'));
      heartbeatInterval = setInterval(() => {
        safeEnqueue(encoder.encode(': keep-alive\n\n'));
      }, 5000);

      try {
        const geminiResp = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: geminiBody,
        });

        if (!geminiResp.ok) {
          const errText = await geminiResp.text();
          let msg = errText;
          try { const j = JSON.parse(errText); msg = j?.error?.message || errText; } catch {}
          safeEnqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Gemini: ' + String(msg).slice(0, 400) })}\n\n`));
        } else {
          // Gemini empezó a responder: cortar heartbeats y reenviar su stream
          if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
          const reader = geminiResp.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            safeEnqueue(value);
          }
        }
      } catch (err) {
        safeEnqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Error: ' + (err.message || 'desconocido') })}\n\n`));
      } finally {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        try { controller.close(); } catch {}
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
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
