'use strict';

/**
 * Receipt service — cryptographic proof for every approved spend.
 *
 * Attestations are signed by ISSUERS (third parties vouching for behavior);
 * receipts are signed by KAIRUNE ITSELF: the moment a spend is authorized,
 * the exact charge (who, what, how much, when) is signed with the platform
 * Ed25519 key and stored on the spend row. Anyone — the paying agent, the
 * payee, or a third party — can then verify the receipt with nothing but the
 * signature, the fields, and the public key. "Show me the receipt" becomes a
 * cryptographic check instead of a database lookup you have to trust.
 *
 * Key management:
 *  - RECEIPT_PRIVATE_KEY set   → that key signs (base64 32-byte seed or PEM).
 *  - RECEIPT_PRIVATE_KEY unset → an ephemeral in-memory key is generated and
 *    the key metadata is flagged `ephemeral: true` so nobody mistakes a
 *    dev/test signature for a production commitment.
 *
 * No external dependency — Node's built-in crypto only.
 */

const crypto = require('crypto');
const { getDb } = require('../db');
const { verifySignature } = require('./verification');

// The exact receipt fields that are signed, in canonical (sorted) order.
// Same discipline as attestation canonical payloads: fixed key order +
// normalized values, so signing and verification always agree byte-for-byte.
const RECEIPT_CANONICAL_FIELDS = Object.freeze([
  'agent_id',
  'amount',
  'created_at',
  'note',
  'payee',
  'permission_id',
  'spend_id',
]);

// PKCS8 DER prefix for a raw 32-byte Ed25519 seed. Lets operators configure
// the platform key as a plain base64 seed (easy to generate, easy to rotate)
// without shipping a PEM file.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Build the canonical, byte-stable payload string for a set of receipt
 * fields. Key order is fixed; `amount` is coerced to a number; empty
 * `note`/`payee` become null. Unknown fields are ignored.
 * @param {object} fields
 * @returns {string}
 */
function canonicalReceiptPayload(fields = {}) {
  const normalized = {};
  for (const key of RECEIPT_CANONICAL_FIELDS) {
    let value = fields[key];
    if (key === 'amount') {
      value = Number(value) || 0;
    } else if (key === 'note' || key === 'payee') {
      value =
        value === undefined || value === null || value === ''
          ? null
          : String(value);
    } else {
      value = value === undefined || value === null ? null : String(value);
    }
    normalized[key] = value;
  }
  // RECEIPT_CANONICAL_FIELDS is already sorted; JSON.stringify preserves
  // insertion order.
  return JSON.stringify(normalized);
}

/**
 * Reconstruct the signed receipt fields from a stored spend row.
 * This is the single source of truth: both the signing step (at spend time)
 * and the public receipt endpoint derive the fields the same way, so what is
 * verified is always exactly what was stored.
 * @param {object} spend row from the spends table
 * @returns {object}
 */
function receiptFieldsFromSpend(spend) {
  return {
    agent_id: spend.agent_id,
    amount: Number(spend.amount) || 0,
    created_at: spend.created_at,
    note: spend.note == null || spend.note === '' ? null : String(spend.note),
    payee: spend.payee == null || spend.payee === '' ? null : String(spend.payee),
    permission_id: spend.permission_id,
    spend_id: spend.id,
  };
}

// Platform key cache. Re-resolved whenever the env value changes, so tests
// can flip RECEIPT_PRIVATE_KEY without a process restart, while production
// (constant env) pays the parsing cost exactly once.
let cached = { raw: undefined, key: null };

/**
 * Build an Ed25519 private KeyObject from a raw 32-byte seed.
 * @param {Buffer} seed
 * @returns {import('crypto').KeyObject}
 */
function privateKeyFromSeed(seed) {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/**
 * Resolve the platform signing key.
 *
 * @returns {{privateKey:import('crypto').KeyObject, publicKeyPem:string, ephemeral:boolean}}
 */
function getPlatformKey() {
  const raw = (process.env.RECEIPT_PRIVATE_KEY || '').trim();
  if (cached.key && cached.raw === raw) return cached.key;

  let privateKey;
  let ephemeral = false;

  if (!raw) {
    // Dev/test convenience: generate an ephemeral key. Signatures are real and
    // verify correctly, but the key dies with the process and is flagged as
    // ephemeral so it is never presented as a production commitment.
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    ephemeral = true;
  } else if (/-----BEGIN/.test(raw)) {
    // PEM (PKCS8) private key supplied verbatim.
    privateKey = crypto.createPrivateKey(raw);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('RECEIPT_PRIVATE_KEY must be an Ed25519 private key');
    }
  } else {
    // Base64 or base64url 32-byte seed. Normalize base64url (-_ → +/, pad)
    // so operators can paste either form.
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      raw.length + ((4 - (raw.length % 4)) % 4),
      '='
    );
    const seed = Buffer.from(b64, 'base64');
    if (seed.length !== 32) {
      throw new Error(
        'RECEIPT_PRIVATE_KEY must be a base64 32-byte Ed25519 seed or a PEM private key'
      );
    }
    privateKey = privateKeyFromSeed(seed);
  }

  const publicKeyPem = crypto
    .createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' })
    .toString();

  cached = {
    raw,
    key: { privateKey, publicKeyPem, ephemeral },
  };
  return cached.key;
}

/**
 * Sign a set of receipt fields with the platform key.
 * @param {object} fields
 * @returns {{signature:string, canonical:string}} base64 signature + canonical payload
 */
function signReceipt(fields) {
  const { privateKey } = getPlatformKey();
  const canonical = canonicalReceiptPayload(fields);
  const signature = crypto
    .sign(null, Buffer.from(canonical), privateKey)
    .toString('base64');
  return { signature, canonical };
}

/**
 * Verify a receipt signature against a public key (defaults to the current
 * platform key). Never throws — malformed input simply returns false.
 * @param {{canonical:string, signatureB64:string, publicKeyPem?:string}} args
 * @returns {boolean}
 */
function verifyReceiptSignature({ canonical, signatureB64, publicKeyPem }) {
  const pem = publicKeyPem || getPlatformKey().publicKeyPem;
  return verifySignature({ publicKeyPem: pem, canonical, signatureB64 });
}

/**
 * Make sure the current platform public key is published in `platform_keys`,
 * and return that row's id. Idempotent: the public key PEM is unique, so a
 * key that is already registered is reused. Best-effort — if the write fails
 * (e.g. a read-only replica mid-deploy) the receipt is still signed; the key
 * row is an audit aid, not a precondition.
 * @returns {Promise<string|null>} platform_keys.id or null when unregistered
 */
async function ensurePlatformKeyRegistered() {
  try {
    const { publicKeyPem, ephemeral } = getPlatformKey();
    const db = await getDb();
    const found = await db.execute({
      sql: `SELECT id FROM platform_keys WHERE public_key = ? LIMIT 1`,
      args: [publicKeyPem],
    });
    if (found.rows[0]) return found.rows[0].id;

    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO platform_keys (id, public_key, algo, purpose, ephemeral, created_at)
            VALUES (?, ?, 'ed25519', 'receipt', ?, ?)`,
      args: [id, publicKeyPem, ephemeral ? 1 : 0, new Date().toISOString()],
    });
    return id;
  } catch {
    return null;
  }
}

/**
 * Sign a spend row's receipt and return everything a verifier needs.
 * Used at spend time: the signature is stored on the spend itself.
 * @param {object} spend
 * @returns {Promise<{signature:string, canonical:string, keyId:string|null, publicKeyPem:string, ephemeral:boolean}>}
 */
async function signSpendReceipt(spend) {
  const fields = receiptFieldsFromSpend(spend);
  const { signature, canonical } = signReceipt(fields);
  const keyId = await ensurePlatformKeyRegistered();
  const { publicKeyPem, ephemeral } = getPlatformKey();
  return { signature, canonical, keyId, publicKeyPem, ephemeral };
}

/**
 * Resolve the public key that signed a stored spend.
 *
 * Prefers the key the spend points at (its `receipt_key_id` row in
 * platform_keys) so receipts keep verifying after a key rotation; falls back
 * to the current platform key when the row is missing (legacy/ephemeral
 * setups). Returns null when neither source yields a key.
 * @param {object} spend
 * @returns {Promise<{publicKeyPem:string, ephemeral:boolean, keyId:string|null}|null>}
 */
async function resolveReceiptKey(spend) {
  if (spend.receipt_key_id) {
    try {
      const db = await getDb();
      const res = await db.execute({
        sql: `SELECT id, public_key, ephemeral FROM platform_keys WHERE id = ? LIMIT 1`,
        args: [spend.receipt_key_id],
      });
      const row = res.rows[0];
      if (row) {
        return {
          publicKeyPem: row.public_key,
          ephemeral: Boolean(Number(row.ephemeral)),
          keyId: row.id,
        };
      }
    } catch {
      /* fall through to the current key */
    }
  }
  try {
    const { publicKeyPem, ephemeral } = getPlatformKey();
    return { publicKeyPem, ephemeral, keyId: spend.receipt_key_id || null };
  } catch {
    return null;
  }
}

/**
 * Build the public receipt for a stored spend and verify it.
 *
 * Returns everything an independent verifier needs — the signed fields, the
 * canonical payload, the signature, and the public key — plus the result of
 * verifying the stored signature right now. A spend recorded before receipts
 * existed (or whose signing failed) has no signature and is reported as
 * `signed: false`, never as a failure.
 *
 * @param {object} spend row from the spends table
 * @returns {Promise<{spend_id:string, signed:boolean, verified:boolean, fields:object, canonical:string|null, signature:string|null, algorithm:string, public_key:string|null, key_id:string|null, ephemeral_key:boolean}>}
 */
async function buildReceipt(spend) {
  const fields = receiptFieldsFromSpend(spend);
  const signature = spend.receipt_signature || null;

  if (!signature) {
    return {
      spend_id: spend.id,
      signed: false,
      verified: false,
      fields,
      canonical: null,
      signature: null,
      algorithm: 'ed25519',
      public_key: null,
      key_id: null,
      ephemeral_key: false,
    };
  }

  const canonical = canonicalReceiptPayload(fields);
  const key = await resolveReceiptKey(spend);
  const verified = key
    ? verifySignature({
        publicKeyPem: key.publicKeyPem,
        canonical,
        signatureB64: signature,
      })
    : false;

  return {
    spend_id: spend.id,
    signed: true,
    verified,
    fields,
    canonical,
    signature,
    algorithm: 'ed25519',
    public_key: key ? key.publicKeyPem : null,
    key_id: key ? key.keyId : null,
    ephemeral_key: key ? key.ephemeral : false,
  };
}

module.exports = {
  RECEIPT_CANONICAL_FIELDS,
  canonicalReceiptPayload,
  receiptFieldsFromSpend,
  getPlatformKey,
  signReceipt,
  verifyReceiptSignature,
  ensurePlatformKeyRegistered,
  signSpendReceipt,
  resolveReceiptKey,
  buildReceipt,
};
