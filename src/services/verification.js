'use strict';

/**
 * Verification module — canonical payload + Ed25519 signature verification.
 *
 * A signed attestation is authenticated by verifying an Ed25519 signature over
 * a deterministic (canonical) serialization of a fixed set of attestation
 * fields. Signing and verification MUST produce identical bytes for identical
 * field values (round-trip property), so the canonical form uses a fixed key
 * order and normalized field values.
 *
 * No external dependency — uses Node's built-in crypto.
 */

const crypto = require('crypto');

// The exact fields that are signed, in canonical (sorted) order.
const CANONICAL_FIELDS = [
  'agent_id',
  'amount',
  'issued_at',
  'issuer_id',
  'issuer_key_id',
  'kind',
  'note',
];

/**
 * Build the canonical, byte-stable payload string for a set of attestation
 * fields. Key order is fixed; `amount` is coerced to a number; empty `note`
 * becomes null. Unknown fields are ignored.
 * @param {object} fields
 * @returns {string}
 */
function canonicalPayload(fields = {}) {
  const normalized = {};
  for (const key of CANONICAL_FIELDS) {
    let value = fields[key];
    if (key === 'amount') {
      value = Number(value) || 0;
    } else if (key === 'note') {
      value = value === undefined || value === null || value === '' ? null : String(value);
    } else {
      value = value === undefined || value === null ? null : String(value);
    }
    normalized[key] = value;
  }
  // CANONICAL_FIELDS is already sorted; JSON.stringify preserves insertion order.
  return JSON.stringify(normalized);
}

/**
 * Verify an Ed25519 signature (base64) over the canonical payload.
 * Returns false on any malformed input rather than throwing.
 * @param {{publicKeyPem:string, canonical:string, signatureB64:string}} args
 * @returns {boolean}
 */
function verifySignature({ publicKeyPem, canonical, signatureB64 }) {
  try {
    const keyObject = crypto.createPublicKey(publicKeyPem);
    const signature = Buffer.from(String(signatureB64), 'base64');
    if (signature.length === 0) return false;
    // For Ed25519 the algorithm argument must be null.
    return crypto.verify(null, Buffer.from(canonical), keyObject, signature);
  } catch {
    return false;
  }
}

/**
 * Evaluate a signed submission against a resolved issuer key row.
 * A revoked key (or a failed signature) yields 'unverified'.
 * @param {{fields:object, issuerKey:{public_key:string, status:string}|null}} args
 * @returns {{status:'verified'|'unverified', reason:string}}
 */
function evaluate({ fields, issuerKey }) {
  if (!issuerKey) {
    return { status: 'unverified', reason: 'key_not_found' };
  }
  const canonical = canonicalPayload(fields);
  const ok = verifySignature({
    publicKeyPem: issuerKey.public_key,
    canonical,
    signatureB64: fields.signature,
  });
  if (!ok) {
    return { status: 'unverified', reason: 'signature_invalid' };
  }
  if (issuerKey.status !== 'active') {
    return { status: 'unverified', reason: 'key_revoked' };
  }
  return { status: 'verified', reason: 'ok' };
}

module.exports = {
  CANONICAL_FIELDS,
  canonicalPayload,
  verifySignature,
  evaluate,
};
