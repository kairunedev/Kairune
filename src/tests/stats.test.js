'use strict';

// Tests for agentService.getStats — the public stats must apply the SAME
// demo/test exclusion as the leaderboard so the headline numbers match what
// visitors actually see. Uses an in-memory DB.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { getDb, closeDb } = require('../db');
const agentService = require('../services/agentService');

after(() => closeDb());

// Insert an agent row directly with an explicit score/tier so we can control
// exactly what counts. Returns the agent id.
async function insertAgent({ handle, wallet, operator = null, score = 500, tier = 2, status = 'active' }) {
  const db = await getDb();
  const ts = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, handle, wallet, operator, status, score, tier, ts, ts],
  });
  return id;
}

test('getStats excludes demo/test/junk agents by default and matches the leaderboard', async () => {
  // 3 real agents. Handles deliberately avoid every synthetic-fixture prefix
  // (including 'real-', which is itself one of our test conventions).
  await insertAgent({ handle: 'northwind', wallet: '0xaaaa000000', score: 900, tier: 4 });
  await insertAgent({ handle: 'meshworks', wallet: '0xbbbb000000', score: 500, tier: 2 });
  await insertAgent({ handle: 'driftless', wallet: '0xcccc000000', score: 100, tier: 0 });

  // Junk that must be excluded: sdk-test handle, try- handle, demo-loop op,
  // 0x0000 wallet, and a non-0x (non-EVM) wallet.
  await insertAgent({ handle: 'sdk-test-999', wallet: '0xffff000000', score: 120, tier: 0 });
  await insertAgent({ handle: 'try-abcde', wallet: '0xdddd000000', operator: 'demo-loop', score: 120, tier: 0 });
  await insertAgent({ handle: 'zerowallet', wallet: '0x0000000012', score: 120, tier: 0 });
  await insertAgent({ handle: 'nonevm', wallet: 'solanaAddrXYZ', score: 120, tier: 0 });

  const stats = await agentService.getStats();
  const leaderboard = await agentService.listAgents({ limit: 200 });

  // Only the 3 real agents count.
  assert.strictEqual(stats.total_agents, 3, 'stats count must match real agents');
  assert.strictEqual(
    stats.total_agents,
    leaderboard.length,
    'stats total must equal leaderboard length'
  );

  // avg of 900, 500, 100 = 500.
  assert.strictEqual(stats.avg_score, 500);

  // Tier distribution only covers the 3 real agents.
  const distTiers = stats.tier_distribution.map((r) => r.tier).sort();
  assert.deepStrictEqual(distTiers, [0, 2, 4]);
});

test('DEMO_EXCLUSION_SQL stays well under Turso expression-depth limit', async () => {
  // Turso rejects expressions deeper than 100 with SQLITE_UNKNOWN
  // "Expression tree is too large". Local libsql does not enforce this, so a
  // flat `a OR b OR c OR ...` chain passes every test and then 500s in
  // production. getStats nests this predicate inside up to three levels of
  // subquery, so the predicate itself must stay shallow.
  let depth = 0;
  let max = 0;
  for (const ch of agentService.DEMO_EXCLUSION_SQL) {
    if (ch === '(') max = Math.max(max, ++depth);
    else if (ch === ')') depth -= 1;
  }
  assert.strictEqual(depth, 0, 'parentheses must balance');
  assert.ok(max <= 20, `predicate nesting depth ${max} leaves no room for subqueries`);
});

test('getStats with includeDemo=true counts everything', async () => {
  const all = await agentService.getStats({ includeDemo: true });
  const real = await agentService.getStats();
  assert.ok(all.total_agents > real.total_agents, 'includeDemo counts more');
});

test('CI fixture handles and automation operators are excluded from public stats', async () => {
  const before = (await agentService.getStats()).total_agents;

  // Handles minted by our own suites and probe scripts. Every one of these
  // shapes was found sitting on the public leaderboard at score 1000.
  const fixtureHandles = [
    'extbot-31626', 'doc-payer-10233', 'gpu-vendor-10233', 'dbg-3233',
    'vf-payer-txo6cx', 'pb-payer-xll6qh', 'sc-alpha', 'ex-bravo',
    'cmp-a', 'rc-a', 'nb-a', 'tp-a', 'ns-a', 'rank-a', 'payee-a',
    'spend-a', 'div-diverse', 'wal-a', 'dup-01', 'kind-01', 'susp-01',
    'quicktest-01', 'auth-agent', 'badsig-agent', 'replay-agent',
  ];
  for (const [i, handle] of fixtureHandles.entries()) {
    await insertAgent({
      handle,
      wallet: `0xfix${String(i).padStart(7, '0')}`,
      score: 1000,
      tier: 4,
    });
  }

  // Automation operators, regardless of how innocuous the handle looks.
  const autoOps = [
    'CI', 'ci ', 'probe', 'smoke', 'live-check', 'verify-script',
    'debug-check', 'yapping-test', 'external-tester',
  ];
  for (const [i, operator] of autoOps.entries()) {
    await insertAgent({
      handle: `plausible${i}`,
      wallet: `0xop${String(i).padStart(8, '0')}`,
      operator,
      score: 1000,
      tier: 4,
    });
  }

  const after = await agentService.getStats();
  assert.strictEqual(
    after.total_agents,
    before,
    'no CI fixture or automation-operated agent may reach public stats'
  );

  // And none of them may appear on the leaderboard either — the two surfaces
  // must never disagree.
  const board = await agentService.listAgents({ limit: 500 });
  const leaked = board
    .map((a) => a.handle)
    .filter((h) => fixtureHandles.includes(h) || h.startsWith('plausible'));
  assert.deepStrictEqual(leaked, [], 'leaderboard leaked synthetic agents');
});

test('getOrganicStats publishes the synthetic/organic split and sums correctly', async () => {
  const s = await agentService.getOrganicStats();

  assert.strictEqual(
    s.organic.total_agents + s.synthetic.agents,
    s.total.agents,
    'organic + synthetic must equal the full row count'
  );
  assert.ok(s.synthetic.agents > 0, 'fixtures inserted above must be counted as synthetic');
  assert.ok(s.organic_ratio >= 0 && s.organic_ratio <= 1, 'ratio is a fraction');
  assert.ok(Array.isArray(s.operators), 'operators breakdown is present');

  // 'CI' and 'ci ' were inserted as distinct raw strings; the breakdown groups
  // on the trimmed/lower-cased value, so they must collapse into one bucket.
  const ciBuckets = s.operators.filter((o) => o.operator === 'ci');
  assert.strictEqual(ciBuckets.length, 1, 'CI variants must collapse to one bucket');
  assert.strictEqual(ciBuckets[0].c, 2, 'both CI variants land in that bucket');
});

test('createAgent trims the operator so casing/whitespace variants group together', async () => {
  const a = await agentService.createAgent({
    handle: 'optrim-one',
    wallet: '0x1111111111111111111111111111111111111111',
    operator: '  Skybridge  ',
  });
  assert.strictEqual(a.operator, 'Skybridge', 'operator is trimmed, case preserved');

  const b = await agentService.createAgent({
    handle: 'optrim-two',
    wallet: '0x2222222222222222222222222222222222222222',
    operator: '   ',
  });
  assert.strictEqual(b.operator, null, 'whitespace-only operator becomes null');
});
