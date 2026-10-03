-- PTE Score Lab — credit accounts, held in Cloudflare D1
--
-- Money lives here and nowhere else: the browser can ask what a balance is, but only the
-- Stripe webhook can raise one. Amounts are whole cents, in the currency the top-up was paid in.
--
-- Create once:   npx wrangler d1 create pte-credit
-- Apply:         npx wrangler d1 execute pte-credit --file worker/schema.sql --remote
--                (or paste this into the D1 console in the Cloudflare dashboard)
-- Bind it to the Worker as DB.

CREATE TABLE IF NOT EXISTS accounts (
  key_hash     TEXT PRIMARY KEY,            -- SHA-256 of the access key; the key itself is never stored
  balance      INTEGER NOT NULL DEFAULT 0,  -- cents
  access_until INTEGER NOT NULL DEFAULT 0,  -- unix seconds; 0 means no period of access bought yet
  email        TEXT,                        -- as given to Stripe, for reissuing a lost key
  created      INTEGER NOT NULL
);

-- every movement, so a disputed charge can be explained
CREATE TABLE IF NOT EXISTS ledger (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL,
  delta    INTEGER NOT NULL,                -- cents: positive a top-up, negative a spend
  reason   TEXT NOT NULL,                   -- 'top-up', 'marking', 'access'
  ref      TEXT,                            -- Stripe session id, or what was spent on
  ts       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_account ON ledger (key_hash, ts);

-- Stripe retries a webhook until it is acknowledged; this makes a replay harmless,
-- because the second insert of the same session id simply fails.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_ref ON ledger (ref) WHERE ref IS NOT NULL;
