'use strict';

// Tests for the SIGNED counterparty verdict:
//   - receiptService.canonicalVerdictPayload  (byte-stable, key-order-independent)
//   - receiptService.verdictFieldsFromResult  (which fields are committed to)
//   - receiptService.signVerdict / verifyVerdictSignature (Ed25519 round-trip)
//   - POST /api/counterparty/check { sign:true } (HTTP: attestation attached)
//   - GET  /api/meta advertises the capability
//
// The point of the feature: a verdict a buyer agent can attach to a Virtuals
// ACP escrow job as attributable, non-repudiable proof of the go/no-go it
// acted on — verifiable OFFLINE with the platform key, without trusting the
// buyer's copy of the JSON. So the tests focus on two properties a signature
// must have to be worth anything:
//   1. it round-trips (a real signature verifies), and
//   2. it FAILS the moment any signed field is altered (tamper-evidence),
//      and matches byte-for-byte regardless of JSON key order.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
// Deterministic platform key so a signature is reproducible across runs and a
// verifier using the published public key gets the same answer we do. 32-byte
// base64 seed (all-zero seed is fine for a test — it is never a prod key).
process.env.RECEIPT_PRIVATE_KEY = Buffer.alloc(32, 7).toString('base64');

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const { getDb } = require('../db');
const receiptService = require('../services/receiptService');
const { KIND_WEIGHTS } = require('../services/trustScore');
const app = require('../../server');

let server;
let base;

function post(path, body) {
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve, reject) => {
    const r = http.request(
      base + path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, json: () => JSON.parse(data) })
        );
      }
    );
    r.on('error', reject);
    r.end(payload);
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, json: () => JSON.parse(data) })
      );
    });
    r.on('error', reject);
    r.end();
  });
}

async function insertAgent({ handle, wallet, score, tier, status = 'active', operator = 'Fixture Labs' }) {
  const db = await getDb();
  const id = crypto.randomUUID();
  const ts = '2026-01-01T00:00:00.000Z';
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, handle, wallet, operator, status, score, tier, ts, ts],
  });
  return id;
}

async function insertAttestation(agentId, kind, { status = 'verified', issuerId = 'iss-0' } = {}) {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO attestations
            (id, agent_id, kind, weight, amount, note, verification_status, issuer_id, created_at)
          VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      agentId,
      kind,
      KIND_WEIGHTS[kind],
      status,
      status === 'verified' ? issuerId : null,
      '2026-07-01T00:00:00.000Z',
    ],
  });
}

before(async () => {
  // A TRUSTED, active counterparty with diverse verified trust → proceed.
  const trustedId = await insertAgent({
    handle: 'sv-trusted',
    wallet: '0xdd00000000000000000000000000000000000001',
    score: 800,
    tier: 3,
  });
  for (let i = 0; i < 8; i++) {
    await insertAttestation(trustedId, 'clean_payment', { issuerId: `iss-${i % 4}` });
  }

  // An unrated fresh agent → decline (no basis to trust).
  await insertAgent({
    handle: 'sv-fresh',
    wallet: '0xdd00000000000000000000000000000000000003',
    score: 100,
    tier: 0,
  });

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

// ---------------------------------------------------------------------------
// canonicalVerdictPayload — byte-stable, key-order-independent, honest nulls
// ---------------------------------------------------------------------------

test('canonicalVerdictPayload is independent of input key order', () => {
  const a = receiptService.canonicalVerdictPayload({
    verdict: 'proceed',
    tier: 3,
    score: 800,
    counterparty_handle: 'x',
    counterparty_wallet: '0xabc',
    issued_at: '2026-08-02T00:00:00.000Z',
    registered: true,
    requested_amount: 100,
    suggested_max_amount: 420,
  });
  const b = receiptService.canonicalVerdictPayload({
    suggested_max_amount: 420,
    requested_amount: 100,
    registered: true,
    issued_at: '2026-08-02T00:00:00.000Z',
    counterparty_wallet: '0xabc',
    counterparty_handle: 'x',
    score: 800,
    tier: 3,
    verdict: 'proceed',
  });
  assert.strictEqual(a, b);
});

test('canonicalVerdictPayload keeps an absent amount null, not 0', () => {
  const s = receiptService.canonicalVerdictPayload({
    verdict: 'proceed',
    requested_amount: null,
  });
  // A signature over amount:null is a different claim from amount:0 (0 would
  // read as "checked against a zero ceiling"). Must not coerce.
  assert.match(s, /"requested_amount":null/);
});

test('canonicalVerdictPayload ignores unknown fields', () => {
  const s = receiptService.canonicalVerdictPayload({
    verdict: 'decline',
    checks: [{ id: 'x', detail: 'reworded prose' }],
    reasons: ['not_registered'],
  });
  assert.doesNotMatch(s, /reworded prose/);
  assert.doesNotMatch(s, /reasons/);
});

// ---------------------------------------------------------------------------
// signVerdict / verifyVerdictSignature — Ed25519 round-trip + tamper evidence
// ---------------------------------------------------------------------------

test('a signed verdict verifies against the platform key', async () => {
  const result = {
    registered: true,
    verdict: 'proceed',
    requested_amount: 100,
    suggested_max_amount: 420,
    counterparty: { handle: 'sv-trusted', wallet: '0xdd...1', score: 800, tier: 3 },
  };
  const signed = await receiptService.signVerdict(result, {
    issuedAt: '2026-08-02T00:00:00.000Z',
  });

  assert.strictEqual(signed.algorithm, 'ed25519');
  assert.strictEqual(signed.ephemeral_key, false, 'configured key is not ephemeral');
  assert.ok(signed.signature, 'a signature is present');
  assert.ok(signed.public_key.includes('BEGIN PUBLIC KEY'));

  const ok = receiptService.verifyVerdictSignature({
    signed_fields: signed.signed_fields,
    signatureB64: signed.signature,
    publicKeyPem: signed.public_key,
  });
  assert.strictEqual(ok, true);
});

test('verification fails if any signed field is altered (tamper-evident)', async () => {
  const result = {
    registered: true,
    verdict: 'decline',
    requested_amount: 100,
    suggested_max_amount: 420,
    counterparty: { handle: 'sv-trusted', wallet: '0xdd...1', score: 800, tier: 3 },
  };
  const signed = await receiptService.signVerdict(result, {
    issuedAt: '2026-08-02T00:00:00.000Z',
  });

  // Flip the decision from decline → proceed and try to reuse the signature.
  const tampered = { ...signed.signed_fields, verdict: 'proceed' };
  const ok = receiptService.verifyVerdictSignature({
    signed_fields: tampered,
    signatureB64: signed.signature,
    publicKeyPem: signed.public_key,
  });
  assert.strictEqual(ok, false, 'flipping the verdict must invalidate the signature');
});

test('verification fails if the amount the verdict was scoped to is changed', async () => {
  const result = {
    registered: true,
    verdict: 'proceed',
    requested_amount: 100,
    suggested_max_amount: 420,
    counterparty: { handle: 'sv-trusted', wallet: '0xdd...1', score: 800, tier: 3 },
  };
  const signed = await receiptService.signVerdict(result, {
    issuedAt: '2026-08-02T00:00:00.000Z',
  });
  const tampered = { ...signed.signed_fields, requested_amount: 100000 };
  const ok = receiptService.verifyVerdictSignature({
    signed_fields: tampered,
    signatureB64: signed.signature,
    publicKeyPem: signed.public_key,
  });
  assert.strictEqual(ok, false, 'a proceed@100 verdict must not verify as proceed@100000');
});

test('verdictFieldsFromResult nulls score/tier for an unregistered counterparty', () => {
  const fields = receiptService.verdictFieldsFromResult(
    { registered: false, verdict: 'decline', wallet: '0xabc', requested_amount: null },
    '2026-08-02T00:00:00.000Z'
  );
  assert.strictEqual(fields.registered, false);
  assert.strictEqual(fields.score, null);
  assert.strictEqual(fields.tier, null);
  assert.strictEqual(fields.verdict, 'decline');
});

// ---------------------------------------------------------------------------
// HTTP — POST /api/counterparty/check { sign: true }
// ---------------------------------------------------------------------------

test('check without sign returns no attestation block', async () => {
  const res = await post('/counterparty/check', { counterparty: 'sv-trusted' });
  assert.strictEqual(res.status, 200);
  const body = res.json();
  assert.strictEqual(body.verdict, 'proceed');
  assert.strictEqual(body.attestation, undefined, 'unsigned by default');
});

test('check with sign:true attaches a verifiable attestation', async () => {
  const res = await post('/counterparty/check', {
    counterparty: 'sv-trusted',
    amount: 100,
    sign: true,
  });
  assert.strictEqual(res.status, 200);
  const body = res.json();
  assert.strictEqual(body.verdict, 'proceed');
  assert.ok(body.attestation, 'attestation attached');

  const a = body.attestation;
  // The signed fields commit to the decision, not the prose.
  assert.strictEqual(a.signed_fields.verdict, 'proceed');
  assert.strictEqual(a.signed_fields.counterparty_handle, 'sv-trusted');
  assert.strictEqual(a.signed_fields.requested_amount, 100);
  assert.strictEqual(a.signed_fields.registered, true);

  // Independently verify with only the fields + signature + public key — the
  // exact position of an offline ACP verifier.
  const ok = receiptService.verifyVerdictSignature({
    signed_fields: a.signed_fields,
    signatureB64: a.signature,
    publicKeyPem: a.public_key,
  });
  assert.strictEqual(ok, true);
});

test('a signed decline for an unregistered wallet still verifies', async () => {
  const res = await post('/counterparty/check', {
    counterparty: '0xffffffffffffffffffffffffffffffffffffffff',
    sign: true,
  });
  assert.strictEqual(res.status, 200);
  const body = res.json();
  assert.strictEqual(body.registered, false);
  assert.strictEqual(body.verdict, 'decline');

  const a = body.attestation;
  assert.strictEqual(a.signed_fields.registered, false);
  assert.strictEqual(a.signed_fields.verdict, 'decline');
  assert.strictEqual(a.signed_fields.score, null);
  const ok = receiptService.verifyVerdictSignature({
    signed_fields: a.signed_fields,
    signatureB64: a.signature,
    publicKeyPem: a.public_key,
  });
  assert.strictEqual(ok, true);
});

test('the signature is bound to the platform key published at /api/platform-key', async () => {
  const signed = (await post('/counterparty/check', { counterparty: 'sv-trusted', sign: true }))
    .json()
    .attestation;
  const key = (await get('/platform-key')).json();
  // Same key material that signs spend receipts — one published key covers
  // both receipts and verdicts.
  assert.strictEqual(signed.public_key.trim(), key.public_key.trim());
});

test('/api/meta advertises the signed-verdict capability', async () => {
  const meta = (await get('/meta')).json();
  assert.strictEqual(meta.counterparty_signed_verdict, true);
  assert.ok(
    meta.counterparty_verdict_signed_fields.includes('verdict'),
    'signed field list is published so a verifier can rebuild the payload'
  );
});
