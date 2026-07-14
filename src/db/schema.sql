-- Kairune database schema
-- SQLite via libSQL / Turso. All timestamps are stored as ISO-8601 strings (UTC).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- agents: identity of each AI agent registered in Kairune
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,              -- uuid
  handle        TEXT NOT NULL UNIQUE,          -- unique name, e.g. "voyager-07"
  wallet        TEXT NOT NULL UNIQUE,          -- wallet address / API identity
  operator      TEXT,                          -- owner / team
  status        TEXT NOT NULL DEFAULT 'active' -- active | suspended
                  CHECK (status IN ('active', 'suspended')),
  score         INTEGER NOT NULL DEFAULT 0,    -- 0..1000, computed result
  tier          INTEGER NOT NULL DEFAULT 0,    -- 0..4
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- attestations: behavior records (good/bad) that form the trust score
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attestations (
  id            TEXT PRIMARY KEY,              -- uuid
  agent_id      TEXT NOT NULL,
  kind          TEXT NOT NULL                  -- event type
                  CHECK (kind IN (
                    'task_completed',
                    'clean_payment',
                    'peer_vouch',
                    'dispute',
                    'chargeback',
                    'anomaly_flag'
                  )),
  weight        REAL NOT NULL DEFAULT 1,        -- event weight (can be negative)
  amount        REAL DEFAULT 0,                 -- transaction value (optional)
  note          TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attestations_agent ON attestations(agent_id);
CREATE INDEX IF NOT EXISTS idx_attestations_kind  ON attestations(kind);

-- ---------------------------------------------------------------------------
-- issuers: registered parties allowed to submit verifiable (signed) attestations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issuers (
  id            TEXT PRIMARY KEY,              -- uuid
  display_name  TEXT NOT NULL,                 -- 1..200 chars
  api_key_hash  TEXT NOT NULL UNIQUE,          -- sha256 of the plaintext API key
  status        TEXT NOT NULL DEFAULT 'active' -- active | disabled
                  CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- issuer_keys: Ed25519 public keys used to verify an issuer's signatures
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issuer_keys (
  id            TEXT PRIMARY KEY,              -- uuid
  issuer_id     TEXT NOT NULL,
  public_key    TEXT NOT NULL,                 -- SPKI PEM (Ed25519)
  algo          TEXT NOT NULL DEFAULT 'ed25519',
  status        TEXT NOT NULL DEFAULT 'active' -- active | revoked
                  CHECK (status IN ('active', 'revoked')),
  created_at    TEXT NOT NULL,
  revoked_at    TEXT,
  FOREIGN KEY (issuer_id) REFERENCES issuers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issuer_keys_issuer ON issuer_keys(issuer_id);

-- ---------------------------------------------------------------------------
-- used_signatures: replay guard — each accepted signature may be used once
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS used_signatures (
  sig_hash      TEXT PRIMARY KEY,             -- sha256(signature)
  issuer_id     TEXT,
  created_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- permissions: scoped spending grants (revocable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
  id            TEXT PRIMARY KEY,              -- uuid
  agent_id      TEXT NOT NULL,
  category      TEXT NOT NULL,                 -- e.g. "compute", "subscriptions"
  ceiling       REAL NOT NULL,                 -- spending limit (per period)
  period        TEXT NOT NULL DEFAULT 'day'    -- day | week | month
                  CHECK (period IN ('day', 'week', 'month')),
  status        TEXT NOT NULL DEFAULT 'active' -- active | revoked
                  CHECK (status IN ('active', 'revoked')),
  granted_by    TEXT,                          -- who granted it
  created_at    TEXT NOT NULL,
  revoked_at    TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_permissions_agent ON permissions(agent_id);

-- ---------------------------------------------------------------------------
-- spends: actual charges authorized against a permission (enforces the ceiling)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spends (
  id            TEXT PRIMARY KEY,              -- uuid
  permission_id TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  amount        REAL NOT NULL,                 -- charge value (> 0)
  note          TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_spends_permission ON spends(permission_id);
CREATE INDEX IF NOT EXISTS idx_spends_agent ON spends(agent_id);

-- ---------------------------------------------------------------------------
-- webhooks: outbound HTTP endpoints notified when spend events happen
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhooks (
  id            TEXT PRIMARY KEY,              -- uuid
  url           TEXT NOT NULL,                 -- https endpoint to POST events to
  secret        TEXT NOT NULL,                 -- HMAC-SHA256 signing secret
  events        TEXT NOT NULL DEFAULT '*',     -- CSV of event names, or '*' for all
  status        TEXT NOT NULL DEFAULT 'active' -- active | disabled
                  CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL,
  last_status   INTEGER,                       -- last HTTP status seen (or null)
  last_error    TEXT,                          -- last delivery error (or null)
  last_at       TEXT                           -- last delivery attempt timestamp
);

CREATE INDEX IF NOT EXISTS idx_webhooks_status ON webhooks(status);

-- ---------------------------------------------------------------------------
-- webhook_deliveries: append-only log of each delivery attempt (audit trail)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            TEXT PRIMARY KEY,              -- uuid
  webhook_id    TEXT NOT NULL,
  event         TEXT NOT NULL,                 -- event name, e.g. spend.blocked
  payload       TEXT NOT NULL,                 -- JSON body sent
  status_code   INTEGER,                       -- HTTP status returned (or null)
  ok            INTEGER NOT NULL DEFAULT 0,    -- 1 if delivered (2xx), else 0
  error         TEXT,                          -- error message if failed
  created_at    TEXT NOT NULL,
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries(webhook_id);
