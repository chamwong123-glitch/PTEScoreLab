/*
  PTE Score Lab - AI marking proxy (Cloudflare Worker)

  Holds the OpenRouter key so it never appears in the web page, chooses the model
  for each kind of marking, and only answers requests from the app's own site.
  It also creates Stripe Checkout Sessions and receives Stripe's webhook, so the
  Stripe secret key never appears in the page either.

  Routes:
    POST /                          AI marking (unchanged)
    POST /auth/code                 emails a six-digit sign-in code
    POST /auth/verify               swaps a code for a session token
    GET  /auth/google               starts Google sign-in
    GET  /auth/google/callback      Google returns here; redirects home with the token
    GET  /me                        the signed-in account: email, balance, access expiry
    POST /create-checkout-session   starts a hosted Stripe Checkout for the signed-in account
    POST /buy-access                spends credit on a month of full access
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

    SESSION_SECRET   - a long random string that signs session tokens
    RESEND_API_KEY   - sends the sign-in codes
    GOOGLE_CLIENT_SECRET
  Optional for Google sign-in:
    GOOGLE_CLIENT_ID, WORKER_URL (this Worker's own address), EMAIL_FROM

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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

/* ----------------------------------------------------------- spending --
   Credit is spent in two ways: a month of full access, and each AI marking after the free ones
   a new account is given. Both deductions are conditional updates, so two clicks or two tabs
   cannot spend the same cents twice, and both leave a row in entries. */
const ACCESS_CENTS = 1500;      // a month of full access
const ACCESS_DAYS = 30;
const MARK_CENTS = 10;          // one AI marking
const CHARGE_MARKING = false;   // turn on when accounts are live; until then marking stays free

async function noteSpend(env, userId, cents, reason){
  await env.DB.prepare('INSERT INTO entries (user_id, delta, reason, ref, ts) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, -cents, reason, reason + ':' + crypto.randomUUID(), Math.floor(Date.now() / 1000)).run();
}

async function buyAccess(request, env, origin){
  if (!env.DB) return reply(500, { error: 'not_configured' }, origin);
  const user = await signedInUser(request, env);
  if (!user) return reply(401, { error: 'signed_out' }, origin);
  const now = Math.floor(Date.now() / 1000);
  // a month bought while one is running is added to the end of it, not thrown away
  const until = Math.max(now, user.access_until || 0) + ACCESS_DAYS * 86400;
  const done = await env.DB.prepare('UPDATE users SET balance = balance - ?, access_until = ? WHERE id = ? AND balance >= ?')
    .bind(ACCESS_CENTS, until, user.id, ACCESS_CENTS).run();
  if (!done.meta || !done.meta.changes) return reply(402, { error: 'low_balance', balance: user.balance, need: ACCESS_CENTS }, origin);
  await noteSpend(env, user.id, ACCESS_CENTS, 'access');
  return reply(200, { balance: user.balance - ACCESS_CENTS, access_until: until }, origin);
}

/* a free marking if the account still has one, otherwise ten cents */
async function chargeMarking(env, user){
  const free = await env.DB.prepare('UPDATE users SET free_marks = free_marks - 1 WHERE id = ? AND free_marks > 0')
    .bind(user.id).run();
  if (free.meta && free.meta.changes) return { ok: true, free: true, left: Math.max(0, (user.free_marks || 0) - 1) };
  const paid = await env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?')
    .bind(MARK_CENTS, user.id, MARK_CENTS).run();
  if (!paid.meta || !paid.meta.changes) return { ok: false };
  await noteSpend(env, user.id, MARK_CENTS, 'marking');
  return { ok: true, free: false, balance: user.balance - MARK_CENTS };
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

/* credit only ever moves up here, and only from the Stripe webhook */
async function creditUser(env, userId, cents, ref){
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO entries (user_id, delta, reason, ref, ts) VALUES (?, ?, ?, ?, ?)')
        .bind(userId, cents, 'top-up', ref, Math.floor(Date.now() / 1000)),
      env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(cents, userId)
    ]);
    return true;
  } catch (e) { return false; }   // the unique index on ref rejects a replayed webhook
}

async function createCheckoutSession(request, env, origin){
  if (!env.STRIPE_SECRET_KEY) return reply(500, { error: 'not_configured' }, origin);

  const mode = 'payment';            // a one-off purchase, so no payment_method_collection
  const domain = env.DOMAIN || RETURN_TO;

  // a top-up belongs to an account, so there has to be one
  const user = await signedInUser(request, env);
  if (!user) return reply(401, { error: 'signed_out' }, origin);

  const params = {
    ui_mode: 'hosted_page',
    mode,
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: false },
    automatic_tax: { enabled: false },
    // this account has Managed Payments on by default, which would force automatic_tax on;
    // turn it off per request so the Checkout Studio settings above are the ones that apply
    managed_payments: { enabled: false },
    allow_promotion_codes: false,
    submit_type: 'auto',
    integration_identifier: 'hosted_web_0001',
    origin_context: 'web',
    success_url: domain + '/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: domain + '/?checkout=cancelled',
    line_items: [{ price: priceId(env), quantity: 1 }],
    client_reference_id: user.id,
    customer_email: user.email,
    metadata: { user_id: user.id }
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
  return reply(200, { url: session.url, id: session.id }, origin);
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

/* ------------------------------------------------------------- accounts --
   A person is one row in users, found by email however they signed in. A session is a signed
   token the browser keeps; the Worker trusts nothing else. Codes are six digits, good for ten
   minutes, five attempts, and only their hash is stored. */
const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const CODE_WAIT = 60;              // seconds before another code will be sent to the same address

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const enc = new TextEncoder();

async function hmac(secret, data){
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function sha(text){
  const d = await crypto.subtle.digest('SHA-256', enc.encode(String(text)));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}
const same = (a, b) => {
  a = String(a || ''); b = String(b || '');
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return !diff;
};

/* a session token is payload.signature, where the payload says who and until when */
async function makeSession(env, userId){
  const body = b64url(enc.encode(JSON.stringify({ u: userId, exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 })));
  return body + '.' + await hmac(env.SESSION_SECRET, body);
}
async function readSession(env, token){
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !env.SESSION_SECRET) return null;
  if (!same(parts[1], await hmac(env.SESSION_SECRET, parts[0]))) return null;
  let claim;
  try { claim = JSON.parse(new TextDecoder().decode(unb64url(parts[0]))); } catch (e) { return null; }
  if (!claim || !claim.u || !claim.exp || claim.exp < Math.floor(Date.now() / 1000)) return null;
  return claim.u;
}
/* every signed-in request arrives with Authorization: Bearer <token> */
async function signedInUser(request, env){
  const auth = request.headers.get('Authorization') || '';
  const id = await readSession(env, auth.replace(/^Bearer\s+/i, ''));
  if (!id) return null;
  const row = await env.DB.prepare('SELECT id, email, balance, access_until, free_marks FROM users WHERE id = ?').bind(id).first();
  if (row) await env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000), id).run();
  return row || null;
}

const cleanEmail = e => String(e || '').trim().toLowerCase();
const emailOk = e => /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(e);

async function findOrMakeUser(env, email, googleSub){
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (row){
    if (googleSub) await env.DB.prepare('UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL').bind(googleSub, row.id).run();
    return row.id;
  }
  const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare('INSERT INTO users (id, email, google_sub, created, last_seen) VALUES (?, ?, ?, ?, ?)')
    .bind(id, email, googleSub || null, now, now).run();
  return id;
}

/* ---- signing in with a code ---- */
async function sendCode(request, env, origin){
  if (!env.DB || !env.RESEND_API_KEY) return reply(500, { error: 'not_configured' }, origin);
  let body = null;
  try { body = await request.json(); } catch (e) {}
  const email = cleanEmail(body && body.email);
  if (!emailOk(email)) return reply(400, { error: 'bad_email' }, origin);

  const now = Math.floor(Date.now() / 1000);
  const waiting = await env.DB.prepare('SELECT sent FROM login_codes WHERE email = ?').bind(email).first();
  if (waiting && now - waiting.sent < CODE_WAIT) return reply(429, { error: 'too_soon', wait: CODE_WAIT - (now - waiting.sent) }, origin);

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  await env.DB.prepare('INSERT INTO login_codes (email, hash, expires, attempts, sent) VALUES (?, ?, ?, 0, ?) ' +
    'ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires, attempts = 0, sent = excluded.sent')
    .bind(email, await sha(code), now + CODE_MINUTES * 60, now).run();

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'PTE Score Lab <onboarding@resend.dev>',
      to: [email],
      subject: code + ' is your PTE Score Lab sign-in code',
      text: 'Your sign-in code is ' + code + '.\n\nIt works for the next ' + CODE_MINUTES +
            ' minutes and can be used once. If you did not ask to sign in, ignore this email.'
    })
  }).catch(() => null);
  if (!res || !res.ok) return reply(502, { error: 'email_failed' }, origin);
  return reply(200, { sent: true, wait: CODE_WAIT }, origin);
}

async function checkCode(request, env, origin){
  if (!env.DB || !env.SESSION_SECRET) return reply(500, { error: 'not_configured' }, origin);
  let body = null;
  try { body = await request.json(); } catch (e) {}
  const email = cleanEmail(body && body.email), code = String((body && body.code) || '').trim();
  if (!emailOk(email) || !/^\d{6}$/.test(code)) return reply(400, { error: 'bad_request' }, origin);

  const row = await env.DB.prepare('SELECT hash, expires, attempts FROM login_codes WHERE email = ?').bind(email).first();
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.expires < now) return reply(400, { error: 'code_expired' }, origin);
  if (row.attempts >= CODE_TRIES) return reply(429, { error: 'too_many_tries' }, origin);
  if (!same(row.hash, await sha(code))){
    await env.DB.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    return reply(400, { error: 'code_wrong', left: CODE_TRIES - row.attempts - 1 }, origin);
  }
  await env.DB.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run();   // one use only
  const id = await findOrMakeUser(env, email, null);
  return reply(200, { token: await makeSession(env, id), email }, origin);
}

/* ---- signing in with Google ---- */
function googleStart(env, origin){
  if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET) return reply(500, { error: 'not_configured' }, origin);
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: (env.WORKER_URL || '') + '/auth/google/callback',
    response_type: 'code',
    scope: 'openid email',
    state,
    prompt: 'select_account'
  }).toString();
  // the state is returned by Google and checked against this cookie, so another site cannot start the flow
  return new Response(null, { status: 302, headers: {
    'Location': url,
    'Set-Cookie': 'g_state=' + state + '; Max-Age=600; Path=/auth/google; HttpOnly; Secure; SameSite=Lax'
  }});
}

async function googleCallback(request, env){
  const url = new URL(request.url);
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  const cookie = (request.headers.get('Cookie') || '').match(/g_state=([^;]+)/);
  const home = (env.DOMAIN || RETURN_TO);
  if (!code || !state || !cookie || !same(state, cookie[1])) return Response.redirect(home + '/?signin=failed', 302);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: (env.WORKER_URL || '') + '/auth/google/callback', grant_type: 'authorization_code'
    }).toString()
  }).catch(() => null);
  const tok = res && res.ok ? await res.json().catch(() => null) : null;
  if (!tok || !tok.id_token) return Response.redirect(home + '/?signin=failed', 302);

  // Google has just handed this to us over TLS, so reading the claims is enough; no need to verify its signature
  let claims = null;
  try { claims = JSON.parse(new TextDecoder().decode(unb64url(tok.id_token.split('.')[1]))); } catch (e) {}
  const email = cleanEmail(claims && claims.email);
  if (!email || claims.email_verified === false) return Response.redirect(home + '/?signin=failed', 302);

  const id = await findOrMakeUser(env, email, claims.sub);
  const token = await makeSession(env, id);
  // the token rides back in the fragment, which browsers do not send to servers or put in logs
  return Response.redirect(home + '/#token=' + encodeURIComponent(token), 302);
}

/* ---- who am I, and what do I have ---- */
async function meInfo(request, env, origin){
  if (!env.DB) return reply(500, { error: 'not_configured' }, origin);
  const user = await signedInUser(request, env);
  if (!user) return reply(401, { error: 'signed_out' }, origin);
  return reply(200, { email: user.email, balance: user.balance, access_until: user.access_until,
    free_marks: user.free_marks, access_cents: ACCESS_CENTS, access_days: ACCESS_DAYS, mark_cents: MARK_CENTS }, origin);
}

async function stripeWebhook(request, env){
  if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  const event = await stripeEvent(request, env);
  if (!event) return new Response('signature_check_failed', { status: 400 });
  if (event.type === 'checkout.session.completed'){
    const session = event.data && event.data.object;
    const userId = session && session.metadata && session.metadata.user_id;
    const cents = session && session.amount_total;
    if (env.DB && userId && cents > 0){
      const ok = await creditUser(env, userId, cents, session.id);
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
    // Google sends the browser here, so these are entered by redirect rather than by fetch
    if (path === '/auth/google') return googleStart(env, '');
    if (path === '/auth/google/callback') return googleCallback(request, env);

    const origin = request.headers.get('Origin') || '';
    const ok = allowedOrigins(env).includes(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers: ok ? cors(origin) : {} });
    if (!ok) return reply(403, { error: 'origin_not_allowed' });
    if (path === '/price' && request.method === 'GET') return priceDetails(env, origin);
    if (path === '/me' && request.method === 'GET') return meInfo(request, env, origin);
    if (path === '/auth/code') return sendCode(request, env, origin);
    if (path === '/auth/verify') return checkCode(request, env, origin);
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, origin);

    if (path === '/create-checkout-session') return createCheckoutSession(request, env, origin);
    if (path === '/buy-access') return buyAccess(request, env, origin);

    if (!env.OPENROUTER_API_KEY_PTE) return reply(500, { error: 'not_configured' }, origin);

    /* Marking is the one thing here that costs real money, so it is the one thing charged for.
       The deduction happens before the model is called; a failure afterwards is refunded. */
    let charged = null;
    if (CHARGE_MARKING && env.DB){
      const user = await signedInUser(request, env);
      if (!user) return reply(401, { error: 'signed_out' }, origin);
      charged = await chargeMarking(env, user);
      if (!charged.ok) return reply(402, { error: 'low_balance' }, origin);
      charged.user = user.id;
    }
    const refund = async () => {
      if (charged && charged.user){
        if (charged.free) await env.DB.prepare('UPDATE users SET free_marks = free_marks + 1 WHERE id = ?').bind(charged.user).run();
        else await env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(MARK_CENTS, charged.user).run();
      }
    };

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
    } catch (e) { return await refund(), reply(502, { error: 'upstream_unreachable' }, origin); }

    if (res.status === 429) return await refund(), reply(429, { error: 'rate_limited' }, origin);
    if (res.status === 402) return await refund(), reply(402, { error: 'out_of_credit' }, origin);
    if (!res.ok) return await refund(), reply(502, { error: 'upstream_error', status: res.status }, origin);

    const out = await res.json().catch(() => null);
    const text = out && out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content;
    if (!text) return await refund(), reply(502, { error: 'empty_completion' }, origin);
    const data = parseJson(text);
    if (!data) return await refund(), reply(502, { error: 'invalid_json' }, origin);
    return reply(200, { data, charged }, origin);
  }
};
