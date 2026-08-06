-- All sat amounts are TEXT so bigints survive a round trip. lp_ledger amounts
-- are SIGNED decimal strings (credits positive, debits negative).

CREATE TABLE IF NOT EXISTS lps (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  api_key_hash  TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | paused
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- One row per lp x direction: the LP's standing offer on that side of the book.
CREATE TABLE IF NOT EXISTS lp_liquidity (
  lp_id           TEXT NOT NULL REFERENCES lps (id),
  direction       TEXT NOT NULL,                  -- swap_in | swap_out
  capacity_sats   TEXT NOT NULL,
  fee_bps         INTEGER NOT NULL,
  fee_fixed_sats  TEXT NOT NULL,
  min_sats        TEXT NOT NULL,
  max_sats        TEXT NOT NULL,
  est_seconds     INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (lp_id, direction)
);

-- The mock source of truth for what an LP can front, per chain. Double-entry
-- style: every swap settlement writes a credit on one chain and a debit on the
-- other; the rows of a completed swap sum to exactly the fees earned.
CREATE TABLE IF NOT EXISTS lp_ledger (
  id           TEXT PRIMARY KEY,
  lp_id        TEXT NOT NULL REFERENCES lps (id),
  chain        TEXT NOT NULL,                     -- onchain | offchain
  swap_id      TEXT REFERENCES swaps (id),
  leg_id       TEXT REFERENCES swap_legs (id),
  entry_type   TEXT NOT NULL,
  amount_sats  TEXT NOT NULL,                     -- signed decimal string
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lp_ledger_lp_chain ON lp_ledger (lp_id, chain);
CREATE INDEX IF NOT EXISTS idx_lp_ledger_swap ON lp_ledger (swap_id);

-- Quotes lock nothing and expire in 60s; legs are frozen as JSON.
CREATE TABLE IF NOT EXISTS quotes (
  id              TEXT PRIMARY KEY,
  direction       TEXT NOT NULL,
  amount_sats     TEXT NOT NULL,
  total_fee_sats  TEXT NOT NULL,
  est_seconds     INTEGER NOT NULL,
  legs_json       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active', -- active | accepted
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS swaps (
  id              TEXT PRIMARY KEY,
  quote_id        TEXT NOT NULL REFERENCES quotes (id),
  direction       TEXT NOT NULL,
  status          TEXT NOT NULL,
  amount_sats     TEXT NOT NULL,
  total_fee_sats  TEXT NOT NULL,
  destination     TEXT NOT NULL,
  webhook_url     TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  completed_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_swaps_status_created ON swaps (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swaps_expiry ON swaps (status, expires_at);

CREATE TABLE IF NOT EXISTS swap_legs (
  id                       TEXT PRIMARY KEY,
  swap_id                  TEXT NOT NULL REFERENCES swaps (id),
  lp_id                    TEXT NOT NULL REFERENCES lps (id),
  amount_sats              TEXT NOT NULL,
  fee_sats                 TEXT NOT NULL,
  est_seconds              INTEGER NOT NULL,
  status                   TEXT NOT NULL,
  deposit_address          TEXT NOT NULL UNIQUE,
  payout_tx_id             TEXT,
  payout_transfer_id       TEXT,
  error                    TEXT,
  needs_manual_resolution  INTEGER NOT NULL DEFAULT 0,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  settled_at               INTEGER
);

CREATE INDEX IF NOT EXISTS idx_swap_legs_swap ON swap_legs (swap_id);
CREATE INDEX IF NOT EXISTS idx_swap_legs_lp ON swap_legs (lp_id);
CREATE INDEX IF NOT EXISTS idx_swap_legs_payout_tx ON swap_legs (payout_tx_id);

-- Settlement events applied to legs. event_id is unique so replaying a poll
-- batch after a crash is a no-op.
CREATE TABLE IF NOT EXISTS leg_events (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL UNIQUE,
  leg_id       TEXT NOT NULL REFERENCES swap_legs (id),
  chain        TEXT NOT NULL,                     -- onchain | offchain
  kind         TEXT NOT NULL,                     -- deposit | payout
  tx_ref       TEXT NOT NULL,                     -- txId or transferId
  amount_sats  TEXT NOT NULL,
  status       TEXT NOT NULL,                     -- seen | confirmed | committed
  observed_at  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leg_events_leg ON leg_events (leg_id);

-- Outbound webhook attempts. The body is frozen at enqueue time so the
-- signature stays stable across retries.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               TEXT PRIMARY KEY,
  swap_id          TEXT NOT NULL REFERENCES swaps (id),
  url              TEXT NOT NULL,
  body             TEXT NOT NULL,
  signature        TEXT NOT NULL,
  status           TEXT NOT NULL,                 -- pending | delivered | failed
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_status_code INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhooks_due ON webhook_deliveries (status, next_attempt_at);

-- Single-row table holding both settlement poll cursors.
CREATE TABLE IF NOT EXISTS adapter_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  onchain_cursor  TEXT,
  offchain_cursor TEXT,
  updated_at      INTEGER NOT NULL
);

INSERT OR IGNORE INTO adapter_state (id, onchain_cursor, offchain_cursor, updated_at)
VALUES (1, NULL, NULL, 0);
