'use strict';

// Unit tests for spend receipts: every approved spend is signed with the
// platform Ed25519 key and anyone can verify the receipt independently.
// Uses an in-memory DB so it never touches real data.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
// Start without a configured key → the platform generates an ephemeral one.
delete process.env.RECEIPT_PRIVATE_KEY;

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { getDb, closeDb } = require('../db');
const spendService = require('../services/spendService');
const receiptService = require('../services/receiptService');
const { verifySignature } = require('../services/verification');

after(() => closeDb());

// Insert an active tier-3 agent + active permission directly.
async function seedPermission({ ceiling = 100, period = 'day' } = {}) {
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  const permId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', 800, 3, ?, ?)`,
    args: [agentId, 'r-' + agentId.slice(0, 8), 'w-' + agentId.slice(0, 8), 'CI', ts, ts],
  });
  await db.execute({
    sql: `INSERT INTO permissions (id, agent_id, category, ceiling, period, status, velocity_limit, velocity_window_s, counterparty_policy, granted_by, created_at, revoked_at)
          VALUES (?, ?, 'compute', ?, ?, 'active', NULL, NULL, 'open', 'CI', ?, NULL)`,
    args: [permId, agentId, ceiling, period, ts],
  });
  return { agentId, permId };
}

// ---------------------------------------------------------------------------
// Canonical payload
// ---------------------------------------------------------------------------

test('canonicalReceiptPayload has a fixed key order and normalizes values', () => {
  const a = receiptService.canonicalReceiptPayload({
    spend_id: 's1',
    amount: '12.5',
    note: '',
    payee: null,
    agent_id: 'a1',
    permission_id: 'p1',
    created_at: '2026-08-21T00:00:00.000Z',
    ignored_extra: 'x',
  });
  const parsed = JSON.parse(a);
  assert.deepStrictEqual(
    Object.keys(parsed),
    [...receiptService.RECEIPT_CANONICAL_FIELDS],
    'keys appear in canonical (sorted) order'
  );
  assert.strictEqual(parsed.amount, 12.5, 'amount coerced to a number');
  assert.strictEqual(parsed.note, null, 'empty note becomes null');
  assert.strictEqual(parsed.payee, null, 'null payee stays null');
  assert.strictEqual(parsed.ignored_extra, undefined, 'unknown fields dropped');
});

test('receiptFieldsFromSpend round-trips through the canonical payload', () => {
  const spend = {
    id: 's1',
    permission_id: 'p1',
    agent_id: 'a1',
    amount: 7,
    note: 'gpu',
    payee: 'vendor',
    created_at: '2026-08-21T00:00:00.000Z',
  };
  const fields = receiptService.receiptFieldsFromSpend(spend);
  assert.strictEqual(fields.spend_id, 's1');
  assert.strictEqual(fields.payee, 'vendor');
  // Rebuilding from the same row must produce identical canonical bytes.
  assert.strictEqual(
    receiptService.canonicalReceiptPayload(fields),
    receiptService.canonicalReceiptPayload(receiptService.receiptFieldsFromSpend(spend))
  );
});

// ---------------------------------------------------------------------------
// Signing + verification round-trip
// ---------------------------------------------------------------------------

test('signReceipt + verifyReceiptSignature round-trip (ephemeral key)', () => {
  const fields = {
    spend_id: 's1',
    permission_id: 'p1',
    agent_id: 'a1',
    amount: 1,
    note: null,
    payee: null,
    created_at: '2026-08-21T00:00:00.000Z',
  };
  const { signature, canonical } = receiptService.signReceipt(fields);
  assert.ok(signature.length > 0);
  assert.strictEqual(
    receiptService.verifyReceiptSignature({ canonical, signatureB64: signature }),
    true
  );
  // A tampered canonical payload fails.
  assert.strictEqual(
    receiptService.verifyReceiptSignature({
      canonical: canonical.replace('"amount":1', '"amount":2'),
      signatureB64: signature,
    }),
    false
  );
});

test('without RECEIPT_PRIVATE_KEY the platform key is flagged ephemeral', () => {
  const key = receiptService.getPlatformKey();
  assert.strictEqual(key.ephemeral, true);
  assert.match(key.publicKeyPem, /-----BEGIN PUBLIC KEY-----/);
});

test('a base64 seed RECEIPT_PRIVATE_KEY is deterministic and non-ephemeral', () => {
  const seed = crypto.randomBytes(32);
  process.env.RECEIPT_PRIVATE_KEY = seed.toString('base64');
  try {
    const k1 = receiptService.getPlatformKey();
    const k2 = receiptService.getPlatformKey();
    assert.strictEqual(k1.ephemeral, false);
    assert.strictEqual(k1.publicKeyPem, k2.publicKeyPem, 'same seed → same key');
    // The base64url form of the same seed resolves to the same key.
    process.env.RECEIPT_PRIVATE_KEY = seed
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const k3 = receiptService.getPlatformKey();
    assert.strictEqual(k3.publicKeyPem, k1.publicKeyPem, 'base64url accepted');
  } finally {
    delete process.env.RECEIPT_PRIVATE_KEY;
  }
});

test('a PEM RECEIPT_PRIVATE_KEY is accepted; garbage is rejected', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.RECEIPT_PRIVATE_KEY = pem;
  try {
    const key = receiptService.getPlatformKey();
    assert.strictEqual(key.ephemeral, false);
    const expected = pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    assert.strictEqual(key.publicKeyPem, expected);
  } finally {
    delete process.env.RECEIPT_PRIVATE_KEY;
  }

  process.env.RECEIPT_PRIVATE_KEY = 'not-a-key-at-all';
  try {
    assert.throws(() => receiptService.getPlatformKey(), /base64 32-byte|PEM/);
  } finally {
    delete process.env.RECEIPT_PRIVATE_KEY;
  }
});

// ---------------------------------------------------------------------------
// authorizeSpend signs every approved charge
// ---------------------------------------------------------------------------

test('authorizeSpend stores a verifying receipt signature + the named payee', async () => {
  const { permId, agentId } = await seedPermission();
  const now = Date.now();

  const { spend } = await spendService.authorizeSpend(
    permId,
    { amount: 12.5, note: 'gpu hour' },
    { nowMs: now }
  );

  assert.ok(spend.receipt_signature, 'spend carries a receipt signature');
  assert.strictEqual(spend.payee, null, 'no counterparty named → payee null');

  // The stored row verifies against the platform key.
  const receipt = await receiptService.buildReceipt(spend);
  assert.strictEqual(receipt.signed, true);
  assert.strictEqual(receipt.verified, true);
  assert.strictEqual(receipt.algorithm, 'ed25519');
  assert.deepStrictEqual(receipt.fields, {
    agent_id: agentId,
    amount: 12.5,
    created_at: spend.created_at,
    note: 'gpu hour',
    payee: null,
    permission_id: permId,
    spend_id: spend.id,
  });

  // Independent verification with ONLY the returned public key + canonical.
  assert.strictEqual(
    verifySignature({
      publicKeyPem: receipt.public_key,
      canonical: receipt.canonical,
      signatureB64: receipt.signature,
    }),
    true
  );
});

test('the payee named on a gated spend is part of the signed receipt', async () => {
  const { permId } = await seedPermission();

  // Register a payee agent so the counterparty gate passes.
  const db = await getDb();
  const ts = new Date().toISOString();
  const payeeId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, 'rcpt-vendor', ?, 'CI', 'active', 500, 2, ?, ?)`,
    args: [payeeId, '0x' + crypto.randomBytes(20).toString('hex'), ts, ts],
  });

  const { spend } = await spendService.authorizeSpend(
    permId,
    { amount: 5, counterparty: 'rcpt-vendor' },
    { nowMs: Date.now() }
  );
  assert.strictEqual(spend.payee, 'rcpt-vendor');

  const receipt = await receiptService.buildReceipt(spend);
  assert.strictEqual(receipt.fields.payee, 'rcpt-vendor');
  assert.strictEqual(receipt.verified, true);
});

test('an idempotent replay returns the original spend with the SAME receipt', async () => {
  const { permId } = await seedPermission();
  const now = Date.now();

  const first = await spendService.authorizeSpend(
    permId,
    { amount: 9, idempotencyKey: 'rcpt-retry' },
    { nowMs: now }
  );
  const replay = await spendService.authorizeSpend(
    permId,
    { amount: 9, idempotencyKey: 'rcpt-retry' },
    { nowMs: now }
  );
  assert.strictEqual(replay.idempotent_replay, true);
  assert.strictEqual(replay.spend.id, first.spend.id);
  assert.strictEqual(
    replay.spend.receipt_signature,
    first.spend.receipt_signature,
    'replay never re-signs — the original receipt stands'
  );
});

// ---------------------------------------------------------------------------
// buildReceipt honesty + tamper detection
// ---------------------------------------------------------------------------

test('a spend recorded before receipts is reported signed:false, never an error', async () => {
  const { permId, agentId } = await seedPermission();
  const db = await getDb();
  const legacyId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO spends (id, permission_id, agent_id, amount, note, payee, idempotency_key, receipt_signature, receipt_key_id, created_at)
          VALUES (?, ?, ?, 3, 'legacy', NULL, NULL, NULL, NULL, ?)`,
    args: [legacyId, permId, agentId, new Date().toISOString()],
  });

  const legacy = await spendService.getSpendById(legacyId);
  const receipt = await receiptService.buildReceipt(legacy);
  assert.strictEqual(receipt.signed, false);
  assert.strictEqual(receipt.verified, false);
  assert.strictEqual(receipt.signature, null);
  assert.strictEqual(receipt.public_key, null);
  assert.deepStrictEqual(receipt.fields, receiptService.receiptFieldsFromSpend(legacy));
});

test('tampering with a stored spend breaks its receipt verification', async () => {
  const { permId } = await seedPermission();
  const { spend } = await spendService.authorizeSpend(
    permId,
    { amount: 20, note: 'honest' },
    { nowMs: Date.now() }
  );

  // Attacker edits the amount in the ledger after the fact.
  const db = await getDb();
  await db.execute({
    sql: `UPDATE spends SET amount = 2000 WHERE id = ?`,
    args: [spend.id],
  });

  const tampered = await spendService.getSpendById(spend.id);
  const receipt = await receiptService.buildReceipt(tampered);
  assert.strictEqual(receipt.signed, true, 'still carries the old signature');
  assert.strictEqual(receipt.verified, false, 'signature no longer matches the fields');
});

test('receipts keep verifying after a platform key rotation', async () => {
  const seedA = crypto.randomBytes(32);
  process.env.RECEIPT_PRIVATE_KEY = seedA.toString('base64');
  try {
    const { permId } = await seedPermission();
    const { spend } = await spendService.authorizeSpend(
      permId,
      { amount: 4 },
      { nowMs: Date.now() }
    );
    const keyA = receiptService.getPlatformKey().publicKeyPem;
    assert.strictEqual(spend.receipt_key_id != null, true, 'spend pins its signing key');

    // Rotate to a brand-new key.
    process.env.RECEIPT_PRIVATE_KEY = crypto.randomBytes(32).toString('base64');
    const keyB = receiptService.getPlatformKey().publicKeyPem;
    assert.notStrictEqual(keyA, keyB, 'rotation actually changed the key');

    // The old receipt still verifies — via the key it was signed with.
    const receipt = await receiptService.buildReceipt(spend);
    assert.strictEqual(receipt.verified, true);
    assert.strictEqual(receipt.public_key, keyA, 'resolved via receipt_key_id, not current key');
    assert.strictEqual(receipt.ephemeral_key, false);
  } finally {
    delete process.env.RECEIPT_PRIVATE_KEY;
  }
});

test('ensurePlatformKeyRegistered is idempotent per public key', async () => {
  const id1 = await receiptService.ensurePlatformKeyRegistered();
  const id2 = await receiptService.ensurePlatformKeyRegistered();
  assert.strictEqual(id1, id2, 'same key → same platform_keys row');

  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM platform_keys WHERE id = ?`,
    args: [id1],
  });
  assert.strictEqual(Number(res.rows[0].n), 1);
});
