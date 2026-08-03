'use strict';

// Tests for the counterparty pre-flight check:
//   - counterpartyService.assessCounterparty (pure verdict engine)
//   - agentService.checkCounterparty (resolves by id/handle/wallet, loads rows)
//   - POST /api/counterparty/check (HTTP)
//
// The verdict engine is a pure function of a stored agent profile + raw
// attestation rows, so most assertions are exact. A FIXED clock is used so the
// "recent negatives" lookback window is deterministic.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const { getDb } = require('../db');
const agentService = require('../services/agentService');
const counterpartyService = require('../services/counterpartyService');
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

function get(path) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, json: () => JSON.parse(data) })
      );
    });
    r.on('error', reject);
    r.end();
  });
}

/** A stored-agent-shaped object for the pure engine (no DB needed). */
function agent({ handle = 'cp', wallet = null, status = 'active', score = 0 }) {
  return { id: `id-${handle}`, handle, wallet, status, score };
}

/** Attestation row shaped like the DB projection the engine consumes. */
function att(kind, { status = 'verified', issuerId = 'iss-0', daysAgo = 1 } = {}) {
  return {
    kind,
    created_at: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    verification_status: status,
    issuer_id: status === 'verified' ? issuerId : null,
  };
}

/** Verified attestations spread across 4 issuers → high trust independence. */
function diverseVerified(kind = 'clean_payment', n = 8) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(att(kind, { status: 'verified', issuerId: `iss-${i % 4}`, daysAgo: 20 }));
  }
  return rows;
}

async function insertAgent({ handle, wallet, score, tier, status = 'active', operator = 'CI' }) {
  const db = await getDb();
  const id = crypto.randomUUID();
  const ts = '2026-01-01T00:00:00.000Z';
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, handle, wallet, operator, status, score, tier, ts, ts],
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
  // cp-trusted: TRUSTED (tier 3, ceiling 420), active, verified trust spread
  // across 4 issuers → proceed with room to spend.
  const trustedId = await insertAgent({
    handle: 'cp-trusted',
    wallet: '0xcc00000000000000000000000000000000000001',
    score: 800,
    tier: 3,
  });
  for (const row of diverseVerified('clean_payment', 8)) {
    await insertAttestation(trustedId, row);
  }

  // cp-flagged: same strong score, but a recent chargeback → hard decline.
  const flaggedId = await insertAgent({
    handle: 'cp-flagged',
    wallet: '0xcc00000000000000000000000000000000000002',
    score: 800,
    tier: 3,
  });
  for (const row of diverseVerified('clean_payment', 8)) {
    await insertAttestation(flaggedId, row);
  }
  await insertAttestation(flaggedId, att('chargeback', { status: 'verified', issuerId: 'iss-9', daysAgo: 3 }));

  // cp-fresh: UNRATED (tier 0), no attestations → decline (no basis to trust).
  await insertAgent({
    handle: 'cp-fresh',
    wallet: '0xcc00000000000000000000000000000000000003',
    score: 100,
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
// assessCounterparty — pure verdict engine
// ---------------------------------------------------------------------------

test('unregistered counterparty declines with a not_registered reason', () => {
  const r = counterpartyService.assessCounterparty(null, [], {
    nowMs: NOW,
    wallet: '0xAbC0000000000000000000000000000000000000',
  });
  assert.strictEqual(r.registered, false);
  assert.strictEqual(r.verdict, 'decline');
  assert.deepStrictEqual(r.reasons, ['not_registered']);
  assert.strictEqual(r.suggested_max_amount, 0);
  assert.strictEqual(r.signals, null);
  // Wallet is normalized to lowercase.
  assert.strictEqual(r.wallet, '0xabc0000000000000000000000000000000000000');
});

test('active TRUSTED agent with diverse verified trust → proceed', () => {
  const r = counterpartyService.assessCounterparty(
    agent({ handle: 'good', score: 800 }),
    diverseVerified('clean_payment', 8),
    { nowMs: NOW }
  );
  assert.strictEqual(r.verdict, 'proceed');
  assert.strictEqual(r.registered, true);
  assert.strictEqual(r.counterparty.tier, 3);
  assert.strictEqual(r.counterparty.tier_label, 'TRUSTED');
  assert.deepStrictEqual(r.reasons, []);
  assert.ok(r.checks.every((c) => c.status === 'pass'));
  assert.ok(r.trust_independence > 20, 'diverse trust should be independent');
});

test('suspended agent declines regardless of score', () => {
  const r = counterpartyService.assessCounterparty(
    agent({ handle: 'susp', status: 'suspended', score: 950 }),
    diverseVerified('clean_payment', 8),
    { nowMs: NOW }
  );
  assert.strictEqual(r.verdict, 'decline');
  assert.ok(r.reasons.includes('status'));
});

test('a recent chargeback is a hard decline even with a strong score', () => {
  const rows = [
    ...diverseVerified('clean_payment', 8),
    att('chargeback', { status: 'verified', issuerId: 'iss-9', daysAgo: 5 }),
  ];
  const r = counterpartyService.assessCounterparty(
    agent({ handle: 'cb', score: 800 }),
    rows,
    { nowMs: NOW }
  );
  assert.strictEqual(r.verdict, 'decline');
  assert.ok(r.reasons.includes('clean_history'));
  assert.strictEqual(r.signals.recent_severe_negatives, 1);
});

test('a recent dispute (no chargeback) is a review, not a decline', () => {
  const rows = [
    ...diverseVerified('clean_payment', 8),
    att('dispute', { status: 'verified', issuerId: 'iss-9', daysAgo: 5 }),
  ];
  const r = counterpartyService.assessCounterparty(
    agent({ handle: 'dp', score: 800 }),
    rows,
    { nowMs: NOW }
  );
  assert.strictEqual(r.verdict, 'review');
  assert.strictEqual(r.signals.recent_disputes, 1);
  assert.strictEqual(r.signals.recent_severe_negatives, 0);
});

test('an old chargeback outside the lookback window does not force a decline', () => {
  const rows = [
    ...diverseVerified('clean_payment', 8),
    att('chargeback', { status: 'verified', issuerId: 'iss-9', daysAgo: 200 }),
  ];
  const r = counterpartyService.assessCounterparty(
    agent({ handle: 'oldcb', score: 800 }),
    rows,
    { nowMs: NOW }
  );
  assert.strictEqual(r.signals.recent_severe_negatives, 0);
  assert.strictEqual(r.verdict, 'proceed');
});

test('tier 0 (UNRATED) declines; tier 1 (EMERGING) reviews', () => {
  const unrated = counterpartyService.assessCounterparty(
    agent({ handle: 'u', score: 100 }),
    [],
    { nowMs: NOW }
  );
  assert.strictEqual(unrated.verdict, 'decline');
  assert.ok(unrated.reasons.includes('tier'));

  const emerging = counterpartyService.assessCounterparty(
    agent({ handle: 'e', score: 300 }),
    diverseVerified('clean_payment', 8),
    { nowMs: NOW }
  );
  assert.strictEqual(emerging.counterparty.tier, 1);
  assert.strictEqual(emerging.verdict, 'review');
  assert.ok(emerging.reasons.includes('tier'));
});

test('verified trust concentrated on one issuer is flagged as low independence', () => {
  const single = [];
  for (let i = 0; i < 10; i++) {
    single.push(att('clean_payment', { status: 'verified', issuerId: 'iss-0', daysAgo: 20 }));
  }
  const r = counterpartyService.assessCounterparty(
    agent({ handle: 'farm', score: 800 }),
    single,
    { nowMs: NOW }
  );
  assert.strictEqual(r.trust_independence, 0);
  assert.ok(r.reasons.includes('trust_independence'));
  assert.strictEqual(r.verdict, 'review');
});

test('amount within the recommended ceiling passes; over it reviews', () => {
  const within = counterpartyService.assessCounterparty(
    agent({ handle: 'a1', score: 800 }),
    diverseVerified('clean_payment', 8),
    { nowMs: NOW, amount: 100 }
  );
  // TRUSTED ceiling is 420.
  assert.strictEqual(within.suggested_max_amount, 420);
  assert.strictEqual(within.within_suggested_ceiling, true);
  assert.strictEqual(within.verdict, 'proceed');

  const over = counterpartyService.assessCounterparty(
    agent({ handle: 'a2', score: 800 }),
    diverseVerified('clean_payment', 8),
    { nowMs: NOW, amount: 900 }
  );
  assert.strictEqual(over.within_suggested_ceiling, false);
  assert.ok(over.reasons.includes('exposure'));
  assert.strictEqual(over.verdict, 'review');
});

test('within_suggested_ceiling is null when no amount is supplied', () => {
  const r = counterpartyService.assessCounterparty(
    agent({ handle: 'noamt', score: 800 }),
    diverseVerified('clean_payment', 8),
    { nowMs: NOW }
  );
  assert.strictEqual(r.requested_amount, null);
  assert.strictEqual(r.within_suggested_ceiling, null);
});

test('reasons are ordered worst-first (fail before warn)', () => {
  // Suspended (fail) + a dispute (warn): the fail code must come first.
  const rows = [att('dispute', { status: 'verified', issuerId: 'iss-1', daysAgo: 2 })];
  const r = counterpartyService.assessCounterparty(
    agent({ handle: 'mix', status: 'suspended', score: 800 }),
    rows,
    { nowMs: NOW }
  );
  assert.strictEqual(r.verdict, 'decline');
  const failIdx = r.reasons.indexOf('status');
  const warnIdx = r.reasons.indexOf('clean_history');
  assert.ok(failIdx !== -1 && warnIdx !== -1);
  assert.ok(failIdx < warnIdx, 'fail reason should precede warn reason');
});

test('signals expose the raw numbers behind the verdict', () => {
  const r = counterpartyService.assessCounterparty(
    agent({ handle: 'sig', score: 800 }),
    diverseVerified('clean_payment', 8),
    { nowMs: NOW }
  );
  assert.strictEqual(r.signals.tier, 3);
  assert.strictEqual(r.signals.distinct_issuers, 4);
  assert.strictEqual(r.signals.verified_count, 8);
  assert.strictEqual(r.signals.unverified_count, 0);
  assert.strictEqual(r.signals.negative_lookback_days, counterpartyService.NEGATIVE_LOOKBACK_DAYS);
});

// ---------------------------------------------------------------------------
// agentService.checkCounterparty — resolution + DB load
// ---------------------------------------------------------------------------

test('checkCounterparty resolves by handle and loads real attestations', async () => {
  const r = await agentService.checkCounterparty('cp-trusted', { nowMs: NOW });
  assert.strictEqual(r.registered, true);
  assert.strictEqual(r.counterparty.handle, 'cp-trusted');
  assert.strictEqual(r.signals.verified_count, 8);
  assert.strictEqual(r.verdict, 'proceed');
});

test('checkCounterparty resolves by wallet address', async () => {
  const r = await agentService.checkCounterparty(
    '0xcc00000000000000000000000000000000000001',
    { nowMs: NOW }
  );
  assert.strictEqual(r.registered, true);
  assert.strictEqual(r.counterparty.handle, 'cp-trusted');
});

test('a valid but unregistered wallet declines (registered:false)', async () => {
  const r = await agentService.checkCounterparty(
    '0xdead00000000000000000000000000000000beef',
    { nowMs: NOW }
  );
  assert.strictEqual(r.registered, false);
  assert.strictEqual(r.verdict, 'decline');
  assert.deepStrictEqual(r.reasons, ['not_registered']);
});

test('an unresolvable non-wallet reference returns null', async () => {
  const r = await agentService.checkCounterparty('no-such-agent', { nowMs: NOW });
  assert.strictEqual(r, null);
});

test('a recent chargeback in the DB drives a decline through checkCounterparty', async () => {
  const r = await agentService.checkCounterparty('cp-flagged', { nowMs: NOW });
  assert.strictEqual(r.verdict, 'decline');
  assert.ok(r.reasons.includes('clean_history'));
});

// ---------------------------------------------------------------------------
// HTTP — POST /api/counterparty/check
// ---------------------------------------------------------------------------

test('HTTP: proceed verdict with full payload shape', async () => {
  const res = await post('/counterparty/check', { counterparty: 'cp-trusted', amount: 100 });
  assert.strictEqual(res.status, 200);
  const b = res.json();
  assert.strictEqual(b.verdict, 'proceed');
  assert.strictEqual(b.registered, true);
  assert.strictEqual(b.requested_amount, 100);
  assert.strictEqual(b.within_suggested_ceiling, true);
  assert.ok(Array.isArray(b.checks) && b.checks.length > 0);
  assert.ok(b.counterparty.handle === 'cp-trusted');
});

test('HTTP: unregistered wallet returns 200 + decline (not 404)', async () => {
  const res = await post('/counterparty/check', {
    counterparty: '0xdead00000000000000000000000000000000beef',
  });
  assert.strictEqual(res.status, 200);
  const b = res.json();
  assert.strictEqual(b.registered, false);
  assert.strictEqual(b.verdict, 'decline');
});

test('HTTP: unknown non-wallet counterparty is 404', async () => {
  const res = await post('/counterparty/check', { counterparty: 'ghost-agent' });
  assert.strictEqual(res.status, 404);
});

test('HTTP: missing counterparty is 400', async () => {
  const res = await post('/counterparty/check', { amount: 10 });
  assert.strictEqual(res.status, 400);
});

test('HTTP: a non-positive amount is 400', async () => {
  const res = await post('/counterparty/check', { counterparty: 'cp-trusted', amount: -5 });
  assert.strictEqual(res.status, 400);
});

test('HTTP: /api/meta advertises the counterparty_check endpoint', async () => {
  const res = await get('/meta');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json().counterparty_check_endpoint, '/api/counterparty/check');
});
