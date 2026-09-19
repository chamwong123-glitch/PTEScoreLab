/*
  PTE Score Lab - AI marking proxy (Cloudflare Worker)

  Holds the OpenRouter key so it never appears in the web page, chooses the model
  for each kind of marking, and only answers requests from the app's own site.

  Secret (set in Cloudflare, never in this file):  OPENROUTER_API_KEY_PTE
  Optional variable:  ALLOWED_ORIGINS  - comma-separated extra origins, e.g. for local testing
*/

const MODELS = {
  speaking: 'google/gemini-3.8-flash',   // listens to the recording
  essay:    'anthropic/claude-sonnet-5',
  writing:  'anthropic/claude-haiku-4.5' // Summarize Written Text, Summarize Spoken Text
};
const SITE = 'https://chamwong123-glitch.github.io';
const MAX_PROMPT = 40000;          // characters
const MAX_AUDIO = 8 * 1024 * 1024; // base64 characters, about 2.5 minutes of 16 kHz WAV

function allowedOrigins(env){
  return [SITE].concat(String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
}
function cors(origin){
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function reply(status, body, origin){
  return new Response(JSON.stringify(body), {
    status, headers: Object.assign({ 'Content-Type': 'application/json' }, origin ? cors(origin) : {})
  });
}

/* the models are asked for JSON; tolerate code fences or stray text around it */
function parseJson(text){
  const t = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const ok = allowedOrigins(env).includes(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers: ok ? cors(origin) : {} });
    if (!ok) return reply(403, { error: 'origin_not_allowed' });
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, origin);
    if (!env.OPENROUTER_API_KEY_PTE) return reply(500, { error: 'not_configured' }, origin);

    // optional per-visitor limit, if a rate-limit binding named LIMITER is attached
    if (env.LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return reply(429, { error: 'rate_limited' }, origin);
    }

    let body;
    try { body = await request.json(); } catch (e) { return reply(400, { error: 'bad_request' }, origin); }
    const model = MODELS[body && body.kind];
    const prompt = body && typeof body.prompt === 'string' ? body.prompt : '';
    const audio = body && typeof body.audio === 'string' ? body.audio : '';
    if (!model || !prompt) return reply(400, { error: 'bad_request' }, origin);
    if (prompt.length > MAX_PROMPT) return reply(413, { error: 'prompt_too_large' }, origin);
    if (audio && (body.kind !== 'speaking' || audio.length > MAX_AUDIO)) return reply(413, { error: 'prompt_too_large' }, origin);

    const content = audio
      ? [{ type: 'text', text: prompt }, { type: 'input_audio', input_audio: { data: audio, format: 'wav' } }]
      : prompt;
    const payload = {
      model,
      messages: [{ role: 'user', content }],
      max_tokens: body.kind === 'essay' ? 4000 : 3000,
      temperature: 0.2
    };
    if (body.kind === 'speaking') payload.reasoning = { effort: 'low' };

    let res;
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.OPENROUTER_API_KEY_PTE,
          'Content-Type': 'application/json',
          'HTTP-Referer': SITE + '/PTEScoreLab/',
          'X-Title': 'PTE Score Lab'
        },
        body: JSON.stringify(payload)
      });
    } catch (e) { return reply(502, { error: 'upstream_unreachable' }, origin); }

    if (res.status === 429) return reply(429, { error: 'rate_limited' }, origin);
    if (res.status === 402) return reply(402, { error: 'out_of_credit' }, origin);
    if (!res.ok) return reply(502, { error: 'upstream_error', status: res.status }, origin);

    const out = await res.json().catch(() => null);
    const text = out && out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content;
    if (!text) return reply(502, { error: 'empty_completion' }, origin);
    const data = parseJson(text);
    if (!data) return reply(502, { error: 'invalid_json' }, origin);
    return reply(200, { data }, origin);
  }
};
