# Stripe integration — remaining steps

Hosted Stripe Checkout was added to the existing Cloudflare Worker in
[worker/marking-worker.js](worker/marking-worker.js), which is the only server-side code in this
project. The buyer is redirected to a Stripe-hosted payment page, so no card details ever reach
this app, and the Stripe secret key lives only in the Worker.

**Where it stands.** A sandbox payment has gone through end to end: Checkout opened, the card was
taken, the buyer came back to the receipt page and the webhook credited the account. What is left
is the sandbox-to-live switch, the two flags below, and the gating in *Next steps*.

## Values to Replace

All of the Checkout Session placeholders are now set. Two switches are still waiting on you.

| Field | File | Current Value | What to Set |
|-------|------|---------------|-------------|
| BUY_ENABLED | index.html | `false` | Set to `true` on the day paying actually unlocks something. Until then the purchase page exists and works, but no button points at it, so nobody can buy what they already have. |
| CHARGE_MARKING | worker/marking-worker.js | `false` | Set to `true` once accounts are live. While it is `false` marking is free and unmetered, so nobody is charged for something they cannot yet sign in to pay for. |

Settled from your answers: **one-off payment**, price `price_1UMJaA8M6WjYmdP65aXWZ6Tc`. The
return pages are `/?checkout=success&session_id={CHECKOUT_SESSION_ID}` and `/?checkout=cancelled`,
both handled inside the app, so no new files are needed on the site.

## What things cost

| What | Price | Where it is set |
|------|-------|-----------------|
| Credit top-up | buyer chooses, min **A$5**, max **A$50** | the Stripe price (pay-what-you-want); set the minimum and maximum on the price in Stripe |
| A month of full access | **A$15.00** per 30 days | `ACCESS_CENTS` / `ACCESS_DAYS` in the Worker |
| One AI marking | **10¢**, after **2 free** per new account | `MARK_CENTS` in the Worker, `free_marks` default in [worker/schema-accounts.sql](worker/schema-accounts.sql) |

Credit is spent, never refunded automatically. Buying a month while one is still running adds
thirty days to the end of it rather than discarding what is left. Both deductions are conditional
updates, so two tabs or a double click cannot spend the same cents twice, and both leave a row in
`entries`.

Marking is charged *before* the model is called and given back on every failure path, so a Worker
error, an upstream timeout or an unusable reply never costs the account anything.

Stripe keeps roughly 1.7% + A$0.30 of a domestic card payment and 3.5% + A$0.30 of an
international one, so a A$5 top-up nets about A$4.61 and a A$50 one about A$48.85. Managed
Payments is off, so no GST is added or collected; if you register for GST, turn `automatic_tax`
on and the price becomes tax-inclusive.

## What full access opens

Without it: the first **three questions of every type**, and no mock exams. Everything else
behaves as it always has — timing, recording, the practice record, saved questions.

With it: the whole bank and the mock exams. `FREE_PER_TYPE` in [index.html](index.html) sets the
three; `BUY_ENABLED` is the master switch, and while it is `false` nothing is held back at all.

This gate is in the page, so it is a courtesy, not a lock: the bank ships with the page and a
determined visitor can read all of it. See *Gate the question bank* in **Next steps** for the
version that holds.

## Configured Parameters

These parameters were configured in Checkout Studio and are already set correctly.

**Files containing these parameters:**
- [worker/marking-worker.js](worker/marking-worker.js)

| Parameter | Value |
|-----------|-------|
| ui_mode | hosted_page |
| billing_address_collection | auto |
| phone_number_collection | { enabled: false } |
| automatic_tax | { enabled: false } |
| allow_promotion_codes | false |
| payment_method_collection | always (sent only when mode is `subscription`) |
| submit_type | auto |
| integration_identifier | hosted_web_0001 |
| origin_context | web |

`ui_mode` is set to `hosted_page`, the value for Stripe SDK 21.0.0 and above. This Worker has no
bundler, so there is no installed SDK to read a version from: it calls the same REST endpoint the
SDK calls. If you ever move to an SDK older than 21.0.0, the value becomes `hosted`.

## Setup

### 1. Secrets and variables

Set these in Cloudflare (Workers → your Worker → Settings → Variables and Secrets):

| Name | Type | Where it comes from |
|------|------|---------------------|
| `STRIPE_SECRET_KEY` | secret | Stripe → API keys, inside the sandbox you are testing in |
| `STRIPE_WEBHOOK_SECRET` | secret | shown when you add the webhook endpoint |
| `SESSION_SECRET` | secret | any long random string; it signs sign-in tokens |
| `RESEND_API_KEY` | secret | [resend.com](https://resend.com) → API keys; sends the sign-in codes |
| `EMAIL_FROM` | text | e.g. `PTE Score Lab <hello@yourdomain.com>`; needs a domain verified in Resend |
| `GOOGLE_CLIENT_ID` | text | Google Cloud → Credentials → OAuth client (Web application) |
| `GOOGLE_CLIENT_SECRET` | secret | the same OAuth client |
| `WORKER_URL` | text | `https://pte-marking.chamwong123.workers.dev` — Google redirects back here |
| `STRIPE_PRICE_ID` | text | the `price_...` id of the top-up price, which is where its minimum and maximum live; set, so the id in the file is unused |
| `DOMAIN` | text | optional; where buyers return to, if the app ever moves |

Generate the two random secrets with `openssl rand -base64 36`.

### Where the top-up limits live

The minimum and maximum are properties of the Stripe price, not of any code here, and Stripe
freezes a price's amounts once it exists. Changing them means creating a *new* price on the same
product and pointing `STRIPE_PRICE_ID` at it; editing the old one looks like it works and does
nothing. The id hardcoded in `marking-worker.js` is only a fallback for when the variable is
missing, and it still names the first price, with its A$100 maximum.


In the Google Cloud console, the OAuth client needs **`https://pte-marking.chamwong123.workers.dev/auth/google/callback`**
as an authorised redirect URI, and the consent screen needs the `email` scope only.

### 2. The database

Run both schema files in the D1 console: [worker/schema.sql](worker/schema.sql) if the database is
new, then [worker/schema-accounts.sql](worker/schema-accounts.sql), which adds `users`,
`login_codes` and `entries`. Bind the database to the Worker as **`DB`**.

The older `accounts` and `ledger` tables belong to the device-key scheme that accounts replaced.
They are no longer read or written, and can be dropped once you are sure nothing in them matters.

### 3. Deploy and register the webhook

Deploy the Worker, then in the **same sandbox** you created the price in: Developers →
Webhooks → **Add endpoint** → `https://pte-marking.chamwong123.workers.dev/stripe-webhook`,
listening for `checkout.session.completed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.

Stripe's **Send test event** button should return 200. A 400 means the signing secret does not
match; a timeout means the Worker has not been deployed with the route.

### 4. Try it

Open the purchase page (`?buy=1` is not wired up, so switch `BUY_ENABLED` to `true` or call
`go({view:'buy'})` from the console), pay with `4242 4242 4242 4242`, and you should land on the
receipt page, see your access key, and watch the balance appear a second or two later when the
webhook lands.

## How it works

1. Someone signs in, by emailed code or Google, and the browser keeps a signed session token.
2. The purchase page asks the Worker for the price, so no amount is hard-coded in the page.
3. **Pay with card** POSTs to `/create-checkout-session` with that token. The Worker refuses
   unless it names a real account, then creates the session with the account's id in its metadata
   and returns `{ url }`.
4. Stripe takes the payment and returns the buyer to `/?checkout=success&session_id=...`, where
   the app shows the receipt page and polls `/me` until the credit appears.
5. Stripe POSTs `checkout.session.completed` to `/stripe-webhook`. The Worker verifies the
   signature with Web Crypto, in constant time, rejects anything older than five minutes, then
   adds `amount_total` to that account and writes a row in `entries`.
6. A replayed webhook is harmless: the unique index on the Stripe session id rejects the second
   insert and the batch rolls back, so credit can never be added twice.

**Credit can only ever be added by the webhook**, against an account that was signed in when the
payment started. Nothing a browser sends can raise a balance.

## Testing

Use test keys (`sk_test_`) and Stripe's test cards:

| Card | Result |
|------|--------|
| 4242 4242 4242 4242 | succeeds |
| 4000 0000 0000 9995 | declined, insufficient funds |
| 4000 0025 0000 3155 | requires 3-D Secure authentication |

Any future expiry date, any CVC. `stripe listen --forward-to https://.../stripe-webhook` replays
webhooks while you develop. Nothing in test mode touches real money.

## Signing in

There are no keys and no passwords. Someone enters their email, the Worker emails a six-digit
code good for ten minutes and five attempts, and a correct code returns a session token signed
with `SESSION_SECRET`. Google sign-in reaches the same account whenever the email matches.
A session lasts thirty days and is renewed on use; the browser keeps only the token.

Practice itself never asks for an account. Signing in is for credit, access and carrying a
practice record between devices.

A lost account is no longer a problem to solve: sign in again with the same email.

### Sending the codes before there is a domain

Resend will not send from a gmail.com address, so a verified domain is what the finished thing
needs. Until then `onboarding@resend.dev` works with no setup at all — it is already the
fallback in `sendCode`, so leaving `EMAIL_FROM` unset is enough. The catch is that it will only
deliver to the address the Resend account itself is on; every other recipient comes back 403,
which the Worker reports as `email_failed`. Good enough to exercise the whole flow, useless for
anyone else, so a domain is still on the list before launch.

Checked on 8 November 2026 against `grumpychewbacca8964@gmail.com`, the address the Resend
account is on: the code arrived, `/auth/verify` returned a thirty-day token, and `/me` answered
with the account rather than `signed_out` — so Resend, `SESSION_SECRET` and the D1 writes are
all working.

The rest of the path went through on the same account the same day. A checkout session built
from that token opened a Stripe page at the new price; paying A$19.99 with `4242 4242 4242 4242`
left `balance` at 1999, which means the webhook's signature check passed and `creditUser` wrote
its row; `/buy-access` then took 1500 of it and set `access_until` to 7 December 2026, leaving
499. Sign in, top up, pay, credit, access — the whole chain, in a sandbox, with no code changes
pending. What has never run is any of it in live mode.

## Next steps


- **Verify a domain in Resend** so codes reach anyone other than the account's own address.
  This is the last thing standing between the current build and a sign-in that works for a
  stranger.
- **Set the public business name in Stripe.** Checkout shows the Stripe account's name above the
  amount; in the sandbox that reads "Grumpy Chewbacca sandbox", and whatever the live account is
  called is what a buyer will see.
- **Gate the question bank for real.** The three-a-type rule above is enforced in the page, so
  anyone who opens the source reads the lot. Serving `data/questions.json` and `data/mock1.json`
  from the Worker, and only to an account with access, is what makes it hold. Marking is already
  enforced there.
- **Carry the practice record on the account.** `users.progress` exists for it but nothing writes
  to it yet, so clearing site data still loses a signed-in user's history.
- **Before taking real money**: terms of service, a privacy policy (you are collecting emails)
  and a refund policy, plus business details and a payout account in Stripe. The refund policy
  should say what happens to unspent credit if the service closes — Stripe can only refund a
  charge for about 180 days, so beyond that a refund has to be paid out some other way.

## Resources

- https://docs.stripe.com/mcp
- https://support.stripe.com
