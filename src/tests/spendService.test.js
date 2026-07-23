'use strict';

// Unit tests for spendService: rolling-window budget enforcement.
// Uses an in-memory DB so it never touches real data.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { getDb, closeDb } = require('../db');
const spendService = require('../services/spendService');

after(() => closeDb());

// Insert an active agent + active permission directly, returning the ids.
async function seedPermission({ ceiling, period = 'day' }) {
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  const permId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', 800, 3, ?, ?)`,
    args: [agentId, 'u-' + agentId.slice(0, 8), 'w-' + agentId.slice(0, 8), 'CI', ts, ts],
  });
  await db.execute({
    sql: `INSERT INTO permissions (id, agent_id, category, ceiling, period, status, granted_by, created_at, revoked_at)
          VALUES (?, ?, 'compute', ?, ?, 'active', 'CI', ?, NULL)`,
    args: [permId, agentId, ceiling, period, ts],
  });
  return { agentId, permId };
}

test('windowStart shifts by the period length', () => {
  const now = 10_000_000_000_000;
  const day = new Date(spendService.windowStart('day', now)).getTime();
  const week = new Date(spendService.windowStart('week', now)).getTime();
  assert.strictEqual(now - day, spendService.PERIOD_MS.day);
  assert.strictEqual(now - week, spendService.PERIOD_MS.week);
});

test('spends accumulate within the window and block over-budget charges', async () => {
  const { permId } = await seedPermission({ ceiling: 100, period: 'day' });
  const now = Date.now();

  const a = await spendService.authorizeSpend(permId, { amount: 60 }, { nowMs: now });
  assert.strictEqual(a.budget.used, 60);
  assert.strictEqual(a.budget.remaining, 40);

  const b = await spendService.authorizeSpend(permId, { amount: 40 }, { nowMs: now });
  assert.strictEqual(b.budget.remaining, 0);

  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 1 }, { nowMs: now }),
    (err) => err.status === 409
  );
});

test('spends outside the rolling window free up budget again', async () => {
  const { permId } = await seedPermission({ ceiling: 100, period: 'day' });
  const now = Date.now();

  // Spend the full ceiling two days ago.
  await spendService.authorizeSpend(
    permId,
    { amount: 100 },
    { nowMs: now - 2 * spendService.PERIOD_MS.day }
  );

  // The old spend is outside the 1-day window, so today's budget is full again.
  const used = await spendService.usedInWindow(permId, 'day', now);
  assert.strictEqual(used, 0);

  const fresh = await spendService.authorizeSpend(permId, { amount: 100 }, { nowMs: now });
  assert.strictEqual(fresh.budget.remaining, 0);
});

test('budgetSummary reports used and remaining without charging', async () => {
  const { permId } = await seedPermission({ ceiling: 200, period: 'week' });
  const now = Date.now();
  await spendService.authorizeSpend(permId, { amount: 75 }, { nowMs: now });

  const summary = await spendService.budgetSummary(permId, { nowMs: now });
  assert.strictEqual(summary.ceiling, 200);
  assert.strictEqual(summary.used, 75);
  assert.strictEqual(summary.remaining, 125);
});

test('idempotency: reusing a key returns the original spend without double-charging', async () => {
  const { permId } = await seedPermission({ ceiling: 100, period: 'day' });
  const now = Date.now();

  const first = await spendService.authorizeSpend(
    permId,
    { amount: 30, idempotencyKey: 'retry-abc' },
    { nowMs: now }
  );
  assert.strictEqual(first.budget.used, 30);
  assert.notStrictEqual(first.idempotent_replay, true);

  // Same key again (e.g. the agent retried after a dropped response).
  const replay = await spendService.authorizeSpend(
    permId,
    { amount: 30, idempotencyKey: 'retry-abc' },
    { nowMs: now }
  );
  assert.strictEqual(replay.idempotent_replay, true);
  assert.strictEqual(replay.spend.id, first.spend.id, 'same spend row returned');
  assert.strictEqual(replay.budget.used, 30, 'budget was not charged twice');

  // Only one spend row exists for this permission.
  const spends = await spendService.listSpends(permId);
  assert.strictEqual(spends.length, 1);
});

test('idempotency: a replay is honoured even after the budget is exhausted', async () => {
  const { permId } = await seedPermission({ ceiling: 50, period: 'day' });
  const now = Date.now();

  const first = await spendService.authorizeSpend(
    permId,
    { amount: 50, idempotencyKey: 'fill-it' },
    { nowMs: now }
  );
  assert.strictEqual(first.budget.remaining, 0);

  // Budget is now full; a fresh charge would be blocked, but the same key
  // must still return the original spend rather than throwing.
  const replay = await spendService.authorizeSpend(
    permId,
    { amount: 50, idempotencyKey: 'fill-it' },
    { nowMs: now }
  );
  assert.strictEqual(replay.idempotent_replay, true);
  assert.strictEqual(replay.spend.id, first.spend.id);
});

test('idempotency: different keys are charged independently', async () => {
  const { permId } = await seedPermission({ ceiling: 100, period: 'day' });
  const now = Date.now();

  await spendService.authorizeSpend(permId, { amount: 20, idempotencyKey: 'k1' }, { nowMs: now });
  const second = await spendService.authorizeSpend(
    permId,
    { amount: 20, idempotencyKey: 'k2' },
    { nowMs: now }
  );
  assert.strictEqual(second.budget.used, 40);
  assert.notStrictEqual(second.idempotent_replay, true);
});

test('idempotency: unkeyed spends are never deduplicated', async () => {
  const { permId } = await seedPermission({ ceiling: 100, period: 'day' });
  const now = Date.now();

  await spendService.authorizeSpend(permId, { amount: 10 }, { nowMs: now });
  const second = await spendService.authorizeSpend(permId, { amount: 10 }, { nowMs: now });
  assert.strictEqual(second.budget.used, 20);
  assert.notStrictEqual(second.idempotent_replay, true);
});

test('normalizeIdempotencyKey rejects malformed keys', () => {
  assert.strictEqual(spendService.normalizeIdempotencyKey(null), null);
  assert.strictEqual(spendService.normalizeIdempotencyKey(''), null);
  assert.strictEqual(spendService.normalizeIdempotencyKey('  ok-key '), 'ok-key');
  assert.throws(() => spendService.normalizeIdempotencyKey(123), (e) => e.status === 400);
  assert.throws(
    () => spendService.normalizeIdempotencyKey('x'.repeat(spendService.MAX_IDEMPOTENCY_KEY_LEN + 1)),
    (e) => e.status === 400
  );
});
