/*
  PTE Score Lab - AI marking proxy (Cloudflare Worker)

  Holds the OpenRouter key so it never appears in the web page, chooses the model
  for each kind of marking, and only answers requests from the app's own site.
  It also creates Stripe Checkout Sessions and receives Stripe's webhook, so the
  Stripe secret key never appears in the page either.

  Routes:
    POST /                          AI marking (unchanged)
    POST /create-checkout-session   starts a hosted Stripe Checkout, returns the account key
    POST /account                   what a key is worth: balance and access expiry
    GET  /price                     what a top-up costs, read from Stripe
    POST /stripe-webhook            Stripe calls this; no Origin header, so no CORS

  Secrets (set in Cloudflare, never in this file):
    OPENROUTER_API_KEY_PTE
    STRIPE_SECRET_KEY
    STRIPE_WEBHOOK_SECRET
  Optional variables:
    ALLOWED_ORIGINS  - comma-separated extra origins, e.g. for local testing
    DOMAIN           - site the buyer returns to after paying
    STRIPE_PRICE_ID  - the top-up price; the one in this file is used if unset

  Binding:
    DB  - the D1 database holding credit accounts (worker/schema.sql)
*/

const MODELS = {
  speaking:  'google/gemini-3.8-flash',   // listens to the recording
  essay:     'anthropic/claude-sonnet-5',
  writing:   'anthropic/claude-haiku-4.5', // Summarize Written Text, Summarize Spoken Text
  translate: 'anthropic/claude-haiku-4.5'  // examiner comments into Traditional Chinese, on request
};
const SITE = 'https://chamwong123-glitch.github.io';
const RETURN_TO = SITE + '/PTEScoreLab';   // where Stripe sends a buyer back to; override with a DOMAIN variable
const MAX_PROMPT = 40000;          // characters
const MAX_AUDIO = 8 * 1024 * 1024; // base64 characters, about 2.5 minutes of 16 kHz WAV

function allowedOrigins(env){
  return [SITE].concat(String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
}
function cors(origin){
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

/* ---------------------------------------------------------------- Stripe --
   There is no bundler here, so the Stripe SDK cannot be installed; these call
   the same REST API the SDK calls, with the parameters set in Checkout Studio.
   No API version is sent, so the account's default is used. */

/* Stripe takes form-encoded bodies, with nesting written as a[b]=c */
function formEncode(obj, prefix, out){
  out = out || new URLSearchParams();
  for (const k in obj){
    const v = obj[k], key = prefix ? prefix + '[' + k + ']' : k;
    if (v == null) continue;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

/* Full access, charged once. Test and live prices are different objects, so the ID can be
   overridden with a STRIPE_PRICE_ID variable instead of editing and redeploying. */
const PRICE_FALLBACK = 'price_1UMJaA8M6WjYmdP65aXWZ6Tc';
const priceId = env => env.STRIPE_PRICE_ID || PRICE_FALLBACK;

/* ------------------------------------------------------- credit accounts --
   Balances live in D1 (binding: DB), never in the browser. A top-up is only ever added by the
   Stripe webhook, so nothing a page says can create credit. The access key is a bearer token
   like a gift-card code: only its SHA-256 is stored, so the database holds nothing usable. */
const KEY_CHARS = 'ACDEFGHJKLMNPQRTUVWXY34679';   // no O/0, I/1, S/5: these get read aloud and typed

function newKey(){
  const r = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(r, b => KEY_CHARS[b % KEY_CHARS.length]).join('');
  return 'PTE-' + s.slice(0, 4) + '-' + s.slice(4);
}
async function keyHash(key){
  const clean = String(key || '').trim().toUpperCase();
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clean));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}
const looksLikeKey = k => /^PTE-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(k || '').trim().toUpperCase());

async function accountRow(env, hash){
  return await env.DB.prepare('SELECT balance, access_until FROM accounts WHERE key_hash = ?').bind(hash).first();
}
/* Stripe may deliver the same event twice; the unique index on ledger.ref turns the replay
   into a failed insert, which rolls the whole batch back and leaves the balance alone. */
async function creditAccount(env, hash, cents, ref, email){
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO accounts (key_hash, balance, access_until, email, created) VALUES (?, 0, 0, ?, ?) ON CONFLICT(key_hash) DO NOTHING')
        .bind(hash, email || null, now),
      env.DB.prepare('INSERT INTO ledger (key_hash, delta, reason, ref, ts) VALUES (?, ?, ?, ?, ?)')
        .bind(hash, cents, 'top-up', ref, now),
      env.DB.prepare('UPDATE accounts SET balance = balance + ?, email = COALESCE(?, email) WHERE key_hash = ?')
        .bind(cents, email || null, hash)
    ]);
    return true;
  } catch (e) { return false; }
}

async function accountInfo(request, env, origin){
  if (!env.DB) return reply(500, { error: 'not_configured' }, origin);
  let body = null;
  try { body = await request.json(); } catch (e) {}
  const key = body && body.key;
  if (!looksLikeKey(key)) return reply(400, { error: 'bad_key' }, origin);
  const row = await accountRow(env, await keyHash(key));
  if (!row) return reply(404, { error: 'no_such_key' }, origin);
  return reply(200, { balance: row.balance, access_until: row.access_until }, origin);
}

async function createCheckoutSession(request, env, origin){
  if (!env.STRIPE_SECRET_KEY) return reply(500, { error: 'not_configured' }, origin);

  const mode = 'payment';            // a one-off purchase, so no payment_method_collection
  const domain = env.DOMAIN || RETURN_TO;

  /* Top up an existing account if the page sent its key, otherwise this payment opens one.
     Only the hash travels to Stripe, so the key is not sitting in the dashboard. */
  let body = null;
  try { body = await request.json(); } catch (e) {}
  const given = body && body.key;
  const key = looksLikeKey(given) ? String(given).trim().toUpperCase() : newKey();
  const hash = await keyHash(key);

  const params = {
    ui_mode: 'hosted_page',
    mode,
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: false },
    automatic_tax: { enabled: false },
    allow_promotion_codes: false,
    submit_type: 'auto',
    integration_identifier: 'hosted_web_0001',
    origin_context: 'web',
    success_url: domain + '/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: domain + '/?checkout=cancelled',
    line_items: [{ price: priceId(env), quantity: 1 }],
    client_reference_id: hash,
    metadata: { key_hash: hash }
  };
  if (mode === 'subscription') params.payment_method_collection = 'always';

  let res;
  try {
    res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formEncode(params).toString()
    });
  } catch (e) { return reply(502, { error: 'upstream_unreachable' }, origin); }

  const session = await res.json().catch(() => null);
  if (!res.ok || !session || !session.url){
    return reply(502, { error: 'checkout_failed', detail: session && session.error && session.error.message }, origin);
  }
  return reply(200, { url: session.url, id: session.id, key }, origin);
}

/* what the purchase costs, read from Stripe so the page never hard-codes a price */
async function priceDetails(env, origin){
  if (!env.STRIPE_SECRET_KEY) return reply(500, { error: 'not_configured' }, origin);
  let res;
  try {
    res = await fetch('https://api.stripe.com/v1/prices/' + priceId(env), {
      headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY }
    });
  } catch (e) { return reply(502, { error: 'upstream_unreachable' }, origin); }
  const p = await res.json().catch(() => null);
  if (!res.ok || !p){
    // Stripe's own words, so a key pointed at the wrong environment says so plainly
    return reply(502, { error: 'price_unavailable', price: priceId(env), status: res.status,
      detail: p && p.error && p.error.message }, origin);
  }
  const currency = String(p.currency || '').toUpperCase();
  if (p.unit_amount != null) return reply(200, { amount: p.unit_amount, currency }, origin);
  // a price the buyer names, or a tiered one: there is no single figure to show
  if (p.custom_unit_amount){
    const c = p.custom_unit_amount;    // the buyer names the amount, within whatever bounds are set
    return reply(200, { amount: null, currency, custom: true,
      minimum: c.minimum, maximum: c.maximum, preset: c.preset }, origin);
  }
  return reply(502, { error: 'price_has_no_fixed_amount', price: priceId(env),
    billing_scheme: p.billing_scheme, type: p.type }, origin);
}

/* the signature check the SDK's constructEvent does, using Web Crypto */
async function stripeEvent(request, env){
  const body = await request.text();
  const header = request.headers.get('Stripe-Signature') || '';
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=').map(s => s.trim())));
  if (!parts.t || !parts.v1 || !env.STRIPE_WEBHOOK_SECRET) return null;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return null;    // stale, so replayed
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts.t + '.' + body));
  const want = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  let same = want.length === parts.v1.length ? 0 : 1;                      // compare in constant time
  for (let i = 0; i < want.length && i < parts.v1.length; i++) same |= want.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  if (same) return null;
  try { return JSON.parse(body); } catch (e) { return null; }
}

async function stripeWebhook(request, env){
  if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  const event = await stripeEvent(request, env);
  if (!event) return new Response('signature_check_failed', { status: 400 });
  if (event.type === 'checkout.session.completed'){
    const session = event.data && event.data.object;
    const hash = session && session.metadata && session.metadata.key_hash;
    const cents = session && session.amount_total;
    const email = session && session.customer_details && session.customer_details.email;
    if (env.DB && hash && cents > 0){
      const ok = await creditAccount(env, hash, cents, session.id, email);
      console.log('Top-up', ok ? 'credited' : 'already seen', cents, session.id);
    } else {
      console.log('Checkout completed with nothing to credit:', session && session.id);
    }
  } else {
    console.log('Unhandled event type:', event.type);
  }
  return new Response('ok', { status: 200 });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/stripe-webhook') return stripeWebhook(request, env);   // called by Stripe, not by a browser

    const origin = request.headers.get('Origin') || '';
    const ok = allowedOrigins(env).includes(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers: ok ? cors(origin) : {} });
    if (!ok) return reply(403, { error: 'origin_not_allowed' });
    if (path === '/price' && request.method === 'GET') return priceDetails(env, origin);
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, origin);

    if (path === '/create-checkout-session') return createCheckoutSession(request, env, origin);
    if (path === '/account') return accountInfo(request, env, origin);

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
