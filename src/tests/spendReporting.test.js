'use strict';

// Unit + integration tests for SPEND REPORTING.
//
// Per-permission history answers "what did this grant pay for". An operator
// running several grants on one agent could not answer "what did this agent
// spend this month, and on whom" without walking every permission client-side.
// This covers the two things that close that gap:
//
//   filters on the existing history   since / until / payee / idempotency_key
//                                     plus limit + offset paging
//   agent-level views                 GET /api/agents/:id/spends
//                                     GET /api/agents/:id/spend-summary
//
// The load-bearing behaviours asserted here:
//   * `until` is EXCLUSIVE, so consecutive windows tile without double-counting
//   * a malformed date is a 400, never a silently-ignored filter
//   * summary totals cover the REQUESTED window, not each permission's rolling
//     ceiling window (a report and a budget check are different questions)
//   * by_payee excludes unnamed charges but `total` still counts them
//
// Uses an in-memory DB so it never touches real data.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const app = require('../../server');
const { getDb, closeDb } = require('../db');
const spendService = require('../services/spendService');

let server;
let base;

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
  return closeDb();
});

function req(method, path) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, { method }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : {} })
      );
    });
    r.on('error', reject);
    r.end();
  });
}

function hexWallet() {
  return '0x' + crypto.randomBytes(20).toString('hex');
}

/** Insert an active, well-scored agent. */
async function seedAgent() {
  const db = await getDb();
  const ts = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', 'active', 900, 4, ?, ?)`,
    args: [id, 'rep-' + id.slice(0, 8), hexWallet(), ts, ts],
  });
  return id;
}

/** Insert an active permission for an agent. */
async function seedPermission(agentId, { category = 'compute', ceiling = 10_000, period = 'day' } = {}) {
  const db = await getDb();
  const ts = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO permissions (id, agent_id, category, ceiling, period, status, velocity_limit, velocity_window_s, counterparty_policy, granted_by, created_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, 'open', 'CI', ?, NULL)`,
    args: [id, agentId, category, ceiling, period, ts],
  });
  return id;
}

/**
 * Insert a spend row directly, so `created_at` can be backdated.
 * The reporting layer reads history; going through authorizeSpend would pin
 * every fixture to "now" and make window tests untestable.
 */
async function seedSpend(permissionId, agentId, { amount, payee = null, at, key = null, note = null } = {}) {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO spends (id, permission_id, agent_id, amount, note, payee, idempotency_key, receipt_signature, receipt_key_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    args: [id, permissionId, agentId, amount, note, payee, key, at],
  });
  return id;
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

test('normalizeDateBound accepts a bare date and a full timestamp', () => {
  assert.strictEqual(
    spendService.normalizeDateBound('2026-08-01', 'since'),
    '2026-08-01T00:00:00.000Z'
  );
  assert.strictEqual(
    spendService.normalizeDateBound('2026-08-01T12:30:00Z', 'since'),
    '2026-08-01T12:30:00.000Z'
  );
});

test('normalizeDateBound treats absent values as "no filter"', () => {
  for (const empty of [null, undefined, '']) {
    assert.strictEqual(spendService.normalizeDateBound(empty, 'since'), null);
  }
});

test('normalizeDateBound rejects an unparseable date with a 400', () => {
  // A silently-ignored date filter would return EVERY spend to a caller who
  // asked for one month — the failure mode must be loud.
  assert.throws(
    () => spendService.normalizeDateBound('last-tuesday', 'since'),
    (err) => err.status === 400 && /since/.test(err.message)
  );
});

test('clampLimit bounds the page size and defaults sanely', () => {
  assert.strictEqual(spendService.clampLimit(undefined), spendService.DEFAULT_SPEND_PAGE);
  assert.strictEqual(spendService.clampLimit('not a number'), spendService.DEFAULT_SPEND_PAGE);
  assert.strictEqual(spendService.clampLimit(0), 1, 'zero clamps up to 1');
  assert.strictEqual(spendService.clampLimit(-5), 1, 'negative clamps up to 1');
  assert.strictEqual(
    spendService.clampLimit(10_000),
    spendService.MAX_SPEND_PAGE,
    'an oversized request is clamped, not rejected'
  );
});

test('clampOffset floors to a non-negative integer', () => {
  assert.strictEqual(spendService.clampOffset(undefined), 0);
  assert.strictEqual(spendService.clampOffset(-3), 0);
  assert.strictEqual(spendService.clampOffset(7.9), 7);
});

// ---------------------------------------------------------------------------
// listSpends — paging + filters
// ---------------------------------------------------------------------------

test('listSpends pages with limit + offset without dropping or repeating rows', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  // Five charges, one per day, so ordering is unambiguous.
  for (let i = 1; i <= 5; i++) {
    await seedSpend(permId, agentId, {
      amount: i,
      at: `2026-08-0${i}T00:00:00.000Z`,
    });
  }

  const page1 = await spendService.listSpends(permId, { limit: 2 });
  const page2 = await spendService.listSpends(permId, { limit: 2, offset: 2 });
  const page3 = await spendService.listSpends(permId, { limit: 2, offset: 4 });

  assert.deepStrictEqual(
    page1.map((s) => s.amount),
    [5, 4],
    'most recent first'
  );
  assert.deepStrictEqual(page2.map((s) => s.amount), [3, 2]);
  assert.deepStrictEqual(page3.map((s) => s.amount), [1], 'last page is short');

  const seen = [...page1, ...page2, ...page3].map((s) => s.id);
  assert.strictEqual(new Set(seen).size, 5, 'paging never repeats a row');
});

test('listSpends filters on a half-open [since, until) window', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  await seedSpend(permId, agentId, { amount: 10, at: '2026-07-31T23:59:59.000Z' });
  await seedSpend(permId, agentId, { amount: 20, at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(permId, agentId, { amount: 30, at: '2026-08-15T00:00:00.000Z' });
  await seedSpend(permId, agentId, { amount: 40, at: '2026-09-01T00:00:00.000Z' });

  const august = await spendService.listSpends(permId, {
    since: '2026-08-01',
    until: '2026-09-01',
  });
  assert.deepStrictEqual(
    august.map((s) => s.amount).sort((a, b) => a - b),
    [20, 30],
    'since is inclusive, until is exclusive'
  );

  // The exclusive upper bound is what lets consecutive windows tile: the
  // Sep 1 charge must land in September, and in exactly one of the two.
  const september = await spendService.listSpends(permId, {
    since: '2026-09-01',
    until: '2026-10-01',
  });
  assert.deepStrictEqual(september.map((s) => s.amount), [40]);
});

test('listSpends filters by payee, case-insensitively', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  await seedSpend(permId, agentId, { amount: 5, payee: 'GPU-Vendor', at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(permId, agentId, { amount: 7, payee: 'gpu-vendor', at: '2026-08-02T00:00:00.000Z' });
  await seedSpend(permId, agentId, { amount: 9, payee: 'other-vendor', at: '2026-08-03T00:00:00.000Z' });
  await seedSpend(permId, agentId, { amount: 11, payee: null, at: '2026-08-04T00:00:00.000Z' });

  const rows = await spendService.listSpends(permId, { payee: 'GPU-VENDOR' });
  assert.deepStrictEqual(
    rows.map((s) => s.amount).sort((a, b) => a - b),
    [5, 7],
    'a payee is matched by identity, not by how it was spelled'
  );
});

test('listSpends filters by idempotency_key — "did that retry land?"', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  await seedSpend(permId, agentId, { amount: 42, key: 'order-99', at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(permId, agentId, { amount: 7, key: 'order-100', at: '2026-08-02T00:00:00.000Z' });

  const rows = await spendService.listSpends(permId, { idempotencyKey: 'order-99' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].amount, 42);

  const none = await spendService.listSpends(permId, { idempotencyKey: 'never-sent' });
  assert.deepStrictEqual(none, [], 'an unused key returns nothing, not everything');
});

test('listSpends scopes to its own permission', async () => {
  const agentId = await seedAgent();
  const permA = await seedPermission(agentId, { category: 'compute' });
  const permB = await seedPermission(agentId, { category: 'data' });
  await seedSpend(permA, agentId, { amount: 1, at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(permB, agentId, { amount: 2, at: '2026-08-01T00:00:00.000Z' });

  const rows = await spendService.listSpends(permA);
  assert.deepStrictEqual(rows.map((s) => s.amount), [1]);
});

// ---------------------------------------------------------------------------
// listAgentSpends — the merged view
// ---------------------------------------------------------------------------

test('listAgentSpends merges every permission and carries the grant category', async () => {
  const agentId = await seedAgent();
  const compute = await seedPermission(agentId, { category: 'compute' });
  const data = await seedPermission(agentId, { category: 'data', period: 'week' });
  await seedSpend(compute, agentId, { amount: 10, at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(data, agentId, { amount: 20, at: '2026-08-02T00:00:00.000Z' });

  const rows = await spendService.listAgentSpends(agentId);
  assert.strictEqual(rows.length, 2, 'both grants appear in one call');
  assert.deepStrictEqual(rows.map((s) => s.amount), [20, 10], 'most recent first');
  const byAmount = new Map(rows.map((r) => [r.amount, r]));
  assert.strictEqual(byAmount.get(10).category, 'compute');
  assert.strictEqual(byAmount.get(20).category, 'data');
  assert.strictEqual(byAmount.get(20).period, 'week');
});

test('listAgentSpends never leaks another agent’s charges', async () => {
  const mine = await seedAgent();
  const theirs = await seedAgent();
  const minePerm = await seedPermission(mine);
  const theirPerm = await seedPermission(theirs);
  await seedSpend(minePerm, mine, { amount: 1, at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(theirPerm, theirs, { amount: 999, at: '2026-08-02T00:00:00.000Z' });

  const rows = await spendService.listAgentSpends(mine);
  assert.deepStrictEqual(rows.map((s) => s.amount), [1]);
});

test('listAgentSpends applies the same filters as the per-permission list', async () => {
  const agentId = await seedAgent();
  const permA = await seedPermission(agentId, { category: 'compute' });
  const permB = await seedPermission(agentId, { category: 'data' });
  await seedSpend(permA, agentId, { amount: 10, payee: 'vendor-x', at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(permB, agentId, { amount: 20, payee: 'vendor-x', at: '2026-09-05T00:00:00.000Z' });
  await seedSpend(permB, agentId, { amount: 30, payee: 'vendor-y', at: '2026-09-06T00:00:00.000Z' });

  const window = await spendService.listAgentSpends(agentId, {
    since: '2026-09-01',
    until: '2026-10-01',
  });
  assert.deepStrictEqual(window.map((s) => s.amount), [30, 20]);

  const byPayee = await spendService.listAgentSpends(agentId, { payee: 'vendor-x' });
  assert.deepStrictEqual(byPayee.map((s) => s.amount).sort((a, b) => a - b), [10, 20]);

  const scoped = await spendService.listAgentSpends(agentId, { permissionId: permB });
  assert.deepStrictEqual(scoped.map((s) => s.amount), [30, 20]);
});

// ---------------------------------------------------------------------------
// spendSummary — the rollup
// ---------------------------------------------------------------------------

test('spendSummary totals across permissions and rolls up by permission, category and payee', async () => {
  const agentId = await seedAgent();
  const compute = await seedPermission(agentId, { category: 'compute' });
  const data = await seedPermission(agentId, { category: 'data' });
  await seedSpend(compute, agentId, { amount: 100, payee: 'gpu-co', at: '2026-08-02T00:00:00.000Z' });
  await seedSpend(compute, agentId, { amount: 50, payee: 'gpu-co', at: '2026-08-03T00:00:00.000Z' });
  await seedSpend(data, agentId, { amount: 25, payee: 'feed-co', at: '2026-08-04T00:00:00.000Z' });

  const s = await spendService.spendSummary(agentId);
  assert.strictEqual(s.total, 175);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.first_spend_at, '2026-08-02T00:00:00.000Z');
  assert.strictEqual(s.last_spend_at, '2026-08-04T00:00:00.000Z');

  assert.deepStrictEqual(
    s.by_permission.map((p) => [p.permission_id, p.total, p.count]),
    [
      [compute, 150, 2],
      [data, 25, 1],
    ],
    'ordered by amount, descending'
  );
  assert.deepStrictEqual(
    s.by_category.map((c) => [c.category, c.total]),
    [
      ['compute', 150],
      ['data', 25],
    ]
  );
  assert.deepStrictEqual(
    s.by_payee.map((p) => [p.payee, p.total, p.count]),
    [
      ['gpu-co', 150, 2],
      ['feed-co', 25, 1],
    ]
  );
  assert.strictEqual(s.by_payee[0].last_spend_at, '2026-08-03T00:00:00.000Z');
});

test('spendSummary groups a payee by identity across spellings', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  await seedSpend(permId, agentId, { amount: 10, payee: 'GPU-Co', at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(permId, agentId, { amount: 15, payee: 'gpu-co', at: '2026-08-02T00:00:00.000Z' });

  const s = await spendService.spendSummary(agentId);
  assert.strictEqual(s.by_payee.length, 1, 'one counterparty, not two');
  assert.strictEqual(s.by_payee[0].total, 25);
});

test('spendSummary counts unnamed charges in the total but not in by_payee', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  await seedSpend(permId, agentId, { amount: 40, payee: 'vendor', at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(permId, agentId, { amount: 60, payee: null, at: '2026-08-02T00:00:00.000Z' });

  const s = await spendService.spendSummary(agentId);
  assert.strictEqual(s.total, 100, 'the money moved, so it is in the total');
  assert.strictEqual(s.count, 2);
  assert.deepStrictEqual(
    s.by_payee.map((p) => p.payee),
    ['vendor'],
    '"who did I pay" has no answer for an unnamed charge'
  );
});

test('spendSummary reports the requested window, not each permission’s rolling ceiling window', async () => {
  const agentId = await seedAgent();
  // A `day`-period grant: its budget window is the last 24h, but a report
  // asking for August must still see an August charge from weeks ago.
  const permId = await seedPermission(agentId, { period: 'day' });
  await seedSpend(permId, agentId, { amount: 500, at: '2026-08-02T00:00:00.000Z' });

  const august = await spendService.spendSummary(agentId, {
    since: '2026-08-01',
    until: '2026-09-01',
  });
  assert.strictEqual(august.total, 500, 'a report is not a budget check');
  assert.strictEqual(august.since, '2026-08-01T00:00:00.000Z');
  assert.strictEqual(august.until, '2026-09-01T00:00:00.000Z');

  // Budget headroom is the other question, and it is unchanged by reporting.
  const budget = await spendService.budgetSummary(permId);
  assert.strictEqual(budget.used, 0, 'the old charge is outside the 24h window');
});

test('spendSummary is empty-safe for an agent that has never spent', async () => {
  const agentId = await seedAgent();
  await seedPermission(agentId);

  const s = await spendService.spendSummary(agentId);
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.first_spend_at, null);
  assert.strictEqual(s.last_spend_at, null);
  assert.deepStrictEqual(s.by_permission, []);
  assert.deepStrictEqual(s.by_category, []);
  assert.deepStrictEqual(s.by_payee, []);
});

test('spendSummary honours a payee filter across the whole rollup', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  await seedSpend(permId, agentId, { amount: 10, payee: 'keep-me', at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(permId, agentId, { amount: 90, payee: 'drop-me', at: '2026-08-02T00:00:00.000Z' });

  const s = await spendService.spendSummary(agentId, { payee: 'keep-me' });
  assert.strictEqual(s.total, 10);
  assert.deepStrictEqual(s.by_payee.map((p) => p.payee), ['keep-me']);
  assert.deepStrictEqual(s.by_category.map((c) => c.total), [10]);
});

test('spendSummary caps by_payee with top_payees', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  for (let i = 1; i <= 4; i++) {
    await seedSpend(permId, agentId, {
      amount: i * 10,
      payee: 'vendor-' + i,
      at: `2026-08-0${i}T00:00:00.000Z`,
    });
  }

  const s = await spendService.spendSummary(agentId, { topPayees: 2 });
  assert.deepStrictEqual(
    s.by_payee.map((p) => p.payee),
    ['vendor-4', 'vendor-3'],
    'the biggest counterparties survive the cap'
  );
  assert.strictEqual(s.total, 100, 'the total still covers every charge');
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

test('GET /api/permissions/:pid/spends returns a paging echo', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  await seedSpend(permId, agentId, { amount: 3, at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(permId, agentId, { amount: 4, at: '2026-08-02T00:00:00.000Z' });

  const r = await req('GET', `/api/permissions/${permId}/spends?limit=1`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.spends.length, 1);
  assert.deepStrictEqual(r.body.paging, { limit: 1, offset: 0, returned: 1 });
});

test('GET /api/permissions/:pid/spends passes filters through', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  await seedSpend(permId, agentId, { amount: 5, payee: 'vendor-a', at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(permId, agentId, { amount: 6, payee: 'vendor-b', at: '2026-09-01T00:00:00.000Z' });

  const r = await req('GET', `/api/permissions/${permId}/spends?payee=vendor-b`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.spends.map((s) => s.amount), [6]);

  const w = await req(
    'GET',
    `/api/permissions/${permId}/spends?since=2026-08-01&until=2026-09-01`
  );
  assert.deepStrictEqual(w.body.spends.map((s) => s.amount), [5]);
});

test('GET /api/permissions/:pid/spends rejects a malformed date with 400', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  const r = await req('GET', `/api/permissions/${permId}/spends?since=yesterday`);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /since/);
});

test('GET /api/agents/:id/spends merges permissions over HTTP', async () => {
  const agentId = await seedAgent();
  const compute = await seedPermission(agentId, { category: 'compute' });
  const data = await seedPermission(agentId, { category: 'data' });
  await seedSpend(compute, agentId, { amount: 11, at: '2026-08-01T00:00:00.000Z' });
  await seedSpend(data, agentId, { amount: 22, at: '2026-08-02T00:00:00.000Z' });

  const r = await req('GET', `/api/agents/${agentId}/spends`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.agent_id, agentId);
  assert.deepStrictEqual(r.body.spends.map((s) => s.amount), [22, 11]);
  assert.strictEqual(r.body.spends[0].category, 'data', 'grant context travels with the row');
  assert.strictEqual(r.body.paging.returned, 2);
});

test('GET /api/agents/:id/spends resolves an agent by handle', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  await seedSpend(permId, agentId, { amount: 8, at: '2026-08-01T00:00:00.000Z' });

  const db = await getDb();
  const row = await db.execute({ sql: 'SELECT handle FROM agents WHERE id = ?', args: [agentId] });
  const handle = row.rows[0].handle;

  const r = await req('GET', `/api/agents/${handle}/spends`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.handle, handle);
  assert.deepStrictEqual(r.body.spends.map((s) => s.amount), [8]);
});

test('GET /api/agents/:id/spends 404s for an unknown agent', async () => {
  const r = await req('GET', '/api/agents/no-such-agent/spends');
  assert.strictEqual(r.status, 404);
});

test('GET /api/agents/:id/spend-summary returns the rollup over HTTP', async () => {
  const agentId = await seedAgent();
  const compute = await seedPermission(agentId, { category: 'compute' });
  const data = await seedPermission(agentId, { category: 'data' });
  await seedSpend(compute, agentId, { amount: 70, payee: 'gpu-co', at: '2026-08-02T00:00:00.000Z' });
  await seedSpend(data, agentId, { amount: 30, payee: 'feed-co', at: '2026-08-03T00:00:00.000Z' });

  const r = await req('GET', `/api/agents/${agentId}/spend-summary`);
  assert.strictEqual(r.status, 200);
  const s = r.body.summary;
  assert.strictEqual(s.total, 100);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.by_permission.length, 2);
  assert.deepStrictEqual(
    s.by_category.map((c) => c.category).sort(),
    ['compute', 'data']
  );
  assert.deepStrictEqual(s.by_payee.map((p) => p.payee), ['gpu-co', 'feed-co']);
  assert.ok(s.handle, 'the summary names the agent it describes');
});

test('GET /api/agents/:id/spend-summary honours a window and 400s on a bad one', async () => {
  const agentId = await seedAgent();
  const permId = await seedPermission(agentId);
  await seedSpend(permId, agentId, { amount: 15, at: '2026-08-10T00:00:00.000Z' });
  await seedSpend(permId, agentId, { amount: 25, at: '2026-09-10T00:00:00.000Z' });

  const r = await req(
    'GET',
    `/api/agents/${agentId}/spend-summary?since=2026-08-01&until=2026-09-01`
  );
  assert.strictEqual(r.body.summary.total, 15);

  const bad = await req('GET', `/api/agents/${agentId}/spend-summary?until=soon`);
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /until/);
});

test('GET /api/agents/:id/spend-summary 404s for an unknown agent', async () => {
  const r = await req('GET', '/api/agents/no-such-agent/spend-summary');
  assert.strictEqual(r.status, 404);
});

test('GET /api/meta advertises the reporting surface', async () => {
  const r = await req('GET', '/api/meta');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.spend_reporting, true);
  assert.strictEqual(r.body.agent_spends_endpoint, '/api/agents/:id/spends');
  assert.strictEqual(r.body.spend_summary_endpoint, '/api/agents/:id/spend-summary');
  assert.deepStrictEqual(r.body.spend_history_filters, [
    'since',
    'until',
    'payee',
    'idempotency_key',
  ]);
  assert.strictEqual(r.body.max_spend_page, spendService.MAX_SPEND_PAGE);
});
