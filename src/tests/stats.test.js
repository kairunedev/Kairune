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
  // 3 real agents.
  await insertAgent({ handle: 'real-alpha', wallet: '0xaaaa000000', score: 900, tier: 4 });
  await insertAgent({ handle: 'real-bravo', wallet: '0xbbbb000000', score: 500, tier: 2 });
  await insertAgent({ handle: 'real-charlie', wallet: '0xcccc000000', score: 100, tier: 0 });

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

test('getStats with includeDemo=true counts everything', async () => {
  const all = await agentService.getStats({ includeDemo: true });
  const real = await agentService.getStats();
  assert.ok(all.total_agents > real.total_agents, 'includeDemo counts more');
});
