'use strict';

/**
 * Database layer — libSQL / Turso client (async).
 *
 * Two automatic modes:
 *  - LOCAL     : file:./data/kairune.db          (dev default)
 *  - TURSO     : libsql://<db>.turso.io + token  (production / Vercel)
 *
 * Env vars read:
 *  - TURSO_DATABASE_URL   (e.g. libsql://kairune-xxx.turso.io)
 *  - TURSO_AUTH_TOKEN     (token from `turso db tokens create`)
 *  - DB_PATH              (override local path, e.g. file:/tmp/x.db or :memory:)
 */

const path = require('path');
const fs = require('fs');

let client = null;
let ready = null;

function resolveConfig() {
  // Priority 1: Turso remote (production).
  if (process.env.TURSO_DATABASE_URL) {
    return {
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
      mode: 'turso',
    };
  }

  // Priority 2: explicit DB_PATH.
  let dbPath = process.env.DB_PATH;
  if (dbPath === ':memory:') {
    return { url: ':memory:', mode: 'memory' };
  }
  if (!dbPath) {
    dbPath = path.join(__dirname, '..', '..', 'data', 'kairune.db');
  }
  // libSQL needs the file: prefix for local paths.
  let fileUrl = dbPath.startsWith('file:') ? dbPath : 'file:' + dbPath;

  // Make sure the directory exists (for local file paths).
  const rawPath = fileUrl.replace(/^file:/, '');
  if (rawPath && rawPath !== ':memory:') {
    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  }
  return { url: fileUrl, mode: 'local' };
}

/**
 * Get the libSQL client (singleton). The schema is guaranteed to be applied.
 * @returns {Promise<import('@libsql/client').Client>}
 */
async function getDb() {
  if (client) {
    await ready;
    return client;
  }
  const cfg = resolveConfig();

  // Pick the right client:
  //  - Turso remote → @libsql/client/web (pure-JS HTTP, safe on serverless Vercel)
  //  - Local file   → @libsql/client (native, supports file: & :memory:)
  const createClient =
    cfg.mode === 'turso'
      ? require('@libsql/client/web').createClient
      : require('@libsql/client').createClient;

  client = createClient(
    cfg.mode === 'turso'
      ? { url: cfg.url, authToken: cfg.authToken }
      : { url: cfg.url }
  );

  ready = initSchema(client);
  await ready;
  return client;
}

/**
 * Apply the schema (idempotent). libSQL executes one statement per call,
 * so schema.sql is split per statement.
 * @param {import('@libsql/client').Client} c
 */
async function initSchema(c) {
  await c.execute('PRAGMA foreign_keys = ON');
  const schemaPath = path.join(__dirname, 'schema.sql');
  const raw = fs.readFileSync(schemaPath, 'utf8');

  // 1) Strip all comment lines FIRST (before splitting), so a comment banner
  //    above a CREATE TABLE doesn't "swallow" the statement.
  const noComments = raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  // 2) Split per statement, drop PRAGMA journal_mode (irrelevant for remote).
  const statements = noComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !/journal_mode/i.test(s));

  for (const stmt of statements) {
    await c.execute(stmt);
  }

  await ensureAttestationColumns(c);
  await ensureSpendColumns(c);
  await ensurePermissionColumns(c);
  await ensureSpendEventsConstraint(c);
}

/**
 * Idempotently add the optional velocity-limit columns to an existing
 * permissions table. CREATE TABLE IF NOT EXISTS won't alter a table that
 * already exists, so the columns are added via PRAGMA table_info + ALTER.
 * Both default to NULL, meaning "no velocity limit" — fully backward
 * compatible with permissions granted before the feature existed.
 * @param {import('@libsql/client').Client} c
 */
async function ensurePermissionColumns(c) {
  const info = await c.execute('PRAGMA table_info(permissions)');
  const existing = new Set(info.rows.map((r) => r.name));
  const additions = [
    ['velocity_limit', 'ALTER TABLE permissions ADD COLUMN velocity_limit REAL'],
    ['velocity_window_s', 'ALTER TABLE permissions ADD COLUMN velocity_window_s INTEGER'],
    // Payee scope: 'open' (legacy behaviour — counterparty optional),
    // 'required' (every spend must name a payee), 'allowlist' (must name a
    // payee that is pinned in permission_payees). Defaults to 'open' so
    // permissions granted before this feature keep working unchanged.
    [
      'counterparty_policy',
      `ALTER TABLE permissions ADD COLUMN counterparty_policy TEXT NOT NULL DEFAULT 'open'`,
    ],
    // Expiry deadline (ISO8601). NULL = never expires, so every permission
    // granted before this feature keeps working exactly as before.
    ['expires_at', 'ALTER TABLE permissions ADD COLUMN expires_at TEXT'],
  ];
  for (const [col, sql] of additions) {
    if (!existing.has(col)) {
      await c.execute(sql);
    }
  }
}

/**
 * Widen the spend_events.event CHECK constraint on databases created before
 * `spend.threshold` existed. CREATE TABLE IF NOT EXISTS won't touch an existing
 * table and SQLite can't ALTER a CHECK, so an old table is rebuilt in place:
 * create the new-shape table, copy rows, swap. The `event` value is always
 * code-controlled (never user input), so widening is safe. No-op when the
 * current definition already allows spend.threshold.
 * @param {import('@libsql/client').Client} c
 */
async function ensureSpendEventsConstraint(c) {
  const res = await c.execute(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spend_events'`
  );
  const ddl = res.rows[0] && res.rows[0].sql;
  // Already migrated (or freshly created with the new schema) — nothing to do.
  if (!ddl || ddl.includes('spend.threshold')) return;

  // Rebuild the table with the widened constraint, preserving existing rows.
  await c.execute('PRAGMA foreign_keys = OFF');
  try {
    await c.execute(`
      CREATE TABLE spend_events_new (
        id            TEXT PRIMARY KEY,
        event         TEXT NOT NULL
                        CHECK (event IN ('spend.approved', 'spend.blocked', 'spend.threshold')),
        agent_id      TEXT,
        agent_handle  TEXT,
        amount        REAL NOT NULL DEFAULT 0,
        ceiling       REAL,
        period        TEXT,
        reason        TEXT,
        created_at    TEXT NOT NULL
      )`);
    await c.execute(
      `INSERT INTO spend_events_new
         (id, event, agent_id, agent_handle, amount, ceiling, period, reason, created_at)
       SELECT id, event, agent_id, agent_handle, amount, ceiling, period, reason, created_at
       FROM spend_events`
    );
    await c.execute('DROP TABLE spend_events');
    await c.execute('ALTER TABLE spend_events_new RENAME TO spend_events');
    await c.execute(
      'CREATE INDEX IF NOT EXISTS idx_spend_events_created ON spend_events(created_at)'
    );
  } finally {
    await c.execute('PRAGMA foreign_keys = ON');
  }
}

/**
 * Idempotently add the idempotency_key column (+ its unique index) to an
 * existing spends table. CREATE TABLE IF NOT EXISTS will not alter a table
 * that already exists, so the column is added via PRAGMA table_info + ALTER.
 * @param {import('@libsql/client').Client} c
 */
async function ensureSpendColumns(c) {
  const info = await c.execute('PRAGMA table_info(spends)');
  const existing = new Set(info.rows.map((r) => r.name));
  if (!existing.has('idempotency_key')) {
    await c.execute('ALTER TABLE spends ADD COLUMN idempotency_key TEXT');
  }
  // Partial unique index: dedupes keyed spends per permission, exempts NULLs.
  await c.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_spends_idempotency
       ON spends(permission_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL`
  );
}

/**
 * Idempotently add the verification columns to the attestations table.
 * CREATE TABLE IF NOT EXISTS will not alter an existing table, so new
 * columns are added via PRAGMA table_info inspection + ALTER TABLE.
 * @param {import('@libsql/client').Client} c
 */
async function ensureAttestationColumns(c) {
  const info = await c.execute('PRAGMA table_info(attestations)');
  const existing = new Set(info.rows.map((r) => r.name));
  const additions = [
    ["verification_status", "ALTER TABLE attestations ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified'"],
    ['issuer_id', 'ALTER TABLE attestations ADD COLUMN issuer_id TEXT'],
    ['issuer_key_id', 'ALTER TABLE attestations ADD COLUMN issuer_key_id TEXT'],
  ];
  for (const [col, sql] of additions) {
    if (!existing.has(col)) {
      await c.execute(sql);
    }
  }
}

/**
 * Close the connection (used during test cleanup).
 */
function closeDb() {
  if (client) {
    client.close();
    client = null;
    ready = null;
  }
}

module.exports = { getDb, closeDb, resolveConfig };
