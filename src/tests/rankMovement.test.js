'use strict';

// Tests for the rank-movement feature:
//   - rank_history persistence via recalcAgent (agentService.recordRankChange)
//   - agentService.getRankHistory (an agent's own move log)
//   - agentService.getTopMovers   (the "who's climbing" feed)
//   - GET /api/agents/:id/rank/history and GET /api/movers (HTTP)
//   - renderMoveCardSvg + GET /a/:handle/move.svg | .png (shareable brag card)
//
// In-memory DB. To exercise a REAL rank move we drive the actual scoring
// pipeline: agents start with seeded attestations, then one agent is given
// enough verified events (from distinct issuers, to dodge the per-issuer cap)
// to leapfrog the others. recalcAgent notices the position change and writes a
// rank_history row — the same path production uses.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const { getDb } = require('../db');
const agentService = require('../services/agentService');
const attestationService = require('../services/attestationService');
const { renderMoveCardSvg } = require('../services/shareCard');
const app = require('../../server');

let server;
let base;

function req(method, path) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, { method }, (res) => {
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
const get = (p) => req('GET', p);

// Register a real agent through the service (so handle/wallet validation and
// normalisation match production) with no attestations yet. The wallet must be
// a plausible EVM address that does NOT trigger the demo exclusion, so it is
// NOT all-zeros-prefixed: we derive 40 hex chars from a keccak-ish digest.
async function makeAgent(handle, seed) {
  const hex = crypto.createHash('sha256').update(`kairune-fixture-${seed}`).digest('hex');
  const wallet = '0x' + hex.slice(0, 40);
  const a = await agentService.createAgent({ handle, wallet, operator: 'Fixture Labs' });
  return a.id;
}

// Give an agent N verified clean_payment events, each from a DISTINCT issuer so
// the per-issuer volume cap doesn't flatten them, then recalc. Verified events
// from distinct issuers also lift the corroboration ceiling, so the score can
// actually climb. Returns the fresh rank.
async function addVerified(agentId, n, sinceIssuer = 0) {
  for (let i = 0; i < n; i++) {
    await attestationService.addAttestation(agentId, {
      kind: 'clean_payment',
      verification_status: 'verified',
      issuer_id: `iss-${sinceIssuer + i}`,
      created_at: new Date().toISOString(),
    });
  }
  await agentService.recalcAgent(agentId);
  return agentService.getRank(agentId);
}

let climber, midA, midB, topDog;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // Build a ranked field. Each agent gets verified events from distinct issuer
  // pools so their scores are stable and well-separated.
  topDog = await makeAgent('rm-topdog', 11);
  midA = await makeAgent('rm-mida', 12);
  midB = await makeAgent('rm-midb', 13);
  climber = await makeAgent('rm-climber', 14);

  await addVerified(topDog, 10, 0);   // strongest
  await addVerified(midA, 6, 10);     // middle
  await addVerified(midB, 5, 20);     // just below midA
  await addVerified(climber, 2, 30);  // starts near the bottom

  // Now the climb: give the climber a large distinct-issuer boost so it moves
  // up past midB and midA. This is the move that must be recorded.
  await addVerified(climber, 12, 40);
});

after(() => server && server.close());

test('a real rank climb writes a rank_history row', async () => {
  const hist = await agentService.getRankHistory(climber, { limit: 10 });
  assert.ok(hist, 'history object returned');
  assert.equal(hist.handle, 'rm-climber');
  assert.ok(hist.moves.length >= 1, 'at least one move recorded');

  const latest = hist.moves[0];
  // A climb means the rank NUMBER went down.
  assert.equal(latest.direction, 'up', 'latest move is a climb');
  assert.ok(latest.rank < latest.previous_rank, 'rank number decreased');
  // delta is positions gained = previous - new, positive for a climb.
  assert.equal(latest.delta, latest.previous_rank - latest.rank);
  assert.ok(latest.delta > 0, 'delta is positive on a climb');
  assert.ok(latest.total >= 4, 'total reflects the ranked field');
  assert.ok(latest.at, 'timestamp present');
});

test('history is newest-first and bounded by ?limit', async () => {
  const hist = await agentService.getRankHistory(climber, { limit: 1 });
  assert.equal(hist.moves.length, 1, 'limit respected');
  // Newest first: the single returned move is the most recent by timestamp.
  const full = await agentService.getRankHistory(climber, { limit: 100 });
  if (full.moves.length > 1) {
    assert.ok(full.moves[0].at >= full.moves[1].at, 'ordered newest first');
  }
});

test('an agent that never moved has an empty move log', async () => {
  // topDog was seeded first and only ever gained score without changing its #1
  // position after the field settled, so it may have 0 or few moves — but a
  // brand-new agent with no recalcs definitely has none.
  const fresh = await makeAgent('rm-nevermoved', 99);
  const hist = await agentService.getRankHistory(fresh, { limit: 10 });
  assert.ok(hist, 'history returned for known agent');
  assert.deepEqual(hist.moves, [], 'no moves for an agent that never recalced');
});

test('getRankHistory returns null for an unknown agent', async () => {
  const hist = await agentService.getRankHistory('rm-does-not-exist', {});
  assert.equal(hist, null);
});

test('the climber shows up in the movers feed as an up-mover', async () => {
  const feed = await agentService.getTopMovers({ windowHours: 24, direction: 'up' });
  assert.ok(Array.isArray(feed.movers));
  assert.equal(feed.window_hours, 24);
  assert.equal(feed.direction, 'up');
  const mine = feed.movers.find((m) => m.handle === 'rm-climber');
  assert.ok(mine, 'climber present in up-movers');
  assert.equal(mine.direction, 'up');
  assert.ok(mine.net_delta > 0, 'net movement is positive');
  assert.ok(mine.to_rank < mine.from_rank, 'ended higher than it started');
});

test('direction=down excludes climbers', async () => {
  const down = await agentService.getTopMovers({ windowHours: 24, direction: 'down' });
  assert.ok(!down.movers.some((m) => m.handle === 'rm-climber'),
    'a climber must not appear in the down feed');
  assert.ok(down.movers.every((m) => m.net_delta < 0), 'all down-movers lost ground');
});

test('movers window and limit are clamped', async () => {
  const feed = await agentService.getTopMovers({ windowHours: 99999, limit: 999, direction: 'all' });
  assert.ok(feed.window_hours <= 24 * 30, 'window capped at 30 days');
  assert.ok(feed.movers.length <= 50, 'limit capped at 50');
});

test('GET /api/agents/:id/rank/history returns the move log', async () => {
  const res = await get('/api/agents/rm-climber/rank/history');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.handle, 'rm-climber');
  assert.ok(body.moves.length >= 1);
  assert.equal(body.moves[0].direction, 'up');
});

test('GET /api/agents/:id/rank/history 404s for unknown agent', async () => {
  const res = await get('/api/agents/rm-nope/rank/history');
  assert.equal(res.status, 404);
});

test('GET /api/movers returns climbers by default', async () => {
  const res = await get('/api/movers');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.direction, 'up');
  assert.ok(body.movers.some((m) => m.handle === 'rm-climber'));
});

test('GET /a/:handle/move.svg renders the latest move as a climb card', async () => {
  const res = await get('/a/rm-climber/move.svg');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/svg\+xml/);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(res.body, /CLIMBED THE LEADERBOARD/);
  assert.match(res.body, /rm-climber/);
  // The move arrow and a "+N places" delta must be present.
  assert.match(res.body, /→/);
  assert.match(res.body, /\+\d+ place/);
});

test('GET /a/:handle/move.png renders a PNG', async () => {
  const res = await req('GET', '/a/rm-climber/move.png');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/png/);
});

test('move card for an agent with no moves is honest, not a fake climb', async () => {
  const res = await get('/a/rm-nevermoved/move.svg');
  assert.equal(res.status, 200);
  // No fabricated climb: it must not claim CLIMBED, and shows the em-dash
  // placeholder ranks rather than invented numbers.
  assert.doesNotMatch(res.body, /CLIMBED THE LEADERBOARD/);
  assert.match(res.body, /HELD THE LEADERBOARD|—/);
});

test('renderMoveCardSvg is defensive with missing fields', () => {
  const svg = renderMoveCardSvg({ handle: 'x' });
  assert.match(svg, /<svg/);
  assert.match(svg, /HELD THE LEADERBOARD/); // neutral when no ranks given
  const climb = renderMoveCardSvg({ handle: 'y', from_rank: 12, to_rank: 4, total: 200, direction: 'up', delta: 8, score: 700, tier: 3, label: 'TRUSTED' });
  assert.match(climb, /CLIMBED THE LEADERBOARD/);
  assert.match(climb, /#12/);
  assert.match(climb, /#4/);
  assert.match(climb, /\+8 places/);
});

test('unknown handle move card does not throw', async () => {
  const res = await get('/a/rm-ghost-handle/move.svg');
  assert.equal(res.status, 200);
  assert.match(res.body, /<svg/);
});
