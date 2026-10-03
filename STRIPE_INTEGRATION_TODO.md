# Stripe integration — remaining steps

Hosted Stripe Checkout was added to the existing Cloudflare Worker in
[worker/marking-worker.js](worker/marking-worker.js), which is the only server-side code in this
project. The buyer is redirected to a Stripe-hosted payment page, so no card details ever reach
this app, and the Stripe secret key lives only in the Worker.

**Nothing is live yet.** The values below are placeholders and the Worker has not been redeployed.

## Values to Replace

All of the Checkout Session placeholders are now set. One switch is still waiting on you.

**Files containing it:**
- [index.html](index.html)

| Field | Current Value | What to Set |
|-------|---------------|-------------|
| BUY_ENABLED | `false` | Set to `true` on the day paying actually unlocks something. Until then the purchase page exists and works, but no button points at it, so nobody can buy what they already have. |

Settled from your answers: **one-off payment**, price `price_1UMJaA8M6WjYmdP65aXWZ6Tc`. The
return pages are `/?checkout=success&session_id={CHECKOUT_SESSION_ID}` and `/?checkout=cancelled`,
both handled inside the app, so no new files are needed on the site.

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

Set these in Cloudflare (Workers → your Worker → Settings → Variables), never in the file:

| Name | Type | Where it comes from |
|------|------|---------------------|
| `STRIPE_SECRET_KEY` | secret | [Dashboard → API keys](https://dashboard.stripe.com/test/apikeys), starts `sk_test_` while testing |
| `STRIPE_WEBHOOK_SECRET` | secret | shown when you add the webhook endpoint, starts `whsec_` |
| `DOMAIN` | variable | **optional.** Only needed if the app moves; the Worker already returns buyers to `https://chamwong123-glitch.github.io/PTEScoreLab` |

`OPENROUTER_API_KEY_PTE` is already set and is unchanged.

### 2. The credit database

Credit balances live in Cloudflare D1, because a balance cannot be kept in the browser.

```bash
npx wrangler d1 create pte-credit
```

Then apply [worker/schema.sql](worker/schema.sql) — either `npx wrangler d1 execute pte-credit
--file worker/schema.sql --remote`, or by pasting it into the D1 console in the dashboard.

Finally bind it: Worker → Settings → **Bindings** → add a **D1 database** binding with the
variable name **`DB`** pointing at `pte-credit`. The Worker reads `env.DB`, so the name matters.

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

1. The purchase page asks the Worker for the price, so no amount is hard-coded in the page.
2. **Pay with card** POSTs to `/create-checkout-session`, sending this device's access key if it
   has one. The Worker reuses that account or opens a new one, puts only the key's **hash** in
   the Stripe session, and returns `{ url, key }`. The browser saves the key and follows the URL.
3. Stripe takes the payment and returns the buyer to `/?checkout=success&session_id=...`. The app
   shows the receipt page with the access key and polls for the balance.
4. Stripe POSTs `checkout.session.completed` to `/stripe-webhook`. The Worker verifies the
   signature with Web Crypto, in constant time, rejects anything older than five minutes, then
   credits `amount_total` to the account named by the hash and writes a ledger row.
5. A replayed webhook is harmless: the ledger's unique index on the Stripe session id rejects the
   second insert and the whole batch rolls back, so a balance can never be credited twice.

**Credit can only ever be added by the webhook.** Nothing a browser sends can raise a balance,
which is what makes the model safe even though the page itself is public.

## Testing

Use test keys (`sk_test_`) and Stripe's test cards:

| Card | Result |
|------|--------|
| 4242 4242 4242 4242 | succeeds |
| 4000 0000 0000 9995 | declined, insufficient funds |
| 4000 0025 0000 3155 | requires 3-D Secure authentication |

Any future expiry date, any CVC. `stripe listen --forward-to https://.../stripe-webhook` replays
webhooks while you develop. Nothing in test mode touches real money.

## Next steps

- **Decide one-off or subscription**, then set `mode`. Subscriptions also need Stripe Billing and
  the [Customer Portal](https://dashboard.stripe.com/settings/billing/portal) so buyers can cancel.
- **Grant access after payment.** The webhook has the buyer's email but nothing to write to. This
  app has no accounts: the usual shape here is a Workers KV binding holding
  `email -> licence`, with the app exchanging an email for a short-lived signed token.
- **Gate what costs money.** AI marking is the recurring expense (around 30¢ per full mock exam).
  Requiring a valid licence on the marking route is the part of a paywall that can actually be
  enforced; anything checked inside the page can be edited by the user.
- **Before taking real money**: terms of service, a privacy policy (you would be collecting
  emails) and a refund policy, plus business details and a payout account in Stripe.

## Resources

- https://docs.stripe.com/mcp
- https://support.stripe.com
