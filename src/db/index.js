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
