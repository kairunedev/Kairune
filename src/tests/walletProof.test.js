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

// Production only recovers — no signing. But the tests act as a wallet, and
// 1.7 (CJS) stores the HMAC sync under secp.utils.hmacSha256Sync.
secp.utils.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.utils.concatBytes(...m));

const app = require('../../server');
const { getDb, closeDb } = require('../db');
const agentService = require('../services/agentService');
const walletProof = require('../services/walletProof');

let server;
let base;

// ---------------------------------------------------------------------------
// Test wallet: a real secp256k1 keypair so signatures are genuine rather than
// stubbed. Signing here exercises the same path a MetaMask personal_sign does.
// ---------------------------------------------------------------------------

function makeWallet() {
  const priv = crypto.randomBytes(32);
  const pub = secp.getPublicKey(priv, false);
  const address =
    '0x' + Buffer.from(keccak_256(pub.subarray(1))).subarray(-20).toString('hex');
  return { priv, address };
}

/**
 * Sign a message the way `personal_sign` does, returning 65-byte r|s|v hex.
 * 1.7 (CJS) returns [bytes, recovery] when called as signSync with {recovered:true, der:false}.
 * @param {Buffer} priv
 * @param {string} message
 * @param {number} [vOffset] what to add to the recovery bit (27 is standard)
 */
function personalSign(priv, message, vOffset = 27) {
  const body = Buffer.from(message, 'utf8');
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8');
  const digest = keccak_256(Buffer.concat([prefix, body]));
  const [sig, rec] = secp.signSync(digest, priv, { recovered: true, der: false });
  const v = (vOffset + rec).toString(16).padStart(2, '0');
  return '0x' + Buffer.from(sig).toString('hex') + v;
}

function call(method, path, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const headers = {};
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
async function seedAgent() {
  const w = makeWallet();
  handleSeq += 1;
  const agent = await agentService.createAgent({
    handle: 'wp-' + handleSeq + '-' + crypto.randomBytes(3).toString('hex'),
    wallet: w.address,
  });
  return { agent, wallet: w };
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
// recoverSigner — the cryptographic core, tested directly
// ---------------------------------------------------------------------------

test('recovers the signing address from a personal_sign signature', () => {
  const w = makeWallet();
  const msg = 'prove it';
  const signer = walletProof.recoverSigner(msg, personalSign(w.priv, msg));
  assert.equal(signer, w.address);
});

test('accepts v encoded as 0 or 1 as well as 27 or 28', () => {
  const w = makeWallet();
  const msg = 'legacy v encoding';
  // Some wallets emit the bare recovery bit instead of the 27-offset form.
  const signer = walletProof.recoverSigner(msg, personalSign(w.priv, msg, 0));
  assert.equal(signer, w.address);
});

test('recovers a different address when the message differs', () => {
  const w = makeWallet();
  const signed = personalSign(w.priv, 'message one');
  // A signature over a different message must not recover to the signer.
  assert.notEqual(walletProof.recoverSigner('message two', signed), w.address);
});

test('returns null for a malformed signature rather than throwing', () => {
  assert.equal(walletProof.recoverSigner('hi', 'not-hex'), null);
  assert.equal(walletProof.recoverSigner('hi', '0x1234'), null);
  assert.equal(walletProof.recoverSigner('hi', ''), null);
  assert.equal(walletProof.recoverSigner('hi', null), null);
  assert.equal(walletProof.recoverSigner('hi', '0x' + 'f'.repeat(130)), null);
});

test('rejects a high-s malleable signature', () => {
  const w = makeWallet();
  const msg = 'malleable';
  const sig = personalSign(w.priv, msg);
  const bytes = Buffer.from(sig.slice(2), 'hex');
  const s = BigInt('0x' + bytes.subarray(32, 64).toString('hex'));
  // Flip s to its high-half counterpart. Mathematically still a valid ECDSA
  // signature, which is exactly why it must be refused.
  const flipped = secp.CURVE.n - s;
  const hi = Buffer.from(flipped.toString(16).padStart(64, '0'), 'hex');
  const tampered =
    '0x' + bytes.subarray(0, 32).toString('hex') + hi.toString('hex') + '1b';
  assert.equal(walletProof.recoverSigner(msg, tampered), null);
});

test('challenge message binds wallet, agent, chain and nonce', () => {
  const msg = walletProof.challengeMessage({
    agentId: 'agent-x',
    wallet: '0xabc',
    nonce: 'n1',
    issuedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.match(msg, /0xabc/);
  assert.match(msg, /agent-x/);
  assert.match(msg, /4663/);
  assert.match(msg, /n1/);
  assert.match(msg, /kairune\.online/);
  // Must state plainly that nothing is being authorized.
  assert.match(msg, /no transaction|moves no funds/i);
});

// ---------------------------------------------------------------------------
// Challenge minting
// ---------------------------------------------------------------------------

test('mints a challenge for a registered agent', async () => {
  const { agent, wallet } = await seedAgent();
  const res = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
  assert.equal(res.status, 201);
  assert.equal(res.body.agent_id, agent.id);
  assert.equal(res.body.wallet, wallet.address);
  assert.equal(res.body.chain_id, 4663);
  assert.equal(typeof res.body.nonce, 'string');
  assert.equal(res.body.nonce.length, 32);
  assert.ok(res.body.message.includes(res.body.nonce));
  assert.ok(res.body.expires_in_s > 0);
});

test('challenge for an unknown agent is 404', async () => {
  const res = await call(
    'POST',
    '/api/agents/00000000-0000-0000-0000-000000000000/wallet-proof/challenge'
  );
  assert.equal(res.status, 404);
});

test('re-challenging replaces the previous nonce', async () => {
  const { agent } = await seedAgent();
  const first = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
  const second = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
  assert.notEqual(first.body.nonce, second.body.nonce);

  // The abandoned first nonce must be dead, or every discarded attempt would
  // stay usable for its full TTL.
  const db = await getDb();
  const rows = await db.execute({
    sql: 'SELECT nonce FROM wallet_challenges WHERE agent_id = ?',
    args: [agent.id],
  });
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].nonce, second.body.nonce);
});

// ---------------------------------------------------------------------------
// Proof submission
// ---------------------------------------------------------------------------

test('verifies a correctly signed challenge', async () => {
  const { agent, wallet } = await seedAgent();
  const ch = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
  const res = await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: personalSign(wallet.priv, ch.body.message),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.proven, true);
  assert.equal(res.body.wallet, wallet.address);
  assert.equal(res.body.chain_id, 4663);
  assert.equal(res.body.method, 'eip191-personal-sign');
  assert.ok(res.body.verified_at);
});

test('rejects a signature from a different wallet', async () => {
  const { agent } = await seedAgent();
  const attacker = makeWallet();
  const ch = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
  const res = await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: personalSign(attacker.priv, ch.body.message),
  });
  assert.equal(res.status, 401);
});

test('rejects a signature over altered challenge text', async () => {
  const { agent, wallet } = await seedAgent();
  const ch = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
  // Right wallet, wrong bytes: the signature is valid but not over our message.
  const res = await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: personalSign(wallet.priv, ch.body.message + ' extra'),
  });
  assert.equal(res.status, 401);
});

test('a nonce cannot be reused after a successful proof', async () => {
  const { agent, wallet } = await seedAgent();
  const ch = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
  const sig = personalSign(wallet.priv, ch.body.message);

  const first = await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: sig,
  });
  assert.equal(first.status, 200);

  const replay = await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: sig,
  });
  assert.equal(replay.status, 404);
});

test('a failed attempt also consumes the nonce', async () => {
  const { agent, wallet } = await seedAgent();
  const attacker = makeWallet();
  const ch = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');

  const bad = await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: personalSign(attacker.priv, ch.body.message),
  });
  assert.equal(bad.status, 401);

  // Burning the nonce on failure is what stops a live challenge being ground
  // against — even the real owner has to request a fresh one.
  const retry = await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: personalSign(wallet.priv, ch.body.message),
  });
  assert.equal(retry.status, 404);
});

test('a nonce minted for one agent cannot be used by another', async () => {
  const victim = await seedAgent();
  const other = await seedAgent();
  const ch = await call(
    'POST',
    '/api/agents/' + victim.agent.id + '/wallet-proof/challenge'
  );
  const res = await call('POST', '/api/agents/' + other.agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: personalSign(victim.wallet.priv, ch.body.message),
  });
  assert.equal(res.status, 404);
});

test('an expired challenge is refused', async () => {
  const { agent, wallet } = await seedAgent();
  const ch = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');

  const db = await getDb();
  await db.execute({
    sql: 'UPDATE wallet_challenges SET expires_at = ? WHERE nonce = ?',
    args: ['2000-01-01T00:00:00.000Z', ch.body.nonce],
  });

  const res = await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: personalSign(wallet.priv, ch.body.message),
  });
  assert.equal(res.status, 400);
});

test('missing fields is 400', async () => {
  const { agent } = await seedAgent();
  const noSig = await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: 'abc',
  });
  assert.equal(noSig.status, 400);
  const noNonce = await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    signature: '0x' + '1'.repeat(130),
  });
  assert.equal(noNonce.status, 400);
});

test('an unknown nonce is 404', async () => {
  const { agent } = await seedAgent();
  const res = await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: 'deadbeefdeadbeefdeadbeefdeadbeef',
    signature: '0x' + '1'.repeat(130),
  });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Status surfaces
// ---------------------------------------------------------------------------

test('proof status reports unproven then proven', async () => {
  const { agent, wallet } = await seedAgent();

  const before_ = await call('GET', '/api/agents/' + agent.id + '/wallet-proof');
  assert.equal(before_.status, 200);
  assert.equal(before_.body.proven, false);
  assert.equal(before_.body.verified_at, null);

  const ch = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
  await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: personalSign(wallet.priv, ch.body.message),
  });

  const after_ = await call('GET', '/api/agents/' + agent.id + '/wallet-proof');
  assert.equal(after_.body.proven, true);
  assert.ok(after_.body.verified_at);
});

test('proof status for an unknown agent is 404', async () => {
  const res = await call(
    'GET',
    '/api/agents/00000000-0000-0000-0000-000000000000/wallet-proof'
  );
  assert.equal(res.status, 404);
});

test('wallet lookup reports proof state', async () => {
  const { agent, wallet } = await seedAgent();

  const unproven = await call('GET', '/api/wallets/' + wallet.address);
  assert.equal(unproven.status, 200);
  assert.equal(unproven.body.wallet_proven, false);
  assert.equal(unproven.body.wallet_proven_at, null);

  const ch = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
  await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: personalSign(wallet.priv, ch.body.message),
  });

  const proven = await call('GET', '/api/wallets/' + wallet.address);
  assert.equal(proven.body.wallet_proven, true);
  assert.ok(proven.body.wallet_proven_at);
  // Proof must be reported alongside trust, not folded into it.
  assert.equal(typeof proven.body.trusted, 'boolean');
});

test('re-proving the same pair is idempotent', async () => {
  const { agent, wallet } = await seedAgent();

  for (let i = 0; i < 2; i++) {
    const ch = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
    const res = await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
      nonce: ch.body.nonce,
      signature: personalSign(wallet.priv, ch.body.message),
    });
    assert.equal(res.status, 200);
  }

  const db = await getDb();
  const rows = await db.execute({
    sql: 'SELECT wallet FROM wallet_proofs WHERE agent_id = ?',
    args: [agent.id],
  });
  assert.equal(rows.rows.length, 1);
});

test('proof does not transfer to a different wallet on the same agent', async () => {
  const { agent, wallet } = await seedAgent();
  const ch = await call('POST', '/api/agents/' + agent.id + '/wallet-proof/challenge');
  await call('POST', '/api/agents/' + agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: personalSign(wallet.priv, ch.body.message),
  });

  // Proof is a property of the (agent, wallet) pair. Asking about a wallet the
  // agent never proved must read as unproven even though the agent has a proof.
  const other = makeWallet();
  const status = await walletProof.proofStatus(agent.id, other.address);
  assert.equal(status.proven, false);
  assert.equal(status.verified_at, null);
});

test('proofMap batches lookups and keys on the pair', async () => {
  const a = await seedAgent();
  const b = await seedAgent();

  const ch = await call('POST', '/api/agents/' + a.agent.id + '/wallet-proof/challenge');
  await call('POST', '/api/agents/' + a.agent.id + '/wallet-proof', {
    nonce: ch.body.nonce,
    signature: personalSign(a.wallet.priv, ch.body.message),
  });

  const map = await walletProof.proofMap([
    { id: a.agent.id, wallet: a.wallet.address },
    { id: b.agent.id, wallet: b.wallet.address },
  ]);
  assert.ok(map.get(a.agent.id + '|' + a.wallet.address));
  assert.equal(map.get(b.agent.id + '|' + b.wallet.address), undefined);

  assert.equal((await walletProof.proofMap([])).size, 0);
  assert.equal((await walletProof.proofMap(null)).size, 0);
});
