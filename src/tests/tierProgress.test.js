'use strict';

// Tests for the tier-progress feature:
//   - agentService.getTierProgress (points-to-next + progress through band)
//   - GET /api/agents/:id/tier (HTTP)
//
// Tier thresholds are [0, 250, 500, 750, 900]. We seed agents at scores placed
// deliberately inside each band so the arithmetic is easy to verify by hand.
// Unlike rank, tier progress is well-defined for EVERY agent (it needs no
// cross-agent comparison), including demo agents, so we assert that too.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const { getDb } = require('../db');
const agentService = require('../services/agentService');
const app = require('../../server');

let server;
let base;

function get(path) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          json: () => JSON.parse(data),
        })
      );
    });
    r.on('error', reject);
    r.end();
  });
}

async function insertAgent({ handle, wallet, score, tier, created_at, operator = 'CI' }) {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    args: [id, handle, wallet, operator, score, tier, created_at, created_at],
  });
  return id;
}

before(async () => {
  // tp-mid:   score 375, tier 1 (EMERGING band 250..500) -> exactly halfway
  // tp-floor: score 500, tier 2 (ESTABLISHED band 500..750) -> 0% (on floor)
  // tp-prime: score 950, tier 4 (PRIME, open band 900..1000) -> no next tier
  // tp-zero:  score 0,   tier 0 (UNRATED band 0..250) -> 0%
  // tp-demo:  score 375, tier 1, but a demo agent (still valid tier progress)
  await insertAgent({
    handle: 'tp-mid',
    wallet: '0xa100000000000000000000000000000000000021',
    score: 375,
    tier: 1,
    created_at: '2026-01-01T00:00:00.000Z',
  });
  await insertAgent({
    handle: 'tp-floor',
    wallet: '0xb100000000000000000000000000000000000022',
    score: 500,
    tier: 2,
    created_at: '2026-01-02T00:00:00.000Z',
  });
  await insertAgent({
    handle: 'tp-prime',
    wallet: '0xc100000000000000000000000000000000000023',
    score: 950,
    tier: 4,
    created_at: '2026-01-03T00:00:00.000Z',
  });
  await insertAgent({
    handle: 'tp-zero',
    wallet: '0xd100000000000000000000000000000000000024',
    score: 0,
    tier: 0,
    created_at: '2026-01-04T00:00:00.000Z',
  });
  await insertAgent({
    handle: 'tp-demo',
    wallet: '0xe100000000000000000000000000000000000025',
    score: 375,
    tier: 1,
    created_at: '2026-01-05T00:00:00.000Z',
    operator: 'demo-loop',
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ---- service logic -------------------------------------------------------

test('getTierProgress reports next threshold, points-to-next and mid-band progress', async () => {
  const t = await agentService.getTierProgress('tp-mid');
  assert.equal(t.tier, 1);
  assert.equal(t.label, 'EMERGING');
  assert.equal(t.tier_floor, 250);
  assert.equal(t.next_tier, 2);
  assert.equal(t.next_label, 'ESTABLISHED');
  assert.equal(t.next_threshold, 500);
  assert.equal(t.points_to_next, 125); // 500 - 375
  assert.equal(t.progress, 50); // (375-250)/(500-250) = 50%
});

test('getTierProgress reads 0% when the score sits exactly on the tier floor', async () => {
  const t = await agentService.getTierProgress('tp-floor');
  assert.equal(t.tier, 2);
  assert.equal(t.tier_floor, 500);
  assert.equal(t.next_threshold, 750);
  assert.equal(t.points_to_next, 250); // 750 - 500
  assert.equal(t.progress, 0);
});

test('getTierProgress has no next tier at PRIME and measures against MAX_SCORE', async () => {
  const t = await agentService.getTierProgress('tp-prime');
  assert.equal(t.tier, 4);
  assert.equal(t.label, 'PRIME');
  assert.equal(t.next_tier, null);
  assert.equal(t.next_label, null);
  assert.equal(t.next_threshold, null);
  assert.equal(t.points_to_next, 0);
  // open band 900..1000, score 950 -> halfway
  assert.equal(t.progress, 50);
});

test('getTierProgress reports 0% at the very bottom (UNRATED, score 0)', async () => {
  const t = await agentService.getTierProgress('tp-zero');
  assert.equal(t.tier, 0);
  assert.equal(t.label, 'UNRATED');
  assert.equal(t.tier_floor, 0);
  assert.equal(t.next_threshold, 250);
  assert.equal(t.points_to_next, 250);
  assert.equal(t.progress, 0);
});

test('getTierProgress is defined for demo agents too (no cross-agent comparison)', async () => {
  const t = await agentService.getTierProgress('tp-demo');
  assert.equal(t.tier, 1);
  assert.equal(t.points_to_next, 125);
  assert.equal(t.progress, 50);
});

test('getTierProgress returns null for an unknown agent', async () => {
  const t = await agentService.getTierProgress('tp-nope-nobody');
  assert.equal(t, null);
});

// ---- HTTP ----------------------------------------------------------------

test('GET /api/agents/:id/tier returns the progress payload', async () => {
  const res = await get('/api/agents/tp-mid/tier');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.handle, 'tp-mid');
  assert.equal(body.tier, 1);
  assert.equal(body.next_threshold, 500);
  assert.equal(body.points_to_next, 125);
  assert.equal(body.progress, 50);
});

test('GET /api/agents/:id/tier works for a PRIME agent (no next tier)', async () => {
  const res = await get('/api/agents/tp-prime/tier');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.tier, 4);
  assert.equal(body.next_tier, null);
  assert.equal(body.points_to_next, 0);
});

test('GET /api/agents/:id/tier returns 404 for an unknown agent', async () => {
  const res = await get('/api/agents/tp-nope-nobody/tier');
  assert.equal(res.status, 404);
});
