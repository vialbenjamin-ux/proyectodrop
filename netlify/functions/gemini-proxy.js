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

  // Cadena de modelos en orden de preferencia. Cuando el primario está
  // saturado, saltamos al siguiente (infra distinta, suele responder).
  // El usuario puede forzar uno con body.model.
  const requestedModel = body.model;
  const MODEL_CHAIN = requestedModel ? [requestedModel] : [
    'gemini-2.5-flash',         // primario: balance calidad/velocidad
    'gemini-2.0-flash-exp',     // alt: infra diferente
    'gemini-2.0-flash',         // alt estable
    'gemini-1.5-flash',         // último recurso, calidad menor pero disponible
  ];

  const parts = [];
  if (body.fileUri && body.mimeType) {
    parts.push({ fileData: { mimeType: body.mimeType, fileUri: body.fileUri } });
  }
  parts.push({ text: prompt });

  // Tope de tokens en output — solo aplica si Gemini quiere generar tanto.
  const maxOutputTokens = body.fileUri ? 65536 : 8192;
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

      function isTransient(status, msg) {
        if (status === 503 || status === 429) return true;
        const m = String(msg || '').toLowerCase();
        return m.includes('high demand') || m.includes('overloaded')
            || m.includes('temporarily') || m.includes('try again later')
            || m.includes('unavailable');
      }

      // Errores que indican "este modelo no existe / no está disponible
      // en mi cuenta/región" — deben saltar al siguiente modelo de la
      // cadena, no abortar. Distinto de transient (saturación) y de
      // errores reales (400, 401, 403 con request malformado).
      function isModelMissing(status, msg) {
        if (status === 404) return true;
        const m = String(msg || '').toLowerCase();
        return m.includes('not found') || m.includes('not supported')
            || m.includes('is not enabled') || m.includes('does not exist');
      }

      try {
        // Recorre la cadena de modelos. Si el primario está saturado,
        // saltamos al siguiente (infra distinta) en vez de reintentar el
        // mismo. Si todos fallan, error final con sugerencias.
        let geminiResp = null;
        let lastErrMsg = null;
        let lastStatus = null;
        let modelUsed = null;

        for (let mi = 0; mi < MODEL_CHAIN.length; mi++) {
          const m = MODEL_CHAIN[mi];
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse&key=${apiKey}`;

          // Intento principal sobre este modelo. Damos UN reintento corto
          // por si fue un blip puntual (1.5s). Si vuelve a fallar transient,
          // saltamos al siguiente modelo de la cadena en lugar de seguir
          // golpeando el mismo modelo saturado.
          let attempted = 0;
          let resp = null;
          while (attempted < 2) {
            attempted++;
            try {
              resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: geminiBody,
              });
            } catch (netErr) {
              lastErrMsg = netErr.message || 'network error';
              lastStatus = 0;
              if (attempted < 2) { await new Promise(r => setTimeout(r, 1500)); continue; }
              break;
            }

            if (resp.ok) {
              geminiResp = resp;
              modelUsed = m;
              break;
            }

            const errText = await resp.text();
            let msg = errText;
            try { const j = JSON.parse(errText); msg = j?.error?.message || errText; } catch {}
            lastErrMsg = msg;
            lastStatus = resp.status;
            resp = null;

            if (isTransient(lastStatus, msg)) {
              if (attempted < 2) {
                safeEnqueue(encoder.encode(`: blip ${m} retry\n\n`));
                await new Promise(r => setTimeout(r, 1500));
                continue;
              }
              // 2 intentos transient → cambiar de modelo
              break;
            }

            // 404 / "not found" / "not supported" → este modelo no
            // existe en la cuenta. Saltamos al siguiente sin abortar.
            if (isModelMissing(lastStatus, msg)) {
              safeEnqueue(encoder.encode(`: skip ${m} (not available)\n\n`));
              break; // sale del loop interno, sigue al próximo modelo
            }

            // Error real (400, 401, 403, prompt mal armado, key inválida)
            // → no tiene sentido probar otros modelos, abortar todo
            mi = MODEL_CHAIN.length; // forzar salida del loop externo
            break;
          }

          if (geminiResp) break;

          // Notificar al cliente cada vez que saltamos a otro modelo
          // (sea por saturación o por modelo no disponible)
          if (mi < MODEL_CHAIN.length - 1 &&
              (isTransient(lastStatus, lastErrMsg) || isModelMissing(lastStatus, lastErrMsg))) {
            const next = MODEL_CHAIN[mi + 1];
            safeEnqueue(encoder.encode(`: switching ${m} -> ${next} (${lastStatus})\n\n`));
          }
        }

        if (geminiResp && geminiResp.ok) {
          if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
          // Avisamos qué modelo se usó si NO fue el primario
          if (modelUsed && modelUsed !== MODEL_CHAIN[0]) {
            safeEnqueue(encoder.encode(`: served-by ${modelUsed}\n\n`));
          }
          const reader = geminiResp.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            safeEnqueue(value);
          }
        } else if (lastErrMsg) {
          if (isTransient(lastStatus, lastErrMsg)) {
            safeEnqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Gemini saturado en todos los modelos (' + MODEL_CHAIN.length + ' probados). Espera 1-2 min y reintenta, o cambia IA destino a Claude/ChatGPT.' })}\n\n`));
          } else if (isModelMissing(lastStatus, lastErrMsg)) {
            safeEnqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Ningún modelo Gemini disponible en tu cuenta para este request. Verifica acceso a la API.' })}\n\n`));
          } else {
            safeEnqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Gemini: ' + String(lastErrMsg).slice(0, 400) })}\n\n`));
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
