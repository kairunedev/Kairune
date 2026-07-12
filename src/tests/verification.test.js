'use strict';

// Unit tests for the verification module (canonical payload + Ed25519).

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  canonicalPayload,
  verifySignature,
  evaluate,
} = require('../services/verification');

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function sign(privateKey, canonical) {
  return crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64');
}

const baseFields = {
  agent_id: 'agent-1',
  kind: 'task_completed',
  amount: 10,
  note: 'ok',
  issuer_id: 'iss-1',
  issuer_key_id: 'key-1',
  issued_at: '2026-07-12T00:00:00.000Z',
};

test('canonicalPayload is deterministic regardless of key order', () => {
  const a = canonicalPayload(baseFields);
  const shuffled = {
    note: 'ok',
    kind: 'task_completed',
    issued_at: '2026-07-12T00:00:00.000Z',
    agent_id: 'agent-1',
    issuer_key_id: 'key-1',
    amount: 10,
    issuer_id: 'iss-1',
  };
  assert.strictEqual(a, canonicalPayload(shuffled));
});

test('signature round-trips: sign then verify succeeds', () => {
  const { publicKeyPem, privateKey } = keypair();
  const canonical = canonicalPayload(baseFields);
  const signatureB64 = sign(privateKey, canonical);
  assert.strictEqual(
    verifySignature({ publicKeyPem, canonical, signatureB64 }),
    true
  );
});

test('tampering any field breaks verification', () => {
  const { publicKeyPem, privateKey } = keypair();
  const signatureB64 = sign(privateKey, canonicalPayload(baseFields));
  const tampered = canonicalPayload({ ...baseFields, amount: 11 });
  assert.strictEqual(
    verifySignature({ publicKeyPem, canonical: tampered, signatureB64 }),
    false
  );
});

test('verifySignature returns false on malformed input (no throw)', () => {
  assert.strictEqual(
    verifySignature({ publicKeyPem: 'not-a-key', canonical: 'x', signatureB64: 'y' }),
    false
  );
});

test('evaluate: valid sig on active key -> verified', () => {
  const { publicKeyPem, privateKey } = keypair();
  const signature = sign(privateKey, canonicalPayload(baseFields));
  const out = evaluate({
    fields: { ...baseFields, signature },
    issuerKey: { public_key: publicKeyPem, status: 'active' },
  });
  assert.strictEqual(out.status, 'verified');
});

test('evaluate: valid sig on revoked key -> unverified', () => {
  const { publicKeyPem, privateKey } = keypair();
  const signature = sign(privateKey, canonicalPayload(baseFields));
  const out = evaluate({
    fields: { ...baseFields, signature },
    issuerKey: { public_key: publicKeyPem, status: 'revoked' },
  });
  assert.strictEqual(out.status, 'unverified');
  assert.strictEqual(out.reason, 'key_revoked');
});

test('evaluate: missing key -> unverified', () => {
  const out = evaluate({ fields: baseFields, issuerKey: null });
  assert.strictEqual(out.status, 'unverified');
});
