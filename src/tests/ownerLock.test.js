'use strict';

// In-memory DB and test env must be set before anything requires the app.
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

// Production only recovers — no signing. The tests act as the wallet.
secp.utils.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.utils.concatBytes(...m));

const app = require('../../server');
const { getDb, closeDb } = require('../db');
const agentService = require('../services/agentService');

let server;
let base;

function makeWallet() {
  const priv = crypto.randomBytes(32);
  const pub = secp.getPublicKey(priv, false);
  const address =
    '0x' + Buffer.from(keccak_256(pub.subarray(1))).subarray(-20).toString('hex');
  return { priv, address };
}

/** Sign a message the way `personal_sign` does, returning 65-byte r|s|v hex. */
function personalSign(priv, message) {
  const body = Buffer.from(message, 'utf8');
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8');
  const digest = keccak_256(Buffer.concat([prefix, body]));
  const [sig, rec] = secp.signSync(digest, priv, { recovered: true, der: false });
  return '0x' + Buffer.from(sig).toString('hex') + (27 + rec).toString(16).padStart(2, '0');
}

function call(method, path, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const headers = { ...extraHeaders };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request(base + path, { method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let handleSeq = 0;

/**
 * Register an agent and earn it enough clean history to qualify for a grant.
 * The tier gate refuses permissions to tier-0 agents, so a lock test that
 * skipped this would be testing the tier gate instead of the lock.
 */
async function seedFundableAgent() {
  const w = makeWallet();
  handleSeq += 1;
  const agent = await agentService.createAgent({
    handle: 'lock-' + handleSeq + '-' + crypto.randomBytes(3).toString('hex'),
    wallet: w.address,
  });
  for (let i = 0; i < 60; i += 1) {
    await call('POST', '/api/agents/' + agent.id + '/attestations', { kind: 'clean_payment' });
  }
  return { agent, wallet: w };
}

/** Mint a challenge and sign it — a complete, single-use owner proof. */
async function freshProof(agentId, wallet) {
  const res = await call('POST', '/api/agents/' + agentId + '/wallet-proof/challenge');
  assert.equal(res.status, 201);
  return { nonce: res.body.nonce, signature: personalSign(wallet.priv, res.body.message) };
}

/** The header a locked agent's owner must present. */
const ownerHeader = (proof) => ({ 'x-owner-proof': proof.nonce + ':' + proof.signature });

/** Lock an agent, asserting it worked. */
async function lock(agentId, wallet) {
  const proof = await freshProof(agentId, wallet);
  const res = await call('POST', '/api/agents/' + agentId + '/lock', proof);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.locked, true);
  return res.body;
}

async function grant(agentId, headers = {}) {
  return call(
    'POST',
    '/api/agents/' + agentId + '/permissions',
    { category: 'compute', ceiling: 50, period: 'day' },
    headers
  );
}

before(async () => {
  await getDb();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
  return closeDb();
});

// ---------------------------------------------------------------------------
// The default: nothing changed for anyone who has not opted in.
// ---------------------------------------------------------------------------

test('an unlocked agent still accepts unauthenticated permission writes', async () => {
  const { agent } = await seedFundableAgent();

  const granted = await grant(agent.id);
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  const pid = granted.body.permission.id;

  // The whole surface, no credentials — exactly as the public console uses it.
  assert.equal((await call('POST', `/api/permissions/${pid}/spends`, { amount: 5 })).status, 201);
  assert.equal(
    (await call('POST', `/api/permissions/${pid}/counterparty-policy`, { counterparty_policy: 'open' })).status,
    200
  );
  assert.equal((await call('POST', `/api/permissions/${pid}/expiry`, {})).status, 200);
  assert.equal((await call('POST', `/api/permissions/${pid}/revoke`, {})).status, 200);

  const detail = await call('GET', '/api/agents/' + agent.id);
  assert.equal(detail.body.agent.owner_locked, false);
});

// ---------------------------------------------------------------------------
// Locking, and what it refuses
// ---------------------------------------------------------------------------

test('locking requires a valid wallet proof', async () => {
  const { agent, wallet } = await seedFundableAgent();

  // No proof at all.
  assert.equal((await call('POST', '/api/agents/' + agent.id + '/lock', {})).status, 400);

  // A well-formed signature from the wrong wallet.
  const other = makeWallet();
  const challenge = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
  const wrong = await call('POST', '/api/agents/' + agent.id + '/lock', {
    nonce: challenge.body.nonce,
    signature: personalSign(other.priv, challenge.body.message),
  });
  assert.equal(wrong.status, 401);

  // Still unlocked after the failed attempt.
  const detail = await call('GET', '/api/agents/' + agent.id);
  assert.equal(detail.body.agent.owner_locked, false);

  // The real wallet succeeds.
  await lock(agent.id, wallet);
  const after = await call('GET', '/api/agents/' + agent.id);
  assert.equal(after.body.agent.owner_locked, true);
  assert.ok(after.body.agent.owner_locked_at);
});

test('a locked agent refuses every mutating permission route without a proof', async () => {
  const { agent, wallet } = await seedFundableAgent();

  // Grant while still open, so there is a permission to attack.
  const pid = (await grant(agent.id)).body.permission.id;
  await lock(agent.id, wallet);

  // This is the attack from the audit, run against a locked agent.
  const attacks = [
    ['POST', `/api/permissions/${pid}/spends`, { amount: 5 }],
    ['POST', `/api/permissions/${pid}/revoke`, {}],
    ['POST', `/api/permissions/${pid}/expiry`, {}],
    ['POST', `/api/permissions/${pid}/counterparty-policy`, { counterparty_policy: 'open' }],
    ['POST', `/api/permissions/${pid}/payees`, { counterparty: agent.wallet }],
    ['DELETE', `/api/permissions/${pid}/payees/${agent.id}`, undefined],
    ['POST', `/api/agents/${agent.id}/permissions`, { category: 'compute', ceiling: 50, period: 'day' }],
  ];
  for (const [method, path, payload] of attacks) {
    const res = await call(method, path, payload);
    assert.equal(res.status, 401, `${method} ${path} -> ${res.status}`);
  }

  // Nothing moved: the grant is still active and the budget untouched.
  const perms = await call('GET', '/api/agents/' + agent.id + '/permissions');
  const still = perms.body.permissions.find((p) => p.id === pid);
  assert.equal(still.status, 'active');
  const budget = await call('GET', `/api/permissions/${pid}/budget`);
  assert.equal(budget.body.budget.used, 0);
});

test('the owner can still act on a locked agent with a fresh proof', async () => {
  const { agent, wallet } = await seedFundableAgent();
  const pid = (await grant(agent.id)).body.permission.id;
  await lock(agent.id, wallet);

  const spend = await call(
    'POST',
    `/api/permissions/${pid}/spends`,
    { amount: 7 },
    ownerHeader(await freshProof(agent.id, wallet))
  );
  assert.equal(spend.status, 201, JSON.stringify(spend.body));

  const revoked = await call(
    'POST',
    `/api/permissions/${pid}/revoke`,
    {},
    ownerHeader(await freshProof(agent.id, wallet))
  );
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.permission.status, 'revoked');
});

// ---------------------------------------------------------------------------
// Proof hygiene — the properties that stop a captured proof being reusable
// ---------------------------------------------------------------------------

test('an owner proof is single-use', async () => {
  const { agent, wallet } = await seedFundableAgent();
  const pid = (await grant(agent.id)).body.permission.id;
  await lock(agent.id, wallet);

  const proof = await freshProof(agent.id, wallet);
  const first = await call('POST', `/api/permissions/${pid}/spends`, { amount: 1 }, ownerHeader(proof));
  assert.equal(first.status, 201);

  // Replaying the same nonce must fail, or a proof captured once would be a
  // standing key to the budget.
  const replay = await call('POST', `/api/permissions/${pid}/spends`, { amount: 1 }, ownerHeader(proof));
  assert.equal(replay.status, 404);
});

test("one agent's proof does not authorize another agent", async () => {
  const a = await seedFundableAgent();
  const b = await seedFundableAgent();
  const pidB = (await grant(b.agent.id)).body.permission.id;
  await lock(b.agent.id, b.wallet);

  // A valid proof, just for the wrong agent. The challenge is bound to the
  // agent id, so it must not transfer.
  const proofA = await freshProof(a.agent.id, a.wallet);
  const res = await call('POST', `/api/permissions/${pidB}/spends`, { amount: 1 }, ownerHeader(proofA));
  assert.equal(res.status, 404);
});

test('a malformed owner proof header is rejected', async () => {
  const { agent, wallet } = await seedFundableAgent();
  const pid = (await grant(agent.id)).body.permission.id;
  await lock(agent.id, wallet);

  const noColon = await call(
    'POST',
    `/api/permissions/${pid}/spends`,
    { amount: 1 },
    { 'x-owner-proof': 'garbage' }
  );
  assert.equal(noColon.status, 400);

  const badSig = await call(
    'POST',
    `/api/permissions/${pid}/spends`,
    { amount: 1 },
    { 'x-owner-proof': 'deadbeef:0xnotasignature' }
  );
  assert.equal(badSig.status, 404);
});

// ---------------------------------------------------------------------------
// Reads stay open, and so does the dry run
// ---------------------------------------------------------------------------

test('locking does not close public reads or the spend dry-run', async () => {
  const { agent, wallet } = await seedFundableAgent();
  const pid = (await grant(agent.id)).body.permission.id;
  await lock(agent.id, wallet);

  assert.equal((await call('GET', '/api/agents/' + agent.id + '/permissions')).status, 200);
  assert.equal((await call('GET', `/api/permissions/${pid}/budget`)).status, 200);
  assert.equal((await call('GET', `/api/permissions/${pid}/spends`)).status, 200);

  // A payment rail must still be able to ask "would this go through?" without
  // holding the owner's wallet. Preview writes nothing and consumes no budget.
  const preview = await call('POST', `/api/permissions/${pid}/spends/preview`, { amount: 5 });
  assert.equal(preview.status, 200);
  const budget = await call('GET', `/api/permissions/${pid}/budget`);
  assert.equal(budget.body.budget.used, 0);
});

// ---------------------------------------------------------------------------
// Unlocking
// ---------------------------------------------------------------------------

test('unlocking requires a proof and restores open access', async () => {
  const { agent, wallet } = await seedFundableAgent();
  await lock(agent.id, wallet);

  // An unauthenticated unlock would make the lock decorative.
  assert.equal((await call('POST', '/api/agents/' + agent.id + '/unlock', {})).status, 400);
  const other = makeWallet();
  const ch = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
  const wrong = await call('POST', '/api/agents/' + agent.id + '/unlock', {
    nonce: ch.body.nonce,
    signature: personalSign(other.priv, ch.body.message),
  });
  assert.equal(wrong.status, 401);
  assert.equal((await call('GET', '/api/agents/' + agent.id)).body.agent.owner_locked, true);

  // The owner can unlock, and the routes open back up.
  const proof = await freshProof(agent.id, wallet);
  const res = await call('POST', '/api/agents/' + agent.id + '/unlock', proof);
  assert.equal(res.status, 200);
  assert.equal(res.body.locked, false);

  const granted = await grant(agent.id);
  assert.equal(granted.status, 201);
});

test('an unknown agent cannot be locked', async () => {
  const res = await call('POST', '/api/agents/no-such-agent/lock', {
    nonce: 'x',
    signature: '0x' + '11'.repeat(65),
  });
  assert.equal(res.status, 404);
});
