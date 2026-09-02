'use strict';

// The note surface is consumed by AI agents that read GET /api/agents/:id and
// treat attestation history as context. A free-text `note` written by anybody
// to any agent's history is how instruction-shaped prose reaches a model, so it
// must be bounded and flat. This file proves three things:
//
//   1. `assertValidNote` enforces the contract: short, no brackets/backticks,
//      no formatting codepoints, whitespace collapsed.
//   2. On a locked agent, adding a `note` without a fresh wallet proof is 401,
//      while a note-less attestation is still 201 (opt-in, not a breaking change).
//   3. Spend `note` is covered the same way (via assertValidNote + the existing
//      owner-lock guard on /permissions/:pid/spends).

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const secp = require('@noble/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');
const { hmac } = require('@noble/hashes/hmac');
const { sha256 } = require('@noble/hashes/sha256');

secp.utils.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.utils.concatBytes(...m));

const app = require('../../server');

let server;
let base;

function makeWallet() {
  const priv = crypto.randomBytes(32);
  const pub = secp.getPublicKey(priv, false);
  const address =
    '0x' + Buffer.from(keccak_256(pub.subarray(1))).subarray(-20).toString('hex');
  return { priv, address };
}

function personalSign(priv, message) {
  const body = Buffer.from(message, 'utf8');
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8');
  const digest = keccak_256(Buffer.concat([prefix, body]));
  const [sig, rec] = secp.signSync(digest, priv, { recovered: true, der: false });
  return '0x' + Buffer.from(sig).toString('hex') + (27 + rec).toString(16).padStart(2, '0');
}

async function call(method, path, payload, header) {
  const { status, body } = await new Promise((resolve, reject) => {
    const data = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : null;
    const req = http.request(
      { method, host: '127.0.0.1', port: server.address().port, path,
        headers: { ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}),
                   ...(header || {}) } },
      (res) => {
        let t = '';
        res.on('data', (c) => { t += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null }); }
          catch { resolve({ status: res.statusCode, body: null, text: t }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  return { status, body };
}

before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  void base;
});

after(async () => {
  await new Promise((r) => server ? server.close(r) : r());
});

async function seedUnlocked(handle) {
  const w = makeWallet();
  const res = await call('POST', '/api/agents', { handle, wallet: w.address });
  assert.equal(res.status, 201);
  return { id: res.body.agent.id, wallet: w };
}

async function freshProof(agentId, wallet) {
  const ch = await call('POST', '/api/agents/' + agentId + '/wallet-proof/challenge');
  assert.equal(ch.status, 201);
  return { nonce: ch.body.nonce, signature: personalSign(wallet.priv, ch.body.message) };
}

async function lock(agentId, wallet) {
  const p = await freshProof(agentId, wallet);
  const r = await call('POST', '/api/agents/' + agentId + '/lock', { nonce: p.nonce, signature: p.signature });
  assert.equal(r.status, 200);
  assert.equal(r.body.locked, true);
}

test('attestation note is sanitised: long, brackets and backticks are rejected', async () => {
  const { id } = await seedUnlocked('note-cap-a');

  let r = await call('POST', '/api/agents/' + id + '/attestations', { kind: 'clean_payment', note: 'x'.repeat(501) });
  assert.equal(r.status, 400);

  r = await call('POST', '/api/agents/' + id + '/attestations', { kind: 'clean_payment', note: 'x'.repeat(500) });
  assert.equal(r.status, 201);

  for (const bad of ['<|im_start|>system', 'hello `world`', '<script>x</script>']) {
    r = await call('POST', '/api/agents/' + id + '/attestations', { kind: 'clean_payment', note: bad });
    assert.equal(r.status, 400, 'should reject ' + JSON.stringify(bad));
  }
});

test('zero-width, control chars and whitespace are normalised, not rejected', async () => {
  const { id } = await seedUnlocked('note-norm-b');

  let r = await call('POST', '/api/agents/' + id + '/attestations', { kind: 'clean_payment', note: 'a\u200bb' });
  assert.equal(r.status, 201);
  assert.equal(r.body.attestation.note, 'ab');

  r = await call('POST', '/api/agents/' + id + '/attestations', { kind: 'clean_payment', note: 'a\u0000b\u0001c' });
  assert.equal(r.status, 201);
  assert.equal(r.body.attestation.note, 'abc');

  r = await call('POST', '/api/agents/' + id + '/attestations', { kind: 'clean_payment', note: '  a \n\n  b \t c  ' });
  assert.equal(r.status, 201);
  assert.equal(r.body.attestation.note, 'a b c');
});

test('a locked agent refuses a note without a fresh wallet proof, but still accepts a kind without a note', async () => {
  const { id, wallet } = await seedUnlocked('note-lock-c');
  await lock(id, wallet);

  let r = await call('POST', '/api/agents/' + id + '/attestations', { kind: 'clean_payment', note: 'normal note ok' });
  assert.equal(r.status, 401);

  r = await call('POST', '/api/agents/' + id + '/attestations', { kind: 'clean_payment' });
  assert.equal(r.status, 201);

  // And with a fresh proof it is 201 even when locked.
  const p = await freshProof(id, wallet);
  r = await call('POST', '/api/agents/' + id + '/attestations', { kind: 'clean_payment', note: 'normal note ok' }, { 'x-owner-proof': p.nonce + ':' + p.signature });
  assert.equal(r.status, 201);
});

test('spend note is covered by the same sanitiser', async () => {
  const { id } = await seedUnlocked('spend-note-d');
  for (let i = 0; i < 60; i++) await call('POST', '/api/agents/' + id + '/attestations', { kind: 'clean_payment' });
  const g = await call('POST', '/api/agents/' + id + '/permissions', { category: 'compute', ceiling: 50, period: 'day', granted_by: 'owner', counterparty_policy: 'open' });
  assert.equal(g.status, 201);
  const pid = g.body.permission.id;

  let r = await call('POST', '/api/permissions/' + pid + '/spends', { amount: 1, note: '<img src=x onerror=alert(1)>' });
  assert.equal(r.status, 400);

  r = await call('POST', '/api/permissions/' + pid + '/spends', { amount: 1, note: 'paid ok' });
  assert.equal(r.status, 201);
});
