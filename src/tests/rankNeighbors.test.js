'use strict';

// Tests for the rank-neighbours feature:
//   - agentService.getRankNeighbors (who's above / below me + score gaps)
//   - GET /api/agents/:id/rank/neighbors (HTTP)
//
// Uses an in-memory DB with agents inserted at fixed scores so the ordering is
// deterministic and independent of the attestation pipeline.

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

async function insertAgent({ handle, wallet, score, tier = 0, created_at, operator = 'CI' }) {
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
  // Fully-ordered leaderboard:
  //   #1 nb-alpha   score 900
  //   #2 nb-bravo   score 500
  //   #3 nb-charlie score 500 (same score, newer -> below bravo)
  //   #4 nb-delta   score 100
  // Plus a demo agent that must never appear as anyone's neighbour.
  await insertAgent({
    handle: 'nb-alpha',
    wallet: '0xa000000000000000000000000000000000000011',
    score: 900,
    tier: 4,
    created_at: '2026-01-01T00:00:00.000Z',
  });
  await insertAgent({
    handle: 'nb-bravo',
    wallet: '0xb000000000000000000000000000000000000012',
    score: 500,
    tier: 3,
    created_at: '2026-01-02T00:00:00.000Z',
  });
  await insertAgent({
    handle: 'nb-charlie',
    wallet: '0xc000000000000000000000000000000000000013',
    score: 500,
    tier: 3,
    created_at: '2026-01-03T00:00:00.000Z',
  });
  await insertAgent({
    handle: 'nb-delta',
    wallet: '0xd000000000000000000000000000000000000014',
    score: 100,
    tier: 1,
    created_at: '2026-01-04T00:00:00.000Z',
  });
  await insertAgent({
    handle: 'nb-demo',
    wallet: '0xe000000000000000000000000000000000000015',
    score: 999,
    tier: 4,
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

test('getRankNeighbors returns above/below with correct score gaps (middle)', async () => {
  const n = await agentService.getRankNeighbors('nb-bravo');
  assert.equal(n.self.rank, 2);
  // above = the #1 agent we are chasing
  assert.equal(n.above.handle, 'nb-alpha');
  assert.equal(n.above.rank, 1);
  assert.equal(n.gap_above, 400); // 900 - 500
  // below = the #3 agent chasing us (same score, tie broken by created_at)
  assert.equal(n.below.handle, 'nb-charlie');
  assert.equal(n.below.rank, 3);
  assert.equal(n.gap_below, 0); // 500 - 500
});

test('getRankNeighbors has no above for the #1 agent', async () => {
  const n = await agentService.getRankNeighbors('nb-alpha');
  assert.equal(n.self.rank, 1);
  assert.equal(n.above, null);
  assert.equal(n.gap_above, null);
  assert.equal(n.below.handle, 'nb-bravo');
  assert.equal(n.gap_below, 400); // 900 - 500
});

test('getRankNeighbors has no below for the last agent', async () => {
  const n = await agentService.getRankNeighbors('nb-delta');
  assert.equal(n.self.rank, 4);
  assert.equal(n.below, null);
  assert.equal(n.gap_below, null);
  assert.equal(n.above.handle, 'nb-charlie');
  assert.equal(n.gap_above, 400); // 500 - 100
});

test('getRankNeighbors never surfaces a demo agent as a neighbour', async () => {
  // nb-demo has score 999 (higher than #1) but is excluded, so nb-alpha's
  // "above" must stay null rather than pointing at the demo agent.
  const n = await agentService.getRankNeighbors('nb-alpha');
  assert.equal(n.above, null);
});

test('getRankNeighbors returns null for a demo agent (no standing)', async () => {
  const n = await agentService.getRankNeighbors('nb-demo');
  assert.equal(n, null);
});

test('getRankNeighbors returns null for an unknown agent', async () => {
  const n = await agentService.getRankNeighbors('nope-not-here');
  assert.equal(n, null);
});

// ---- HTTP route ----------------------------------------------------------

test('GET /api/agents/:id/rank/neighbors returns above + below', async () => {
  const res = await get('/api/agents/nb-bravo/rank/neighbors');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ranked, true);
  assert.equal(body.self.rank, 2);
  assert.equal(body.above.handle, 'nb-alpha');
  assert.equal(body.below.handle, 'nb-charlie');
  assert.equal(body.gap_above, 400);
});

test('GET /api/agents/:id/rank/neighbors reports demo agents as unranked', async () => {
  const res = await get('/api/agents/nb-demo/rank/neighbors');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ranked, false);
  assert.equal(body.self, null);
});

test('GET /api/agents/:id/rank/neighbors 404s for an unknown agent', async () => {
  const res = await get('/api/agents/nope-not-here/rank/neighbors');
  assert.equal(res.status, 404);
});
