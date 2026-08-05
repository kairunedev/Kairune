'use strict';

// Tests for counterparty compare — the "which of these do I pay?" endpoint:
//   - agentService.compareCounterparties (ranking + winner selection)
//   - POST /api/counterparty/compare (HTTP contract + input validation)
//
// The ranking rule is fully specified (verdict, then score, then trust
// independence, then handle) so every assertion here is exact rather than
// approximate. A FIXED clock keeps the "recent negatives" window deterministic,
// which matters because one fixture leans on a 3-day-old chargeback.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const { getDb } = require('../db');
const agentService = require('../services/agentService');
const { KIND_WEIGHTS } = require('../services/trustScore');
const app = require('../../server');

let server;
let base;

// Fixed clock: negatives are "recent" relative to this instant.
const NOW = Date.parse('2026-08-02T00:00:00.000Z');

function post(path, body) {
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve, reject) => {
    const r = http.request(
      base + path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, json: () => JSON.parse(data) })
        );
      }
    );
    r.on('error', reject);
    r.end(payload);
  });
}

async function insertAgent({ handle, wallet, score, tier, status = 'active' }) {
  const db = await getDb();
  const id = crypto.randomUUID();
  const ts = '2026-01-01T00:00:00.000Z';
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, handle, wallet, 'CI', status, score, tier, ts, ts],
  });
  return id;
}

async function insertAttestation(agentId, kind, { status = 'verified', issuerId = 'iss-0', daysAgo = 20 } = {}) {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO attestations
            (id, agent_id, kind, weight, amount, note, verification_status, issuer_id, created_at)
          VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      agentId,
      kind,
      KIND_WEIGHTS[kind],
      status,
      status === 'verified' ? issuerId : null,
      new Date(NOW - daysAgo * 86_400_000).toISOString(),
    ],
  });
}

/** Verified attestations spread across 4 issuers → high trust independence. */
async function seedDiverse(agentId, n = 8) {
  for (let i = 0; i < n; i++) {
    await insertAttestation(agentId, 'clean_payment', { issuerId: `iss-${i % 4}` });
  }
}

before(async () => {
  // cmp-prime: highest score, diverse verified trust → proceed, ranks first.
  const prime = await insertAgent({
    handle: 'cmp-prime',
    wallet: '0xdd00000000000000000000000000000000000001',
    score: 950,
    tier: 4,
  });
  await seedDiverse(prime);

  // cmp-trusted: also proceeds, but a lower score than cmp-prime.
  const trusted = await insertAgent({
    handle: 'cmp-trusted',
    wallet: '0xdd00000000000000000000000000000000000002',
    score: 800,
    tier: 3,
  });
  await seedDiverse(trusted);

  // cmp-disputed: strong score but a recent dispute → review (middle rank).
  const disputed = await insertAgent({
    handle: 'cmp-disputed',
    wallet: '0xdd00000000000000000000000000000000000003',
    score: 820,
    tier: 3,
  });
  await seedDiverse(disputed);
  await insertAttestation(disputed, 'dispute', { issuerId: 'iss-9', daysAgo: 5 });

  // cmp-flagged: top-tier score undone by a recent chargeback → decline (last).
  const flagged = await insertAgent({
    handle: 'cmp-flagged',
    wallet: '0xdd00000000000000000000000000000000000004',
    score: 980,
    tier: 4,
  });
  await seedDiverse(flagged);
  await insertAttestation(flagged, 'chargeback', { issuerId: 'iss-9', daysAgo: 3 });

  // Two agents pinned at the SAME ceiling score with the SAME verdict, differing
  // only in how much recent harm they carry. Mirrors what live data looks like
  // once scores saturate. Handles are chosen so that 'bad' sorts BEFORE 'mild'
  // alphabetically — a lexical fallback would rank the worse agent first.
  const satBad = await insertAgent({
    handle: 'cmp-saturated-bad',
    wallet: '0xdd00000000000000000000000000000000000005',
    score: 1000,
    tier: 4,
  });
  await seedDiverse(satBad);
  for (let i = 0; i < 8; i++) {
    await insertAttestation(satBad, 'chargeback', { issuerId: 'iss-9', daysAgo: 3 + i });
  }

  const satMild = await insertAgent({
    handle: 'cmp-saturated-mild',
    wallet: '0xdd00000000000000000000000000000000000006',
    score: 1000,
    tier: 4,
  });
  await seedDiverse(satMild);
  await insertAttestation(satMild, 'chargeback', { issuerId: 'iss-9', daysAgo: 3 });

  // Clean counterpart for the dispute tie-break test → proceed, no negatives.
  const cleanTie = await insertAgent({
    handle: 'cmp-clean-tie',
    wallet: '0xdd00000000000000000000000000000000000007',
    score: 820,
    tier: 3,
  });
  await seedDiverse(cleanTie);

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

// ---------------------------------------------------------------------------
// compareCounterparties — ranking engine
// ---------------------------------------------------------------------------

test('ranks by verdict first, so a flagged high scorer loses to a clean lower one', async () => {
  const r = await agentService.compareCounterparties(
    ['cmp-flagged', 'cmp-trusted'],
    { nowMs: NOW }
  );

  // cmp-flagged has the higher score (980 vs 800) but declines, so verdict wins.
  assert.strictEqual(r.ranked[0].handle, 'cmp-trusted');
  assert.strictEqual(r.ranked[0].verdict, 'proceed');
  assert.strictEqual(r.ranked[1].handle, 'cmp-flagged');
  assert.strictEqual(r.ranked[1].verdict, 'decline');
  assert.strictEqual(r.recommended.handle, 'cmp-trusted');
});

test('breaks a verdict tie on score', async () => {
  const r = await agentService.compareCounterparties(
    ['cmp-trusted', 'cmp-prime'],
    { nowMs: NOW }
  );
  assert.strictEqual(r.ranked[0].handle, 'cmp-prime', '950 outranks 800');
  assert.strictEqual(r.ranked[1].handle, 'cmp-trusted');
});

test('among equally scored declines, fewer severe negatives ranks first', async () => {
  // Regression guard. Live data exposed the failure this covers: several agents
  // sat at the score ceiling (1000) with independence 0 and all declined, so the
  // old rule fell straight through to alphabetical order — putting the agent
  // with 47 chargebacks at ranked[0] ahead of one with 2. Callers reading
  // ranked[0] as "least bad" were being handed the worst actor.
  const r = await agentService.compareCounterparties(
    ['cmp-saturated-bad', 'cmp-saturated-mild'],
    { nowMs: NOW }
  );

  assert.deepStrictEqual(
    r.ranked.map((c) => c.verdict),
    ['decline', 'decline'],
    'both should decline, isolating the tie-break'
  );
  assert.strictEqual(r.ranked[0].score, r.ranked[1].score, 'scores are tied at the ceiling');

  // 'cmp-saturated-bad' sorts FIRST alphabetically, so if ordering regressed to
  // lexical it would win — this assertion only passes on severity ordering.
  assert.strictEqual(r.ranked[0].handle, 'cmp-saturated-mild', 'fewer chargebacks ranks first');
  assert.ok(
    r.ranked[0].signals.recent_severe_negatives < r.ranked[1].signals.recent_severe_negatives,
    'ranked[0] must carry fewer severe negatives'
  );
});

test('with severe negatives tied, fewer disputes ranks first', async () => {
  const r = await agentService.compareCounterparties(
    ['cmp-disputed', 'cmp-clean-tie'],
    { nowMs: NOW }
  );
  // Both are severe-negative-free; cmp-disputed carries a dispute (→ review),
  // cmp-clean-tie does not (→ proceed), so verdict already separates them. The
  // point here is that the dispute count is surfaced and consistent.
  assert.strictEqual(r.ranked[0].handle, 'cmp-clean-tie');
  assert.strictEqual(r.ranked[0].signals.recent_disputes, 0);
  assert.ok(r.ranked[1].signals.recent_disputes > 0);
});

test('orders proceed > review > decline across a full slate', async () => {
  const r = await agentService.compareCounterparties(
    ['cmp-flagged', 'cmp-disputed', 'cmp-prime'],
    { nowMs: NOW }
  );
  assert.deepStrictEqual(
    r.ranked.map((c) => c.verdict),
    ['proceed', 'review', 'decline']
  );
  assert.deepStrictEqual(
    r.ranked.map((c) => c.handle),
    ['cmp-prime', 'cmp-disputed', 'cmp-flagged']
  );
  // Rank is 1-based and dense.
  assert.deepStrictEqual(r.ranked.map((c) => c.rank), [1, 2, 3]);
});

test('recommended is null when nothing clears, rather than the least-bad option', async () => {
  const r = await agentService.compareCounterparties(
    ['cmp-flagged', 'cmp-disputed'],
    { nowMs: NOW }
  );
  assert.strictEqual(r.recommended, null, 'review is not good enough to recommend');
  // But the ranking is still returned so a caller can decide for itself.
  assert.strictEqual(r.ranked[0].handle, 'cmp-disputed');
  assert.strictEqual(r.candidate_count, 2);
});

test('unresolvable handles are reported, not fatal to the batch', async () => {
  const r = await agentService.compareCounterparties(
    ['cmp-prime', 'no-such-agent-xyz', 'cmp-trusted'],
    { nowMs: NOW }
  );
  assert.strictEqual(r.candidate_count, 2);
  assert.deepStrictEqual(r.unresolved, ['no-such-agent-xyz']);
  assert.strictEqual(r.recommended.handle, 'cmp-prime');
});

test('an unregistered wallet is assessed (declines) rather than dropped', async () => {
  const r = await agentService.compareCounterparties(
    ['cmp-prime', '0xabc0000000000000000000000000000000000000'],
    { nowMs: NOW }
  );
  // A well-formed wallet always yields a verdict, so it is a candidate.
  assert.strictEqual(r.candidate_count, 2);
  assert.deepStrictEqual(r.unresolved, []);
  const unreg = r.ranked.find((c) => c.registered === false);
  assert.ok(unreg, 'unregistered wallet should appear in the ranking');
  assert.strictEqual(unreg.verdict, 'decline');
  assert.deepStrictEqual(unreg.reasons, ['not_registered']);
});

test('duplicate references collapse to a single candidate', async () => {
  const r = await agentService.compareCounterparties(
    ['cmp-prime', 'CMP-PRIME', 'cmp-trusted'],
    { nowMs: NOW }
  );
  assert.strictEqual(r.candidate_count, 2, 'case-insensitive de-dupe');
});

test('resolves candidates by wallet as well as handle', async () => {
  const r = await agentService.compareCounterparties(
    ['0xdd00000000000000000000000000000000000001', 'cmp-trusted'],
    { nowMs: NOW }
  );
  assert.strictEqual(r.ranked[0].handle, 'cmp-prime', 'wallet resolved to the agent');
  assert.strictEqual(r.candidate_count, 2);
});

test('amount is applied to every candidate', async () => {
  // 5000 is far above any tier ceiling, so it should trip exposure for both and
  // demote the otherwise-clean pair to review.
  const r = await agentService.compareCounterparties(
    ['cmp-prime', 'cmp-trusted'],
    { amount: 5000, nowMs: NOW }
  );
  assert.strictEqual(r.requested_amount, 5000);
  for (const c of r.ranked) {
    assert.strictEqual(c.within_suggested_ceiling, false);
    assert.ok(c.reasons.includes('exposure'), `${c.handle} should flag exposure`);
  }
  assert.strictEqual(r.recommended, null, 'over-exposed candidates do not clear');
});

// ---------------------------------------------------------------------------
// POST /api/counterparty/compare — HTTP contract
// ---------------------------------------------------------------------------

test('POST /counterparty/compare returns a ranked slate', async () => {
  const res = await post('/counterparty/compare', {
    counterparties: ['cmp-flagged', 'cmp-prime', 'cmp-disputed'],
  });
  assert.strictEqual(res.status, 200);
  const body = res.json();
  assert.strictEqual(body.candidate_count, 3);
  assert.strictEqual(body.recommended.handle, 'cmp-prime');
  assert.strictEqual(body.ranked.length, 3);
  // Checks travel with each candidate so a caller can render "why".
  assert.ok(Array.isArray(body.ranked[0].checks));
  assert.ok(body.ranked[0].checks.length > 0);
});

test('POST /counterparty/compare rejects a non-array', async () => {
  const res = await post('/counterparty/compare', { counterparties: 'cmp-prime' });
  assert.strictEqual(res.status, 400);
  assert.match(res.json().error, /must be an array/i);
});

test('POST /counterparty/compare requires at least 2 candidates', async () => {
  const res = await post('/counterparty/compare', { counterparties: ['cmp-prime'] });
  assert.strictEqual(res.status, 400);
  assert.match(res.json().error, /at least 2/i);
});

test('POST /counterparty/compare caps the candidate count', async () => {
  const many = Array.from({ length: agentService.MAX_COMPARE_CANDIDATES + 1 }, (_, i) => `a-${i}`);
  const res = await post('/counterparty/compare', { counterparties: many });
  assert.strictEqual(res.status, 400);
  assert.match(res.json().error, /at most/i);
});

test('POST /counterparty/compare rejects a non-positive amount', async () => {
  const res = await post('/counterparty/compare', {
    counterparties: ['cmp-prime', 'cmp-trusted'],
    amount: -5,
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.json().error, /positive number/i);
});

test('POST /counterparty/compare 404s when no candidate resolves', async () => {
  const res = await post('/counterparty/compare', {
    counterparties: ['nope-one', 'nope-two'],
  });
  assert.strictEqual(res.status, 404);
});

test('POST /counterparty/compare requires the counterparties field', async () => {
  const res = await post('/counterparty/compare', {});
  assert.strictEqual(res.status, 400);
  assert.match(res.json().error, /counterparties/i);
});

test('/api/meta advertises the compare endpoint and its cap', async () => {
  const res = await new Promise((resolve, reject) => {
    const r = http.request(base + '/meta', { method: 'GET' }, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => resolve({ status: resp.statusCode, json: () => JSON.parse(data) }));
    });
    r.on('error', reject);
    r.end();
  });
  const body = res.json();
  assert.strictEqual(body.counterparty_compare_endpoint, '/api/counterparty/compare');
  assert.strictEqual(
    body.counterparty_compare_max_candidates,
    agentService.MAX_COMPARE_CANDIDATES
  );
});
