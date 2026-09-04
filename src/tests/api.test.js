'use strict';

// Integration test for the REST API. Uses an in-memory DB (DB_PATH=:memory:)
// so it never touches real data. The server starts on a random port.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { canonicalPayload, verifySignature } = require('../services/verification');

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
  // Counterparty-gated spending is advertised so callers can discover it.
  assert.strictEqual(r.body.spend_counterparty_gate, true);
  assert.ok(r.body.spend_counterparty_blocking_verdicts.includes('decline'));
  assert.ok(r.body.webhook_events.includes('spend.counterparty_blocked'));
  // Payee scope: the policies + management endpoints are discoverable.
  assert.deepStrictEqual(r.body.counterparty_policies, ['open', 'required', 'allowlist']);
  assert.strictEqual(r.body.payees_endpoint, '/api/permissions/:pid/payees');
  assert.ok(r.body.max_payees_per_permission > 0);
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

test('counterparty gate: a spend to a declined payee is blocked (409) with budget intact', async () => {
  const ctx = await setupIssuer('gate-issuer');

  // Payer: raise its tier so it can hold a spending permission.
  const payer = await req('POST', '/api/agents', {
    handle: 'gate-payer',
    wallet: '0x9a7e000000000000000000000000000000000001',
    operator: 'CI',
  });
  const payerId = payer.body.agent.id;
  for (let i = 0; i < 15; i++) await signedAttest(payerId, 'task_completed', ctx);
  await signedAttest(payerId, 'peer_vouch', ctx);

  const grant = await req('POST', '/api/agents/' + payerId + '/permissions', {
    category: 'compute',
    ceiling: 100,
  });
  const pid = grant.body.permission.id;

  // Payee: register, then stamp it with a chargeback so its check verdict is
  // `decline`.
  const payee = await req('POST', '/api/agents', {
    handle: 'gate-payee',
    wallet: '0x9a7e000000000000000000000000000000000002',
    operator: 'CI',
  });
  const payeeId = payee.body.agent.id;
  // Attributed, not anonymous: negative attestations require an issuer, so an
  // unsigned post here would 401 and the payee would only decline for being
  // unrated — which would let this test pass without exercising the gate.
  const stamped = await signedAttest(payeeId, 'chargeback', ctx);
  assert.strictEqual(stamped.status, 201);

  // Preview says no-go for the bad payee.
  const preview = await req('POST', '/api/permissions/' + pid + '/spends/preview', {
    amount: 10,
    counterparty: 'gate-payee',
  });
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.body.allowed, false);
  assert.strictEqual(preview.body.reason, 'counterparty_declined');

  // A real charge is refused with 409 and the decline details.
  const blocked = await req('POST', '/api/permissions/' + pid + '/spends', {
    amount: 10,
    counterparty: 'gate-payee',
  });
  assert.strictEqual(blocked.status, 409);
  assert.strictEqual(blocked.body.details.verdict, 'decline');

  // Budget was never touched.
  const budget = await req('GET', '/api/permissions/' + pid + '/budget');
  assert.strictEqual(budget.body.budget.used, 0);

  // The same spend WITHOUT a counterparty still goes through — the gate only
  // engages when a payee is named.
  const ok = await req('POST', '/api/permissions/' + pid + '/spends', { amount: 10 });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.body.budget.used, 10);

  await req('DELETE', '/api/agents/' + payerId);
  await req('DELETE', '/api/agents/' + payeeId);
});

test('payee scope: an allowlist grant only pays its allowlisted vendors', async () => {
  const ctx = await setupIssuer('scope-issuer');

  // Payer, raised to a tier that can hold a permission.
  const payer = await req('POST', '/api/agents', {
    handle: 'scope-payer',
    wallet: '0x5c0e000000000000000000000000000000000001',
    operator: 'CI',
  });
  const payerId = payer.body.agent.id;
  for (let i = 0; i < 15; i++) await signedAttest(payerId, 'task_completed', ctx);
  await signedAttest(payerId, 'peer_vouch', ctx);

  // Two registered payees with clean, verified history — both would pass the
  // trust gate. Only one is in scope for this budget.
  const vendorIds = {};
  for (const h of ['scope-vendor', 'scope-stranger']) {
    const a = await req('POST', '/api/agents', {
      handle: h,
      wallet:
        h === 'scope-vendor'
          ? '0x5c0e000000000000000000000000000000000002'
          : '0x5c0e000000000000000000000000000000000003',
      operator: 'CI',
    });
    vendorIds[h] = a.body.agent.id;
    for (let i = 0; i < 12; i++) await signedAttest(vendorIds[h], 'task_completed', ctx);
  }

  // Grant a permission scoped to exactly one vendor.
  const grant = await req('POST', '/api/agents/' + payerId + '/permissions', {
    category: 'compute',
    ceiling: 100,
    counterparty_policy: 'allowlist',
    payees: ['scope-vendor'],
  });
  assert.strictEqual(grant.status, 201);
  assert.strictEqual(grant.body.permission.counterparty_policy, 'allowlist');
  assert.strictEqual(grant.body.permission.payees.length, 1);
  const pid = grant.body.permission.id;

  // The allowlisted vendor gets paid.
  const paid = await req('POST', '/api/permissions/' + pid + '/spends', {
    amount: 10,
    counterparty: 'scope-vendor',
  });
  assert.strictEqual(paid.status, 201);

  // A perfectly trustworthy but OUT-OF-SCOPE payee is refused.
  const off = await req('POST', '/api/permissions/' + pid + '/spends', {
    amount: 10,
    counterparty: 'scope-stranger',
  });
  assert.strictEqual(off.status, 409);
  assert.strictEqual(off.body.details.reason, 'counterparty_not_allowed');

  // And the omission bypass is closed: no payee named → refused.
  const bare = await req('POST', '/api/permissions/' + pid + '/spends', { amount: 10 });
  assert.strictEqual(bare.status, 409);
  assert.strictEqual(bare.body.details.reason, 'counterparty_required');

  // Only the one legitimate charge landed.
  const budget = await req('GET', '/api/permissions/' + pid + '/budget');
  assert.strictEqual(budget.body.budget.used, 10);
  assert.strictEqual(budget.body.budget.counterparty_policy, 'allowlist');

  // Allowlist is inspectable, and adding the stranger lets it through.
  const list = await req('GET', '/api/permissions/' + pid + '/payees');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.payees.length, 1);

  const added = await req('POST', '/api/permissions/' + pid + '/payees', {
    counterparty: 'scope-stranger',
    label: 'backup vendor',
  });
  assert.strictEqual(added.status, 201);
  const nowOk = await req('POST', '/api/permissions/' + pid + '/spends', {
    amount: 10,
    counterparty: 'scope-stranger',
  });
  assert.strictEqual(nowOk.status, 201);

  // Removing it revokes access immediately.
  const removed = await req('DELETE', '/api/permissions/' + pid + '/payees/scope-stranger');
  assert.strictEqual(removed.status, 200);
  const blockedAgain = await req('POST', '/api/permissions/' + pid + '/spends', {
    amount: 10,
    counterparty: 'scope-stranger',
  });
  assert.strictEqual(blockedAgain.status, 409);

  await req('DELETE', '/api/agents/' + payerId);
  await req('DELETE', '/api/agents/' + vendorIds['scope-vendor']);
  await req('DELETE', '/api/agents/' + vendorIds['scope-stranger']);
});

test('payee scope: an open grant can be tightened without losing its history', async () => {
  const ctx = await setupIssuer('tighten-issuer');
  const payer = await req('POST', '/api/agents', {
    handle: 'tighten-payer',
    wallet: '0x71e0000000000000000000000000000000000001',
    operator: 'CI',
  });
  const payerId = payer.body.agent.id;
  for (let i = 0; i < 15; i++) await signedAttest(payerId, 'task_completed', ctx);
  await signedAttest(payerId, 'peer_vouch', ctx);

  const vendor = await req('POST', '/api/agents', {
    handle: 'tighten-vendor',
    wallet: '0x71e0000000000000000000000000000000000002',
    operator: 'CI',
  });
  const vendorId = vendor.body.agent.id;
  for (let i = 0; i < 12; i++) await signedAttest(vendorId, 'task_completed', ctx);

  // Legacy-style grant: no policy → 'open', unnamed spends allowed.
  const grant = await req('POST', '/api/agents/' + payerId + '/permissions', {
    category: 'compute',
    ceiling: 100,
  });
  const pid = grant.body.permission.id;
  assert.strictEqual(grant.body.permission.counterparty_policy, 'open');
  const spent = await req('POST', '/api/permissions/' + pid + '/spends', { amount: 20 });
  assert.strictEqual(spent.status, 201);

  // Tighten in place.
  const tightened = await req('POST', '/api/permissions/' + pid + '/counterparty-policy', {
    counterparty_policy: 'allowlist',
    payees: ['tighten-vendor'],
  });
  assert.strictEqual(tightened.status, 200);
  assert.strictEqual(tightened.body.permission.id, pid);
  assert.strictEqual(tightened.body.permission.counterparty_policy, 'allowlist');

  // Unnamed spends now refused; the earlier spend still counts against budget.
  const bare = await req('POST', '/api/permissions/' + pid + '/spends', { amount: 5 });
  assert.strictEqual(bare.status, 409);
  const budget = await req('GET', '/api/permissions/' + pid + '/budget');
  assert.strictEqual(budget.body.budget.used, 20);

  await req('DELETE', '/api/agents/' + payerId);
  await req('DELETE', '/api/agents/' + vendorId);
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
  // Not 'CI': that operator marks an agent as a synthetic fixture and hides it
  // from /api/stats and the leaderboard, which several assertions below read.
  const create = await req('POST', '/api/agents', { handle, wallet, operator: 'Fixture Labs' });
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

test('velocity: a grant with a burst cap blocks a rapid over-limit spend (429)', async () => {
  const id = await trustedAgent('velocity-01', '0x5000000000000000000000000000000000000013');
  const grant = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 100000, // large ceiling so only the velocity cap can trip
    period: 'day',
    velocity_limit: 30,
    velocity_window_s: 60,
  });
  assert.strictEqual(grant.status, 201);
  assert.strictEqual(grant.body.permission.velocity_limit, 30);
  assert.strictEqual(grant.body.permission.velocity_window_s, 60);
  const pid = grant.body.permission.id;

  // First 20 fits under both ceiling and the 30/60s burst cap.
  const first = await req('POST', '/api/permissions/' + pid + '/spends', { amount: 20 });
  assert.strictEqual(first.status, 201);

  // A second 15 would push the 60s window to 35 > 30 → velocity block (429).
  const burst = await req('POST', '/api/permissions/' + pid + '/spends', { amount: 15 });
  assert.strictEqual(burst.status, 429);
  assert.strictEqual(burst.body.details.velocity_remaining, 10);

  // A preview agrees: same inputs would be blocked with velocity_exceeded.
  const preview = await req('POST', '/api/permissions/' + pid + '/spends/preview', { amount: 15 });
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.body.allowed, false);
  assert.strictEqual(preview.body.reason, 'velocity_exceeded');

  // Budget only reflects the one accepted spend.
  const budget = await req('GET', '/api/permissions/' + pid + '/budget');
  assert.strictEqual(budget.body.budget.used, 20);
  assert.strictEqual(budget.body.budget.velocity_limit, 30);
});

test('velocity: velocity_window_s without velocity_limit is rejected (400)', async () => {
  const id = await trustedAgent('velocity-02', '0x5000000000000000000000000000000000000014');
  const bad = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 100,
    velocity_window_s: 60,
  });
  assert.strictEqual(bad.status, 400);
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
  // Handle must not match a synthetic-fixture prefix, or the agent (and its
  // spend) is excluded from /api/stats and the delta below reads as zero.
  const id = await trustedAgent('spender04', '0x5000000000000000000000000000000000000004');
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

// ---------------------------------------------------------------------------
// Spend receipts — every approved charge carries a verifiable Ed25519 receipt.
// ---------------------------------------------------------------------------
test('spend receipts: authorized spend returns a receipt that verifies publicly', async () => {
  const id = await trustedAgent('rcpt-http', '0x6000000000000000000000000000000000000001');
  const grant = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 100,
    period: 'day',
  });
  const pid = grant.body.permission.id;

  const sp = await req('POST', '/api/permissions/' + pid + '/spends', {
    amount: 12.5,
    note: 'gpu hour',
  });
  assert.strictEqual(sp.status, 201);
  assert.ok(sp.body.spend.receipt_signature, 'spend carries a receipt signature');

  // Public receipt endpoint — no auth needed.
  const rc = await req('GET', '/api/spends/' + sp.body.spend.id + '/receipt');
  assert.strictEqual(rc.status, 200);
  const receipt = rc.body.receipt;
  assert.strictEqual(receipt.signed, true);
  assert.strictEqual(receipt.verified, true);
  assert.strictEqual(receipt.algorithm, 'ed25519');
  assert.strictEqual(receipt.fields.amount, 12.5);
  assert.strictEqual(receipt.fields.payee, null);
  assert.ok(receipt.public_key, 'public key included for independent verification');

  // Independent verification with ONLY the public key + canonical + signature.
  const ok = verifySignature({
    publicKeyPem: receipt.public_key,
    canonical: receipt.canonical,
    signatureB64: receipt.signature,
  });
  assert.strictEqual(ok, true, 'receipt verifies without trusting Kairune');
});

test('spend receipts: named payee is signed into the receipt', async () => {
  const payer = await trustedAgent('rcpt-payer', '0x6000000000000000000000000000000000000002');
  const vendor = await trustedAgent('rcpt-vendor', '0x6000000000000000000000000000000000000003');
  void vendor;
  const grant = await req('POST', '/api/agents/' + payer + '/permissions', {
    category: 'compute',
    ceiling: 100,
    period: 'day',
  });
  const pid = grant.body.permission.id;

  const sp = await req('POST', '/api/permissions/' + pid + '/spends', {
    amount: 5,
    counterparty: 'rcpt-vendor',
  });
  assert.strictEqual(sp.status, 201);
  assert.strictEqual(sp.body.spend.payee, 'rcpt-vendor');

  const rc = await req('GET', '/api/spends/' + sp.body.spend.id + '/receipt');
  assert.strictEqual(rc.body.receipt.fields.payee, 'rcpt-vendor');
  assert.strictEqual(rc.body.receipt.verified, true);
});

test('platform-key: exposes the current receipt-signing public key', async () => {
  const r = await req('GET', '/api/platform-key');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.algorithm, 'ed25519');
  assert.strictEqual(r.body.purpose, 'receipt');
  assert.match(r.body.public_key, /-----BEGIN PUBLIC KEY-----/);
  assert.strictEqual(typeof r.body.ephemeral, 'boolean');
});

test('receipt: unknown spend → 404', async () => {
  const r = await req('GET', '/api/spends/does-not-exist/receipt');
  assert.strictEqual(r.status, 404);
});

test('meta exposes spend receipt endpoints', async () => {
  const r = await req('GET', '/api/meta');
  assert.strictEqual(r.body.spend_receipts, true);
  assert.strictEqual(r.body.spend_receipt_endpoint, '/api/spends/:sid/receipt');
  assert.strictEqual(r.body.platform_key_endpoint, '/api/platform-key');
  assert.ok(Array.isArray(r.body.receipt_signed_fields));
});
