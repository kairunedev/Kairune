'use strict';

// Integration test for the REST API. Uses an in-memory DB (DB_PATH=:memory:)
// so it never touches real data. The server starts on a random port.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { canonicalPayload } = require('../services/verification');

const app = require('../../server');
let server;
let base;

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      base + path,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : {} })
        );
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Register an issuer + an Ed25519 key; return the material needed to sign.
async function setupIssuer(name = 'ci-issuer') {
  const reg = await req('POST', '/api/issuers', { display_name: name });
  const apiKey = reg.body.api_key;
  const issuerId = reg.body.issuer.id;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyRes = await req(
    'POST',
    '/api/issuers/' + issuerId + '/keys',
    { public_key: pem },
    { 'X-Issuer-Key': apiKey }
  );
  return { reg, apiKey, issuerId, keyId: keyRes.body.key.id, privateKey };
}

// Post a signed attestation for an agent.
function signedAttest(agentId, kind, ctx, overrides = {}) {
  const { apiKey, ...bodyOverrides } = overrides;
  const issued_at = new Date().toISOString();
  const fields = {
    agent_id: agentId,
    kind,
    amount: undefined,
    note: undefined,
    issuer_id: ctx.issuerId,
    issuer_key_id: ctx.keyId,
    issued_at,
  };
  const canonical = canonicalPayload(fields);
  const signature = crypto
    .sign(null, Buffer.from(canonical), ctx.privateKey)
    .toString('base64');
  return req(
    'POST',
    '/api/agents/' + agentId + '/attestations',
    {
      kind,
      issuer_id: ctx.issuerId,
      issuer_key_id: ctx.keyId,
      signature,
      issued_at,
      ...bodyOverrides,
    },
    { 'X-Issuer-Key': apiKey || ctx.apiKey }
  );
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
});

test('GET /health returns ok', async () => {
  const r = await req('GET', '/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'ok');
});

test('GET /api/meta returns kinds and tiers', async () => {
  const r = await req('GET', '/api/meta');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.attestation_kinds));
  assert.ok(r.body.attestation_kinds.includes('task_completed'));
});

test('full lifecycle: create → attest → score up → permission → revoke', async () => {
  const ctx = await setupIssuer('lifecycle-issuer');

  // create
  const create = await req('POST', '/api/agents', {
    handle: 'itest-01',
    wallet: '0xabc0000000000000000000000000000000000001',
    operator: 'CI',
  });
  assert.strictEqual(create.status, 201);
  const id = create.body.agent.id;
  assert.strictEqual(create.body.agent.score, 120); // baseline

  // add positive, signed (verified) attestations
  for (let i = 0; i < 15; i++) {
    await signedAttest(id, 'task_completed', ctx);
  }
  const vouch = await signedAttest(id, 'peer_vouch', ctx);
  assert.strictEqual(vouch.status, 201);
  assert.strictEqual(vouch.body.attestation.verification_status, 'verified');
  assert.ok(vouch.body.agent.score > 120, 'score should rise above the baseline');

  // grant permission (should be capped by tier)
  const grant = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 99999,
  });
  assert.strictEqual(grant.status, 201);
  assert.ok(grant.body.permission.capped, 'ceiling should be capped by tier');
  const pid = grant.body.permission.id;

  // revoke
  const revoke = await req('POST', '/api/permissions/' + pid + '/revoke');
  assert.strictEqual(revoke.status, 200);
  assert.strictEqual(revoke.body.permission.status, 'revoked');

  // cleanup
  const del = await req('DELETE', '/api/agents/' + id);
  assert.strictEqual(del.status, 200);
});

test('spend idempotency: Idempotency-Key header prevents a double-charge', async () => {
  const ctx = await setupIssuer('idem-issuer');
  const create = await req('POST', '/api/agents', {
    handle: 'idem-01',
    wallet: '0x4de000000000000000000000000000000000ea01',
    operator: 'CI',
  });
  assert.strictEqual(create.status, 201);
  const id = create.body.agent.id;

  // Raise the agent's tier so it can receive a spending permission.
  for (let i = 0; i < 15; i++) await signedAttest(id, 'task_completed', ctx);
  await signedAttest(id, 'peer_vouch', ctx);

  const grant = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 100,
  });
  assert.strictEqual(grant.status, 201);
  const pid = grant.body.permission.id;

  // First charge with a key → 201 Created.
  const first = await req(
    'POST',
    '/api/permissions/' + pid + '/spends',
    { amount: 25 },
    { 'Idempotency-Key': 'order-9001' }
  );
  assert.strictEqual(first.status, 201);
  assert.strictEqual(first.body.budget.used, 25);

  // Retry with the same key → 200, same spend, budget unchanged.
  const retry = await req(
    'POST',
    '/api/permissions/' + pid + '/spends',
    { amount: 25 },
    { 'Idempotency-Key': 'order-9001' }
  );
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.body.idempotent_replay, true);
  assert.strictEqual(retry.body.spend.id, first.body.spend.id);
  assert.strictEqual(retry.body.budget.used, 25, 'budget must not be charged twice');

  // A different key charges again → 201, budget advances.
  const other = await req(
    'POST',
    '/api/permissions/' + pid + '/spends',
    { amount: 25 },
    { 'Idempotency-Key': 'order-9002' }
  );
  assert.strictEqual(other.status, 201);
  assert.strictEqual(other.body.budget.used, 50);

  await req('DELETE', '/api/agents/' + id);
});

test('validation: missing fields → 400', async () => {
  const r = await req('POST', '/api/agents', {});
  assert.strictEqual(r.status, 400);
});

test('validation: duplicate handle → 409', async () => {
  await req('POST', '/api/agents', { handle: 'dup-01', wallet: '0xdd0000000000000000000000000000000000d001' });
  const r = await req('POST', '/api/agents', { handle: 'dup-01', wallet: '0xdd0000000000000000000000000000000000d002' });
  assert.strictEqual(r.status, 409);
});

test('validation: duplicate wallet → 409', async () => {
  await req('POST', '/api/agents', { handle: 'wal-a', wallet: '0xaa0000000000000000000000000000000000a001' });
  const r = await req('POST', '/api/agents', { handle: 'wal-b', wallet: '0xaa0000000000000000000000000000000000a001' });
  assert.strictEqual(r.status, 409);
});

test('validation: short wallet → 400', async () => {
  const r = await req('POST', '/api/agents', { handle: 'short-01', wallet: '0xab' });
  assert.strictEqual(r.status, 400);
});

test('validation: non-EVM wallet → 400 (Robinhood Chain only)', async () => {
  const r = await req('POST', '/api/agents', {
    handle: 'sol-01',
    wallet: '7EqQdEULxWcraVx3mXKFjc84LhCkMGZCkRuDpvcMwJeK',
  });
  assert.strictEqual(r.status, 400);
});

test('validation: invalid attestation kind → 400', async () => {
  const c = await req('POST', '/api/agents', { handle: 'kind-01', wallet: '0xcc0000000000000000000000000000000000c001' });
  const r = await req('POST', '/api/agents/' + c.body.agent.id + '/attestations', {
    kind: 'malicious',
  });
  assert.strictEqual(r.status, 400);
});

test('unknown api route → 404 JSON', async () => {
  const r = await req('GET', '/api/does-not-exist');
  assert.strictEqual(r.status, 404);
  assert.ok(r.body.error);
});

test('suspended agent cannot get permission → 409', async () => {
  const c = await req('POST', '/api/agents', { handle: 'susp-01', wallet: '0xbb0000000000000000000000000000000000b001' });
  const id = c.body.agent.id;
  await req('PATCH', '/api/agents/' + id + '/status', { status: 'suspended' });
  const r = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'x',
    ceiling: 10,
  });
  assert.strictEqual(r.status, 409);
});

// Bring an agent up to a tier that can receive spending permission.
async function trustedAgent(handle, wallet) {
  const ctx = await setupIssuer(handle + '-issuer');
  const create = await req('POST', '/api/agents', { handle, wallet, operator: 'CI' });
  const id = create.body.agent.id;
  for (let i = 0; i < 15; i++) await signedAttest(id, 'task_completed', ctx);
  await signedAttest(id, 'peer_vouch', ctx);
  return id;
}

test('spend: authorize within ceiling, then reject over budget', async () => {
  const id = await trustedAgent('spend-01', '0x5000000000000000000000000000000000000001');

  const grant = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 100,
    period: 'day',
  });
  assert.strictEqual(grant.status, 201);
  const pid = grant.body.permission.id;
  const ceiling = grant.body.permission.ceiling; // capped by tier

  // First spend of 10 succeeds and reports remaining budget.
  const ok = await req('POST', '/api/permissions/' + pid + '/spends', {
    amount: 10,
    note: 'gpu hour',
  });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.body.budget.used, 10);
  assert.strictEqual(ok.body.budget.remaining, ceiling - 10);

  // A spend larger than the remaining budget is rejected with 409.
  const over = await req('POST', '/api/permissions/' + pid + '/spends', {
    amount: ceiling, // remaining is ceiling-10, so this exceeds it
  });
  assert.strictEqual(over.status, 409);

  // Budget summary reflects only the accepted spend.
  const budget = await req('GET', '/api/permissions/' + pid + '/budget');
  assert.strictEqual(budget.status, 200);
  assert.strictEqual(budget.body.budget.used, 10);
  assert.strictEqual(budget.body.budget.remaining, ceiling - 10);

  // Spend history lists the accepted charge only.
  const spends = await req('GET', '/api/permissions/' + pid + '/spends');
  assert.strictEqual(spends.status, 200);
  assert.strictEqual(spends.body.spends.length, 1);
  assert.strictEqual(spends.body.spends[0].amount, 10);
});

test('spend preview: dry-run reports go/no-go without charging', async () => {
  const id = await trustedAgent('spend-preview', '0x5000000000000000000000000000000000000011');
  const grant = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 100,
    period: 'day',
  });
  const pid = grant.body.permission.id;
  const ceiling = grant.body.permission.ceiling;

  // Preview a charge that fits: allowed, and budget untouched (used stays 0).
  const ok = await req('POST', '/api/permissions/' + pid + '/spends/preview', {
    amount: 10,
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.allowed, true);
  assert.strictEqual(ok.body.reason, null);
  assert.strictEqual(ok.body.budget.used, 0);

  // Preview an over-budget charge: blocked with a machine-readable reason.
  const over = await req('POST', '/api/permissions/' + pid + '/spends/preview', {
    amount: ceiling + 1,
  });
  assert.strictEqual(over.status, 200);
  assert.strictEqual(over.body.allowed, false);
  assert.strictEqual(over.body.reason, 'ceiling_exceeded');

  // The preview charged nothing: no spend history and full budget remain.
  const spends = await req('GET', '/api/permissions/' + pid + '/spends');
  assert.strictEqual(spends.body.spends.length, 0);
  const budget = await req('GET', '/api/permissions/' + pid + '/budget');
  assert.strictEqual(budget.body.budget.used, 0);
  assert.strictEqual(budget.body.budget.remaining, ceiling);
});

test('spend preview: bad amount → 400, unknown permission → 404', async () => {
  const id = await trustedAgent('spend-preview-err', '0x5000000000000000000000000000000000000012');
  const grant = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 50,
  });
  const pid = grant.body.permission.id;

  const bad = await req('POST', '/api/permissions/' + pid + '/spends/preview', { amount: 0 });
  assert.strictEqual(bad.status, 400);

  const missing = await req('POST', '/api/permissions/does-not-exist/spends/preview', {
    amount: 5,
  });
  assert.strictEqual(missing.status, 404);
});

test('spend: history lists accepted charges, most recent first', async () => {
  const id = await trustedAgent('spend-05', '0x5000000000000000000000000000000000000005');
  const grant = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 50,
  });
  const pid = grant.body.permission.id;

  await req('POST', '/api/permissions/' + pid + '/spends', { amount: 3, note: 'first' });
  await req('POST', '/api/permissions/' + pid + '/spends', { amount: 4, note: 'second' });

  const spends = await req('GET', '/api/permissions/' + pid + '/spends');
  assert.strictEqual(spends.status, 200);
  assert.strictEqual(spends.body.spends.length, 2);
  // Rejected charges never appear in history.
  const total = spends.body.spends.reduce((sum, s) => sum + s.amount, 0);
  assert.strictEqual(total, 7);
});

test('spend: revoked permission cannot be charged → 409', async () => {
  const id = await trustedAgent('spend-02', '0x5000000000000000000000000000000000000002');
  const grant = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 50,
  });
  const pid = grant.body.permission.id;
  await req('POST', '/api/permissions/' + pid + '/revoke');

  const r = await req('POST', '/api/permissions/' + pid + '/spends', { amount: 5 });
  assert.strictEqual(r.status, 409);
});

test('spend: non-positive amount → 400, unknown permission → 404', async () => {
  const id = await trustedAgent('spend-03', '0x5000000000000000000000000000000000000003');
  const grant = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 50,
  });
  const pid = grant.body.permission.id;

  const bad = await req('POST', '/api/permissions/' + pid + '/spends', { amount: 0 });
  assert.strictEqual(bad.status, 400);

  const missing = await req('POST', '/api/permissions/does-not-exist/spends', {
    amount: 5,
  });
  assert.strictEqual(missing.status, 404);
});

test('stats: total_spend reflects authorized spends', async () => {
  const id = await trustedAgent('spend-04', '0x5000000000000000000000000000000000000004');
  const grant = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 50,
  });
  const pid = grant.body.permission.id;

  const before = await req('GET', '/api/stats');
  assert.strictEqual(typeof before.body.total_spend, 'number');

  await req('POST', '/api/permissions/' + pid + '/spends', { amount: 12.5 });

  const after = await req('GET', '/api/stats');
  assert.strictEqual(
    Math.round((after.body.total_spend - before.body.total_spend) * 100) / 100,
    12.5
  );
});

test('wallet lookup: known trusted wallet returns a live trust profile', async () => {
  const wallet = '0x7000000000000000000000000000000000000001';
  await trustedAgent('wl-trusted', wallet);

  // Lookup by the exact wallet, and by an upper-cased variant (case-insensitive).
  const r = await req('GET', '/api/wallets/' + wallet);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.registered, true);
  assert.strictEqual(r.body.wallet, wallet);
  assert.strictEqual(r.body.handle, 'wl-trusted');
  assert.strictEqual(r.body.chain_id, 4663);
  assert.ok(r.body.tier >= 1, 'trusted agent should be tier >= 1');
  assert.strictEqual(r.body.trusted, true);
  assert.ok(typeof r.body.suggested_daily_ceiling === 'number');

  const upper = await req('GET', '/api/wallets/' + wallet.toUpperCase().replace('0X', '0x'));
  assert.strictEqual(upper.status, 200);
  assert.strictEqual(upper.body.handle, 'wl-trusted');
});

test('wallet lookup: unknown wallet → 404 with registered:false', async () => {
  const r = await req('GET', '/api/wallets/0x9999999999999999999999999999999999999999');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.registered, false);
  assert.strictEqual(r.body.chain_id, 4663);
});

test('wallet lookup: non-EVM wallet → 400', async () => {
  const r = await req('GET', '/api/wallets/7EqQdEULxWcraVx3mXKFjc84LhCkMGZCkRuDpvcMwJeK');
  assert.strictEqual(r.status, 400);
});

test('wallet lookup: suspended agent is not trusted even with a high score', async () => {
  const wallet = '0x7000000000000000000000000000000000000002';
  const id = await trustedAgent('wl-suspended', wallet);
  await req('PATCH', '/api/agents/' + id + '/status', { status: 'suspended' });

  const r = await req('GET', '/api/wallets/' + wallet);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'suspended');
  assert.strictEqual(r.body.trusted, false);
});
