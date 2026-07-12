'use strict';

/**
 * Replay guard for signed attestations.
 *
 * Two protections:
 *  1. Freshness: a signed submission's issued_at must be recent (within a
 *     configurable window) and not too far in the future (clock skew).
 *  2. Single-use: each accepted signature may only be used once — the signature
 *     hash is reserved atomically, and a repeat submission is rejected as a replay.
 *
 * Config (env):
 *   REPLAY_MAX_AGE_SECONDS      default 300  (how old issued_at may be)
 *   REPLAY_FUTURE_SKEW_SECONDS  default 60   (how far ahead issued_at may be)
 */

const crypto = require('crypto');
const { getDb } = require('../db');

function maxAgeSeconds() {
  const n = parseInt(process.env.REPLAY_MAX_AGE_SECONDS, 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
}
function futureSkewSeconds() {
  const n = parseInt(process.env.REPLAY_FUTURE_SKEW_SECONDS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

function hashSignature(signatureB64) {
  return crypto.createHash('sha256').update(String(signatureB64)).digest('hex');
}

/**
 * Check that issued_at is a valid ISO timestamp within the freshness window.
 * @param {string} issuedAt
 * @param {number} [nowMs]
 * @returns {{ ok:boolean, reason?:string }}
 */
function checkFreshness(issuedAt, nowMs) {
  const now = nowMs || Date.now();
  const t = Date.parse(issuedAt);
  if (!Number.isFinite(t)) {
    return { ok: false, reason: 'issued_at missing or not a valid ISO timestamp' };
  }
  const ageMs = now - t;
  if (ageMs > maxAgeSeconds() * 1000) {
    return { ok: false, reason: 'issued_at is too old (stale signature)' };
  }
  if (-ageMs > futureSkewSeconds() * 1000) {
    return { ok: false, reason: 'issued_at is too far in the future' };
  }
  return { ok: true };
}

/**
 * Atomically reserve a signature hash. Returns true if this is the first use,
 * false if the signature has already been used (replay).
 * @param {string} signatureB64
 * @param {string|null} issuerId
 * @returns {Promise<boolean>}
 */
async function reserveSignature(signatureB64, issuerId = null) {
  const db = await getDb();
  const res = await db.execute({
    sql: `INSERT OR IGNORE INTO used_signatures (sig_hash, issuer_id, created_at)
          VALUES (?, ?, ?)`,
    args: [hashSignature(signatureB64), issuerId, new Date().toISOString()],
  });
  return res.rowsAffected > 0;
}

module.exports = {
  maxAgeSeconds,
  futureSkewSeconds,
  hashSignature,
  checkFreshness,
  reserveSignature,
};
