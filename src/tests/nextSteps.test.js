'use strict';

// Tests for the next-steps / tier-planner feature:
//   - tierPlanner.planNextTier (pure simulation over a supplied history)
//   - agentService.getNextSteps (loads real attestation rows, then plans)
//   - GET /api/agents/:id/next-steps (HTTP)
//
// The planner works by re-running the REAL scoring engine over the agent's real
// history plus hypothetical events, so these tests assert two different classes
// of property:
//
//   1. Structural invariants that must hold for any weights (verified needs
//      fewer events than unverified; heavier kinds need fewer events; paths are
//      sorted cheapest-first; the projection actually reaches the target).
//   2. A couple of exact values, to catch silent drift in the simulation.
//
// A FIXED clock is passed everywhere so recency decay is deterministic.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const { getDb } = require('../db');
const agentService = require('../services/agentService');
const tierPlanner = require('../services/tierPlanner');
const { computeScore, TIER_THRESHOLDS, KIND_WEIGHTS } = require('../services/trustScore');
const app = require('../../server');

let server;
let base;

// Fixed clock for every simulation in this file.
const NOW = Date.parse('2026-08-02T00:00:00.000Z');

function get(path) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          body: data,
          json: () => JSON.parse(data),
        })
      );
    });
    r.on('error', reject);
    r.end();
  });
}

/** Attestation row shaped like the DB projection computeScore reads. */
function att(kind, status, issuerId, daysAgo = 0) {
  return {
    kind,
    created_at: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    verification_status: status,
    issuer_id: status === 'verified' ? issuerId : null,
  };
}

/**
 * History for an agent sitting mid-ESTABLISHED: 20 peer vouches across 5
 * issuers and 25 clean payments across 4 issuers, all a couple of weeks old.
 * Verified live score for this set is 667 (tier 2).
 */
function establishedHistory() {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(att('peer_vouch', 'verified', `iss-${i % 5}`, 5));
  for (let i = 0; i < 25; i++) rows.push(att('clean_payment', 'verified', `iss-${i % 4}`, 15));
  return rows;
}

async function insertAgent({ handle, wallet, score, tier, operator = 'CI' }) {
  const db = await getDb();
  const id = crypto.randomUUID();
  const ts = '2026-01-01T00:00:00.000Z';
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    args: [id, handle, wallet, operator, score, tier, ts, ts],
  });
  return id;
}

async function insertAttestation(agentId, row) {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO attestations
            (id, agent_id, kind, weight, amount, note, verification_status, issuer_id, created_at)
          VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      agentId,
      row.kind,
      KIND_WEIGHTS[row.kind],
      row.verification_status,
      row.issuer_id,
      row.created_at,
    ],
  });
}

before(async () => {
  // ns-established: real attestation rows in the DB, stored score kept in sync
  // with what computeScore produces for that history at NOW.
  const history = establishedHistory();
  const live = computeScore(history, NOW);
  const establishedId = await insertAgent({
    handle: 'ns-established',
    wallet: '0xc100000000000000000000000000000000000031',
    score: live.score,
    tier: live.tier,
  });
  for (const row of history) await insertAttestation(establishedId, row);

  // ns-prime: top tier, no next tier to plan for.
  await insertAgent({
    handle: 'ns-prime',
    wallet: '0xc200000000000000000000000000000000000032',
    score: 950,
    tier: 4,
  });

  // ns-fresh: no attestations at all, tier 0.
  await insertAgent({
    handle: 'ns-fresh',
    wallet: '0xc300000000000000000000000000000000000033',
    score: 0,
    tier: 0,
  });

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

// ---------------------------------------------------------------------------
// planNextTier — structural invariants
// ---------------------------------------------------------------------------

test('verified paths always need fewer events than unverified ones', () => {
  const history = establishedHistory();
  const live = computeScore(history, NOW);
  const plan = tierPlanner.planNextTier(
    { handle: 'p', score: live.score, tier: live.tier },
    history,
    NOW
  );

  assert.ok(plan.paths.length > 0, 'expected at least one path');
  for (const p of plan.paths) {
    assert.ok(p.verified_events !== null, `${p.kind} should be reachable`);
    assert.ok(p.unverified_events !== null, `${p.kind} unverified should be reachable`);
    // Unverified attestations are discounted to 25%, so they can never be the
    // cheaper route for the same kind.
    assert.ok(
      p.unverified_events > p.verified_events,
      `${p.kind}: unverified (${p.unverified_events}) should exceed verified (${p.verified_events})`
    );
  }
});

test('paths are sorted cheapest-first and fastest matches paths[0]', () => {
  const history = establishedHistory();
  const live = computeScore(history, NOW);
  const plan = tierPlanner.planNextTier(
    { handle: 'p', score: live.score, tier: live.tier },
    history,
    NOW
  );

  for (let i = 1; i < plan.paths.length; i++) {
    assert.ok(
      plan.paths[i - 1].verified_events <= plan.paths[i].verified_events,
      'paths must be ordered by ascending verified_events'
    );
  }
  assert.strictEqual(plan.fastest.kind, plan.paths[0].kind);
  assert.strictEqual(plan.fastest.verified_events_needed, plan.paths[0].verified_events);
  // Heaviest positive kind (peer_vouch, +14) is the cheapest route here.
  assert.strictEqual(plan.fastest.kind, 'peer_vouch');
});

test('the projected score for each path actually reaches the target', () => {
  const history = establishedHistory();
  const live = computeScore(history, NOW);
  const plan = tierPlanner.planNextTier(
    { handle: 'p', score: live.score, tier: live.tier },
    history,
    NOW
  );

  for (const p of plan.paths) {
    assert.ok(
      p.projected_score >= plan.target_score,
      `${p.kind}: projected ${p.projected_score} must reach target ${plan.target_score}`
    );
  }
});

test('the simulated count is minimal — one event fewer misses the target', () => {
  const history = establishedHistory();
  const live = computeScore(history, NOW);
  const plan = tierPlanner.planNextTier(
    { handle: 'p', score: live.score, tier: live.tier },
    history,
    NOW
  );

  const fastest = plan.paths[0];
  const oneFewer = [];
  for (let i = 0; i < fastest.verified_events - 1; i++) {
    oneFewer.push(att(fastest.kind, 'verified', `__probe__${i}`, 0));
  }
  const short = computeScore([...history, ...oneFewer], NOW);
  assert.ok(
    short.score < plan.target_score,
    `${fastest.verified_events - 1} events should NOT reach ${plan.target_score}, got ${short.score}`
  );
});

test('exact values for the established fixture (guards simulation drift)', () => {
  const history = establishedHistory();
  const live = computeScore(history, NOW);
  assert.strictEqual(live.score, 667);
  assert.strictEqual(live.tier, 2);

  const plan = tierPlanner.planNextTier(
    { handle: 'p', score: live.score, tier: live.tier },
    history,
    NOW
  );

  assert.strictEqual(plan.target_score, 750);
  assert.strictEqual(plan.points_to_next, 83);
  assert.strictEqual(plan.tier_floor, 500);
  assert.strictEqual(plan.fastest.verified_events_needed, 6);
  assert.strictEqual(plan.fastest.unverified_events_needed, 21);
});

// ---------------------------------------------------------------------------
// planNextTier — risks
// ---------------------------------------------------------------------------

test('heavier negative kinds need fewer events to cost the tier', () => {
  const history = establishedHistory();
  const live = computeScore(history, NOW);
  const plan = tierPlanner.planNextTier(
    { handle: 'p', score: live.score, tier: live.tier },
    history,
    NOW
  );

  const byKind = new Map(plan.risks.map((r) => [r.kind, r]));
  const dispute = byKind.get('dispute');
  const chargeback = byKind.get('chargeback');
  const anomaly = byKind.get('anomaly_flag');

  for (const r of [dispute, chargeback, anomaly]) {
    assert.ok(r.events_to_lose_tier > 0, `${r.kind} should have a finite risk count`);
    // Falling out of the tier means landing below its floor.
    assert.ok(
      r.projected_score < plan.tier_floor,
      `${r.kind}: projected ${r.projected_score} must be below floor ${plan.tier_floor}`
    );
  }

  // -90 is heavier than -70 is heavier than -40, so the counts must be ordered
  // the other way around.
  assert.ok(anomaly.events_to_lose_tier <= chargeback.events_to_lose_tier);
  assert.ok(chargeback.events_to_lose_tier <= dispute.events_to_lose_tier);
});

test('tier 0 cannot be lost, so risks report null', () => {
  const plan = tierPlanner.planNextTier(
    { handle: 'fresh', score: 0, tier: 0 },
    [],
    NOW
  );
  assert.strictEqual(plan.tier_floor, 0);
  for (const r of plan.risks) {
    assert.strictEqual(r.events_to_lose_tier, null, `${r.kind} should be null at tier 0`);
  }
});

// ---------------------------------------------------------------------------
// planNextTier — top tier & edge cases
// ---------------------------------------------------------------------------

test('PRIME has no paths but still reports risks', () => {
  const history = establishedHistory();
  const plan = tierPlanner.planNextTier(
    { handle: 'prime', score: 950, tier: 4 },
    history,
    NOW
  );

  assert.strictEqual(plan.at_top_tier, true);
  assert.strictEqual(plan.next_tier, null);
  assert.strictEqual(plan.next_label, null);
  assert.strictEqual(plan.target_score, null);
  assert.strictEqual(plan.points_to_next, 0);
  assert.strictEqual(plan.paths.length, 0);
  assert.strictEqual(plan.fastest, null);
  // The top tier has the most to lose, so risks must still be computed.
  assert.strictEqual(plan.tier_floor, TIER_THRESHOLDS[4]);
  assert.ok(plan.risks.some((r) => r.events_to_lose_tier > 0));
});

test('an empty history still yields a usable plan', () => {
  const plan = tierPlanner.planNextTier({ handle: 'fresh', score: 0, tier: 0 }, [], NOW);
  assert.strictEqual(plan.attestations_considered, 0);
  assert.strictEqual(plan.target_score, 250);
  assert.ok(plan.fastest.verified_events_needed > 0);
  // Every positive kind is represented as a route.
  assert.strictEqual(plan.paths.length, tierPlanner.POSITIVE_KINDS.length);
});

test('stored/live score divergence is reported as stale', () => {
  const history = establishedHistory();
  // Deliberately pass a stored score that does not match the history.
  const plan = tierPlanner.planNextTier(
    { handle: 'p', score: 300, tier: 1 },
    history,
    NOW
  );
  assert.strictEqual(plan.score, 300, 'plan anchors to the stored score');
  assert.strictEqual(plan.live_score, 667, 'live score recomputed from history');
  assert.strictEqual(plan.score_is_stale, true);
});

// ---------------------------------------------------------------------------
// agentService.getNextSteps
// ---------------------------------------------------------------------------

test('getNextSteps loads the agent history and plans from it', async () => {
  const plan = await agentService.getNextSteps('ns-established', { nowMs: NOW });
  assert.ok(plan);
  assert.strictEqual(plan.handle, 'ns-established');
  assert.strictEqual(plan.attestations_considered, 45);
  assert.strictEqual(plan.score_is_stale, false, 'stored score should match history');
  assert.strictEqual(plan.fastest.kind, 'peer_vouch');
  assert.strictEqual(plan.fastest.verified_events_needed, 6);
});

test('getNextSteps returns null for an unknown agent', async () => {
  assert.strictEqual(await agentService.getNextSteps('ns-nope'), null);
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test('GET /api/agents/:id/next-steps returns the full plan', async () => {
  const res = await get('/agents/ns-established/next-steps');
  assert.strictEqual(res.status, 200);
  const body = res.json();

  assert.strictEqual(body.handle, 'ns-established');
  assert.strictEqual(body.label, 'ESTABLISHED');
  assert.strictEqual(body.next_label, 'TRUSTED');
  assert.strictEqual(body.target_score, 750);
  assert.strictEqual(body.at_top_tier, false);
  assert.ok(Array.isArray(body.paths) && body.paths.length > 0);
  assert.ok(Array.isArray(body.risks) && body.risks.length > 0);

  const path = body.paths[0];
  for (const key of ['kind', 'weight', 'verified_events', 'unverified_events', 'projected_score']) {
    assert.ok(key in path, `path should expose ${key}`);
  }
  const risk = body.risks[0];
  for (const key of ['kind', 'weight', 'events_to_lose_tier', 'projected_score']) {
    assert.ok(key in risk, `risk should expose ${key}`);
  }
});

test('GET /api/agents/:id/next-steps on a PRIME agent has no paths', async () => {
  const res = await get('/agents/ns-prime/next-steps');
  assert.strictEqual(res.status, 200);
  const body = res.json();
  assert.strictEqual(body.at_top_tier, true);
  assert.strictEqual(body.next_tier, null);
  assert.strictEqual(body.paths.length, 0);
  assert.strictEqual(body.fastest, null);
});

test('GET /api/agents/:id/next-steps 404s for an unknown agent', async () => {
  const res = await get('/agents/ns-does-not-exist/next-steps');
  assert.strictEqual(res.status, 404);
});

test('/api/meta advertises the next-steps endpoint', async () => {
  const res = await get('/meta');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json().next_steps_endpoint, '/api/agents/:id/next-steps');
});
