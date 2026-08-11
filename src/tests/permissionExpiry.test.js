'use strict';

// Unit tests for PERMISSION EXPIRY — time-bound spending grants.
//
// A permission used to be forever until a human revoked it. Every real
// delegation is temporary ("rent this GPU for an hour", "run this backfill
// tonight"), so the safe shape was the one nobody remembered to do: grant, then
// come back later and revoke. Expiry makes the deadline part of the grant.
//
// Design under test:
//   * expires_at is NULL by default → never expires (legacy behaviour intact)
//   * expiry is evaluated LAZILY at decision time — there is no sweeper job, so
//     the row keeps status='active' and `status` still means "revoked by human"
//   * an expired grant refuses spends with `permission_expired`
//   * preview agrees with authorize, always
//   * expiry is checked BEFORE payee scope, trust, and budget
//
// Uses an in-memory DB so it never touches real data.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { getDb, closeDb } = require('../db');
const spendService = require('../services/spendService');
const permissionService = require('../services/permissionService');

after(() => closeDb());

function hexWallet() {
  return '0x' + crypto.randomBytes(20).toString('hex');
}

// Seed a payer whose permission expires at a chosen instant (null = never).
async function seedPayer({ ceiling = 1000, expiresAt = null, policy = 'open', status = 'active' } = {}) {
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  const permId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', 'active', 900, 4, ?, ?)`,
    args: [agentId, 'ex-payer-' + agentId.slice(0, 8), hexWallet(), ts, ts],
  });
  await db.execute({
    sql: `INSERT INTO permissions (id, agent_id, category, ceiling, period, status, velocity_limit, velocity_window_s, counterparty_policy, expires_at, granted_by, created_at, revoked_at)
          VALUES (?, ?, 'compute', ?, 'day', ?, NULL, NULL, ?, ?, 'CI', ?, NULL)`,
    args: [permId, agentId, ceiling, status, policy, expiresAt, ts],
  });
  return { agentId, permId };
}

const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// resolveExpiry — input validation
// ---------------------------------------------------------------------------

test('no expiry input → null (never expires)', () => {
  assert.equal(permissionService.resolveExpiry({}), null);
  assert.equal(permissionService.resolveExpiry({ expires_in_s: null, expires_at: null }), null);
  assert.equal(permissionService.resolveExpiry({ expires_in_s: '', expires_at: '' }), null);
});

test('expires_in_s resolves to an absolute deadline', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(
    permissionService.resolveExpiry({ expires_in_s: 3600, nowMs: now }),
    '2026-01-01T01:00:00.000Z'
  );
});

test('expires_at is accepted and normalized to ISO8601', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const out = permissionService.resolveExpiry({
    expires_at: '2026-06-01T12:30:00Z',
    nowMs: now,
  });
  assert.equal(out, '2026-06-01T12:30:00.000Z');
});

test('supplying both expires_in_s and expires_at is a 400', () => {
  assert.throws(
    () => permissionService.resolveExpiry({ expires_in_s: 60, expires_at: '2030-01-01T00:00:00Z' }),
    (e) => e.status === 400 && /not both/i.test(e.message)
  );
});

test('expires_in_s must be a positive integer', () => {
  for (const bad of [0, -60, 1.5, 'soon', NaN]) {
    assert.throws(
      () => permissionService.resolveExpiry({ expires_in_s: bad }),
      (e) => e.status === 400,
      `expected 400 for ${String(bad)}`
    );
  }
});

test('expires_in_s beyond 365 days is refused (catches a units mistake)', () => {
  // e.g. passing a whole day in milliseconds instead of seconds.
  assert.throws(
    () => permissionService.resolveExpiry({ expires_in_s: 86400 * 1000 }),
    (e) => e.status === 400 && /365 days/.test(e.message)
  );
  assert.throws(
    () => permissionService.resolveExpiry({ expires_in_s: permissionService.MAX_EXPIRES_IN_S + 1 }),
    (e) => e.status === 400,
    'one second past the cap is refused'
  );
  assert.equal(
    typeof permissionService.resolveExpiry({ expires_in_s: permissionService.MAX_EXPIRES_IN_S }),
    'string',
    'exactly 365 days is still allowed'
  );
});

test('an unparseable expires_at is a 400', () => {
  assert.throws(
    () => permissionService.resolveExpiry({ expires_at: 'next tuesday' }),
    (e) => e.status === 400 && /ISO8601/.test(e.message)
  );
});

test('an expires_at in the past is a 400, not a dead-on-arrival grant', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.throws(
    () => permissionService.resolveExpiry({ expires_at: iso(now - MIN), nowMs: now }),
    (e) => e.status === 400 && /future/.test(e.message)
  );
  // Exactly "now" is also refused — it would expire on the same tick.
  assert.throws(
    () => permissionService.resolveExpiry({ expires_at: iso(now), nowMs: now }),
    (e) => e.status === 400
  );
});

// ---------------------------------------------------------------------------
// isExpired / expiresInSeconds
// ---------------------------------------------------------------------------

test('isExpired: null deadline never expires', () => {
  assert.equal(permissionService.isExpired({ expires_at: null }), false);
  assert.equal(permissionService.isExpired({}), false);
  assert.equal(permissionService.isExpired(null), false);
});

test('isExpired flips exactly at the deadline', () => {
  const at = Date.parse('2026-01-01T00:00:00.000Z');
  const perm = { expires_at: iso(at) };
  assert.equal(permissionService.isExpired(perm, at - 1), false, 'before');
  assert.equal(permissionService.isExpired(perm, at), true, 'at the deadline');
  assert.equal(permissionService.isExpired(perm, at + 1), true, 'after');
});

test('expiresInSeconds counts down and floors at 0', () => {
  const at = Date.parse('2026-01-01T00:00:00.000Z');
  const perm = { expires_at: iso(at) };
  assert.equal(permissionService.expiresInSeconds(perm, at - 90 * 1000), 90);
  assert.equal(permissionService.expiresInSeconds(perm, at + 500 * 1000), 0, 'never negative');
  assert.equal(permissionService.expiresInSeconds({ expires_at: null }, at), null);
});

// ---------------------------------------------------------------------------
// Enforcement at spend time
// ---------------------------------------------------------------------------

test('a spend inside the window is authorized', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ expiresAt: iso(now + 10 * MIN) });
  const { spend } = await spendService.authorizeSpend(permId, { amount: 25 }, { nowMs: now });
  assert.equal(spend.amount, 25);
});

test('a spend past the deadline is refused with permission_expired', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ expiresAt: iso(now - MIN) });
  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 25 }, { nowMs: now }),
    (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.details.reason, 'permission_expired');
      assert.ok(e.details.expires_at, 'reports the deadline it passed');
      return true;
    }
  );
});

test('a permission with no deadline still authorizes (backward compatible)', async () => {
  const { permId } = await seedPayer({ expiresAt: null });
  const { spend } = await spendService.authorizeSpend(permId, { amount: 10 });
  assert.equal(spend.amount, 10);
});

test('expiry needs no write to take effect — same row, later clock', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ expiresAt: iso(now + 5 * MIN) });

  // Allowed now...
  await spendService.authorizeSpend(permId, { amount: 5 }, { nowMs: now });

  // ...refused later, with nothing having been updated in between.
  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 5 }, { nowMs: now + 10 * MIN }),
    (e) => e.details.reason === 'permission_expired'
  );

  // The row is still status='active' — expiry is not revocation.
  const db = await getDb();
  const res = await db.execute({ sql: 'SELECT status FROM permissions WHERE id = ?', args: [permId] });
  assert.equal(res.rows[0].status, 'active');
});

test('an expired spend attempt is recorded on the public feed', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ expiresAt: iso(now - MIN) });
  await assert.rejects(() => spendService.authorizeSpend(permId, { amount: 7 }, { nowMs: now }));

  const feed = await spendService.listFeed({ limit: 10 });
  const hit = feed.find((f) => f.reason === 'permission_expired');
  assert.ok(hit, 'expected a spend.blocked feed row with reason permission_expired');
  assert.equal(hit.event, 'spend.blocked');
  // Every other feed row names the agent, so this one must too.
  assert.ok(hit.agent_handle, 'blocked-by-expiry rows stay attributable');
});

// ---------------------------------------------------------------------------
// Preview agrees with authorize
// ---------------------------------------------------------------------------

test('preview reports permission_expired without charging', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ expiresAt: iso(now - MIN) });
  const preview = await spendService.previewSpend(permId, { amount: 25 }, { nowMs: now });
  assert.equal(preview.allowed, false);
  assert.equal(preview.reason, 'permission_expired');

  const spends = await spendService.listSpends(permId);
  assert.equal(spends.length, 0, 'preview must never charge');
});

test('preview allows a spend still inside the window', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ expiresAt: iso(now + MIN) });
  const preview = await spendService.previewSpend(permId, { amount: 25 }, { nowMs: now });
  assert.equal(preview.allowed, true);
  assert.equal(preview.reason, null);
});

// ---------------------------------------------------------------------------
// Gate ORDER — expiry outranks scope, trust, and budget
// ---------------------------------------------------------------------------

test('expiry is checked BEFORE the budget ceiling', async () => {
  const now = Date.now();
  // Amount far over the ceiling AND expired: expiry must win, otherwise the
  // refusal reason would leak the wrong cause to the caller.
  const { permId } = await seedPayer({ ceiling: 10, expiresAt: iso(now - MIN) });
  const preview = await spendService.previewSpend(permId, { amount: 9999 }, { nowMs: now });
  assert.equal(preview.reason, 'permission_expired', 'expected expiry, not over_ceiling');
});

test('expiry is checked BEFORE payee scope', async () => {
  const now = Date.now();
  // `required` policy + no counterparty would normally be counterparty_required.
  const { permId } = await seedPayer({ policy: 'required', expiresAt: iso(now - MIN) });
  const preview = await spendService.previewSpend(permId, { amount: 5 }, { nowMs: now });
  assert.equal(preview.reason, 'permission_expired', 'expected expiry, not counterparty_required');
});

test('revocation still outranks expiry', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ status: 'revoked', expiresAt: iso(now - MIN) });
  const preview = await spendService.previewSpend(permId, { amount: 5 }, { nowMs: now });
  assert.equal(preview.reason, 'permission_revoked');
});

// ---------------------------------------------------------------------------
// Reporting surfaces
// ---------------------------------------------------------------------------

test('budgetSummary exposes the deadline and countdown', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ expiresAt: iso(now + 2 * MIN) });
  const budget = await spendService.budgetSummary(permId, { nowMs: now });
  assert.equal(budget.expired, false);
  assert.equal(budget.expires_in_s, 120);
  assert.ok(budget.expires_at);
});

test('budgetSummary marks an expired permission', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ expiresAt: iso(now - MIN) });
  const budget = await spendService.budgetSummary(permId, { nowMs: now });
  assert.equal(budget.expired, true);
  assert.equal(budget.expires_in_s, 0);
});

test('listPermissions activeOnly excludes expired grants', async () => {
  const now = Date.now();
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', 'active', 900, 4, ?, ?)`,
    args: [agentId, 'ex-list-' + agentId.slice(0, 8), hexWallet(), ts, ts],
  });

  const mk = async (expiresAt) => {
    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO permissions (id, agent_id, category, ceiling, period, status, velocity_limit, velocity_window_s, counterparty_policy, expires_at, granted_by, created_at, revoked_at)
            VALUES (?, ?, 'compute', 100, 'day', 'active', NULL, NULL, 'open', ?, 'CI', ?, NULL)`,
      args: [id, agentId, expiresAt, ts],
    });
    return id;
  };

  const live = await mk(iso(now + 10 * MIN));
  const dead = await mk(iso(now - 10 * MIN));
  const forever = await mk(null);

  const active = await permissionService.listPermissions(agentId, { activeOnly: true, nowMs: now });
  const ids = active.map((p) => p.id);
  assert.ok(ids.includes(live), 'live grant listed');
  assert.ok(ids.includes(forever), 'never-expiring grant listed');
  assert.ok(!ids.includes(dead), 'expired grant must NOT count as active');

  const all = await permissionService.listPermissions(agentId, { nowMs: now });
  assert.equal(all.length, 3, 'unfiltered list still shows every grant');
  assert.equal(all.find((p) => p.id === dead).expired, true, 'and flags the expired one');
});

// ---------------------------------------------------------------------------
// grantPermission + setExpiry
// ---------------------------------------------------------------------------

test('grantPermission stores a relative expiry', async () => {
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', 'active', 900, 4, ?, ?)`,
    args: [agentId, 'ex-grant-' + agentId.slice(0, 8), hexWallet(), ts, ts],
  });

  const perm = await permissionService.grantPermission(agentId, {
    category: 'compute',
    ceiling: 50,
    expires_in_s: 900,
  });
  assert.ok(perm.expires_at, 'deadline persisted');
  assert.ok(perm.expires_in_s > 800 && perm.expires_in_s <= 900);

  const budget = await spendService.budgetSummary(perm.id);
  assert.equal(budget.expired, false);
});

test('grantPermission without expiry leaves it null', async () => {
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', 'active', 900, 4, ?, ?)`,
    args: [agentId, 'ex-noexp-' + agentId.slice(0, 8), hexWallet(), ts, ts],
  });
  const perm = await permissionService.grantPermission(agentId, {
    category: 'compute',
    ceiling: 50,
  });
  assert.equal(perm.expires_at, null);
  assert.equal(perm.expires_in_s, null);
});

test('setExpiry extends a running grant, keeping its id and history', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ expiresAt: iso(now + MIN) });
  await spendService.authorizeSpend(permId, { amount: 20 }, { nowMs: now });

  const updated = await permissionService.setExpiry(permId, { expires_in_s: 3600, nowMs: now });
  assert.equal(updated.id, permId, 'same permission id');
  assert.equal(updated.expires_in_s, 3600);
  assert.equal(updated.expired, false);

  // History survived, so the used budget carries over.
  const budget = await spendService.budgetSummary(permId, { nowMs: now });
  assert.equal(budget.used, 20);
});

test('setExpiry with an empty body clears the deadline', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ expiresAt: iso(now + MIN) });
  const updated = await permissionService.setExpiry(permId, { nowMs: now });
  assert.equal(updated.expires_at, null);

  // Now it authorizes arbitrarily far in the future.
  const { spend } = await spendService.authorizeSpend(permId, { amount: 5 }, { nowMs: now + 400 * MIN });
  assert.equal(spend.amount, 5);
});

test('setExpiry can revive an expired grant and flags it as revived', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ expiresAt: iso(now - MIN) });

  await assert.rejects(() => spendService.authorizeSpend(permId, { amount: 5 }, { nowMs: now }));

  const updated = await permissionService.setExpiry(permId, { expires_in_s: 600, nowMs: now });
  assert.equal(updated.revived, true);

  const { spend } = await spendService.authorizeSpend(permId, { amount: 5 }, { nowMs: now });
  assert.equal(spend.amount, 5, 'spends work again after a revive');
});

test('setExpiry refuses a revoked permission (revocation stays final)', async () => {
  const { permId } = await seedPayer({ status: 'revoked' });
  await assert.rejects(
    () => permissionService.setExpiry(permId, { expires_in_s: 600 }),
    (e) => e.status === 409 && /revoked/i.test(e.message)
  );
});

test('setExpiry on an unknown permission is a 404', async () => {
  await assert.rejects(
    () => permissionService.setExpiry(crypto.randomUUID(), { expires_in_s: 60 }),
    (e) => e.status === 404
  );
});

test('setExpiry rejects a past deadline', async () => {
  const now = Date.now();
  const { permId } = await seedPayer({ expiresAt: iso(now + MIN) });
  await assert.rejects(
    () => permissionService.setExpiry(permId, { expires_at: iso(now - MIN), nowMs: now }),
    (e) => e.status === 400 && /future/.test(e.message)
  );
});
