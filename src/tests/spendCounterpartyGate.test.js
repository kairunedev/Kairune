'use strict';

// Unit tests for the counterparty trust gate on spend authorization.
//
// This is the bridge between the two halves of Kairune: budget enforcement
// (how much an agent may spend) and the counterparty trust check (who it is
// paying). A spend that names a `counterparty` must be refused when that payee
// fails its trust check — even when the budget would otherwise allow it.
//
// Uses an in-memory DB so it never touches real data.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { getDb, closeDb } = require('../db');
const spendService = require('../services/spendService');

after(() => closeDb());

// Seed a spending agent + active permission (the PAYER). High score so its own
// tier never limits the ceiling under test.
async function seedPayer({ ceiling = 1000, period = 'day' } = {}) {
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  const permId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', 'active', 900, 4, ?, ?)`,
    args: [agentId, 'payer-' + agentId.slice(0, 8), 'wp-' + agentId.slice(0, 8), ts, ts],
  });
  await db.execute({
    sql: `INSERT INTO permissions (id, agent_id, category, ceiling, period, status, velocity_limit, velocity_window_s, granted_by, created_at, revoked_at)
          VALUES (?, ?, 'compute', ?, ?, 'active', NULL, NULL, 'CI', ?, NULL)`,
    args: [permId, agentId, ceiling, period, ts],
  });
  return { agentId, permId };
}

// Seed a counterparty (the PAYEE) with a given score/status and an optional
// recent negative attestation. Returns its handle + wallet so tests can gate on
// any reference form.
async function seedPayee({ score = 900, tier = 4, status = 'active', negative = null } = {}) {
  const db = await getDb();
  const ts = new Date().toISOString();
  const id = crypto.randomUUID();
  const handle = 'payee-' + id.slice(0, 8);
  const wallet = '0x' + id.replace(/-/g, '').slice(0, 40);
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', ?, ?, ?, ?, ?)`,
    args: [id, handle, wallet, status, score, tier, ts, ts],
  });
  if (negative) {
    await db.execute({
      sql: `INSERT INTO attestations (id, agent_id, kind, weight, amount, note, created_at)
            VALUES (?, ?, ?, -1, 0, 'CI', ?)`,
      args: [crypto.randomUUID(), id, negative, ts],
    });
  }
  return { id, handle, wallet };
}

test('spend WITHOUT a counterparty is unaffected (backward compatible)', async () => {
  const { permId } = await seedPayer();
  const r = await spendService.authorizeSpend(permId, { amount: 50 });
  assert.strictEqual(r.budget.used, 50);
});

test('spend to a trusted counterparty is allowed', async () => {
  const { permId } = await seedPayer();
  const payee = await seedPayee({ score: 900, tier: 4 });
  const r = await spendService.authorizeSpend(permId, {
    amount: 20,
    counterparty: payee.handle,
  });
  assert.strictEqual(r.budget.used, 20);
});

test('spend to a chargeback payee is REFUSED even with budget available', async () => {
  const { permId } = await seedPayer({ ceiling: 1000 });
  const payee = await seedPayee({ score: 900, tier: 4, negative: 'chargeback' });

  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 5, counterparty: payee.handle }),
    (err) => {
      assert.strictEqual(err.status, 409);
      assert.strictEqual(err.details.verdict, 'decline');
      assert.strictEqual(err.details.registered, true);
      return true;
    }
  );

  // Nothing was charged — the budget is untouched.
  const budget = await spendService.budgetSummary(permId);
  assert.strictEqual(budget.used, 0);
});

test('spend to an UNREGISTERED wallet is refused', async () => {
  const { permId } = await seedPayer();
  const unknownWallet = '0x' + 'a'.repeat(40);

  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 5, counterparty: unknownWallet }),
    (err) => {
      assert.strictEqual(err.status, 409);
      assert.strictEqual(err.details.verdict, 'decline');
      return true;
    }
  );
});

test('spend to an UNRESOLVABLE handle is refused (cannot gate what we cannot identify)', async () => {
  const { permId } = await seedPayer();
  await assert.rejects(
    () =>
      spendService.authorizeSpend(permId, {
        amount: 5,
        counterparty: 'nobody-here-xyz',
      }),
    (err) => {
      assert.strictEqual(err.status, 409);
      assert.deepStrictEqual(err.details.reasons, ['counterparty_unresolved']);
      return true;
    }
  );
});

test('spend to a SUSPENDED counterparty is refused', async () => {
  const { permId } = await seedPayer();
  const payee = await seedPayee({ score: 900, tier: 4, status: 'suspended' });
  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 5, counterparty: payee.handle }),
    (err) => err.status === 409 && err.details.verdict === 'decline'
  );
});

test('counterparty gate is checked BEFORE the budget ceiling', async () => {
  // Budget is already exhausted, AND the payee is bad. The gate should win, so
  // the reason is the counterparty decline, not ceiling_exceeded.
  const { permId } = await seedPayer({ ceiling: 100 });
  await spendService.authorizeSpend(permId, { amount: 100 }); // exhaust budget
  const payee = await seedPayee({ negative: 'chargeback' });

  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 10, counterparty: payee.handle }),
    (err) => {
      assert.strictEqual(err.status, 409);
      assert.strictEqual(err.details.verdict, 'decline');
      return true;
    }
  );
});

test('previewSpend mirrors the gate without charging', async () => {
  const { permId } = await seedPayer();
  const bad = await seedPayee({ negative: 'chargeback' });
  const good = await seedPayee({ score: 900, tier: 4 });

  const blocked = await spendService.previewSpend(permId, {
    amount: 5,
    counterparty: bad.handle,
  });
  assert.strictEqual(blocked.allowed, false);
  assert.strictEqual(blocked.reason, 'counterparty_declined');
  assert.strictEqual(blocked.counterparty.verdict, 'decline');

  const ok = await spendService.previewSpend(permId, {
    amount: 5,
    counterparty: good.handle,
  });
  assert.strictEqual(ok.allowed, true);
  assert.strictEqual(ok.reason, null);
  assert.strictEqual(ok.budget.counterparty.verdict, 'proceed');

  // Preview never charged.
  const budget = await spendService.budgetSummary(permId);
  assert.strictEqual(budget.used, 0);
});

test('assessSpendCounterparty passes through with no reference', async () => {
  const gate = await spendService.assessSpendCounterparty(null);
  assert.strictEqual(gate.ok, true);
  assert.strictEqual(gate.assessment, null);
});
