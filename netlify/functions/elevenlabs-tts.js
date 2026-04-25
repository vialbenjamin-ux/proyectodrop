// Genera audio TTS con ElevenLabs.
// Endpoint: POST /.netlify/functions/elevenlabs-tts
// Body: { text, voiceId, modelId? }
// Responde: { audioBase64, mimeType: "audio/mpeg" }
// Modelo default: eleven_multilingual_v2 (mejor calidad para español).

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return respond(500, { error: 'ELEVENLABS_API_KEY no configurada' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'JSON inválido' }); }

  const text = (body.text || '').trim();
  const voiceId = (body.voiceId || '').trim();
  if (!text) return respond(400, { error: 'Falta "text"' });
  if (!voiceId) return respond(400, { error: 'Falta "voiceId"' });

  // Hard cap a 1500 caracteres por request (≈90 segundos de audio).
  // Sirve también de safety contra abuso del endpoint público.
  const MAX_CHARS = 1500;
  if (text.length > MAX_CHARS) {
    return respond(400, { error: `Texto muy largo (${text.length} chars). Máximo ${MAX_CHARS}.` });
  }

  const modelId = body.modelId || 'eleven_multilingual_v2';
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      let msg = errText;
      try { const j = JSON.parse(errText); msg = j.detail?.message || j.detail || errText; } catch {}
      return respond(resp.status, { error: 'ElevenLabs: ' + String(msg).slice(0, 300) });
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: JSON.stringify({
        audioBase64: buffer.toString('base64'),
        mimeType: 'audio/mpeg',
        chars: text.length,
        model: modelId,
      }),
    };
  } catch (err) {
    return respond(500, { error: err.message || 'Error generando audio' });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(payload),
  };
}
