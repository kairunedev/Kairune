'use strict';

// Tests for PUBLIC verdict verification via POST /api/verify.
//
// The signed counterparty verdict (POST /api/counterparty/check {sign:true})
// already exists and is verifiable with the SDK's verifyVerdictSignature. But
// an offline ACP verifier — an escrow contract's keeper, a seller agent, an
// arbiter — should not need our SDK to check it. It should be able to POST the
// signed_fields + signature + published platform key to the same public,
// stateless /api/verify endpoint it already uses for attestations, and get a
// straight yes/no.
//
// Before this change /api/verify only knew the ATTESTATION canonical shape
// (agent_id, kind, amount, ...). Handed a verdict's signed_fields it rebuilt
// the wrong payload and every real verdict verified as FALSE. These tests pin
// the two properties that matter:
//   1. a real verdict, verified through the public endpoint, returns true, and
//   2. flipping any signed field flips it to false (tamper-evidence),
// plus that the endpoint auto-detects a verdict payload without a mode flag,
// and that the attestation path is completely unchanged.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.RECEIPT_PRIVATE_KEY = Buffer.alloc(32, 7).toString('base64');

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const { getDb } = require('../db');
const receiptService = require('../services/receiptService');
const verification = require('../services/verification');
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

async function insertAttestation(agentId, kind, { issuerId = 'iss-0' } = {}) {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO attestations
            (id, agent_id, kind, weight, amount, note, verification_status, issuer_id, created_at)
          VALUES (?, ?, ?, ?, 0, NULL, 'verified', ?, ?)`,
    args: [crypto.randomUUID(), agentId, kind, KIND_WEIGHTS[kind], issuerId, '2026-07-01T00:00:00.000Z'],
  });
}

before(async () => {
  const trustedId = await insertAgent({
    handle: 'vv-trusted',
    wallet: '0xee00000000000000000000000000000000000001',
    score: 800,
    tier: 3,
  });
  for (let i = 0; i < 8; i++) {
    await insertAttestation(trustedId, 'clean_payment', { issuerId: `iss-${i % 4}` });
  }
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

// Get a real signed verdict straight from the HTTP surface.
async function signedVerdict(counterparty = 'vv-trusted', amount = 100) {
  const res = await post('/counterparty/check', { counterparty, amount, sign: true });
  assert.strictEqual(res.status, 200, 'check returned 200');
  return res.json().attestation;
}

// ---------------------------------------------------------------------------
// The gap this closes: a verdict, verified through the PUBLIC endpoint.
// ---------------------------------------------------------------------------

test('POST /api/verify with mode:"verdict" verifies a real signed verdict', async () => {
  const a = await signedVerdict();
  const res = await post('/verify', {
    mode: 'verdict',
    public_key: a.public_key,
    signature: a.signature,
    fields: a.signed_fields,
  });
  assert.strictEqual(res.status, 200);
  const body = res.json();
  assert.strictEqual(body.verified, true, 'a real verdict verifies through /api/verify');
  assert.strictEqual(body.mode, 'verdict');
  assert.ok(body.signed_fields.includes('verdict'));
});

test('POST /api/verify auto-detects a verdict payload without a mode flag', async () => {
  const a = await signedVerdict();
  // No mode: the presence of a `verdict` field (and absence of `kind`) is
  // enough for the endpoint to pick the verdict canonicalization.
  const res = await post('/verify', {
    public_key: a.public_key,
    signature: a.signature,
    fields: a.signed_fields,
  });
  assert.strictEqual(res.json().verified, true);
  assert.strictEqual(res.json().mode, 'verdict');
});

test('a tampered verdict fails public verification', async () => {
  const a = await signedVerdict('vv-trusted', 100);
  const tampered = { ...a.signed_fields, requested_amount: 1000000 };
  const res = await post('/verify', {
    mode: 'verdict',
    public_key: a.public_key,
    signature: a.signature,
    fields: tampered,
  });
  assert.strictEqual(res.json().verified, false);
  assert.strictEqual(res.json().reason, 'signature_invalid');
});

test('the canonical returned matches the SDK canonicalization byte-for-byte', async () => {
  const a = await signedVerdict();
  const res = await post('/verify', {
    mode: 'verdict',
    public_key: a.public_key,
    signature: a.signature,
    fields: a.signed_fields,
  });
  const expected = receiptService.canonicalVerdictPayload(a.signed_fields);
  assert.strictEqual(res.json().canonical, expected);
});

// ---------------------------------------------------------------------------
// The attestation path must be completely unchanged.
// ---------------------------------------------------------------------------

test('attestation verification still works and is the default mode', async () => {
  // Sign an attestation-shaped payload with a throwaway Ed25519 key and verify
  // it through the same endpoint, exactly as before this change.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const fields = {
    agent_id: 'a-1',
    amount: 10,
    issued_at: '2026-08-02T00:00:00.000Z',
    issuer_id: 'iss-x',
    issuer_key_id: 'key-x',
    kind: 'clean_payment',
    note: 'hello',
  };
  const canonical = verification.canonicalPayload(fields);
  const signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

  const res = await post('/verify', { public_key: publicKeyPem, signature, fields });
  const body = res.json();
  assert.strictEqual(body.verified, true);
  assert.strictEqual(body.mode, 'attestation');
  assert.deepStrictEqual(body.signed_fields, verification.CANONICAL_FIELDS);
});

test('an explicit mode:"attestation" on a verdict payload does NOT auto-switch', async () => {
  // If the caller insists on attestation mode, honor it — a verdict payload
  // then simply fails to verify (wrong canonical), rather than being silently
  // reinterpreted. Explicit beats auto-detect.
  const a = await signedVerdict();
  const res = await post('/verify', {
    mode: 'attestation',
    public_key: a.public_key,
    signature: a.signature,
    fields: a.signed_fields,
  });
  assert.strictEqual(res.json().mode, 'attestation');
  assert.strictEqual(res.json().verified, false);
});

test('an invalid mode is a 400', async () => {
  const a = await signedVerdict();
  const res = await post('/verify', {
    mode: 'nonsense',
    public_key: a.public_key,
    signature: a.signature,
    fields: a.signed_fields,
  });
  assert.strictEqual(res.status, 400);
});

test('/api/meta advertises that /api/verify checks verdicts too', async () => {
  const res = await post('/counterparty/check', { counterparty: 'vv-trusted' });
  assert.strictEqual(res.status, 200);
  const metaRes = await new Promise((resolve, reject) => {
    const r = http.request(base + '/meta', { method: 'GET' }, (rr) => {
      let d = '';
      rr.on('data', (c) => (d += c));
      rr.on('end', () => resolve(JSON.parse(d)));
    });
    r.on('error', reject);
    r.end();
  });
  assert.ok(
    Array.isArray(metaRes.verify_modes) && metaRes.verify_modes.includes('verdict'),
    'meta.verify_modes lists "verdict"'
  );
});
