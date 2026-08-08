'use strict';

// Unit tests for PAYEE SCOPE — a permission's `counterparty_policy`.
//
// The counterparty trust gate can only run when a spend names a payee, so
// omitting that field skipped it entirely: the strongest safety property in the
// product was opt-in, decided by the very code doing the spending. Payee scope
// moves the decision onto the GRANT:
//
//   open       payee optional (legacy behaviour)
//   required   every spend must name a payee
//   allowlist  every spend must name a payee pinned to this permission
//
// Being on the allowlist means "in scope", never "trusted" — an allowlisted
// payee that fails its trust check is still refused.
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

// A valid 40-nibble hex EVM address. Agent wallets are validated as hex, so a
// fixture with a non-hex nibble silently fails to create the agent.
function hexWallet() {
  return '0x' + crypto.randomBytes(20).toString('hex');
}

// Seed a spending agent + permission (the PAYER) with a given payee scope.
async function seedPayer({ ceiling = 1000, period = 'day', policy = 'open' } = {}) {
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  const permId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', 'active', 900, 4, ?, ?)`,
    args: [agentId, 'sc-payer-' + agentId.slice(0, 8), hexWallet(), ts, ts],
  });
  await db.execute({
    sql: `INSERT INTO permissions (id, agent_id, category, ceiling, period, status, velocity_limit, velocity_window_s, counterparty_policy, granted_by, created_at, revoked_at)
          VALUES (?, ?, 'compute', ?, ?, 'active', NULL, NULL, ?, 'CI', ?, NULL)`,
    args: [permId, agentId, ceiling, period, policy, ts],
  });
  return { agentId, permId };
}

// Seed a payee. `negative` adds a recent severe negative so its verdict becomes
// a `decline` (used to prove the allowlist does not override the trust gate).
async function seedPayee({ score = 900, tier = 4, status = 'active', negative = null } = {}) {
  const db = await getDb();
  const ts = new Date().toISOString();
  const id = crypto.randomUUID();
  const handle = 'sc-payee-' + id.slice(0, 8);
  const wallet = hexWallet();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', ?, ?, ?, ?, ?)`,
    args: [id, handle, wallet, status, score, tier, ts, ts],
  });
  // Positive history so an otherwise-clean payee clears the trust gate.
  for (let i = 0; i < 12; i += 1) {
    await db.execute({
      sql: `INSERT INTO attestations (id, agent_id, kind, weight, amount, note, created_at, verification_status)
            VALUES (?, ?, 'task_completed', 1, 0, 'CI', ?, 'verified')`,
      args: [crypto.randomUUID(), id, ts],
    });
  }
  if (negative) {
    await db.execute({
      sql: `INSERT INTO attestations (id, agent_id, kind, weight, amount, note, created_at)
            VALUES (?, ?, ?, -1, 0, 'CI', ?)`,
      args: [crypto.randomUUID(), id, negative, ts],
    });
  }
  return { id, handle, wallet };
}

// ---------------------------------------------------------------------------
// policy: open (legacy behaviour must not change)
// ---------------------------------------------------------------------------

test('policy "open": a spend with no counterparty is still allowed', async () => {
  const { permId } = await seedPayer({ policy: 'open' });
  const r = await spendService.authorizeSpend(permId, { amount: 50 });
  assert.equal(r.spend.amount, 50);
  assert.equal(r.budget.remaining, 950);
});

test('budget summary reports the permission\'s counterparty_policy', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const budget = await spendService.budgetSummary(permId);
  assert.equal(budget.counterparty_policy, 'allowlist');
});

test('a permission created before the feature defaults to "open"', async () => {
  // Simulate a legacy row: insert WITHOUT the counterparty_policy column, the
  // way the pre-feature INSERT did. The column default must fill it in.
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  const permId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', 'active', 900, 4, ?, ?)`,
    args: [agentId, 'legacy-' + agentId.slice(0, 8), hexWallet(), ts, ts],
  });
  await db.execute({
    sql: `INSERT INTO permissions (id, agent_id, category, ceiling, period, status, granted_by, created_at)
          VALUES (?, ?, 'compute', 500, 'day', 'active', 'CI', ?)`,
    args: [permId, agentId, ts],
  });
  const budget = await spendService.budgetSummary(permId);
  assert.equal(budget.counterparty_policy, 'open');
  // And it still spends without naming a payee.
  const r = await spendService.authorizeSpend(permId, { amount: 10 });
  assert.equal(r.spend.amount, 10);
});

// ---------------------------------------------------------------------------
// policy: required — closes the "just omit the field" bypass
// ---------------------------------------------------------------------------

test('policy "required": a spend that omits the counterparty is REFUSED', async () => {
  const { permId } = await seedPayer({ policy: 'required' });
  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 50 }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.details.reason, 'counterparty_required');
      assert.equal(err.details.counterparty_policy, 'required');
      return true;
    }
  );
  // Budget untouched — the refusal happens before any charge.
  const budget = await spendService.budgetSummary(permId);
  assert.equal(budget.used, 0);
  assert.equal(budget.remaining, 1000);
});

test('policy "required": an empty-string counterparty is treated as missing', async () => {
  const { permId } = await seedPayer({ policy: 'required' });
  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 5, counterparty: '   ' }),
    (err) => {
      assert.equal(err.details.reason, 'counterparty_required');
      return true;
    }
  );
});

test('policy "required": naming a trusted payee is allowed', async () => {
  const { permId } = await seedPayer({ policy: 'required' });
  const payee = await seedPayee();
  const r = await spendService.authorizeSpend(permId, {
    amount: 25,
    counterparty: payee.handle,
  });
  assert.equal(r.spend.amount, 25);
});

test('policy "required": the trust gate still runs on the named payee', async () => {
  const { permId } = await seedPayer({ policy: 'required' });
  const bad = await seedPayee({ negative: 'chargeback' });
  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 25, counterparty: bad.handle }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.details.verdict, 'decline');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// policy: allowlist — "this budget may only ever pay these vendors"
// ---------------------------------------------------------------------------

test('policy "allowlist": an allowlisted payee is allowed', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const payee = await seedPayee();
  await permissionService.addPayee(permId, payee.handle, { label: 'primary vendor' });

  const r = await spendService.authorizeSpend(permId, {
    amount: 40,
    counterparty: payee.handle,
  });
  assert.equal(r.spend.amount, 40);
});

test('policy "allowlist": a payee NOT on the list is refused, budget intact', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const allowed = await seedPayee();
  const stranger = await seedPayee();
  await permissionService.addPayee(permId, allowed.handle);

  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 40, counterparty: stranger.handle }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.details.reason, 'counterparty_not_allowed');
      assert.equal(err.details.counterparty_policy, 'allowlist');
      return true;
    }
  );
  const budget = await spendService.budgetSummary(permId);
  assert.equal(budget.used, 0);
});

test('policy "allowlist": omitting the payee is refused as counterparty_required', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const payee = await seedPayee();
  await permissionService.addPayee(permId, payee.handle);

  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 10 }),
    (err) => {
      assert.equal(err.details.reason, 'counterparty_required');
      return true;
    }
  );
});

test('allowlist matches by IDENTITY: added by handle, spent by wallet', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const payee = await seedPayee();
  await permissionService.addPayee(permId, payee.handle);

  // Same payee, different spelling — must still match.
  const r = await spendService.authorizeSpend(permId, {
    amount: 15,
    counterparty: payee.wallet,
  });
  assert.equal(r.spend.amount, 15);
});

test('allowlist matches by IDENTITY: added by wallet, spent by handle', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const payee = await seedPayee();
  await permissionService.addPayee(permId, payee.wallet);

  const r = await spendService.authorizeSpend(permId, {
    amount: 15,
    counterparty: payee.handle,
  });
  assert.equal(r.spend.amount, 15);
});

test('allowlist wallet matching is case-insensitive', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const payee = await seedPayee();
  await permissionService.addPayee(permId, payee.wallet.toLowerCase());

  const r = await spendService.authorizeSpend(permId, {
    amount: 15,
    counterparty: payee.wallet.toUpperCase().replace('0X', '0x'),
  });
  assert.equal(r.spend.amount, 15);
});

// The load-bearing property: the allowlist grants SCOPE, not TRUST.
test('an allowlisted payee that fails its trust check is STILL refused', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const bad = await seedPayee({ negative: 'chargeback' });
  await permissionService.addPayee(permId, bad.handle);

  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 20, counterparty: bad.handle }),
    (err) => {
      assert.equal(err.status, 409);
      // Refused by the TRUST gate, not by scope — proves the allowlist is not
      // an override for trust.
      assert.equal(err.details.verdict, 'decline');
      return true;
    }
  );
});

test('payee scope is checked BEFORE the budget ceiling', async () => {
  // Ceiling fully consumed, so a ceiling check would reject first if it ran
  // first. The refusal must still be the scope one.
  const { permId } = await seedPayer({ ceiling: 100, policy: 'required' });
  await spendService.authorizeSpend(permId, { amount: 100, counterparty: (await seedPayee()).handle });

  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 50 }),
    (err) => {
      assert.equal(err.details.reason, 'counterparty_required');
      return true;
    }
  );
});

test('payee scope is checked BEFORE the trust gate (no trust info leaked)', async () => {
  // A payee that is BOTH off-allowlist and trust-declined must be refused for
  // being out of scope, saying nothing about its trust standing.
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const onList = await seedPayee();
  const badStranger = await seedPayee({ negative: 'chargeback' });
  await permissionService.addPayee(permId, onList.handle);

  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 10, counterparty: badStranger.handle }),
    (err) => {
      assert.equal(err.details.reason, 'counterparty_not_allowed');
      assert.equal(err.details.verdict, undefined);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// previewSpend mirrors the real decision
// ---------------------------------------------------------------------------

test('previewSpend mirrors counterparty_required without charging', async () => {
  const { permId } = await seedPayer({ policy: 'required' });
  const p = await spendService.previewSpend(permId, { amount: 30 });
  assert.equal(p.allowed, false);
  assert.equal(p.reason, 'counterparty_required');
  assert.equal(p.counterparty.counterparty_policy, 'required');
  const budget = await spendService.budgetSummary(permId);
  assert.equal(budget.used, 0);
});

test('previewSpend mirrors counterparty_not_allowed', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const onList = await seedPayee();
  const stranger = await seedPayee();
  await permissionService.addPayee(permId, onList.handle);

  const p = await spendService.previewSpend(permId, {
    amount: 30,
    counterparty: stranger.handle,
  });
  assert.equal(p.allowed, false);
  assert.equal(p.reason, 'counterparty_not_allowed');
});

test('previewSpend allows an allowlisted payee', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const payee = await seedPayee();
  await permissionService.addPayee(permId, payee.handle);

  const p = await spendService.previewSpend(permId, {
    amount: 30,
    counterparty: payee.handle,
  });
  assert.equal(p.allowed, true);
  assert.equal(p.reason, null);
});

// ---------------------------------------------------------------------------
// allowlist management
// ---------------------------------------------------------------------------

test('addPayee resolves a handle to the payee agent id', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const payee = await seedPayee();
  const row = await permissionService.addPayee(permId, payee.handle, { label: 'gpu vendor' });
  assert.equal(row.agent_id, payee.id);
  assert.equal(row.registered, true);
  assert.equal(row.label, 'gpu vendor');
});

test('addPayee accepts an unregistered wallet (scope != trust)', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const wallet = hexWallet();
  const row = await permissionService.addPayee(permId, wallet);
  assert.equal(row.agent_id, null);
  assert.equal(row.registered, false);
  // ...but paying it is still refused by the trust gate.
  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 10, counterparty: wallet }),
    (err) => {
      assert.equal(err.details.verdict, 'decline');
      return true;
    }
  );
});

test('addPayee rejects an unresolvable non-wallet reference', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  await assert.rejects(
    () => permissionService.addPayee(permId, 'no-such-agent-anywhere'),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('addPayee rejects a duplicate with 409', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const payee = await seedPayee();
  await permissionService.addPayee(permId, payee.handle);
  await assert.rejects(
    () => permissionService.addPayee(permId, payee.handle),
    (err) => {
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test('addPayee 404s for an unknown permission', async () => {
  const payee = await seedPayee();
  await assert.rejects(
    () => permissionService.addPayee(crypto.randomUUID(), payee.handle),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('removePayee takes a reference and revokes access immediately', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const a = await seedPayee();
  const b = await seedPayee();
  await permissionService.addPayee(permId, a.handle);
  await permissionService.addPayee(permId, b.handle);

  // Paying b works...
  await spendService.authorizeSpend(permId, { amount: 5, counterparty: b.handle });

  const removed = await permissionService.removePayee(permId, b.handle);
  assert.ok(removed);

  // ...and stops the moment it is removed.
  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 5, counterparty: b.handle }),
    (err) => {
      assert.equal(err.details.reason, 'counterparty_not_allowed');
      return true;
    }
  );
  const left = await permissionService.listPayees(permId);
  assert.equal(left.length, 1);
  assert.equal(left[0].reference, a.handle);
});

test('removePayee returns null for a payee that is not on the list', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  assert.equal(await permissionService.removePayee(permId, 'nobody'), null);
});

test('listPayees reports the current handle for a resolved payee', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const payee = await seedPayee();
  await permissionService.addPayee(permId, payee.wallet);
  const rows = await permissionService.listPayees(permId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].handle, payee.handle);
  assert.equal(rows[0].registered, true);
});

// ---------------------------------------------------------------------------
// grantPermission + policy changes
// ---------------------------------------------------------------------------

test('grantPermission seeds the allowlist atomically', async () => {
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', 'active', 950, 4, ?, ?)`,
    args: [agentId, 'g-payer-' + agentId.slice(0, 8), hexWallet(), ts, ts],
  });
  const payee = await seedPayee();

  const perm = await permissionService.grantPermission(agentId, {
    category: 'compute',
    ceiling: 200,
    counterparty_policy: 'allowlist',
    payees: [payee.handle],
  });
  assert.equal(perm.counterparty_policy, 'allowlist');
  assert.equal(perm.payees.length, 1);
  assert.equal(perm.payees[0].agent_id, payee.id);

  const r = await spendService.authorizeSpend(perm.id, {
    amount: 10,
    counterparty: payee.handle,
  });
  assert.equal(r.spend.amount, 10);
});

test('grantPermission rejects an allowlist policy with no payees', async () => {
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', 'active', 950, 4, ?, ?)`,
    args: [agentId, 'g2-' + agentId.slice(0, 8), hexWallet(), ts, ts],
  });
  await assert.rejects(
    () =>
      permissionService.grantPermission(agentId, {
        category: 'compute',
        ceiling: 200,
        counterparty_policy: 'allowlist',
      }),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('grantPermission rejects an invalid counterparty_policy', async () => {
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', 'active', 950, 4, ?, ?)`,
    args: [agentId, 'g3-' + agentId.slice(0, 8), hexWallet(), ts, ts],
  });
  await assert.rejects(
    () =>
      permissionService.grantPermission(agentId, {
        category: 'compute',
        ceiling: 200,
        counterparty_policy: 'whatever',
      }),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('setCounterpartyPolicy tightens an existing grant without revoking it', async () => {
  const { permId } = await seedPayer({ policy: 'open' });
  const payee = await seedPayee();

  // Legacy grant: an unnamed spend works today.
  await spendService.authorizeSpend(permId, { amount: 10 });

  const updated = await permissionService.setCounterpartyPolicy(permId, 'allowlist', {
    payees: [payee.handle],
  });
  assert.equal(updated.id, permId); // same permission, history preserved
  assert.equal(updated.counterparty_policy, 'allowlist');

  // The same unnamed spend is now refused.
  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 10 }),
    (err) => {
      assert.equal(err.details.reason, 'counterparty_required');
      return true;
    }
  );
  // Prior spends survive the tightening.
  const budget = await spendService.budgetSummary(permId);
  assert.equal(budget.used, 10);
});

test('setCounterpartyPolicy refuses allowlist with an empty allowlist', async () => {
  const { permId } = await seedPayer({ policy: 'open' });
  await assert.rejects(
    () => permissionService.setCounterpartyPolicy(permId, 'allowlist'),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('setCounterpartyPolicy is idempotent for an already-pinned payee', async () => {
  const { permId } = await seedPayer({ policy: 'allowlist' });
  const payee = await seedPayee();
  await permissionService.addPayee(permId, payee.handle);
  const updated = await permissionService.setCounterpartyPolicy(permId, 'allowlist', {
    payees: [payee.handle],
  });
  assert.equal(updated.payees.length, 1);
});

test('setCounterpartyPolicy can loosen back to open', async () => {
  const { permId } = await seedPayer({ policy: 'required' });
  await permissionService.setCounterpartyPolicy(permId, 'open');
  const r = await spendService.authorizeSpend(permId, { amount: 10 });
  assert.equal(r.spend.amount, 10);
});

test('enforcePayeeScope is exported and pure-ish for an open policy', async () => {
  const scope = await spendService.enforcePayeeScope({ counterparty_policy: 'open' }, null);
  assert.equal(scope.ok, true);
  assert.equal(scope.policy, 'open');
});
