-- PTE Score Lab — user accounts, replacing the key-per-device scheme
--
-- A person is one row in users, found by email however they signed in. Credit and access live
-- on that row, so paying on a phone and practising on a laptop is the same account.
--
-- Apply after schema.sql (or instead of it, on a fresh database):
--   paste into the D1 console, or
--   npx wrangler d1 execute pte-credit --file worker/schema-accounts.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,            -- random, never guessable; what a session names
  email        TEXT NOT NULL UNIQUE,        -- always stored lower-cased
  google_sub   TEXT UNIQUE,                 -- Google's subject id, set the first time they use it
  balance      INTEGER NOT NULL DEFAULT 0,  -- cents
  access_until INTEGER NOT NULL DEFAULT 0,  -- unix seconds
  free_marks   INTEGER NOT NULL DEFAULT 2,  -- AI markings given to a new account to try
  progress     TEXT,                        -- practice record as JSON, so history follows the account
  created      INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);

-- one-time sign-in codes; only the hash is kept, and they are useless after ten minutes
CREATE TABLE IF NOT EXISTS login_codes (
  email    TEXT PRIMARY KEY,
  hash     TEXT NOT NULL,
  expires  INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent     INTEGER NOT NULL
);

-- every movement of credit, kept against the user
CREATE TABLE IF NOT EXISTS entries (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  delta   INTEGER NOT NULL,                 -- cents: positive a top-up, negative a spend
  reason  TEXT NOT NULL,                    -- 'top-up', 'marking', 'access'
  ref     TEXT,                             -- Stripe session id, or what was spent on
  ts      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS entries_user ON entries (user_id, ts);

-- Stripe retries a webhook until it is acknowledged; this makes a replay harmless,
-- because the second insert of the same session id simply fails.
CREATE UNIQUE INDEX IF NOT EXISTS entries_ref ON entries (ref) WHERE ref IS NOT NULL;
