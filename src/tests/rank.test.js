'use strict';

// Tests for the live leaderboard rank feature:
//   - agentService.getRank (service logic + demo exclusion)
//   - GET /api/agents/:id/rank (HTTP)
//   - renderRankBadgeSvg + GET /a/:handle/rank.svg (embeddable badge)
//
// Uses an in-memory DB. Agents are inserted directly with fixed scores so the
// ordering is deterministic and we don't depend on the attestation pipeline.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const { getDb } = require('../db');
const agentService = require('../services/agentService');
const { renderRankBadgeSvg } = require('../services/shareCard');
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

// Insert an agent straight into the DB with an explicit score/tier so rank
// ordering is fully under our control (no attestation math involved).
async function insertAgent({ handle, wallet, score, tier = 0, created_at, operator = 'Fixture Labs' }) {
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
  // Seed a small, fully-ordered leaderboard:
  //   #1 alpha   score 900  (oldest)
  //   #2 bravo   score 500
  //   #3 charlie score 500  (same score, newer -> ranks below bravo)
  //   #4 delta   score 100
  // Plus a demo agent that must NOT be counted or ranked.
  await insertAgent({
    handle: 'boardalpha',
    wallet: '0xa000000000000000000000000000000000000001',
    score: 900,
    tier: 4,
    created_at: '2026-01-01T00:00:00.000Z',
  });
  await insertAgent({
    handle: 'boardbravo',
    wallet: '0xb000000000000000000000000000000000000002',
    score: 500,
    tier: 3,
    created_at: '2026-01-02T00:00:00.000Z',
  });
  await insertAgent({
    handle: 'boardcharlie',
    wallet: '0xc000000000000000000000000000000000000003',
    score: 500,
    tier: 3,
    created_at: '2026-01-03T00:00:00.000Z',
  });
  await insertAgent({
    handle: 'boarddelta',
    wallet: '0xd000000000000000000000000000000000000004',
    score: 100,
    tier: 1,
    created_at: '2026-01-04T00:00:00.000Z',
  });
  await insertAgent({
    handle: 'demo-ghost',
    wallet: '0xe000000000000000000000000000000000000005',
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

test('getRank places the top-scoring agent at #1', async () => {
  const r = await agentService.getRank('boardalpha');
  assert.equal(r.rank, 1);
  assert.equal(r.total, 4); // demo agent excluded
  assert.equal(r.percentile, 25); // 1/4 -> top 25%
  assert.equal(r.tier, 4);
  assert.equal(r.label, 'PRIME');
});

test('getRank breaks score ties by earlier created_at', async () => {
  const bravo = await agentService.getRank('boardbravo');
  const charlie = await agentService.getRank('boardcharlie');
  // Same score (500) but bravo is older -> bravo ranks above charlie.
  assert.equal(bravo.rank, 2);
  assert.equal(charlie.rank, 3);
});

test('getRank ranks the lowest agent last', async () => {
  const r = await agentService.getRank('boarddelta');
  assert.equal(r.rank, 4);
  assert.equal(r.total, 4);
  assert.equal(r.percentile, 100); // 4/4 -> top 100%
});

test('getRank excludes demo/test agents from the ranked universe', async () => {
  // The demo agent has the highest score but no public standing.
  const r = await agentService.getRank('demo-ghost');
  assert.equal(r, null);
});

test('getRank returns null for an unknown agent', async () => {
  const r = await agentService.getRank('nope-not-here');
  assert.equal(r, null);
});

// ---- HTTP route ----------------------------------------------------------

test('GET /api/agents/:id/rank returns a live position', async () => {
  const res = await get('/api/agents/boardbravo/rank');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ranked, true);
  assert.equal(body.rank, 2);
  assert.equal(body.total, 4);
  assert.equal(body.handle, 'boardbravo');
});

test('GET /api/agents/:id/rank reports demo agents as unranked', async () => {
  const res = await get('/api/agents/demo-ghost/rank');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ranked, false);
  assert.equal(body.rank, null);
});

test('GET /api/agents/:id/rank 404s for an unknown agent', async () => {
  const res = await get('/api/agents/nope-not-here/rank');
  assert.equal(res.status, 404);
});

// ---- badge renderer + route ---------------------------------------------

test('renderRankBadgeSvg shows "#rank of total" for a ranked agent', () => {
  const svg = renderRankBadgeSvg({ rank: 3, total: 142, tier: 3 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /#3 of 142/);
  assert.match(svg, /kairune rank/);
  assert.match(svg, /#D7FF3F/); // TRUSTED tier colour
  assert.match(svg, /height="20"/);
});

test('renderRankBadgeSvg shows "unranked" when there is no position', () => {
  const svg = renderRankBadgeSvg({ rank: 0, total: 0, tier: 0 });
  assert.match(svg, /unranked/);
  assert.match(svg, /#6B7076/); // muted UNRATED colour
});

test('GET /a/:handle/rank.svg returns an SVG badge with the live rank', async () => {
  const res = await get('/a/boardalpha/rank.svg');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/svg\+xml/);
  assert.match(res.body, /#1 of 4/);
  // Hotlinked cross-origin from READMEs, so CORS must be open.
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('GET /a/:handle/rank.svg renders "unranked" for an unknown handle', async () => {
  const res = await get('/a/does-not-exist/rank.svg');
  assert.equal(res.status, 200);
  assert.match(res.body, /unranked/);
});
