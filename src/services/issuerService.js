'use strict';

/**
 * Issuer service — registered parties that submit verifiable attestations,
 * plus management of their Ed25519 public keys (async / libSQL).
 *
 * Secrets: the API key is generated once at registration, returned once, and
 * stored only as a SHA-256 hash. Public keys are stored as SPKI PEM.
 */

const crypto = require('crypto');
const { getDb } = require('../db');

const SUPPORTED_ALGOS = new Set(['ed25519']);
const MAX_PUBLIC_KEY_BYTES = 4096;
const DISPLAY_NAME_MAX = 200;

function nowIso() {
  return new Date().toISOString();
}
function uuid() {
  return crypto.randomUUID();
}
function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex');
}
function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Public view of an issuer row (never exposes the api_key_hash). */
function publicIssuer(row) {
  if (!row) return null;
  return {
    id: row.id,
    display_name: row.display_name,
    status: row.status,
    created_at: row.created_at,
  };
}

/**
 * Register a new issuer (Admin path). Returns the plaintext API key exactly
 * once — it is never retrievable again.
 * @param {{displayName:string}} input
 * @returns {Promise<{issuer:object, apiKey:string}>}
 */
async function createIssuer({ displayName }) {
  const name = String(displayName == null ? '' : displayName).trim();
  if (name.length < 1 || name.length > DISPLAY_NAME_MAX) {
    throw httpError(
      `Field "display_name" must be 1-${DISPLAY_NAME_MAX} characters`,
      400
    );
  }

  const db = await getDb();
  const apiKey = crypto.randomBytes(24).toString('base64url'); // 32 chars
  const issuer = {
    id: uuid(),
    display_name: name,
    api_key_hash: hashApiKey(apiKey),
    status: 'active',
    created_at: nowIso(),
  };

  await db.execute({
    sql: `INSERT INTO issuers (id, display_name, api_key_hash, status, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      issuer.id, issuer.display_name, issuer.api_key_hash,
      issuer.status, issuer.created_at,
    ],
  });

  return { issuer: publicIssuer(issuer), apiKey };
}

/**
 * List all issuers (no secrets).
 * @returns {Promise<object[]>}
 */
async function listIssuers() {
  const db = await getDb();
  const res = await db.execute(
    `SELECT id, display_name, status, created_at FROM issuers ORDER BY created_at DESC`
  );
  return res.rows.map(publicIssuer);
}

/**
 * Resolve an issuer by its plaintext API key (hash lookup).
 * @param {string} apiKey
 * @returns {Promise<object|null>} full row or null
 */
async function getIssuerByApiKey(apiKey) {
  if (!apiKey) return null;
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM issuers WHERE api_key_hash = ? AND status = 'active' LIMIT 1`,
    args: [hashApiKey(apiKey)],
  });
  return res.rows[0] || null;
}

/**
 * Get an issuer by id (full row).
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function getIssuer(id) {
  if (!id) return null;
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM issuers WHERE id = ? LIMIT 1`,
    args: [id],
  });
  return res.rows[0] || null;
}

/**
 * Register a public key for an issuer.
 * @param {string} issuerId
 * @param {{publicKeyPem:string, algo?:string}} input
 * @returns {Promise<object>}
 */
async function addKey(issuerId, { publicKeyPem, algo = 'ed25519' }) {
  const db = await getDb();

  if (!SUPPORTED_ALGOS.has(String(algo).toLowerCase())) {
    throw httpError(`Unsupported key algorithm: ${algo}`, 400);
  }
  const pem = String(publicKeyPem || '');
  if (Buffer.byteLength(pem, 'utf8') > MAX_PUBLIC_KEY_BYTES) {
    throw httpError('Public key exceeds maximum allowed size', 400);
  }
  // Validate the key parses as an Ed25519 public key.
  try {
    const keyObject = crypto.createPublicKey(pem);
    if (keyObject.asymmetricKeyType !== 'ed25519') {
      throw new Error('not ed25519');
    }
  } catch {
    throw httpError('Malformed or unsupported public key', 400);
  }

  const key = {
    id: uuid(),
    issuer_id: issuerId,
    public_key: pem,
    algo: 'ed25519',
    status: 'active',
    created_at: nowIso(),
    revoked_at: null,
  };

  await db.execute({
    sql: `INSERT INTO issuer_keys (id, issuer_id, public_key, algo, status, created_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      key.id, key.issuer_id, key.public_key, key.algo,
      key.status, key.created_at, key.revoked_at,
    ],
  });

  return { ...key, public_key: undefined };
}

/**
 * Revoke one of an issuer's keys.
 *  - 404 when the key does not exist for this issuer
 *  - idempotent when already revoked (returns the current state)
 * @param {string} issuerId
 * @param {string} keyId
 * @returns {Promise<object>}
 */
async function revokeKey(issuerId, keyId) {
  const db = await getDb();
  const found = await db.execute({
    sql: `SELECT * FROM issuer_keys WHERE id = ? AND issuer_id = ? LIMIT 1`,
    args: [keyId, issuerId],
  });
  const key = found.rows[0];
  if (!key) {
    throw httpError('Issuer key not found', 404);
  }
  if (key.status === 'revoked') {
    return { id: key.id, status: 'revoked', revoked_at: key.revoked_at };
  }
  const ts = nowIso();
  await db.execute({
    sql: `UPDATE issuer_keys SET status = 'revoked', revoked_at = ? WHERE id = ?`,
    args: [ts, keyId],
  });
  return { id: key.id, status: 'revoked', revoked_at: ts };
}

/**
 * List an issuer's keys (public metadata only, never the raw key in listings).
 * @param {string} issuerId
 * @returns {Promise<object[]>}
 */
async function listKeys(issuerId) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT id, issuer_id, algo, status, created_at, revoked_at
          FROM issuer_keys WHERE issuer_id = ? ORDER BY created_at DESC`,
    args: [issuerId],
  });
  return res.rows;
}

/**
 * Get a specific key belonging to an issuer (full row, incl. public_key).
 * @param {string} issuerId
 * @param {string} keyId
 * @returns {Promise<object|null>}
 */
async function getKey(issuerId, keyId) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM issuer_keys WHERE id = ? AND issuer_id = ? LIMIT 1`,
    args: [keyId, issuerId],
  });
  return res.rows[0] || null;
}

module.exports = {
  SUPPORTED_ALGOS,
  MAX_PUBLIC_KEY_BYTES,
  DISPLAY_NAME_MAX,
  publicIssuer,
  createIssuer,
  listIssuers,
  getIssuerByApiKey,
  getIssuer,
  addKey,
  revokeKey,
  listKeys,
  getKey,
};
