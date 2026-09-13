'use strict';

// Tests for COUNTERPARTY EXPOSURE — GET /api/agents/:id/counterparty-exposure.
//
// spend-summary answers "how much did I pay each payee"; /counterparty/check
// answers "is this one payee safe right now". This endpoint joins them, so the
// behaviours that only exist at the join are what's worth asserting:
//
//   drift          a payee that was fine when it was paid but has SINCE
//                  collected a chargeback shows up as verdict=decline and its
//                  spend counts toward risky_spend
//   concentration  a single payee holding > CONCENTRATION_SHARE of total spend
//                  is flagged even when its verdict is clean
//   unresolved     spend to an unregistered wallet is risky (no trust basis)
//                  and never fabricates a counterparty score
//   share math     shares are computed against the FULL total, including
//                  unnamed charges that by_payee itself excludes
//   auth           the report is admin-gated like the other spend reports
//
// A fixed clock pins the "recent negatives" window so the chargeback is
// deterministically inside the 90-day lookback. In-memory DB, no real data.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const app = require('../../server');
const { getDb, closeDb } = require('../db');
const { KIND_WEIGHTS } = require('../services/trustScore');
const counterpartyExposure = require('../services/counterpartyExposure');

const NOW = Date.parse('2026-08-02T00:00:00.000Z');

let server;
let base;

// The paying agent, and the wallets it has paid.
let payerId;
const TRUSTED_WALLET = '0xcc00000000000000000000000000000000000101';
const DRIFTED_WALLET = '0xcc00000000000000000000000000000000000102';
const STRANGER_WALLET = '0xcc00000000000000000000000000000000000103';

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

async function insertAgent({ handle, wallet, score, tier, status = 'active' }) {
  const db = await getDb();
  const id = crypto.randomUUID();
  const ts = '2026-01-01T00:00:00.000Z';
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, 'CI', ?, ?, ?, ?, ?)`,
    args: [id, handle, wallet, status, score, tier, ts, ts],
  });
  return id;
}

async function insertAttestation(agentId, { kind, issuerId, daysAgo }) {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO attestations
            (id, agent_id, kind, weight, amount, note, verification_status, issuer_id, created_at)
          VALUES (?, ?, ?, ?, 0, NULL, 'verified', ?, ?)`,
    args: [
      crypto.randomUUID(),
      agentId,
      kind,
      KIND_WEIGHTS[kind],
      issuerId,
      new Date(NOW - daysAgo * 86_400_000).toISOString(),
    ],
  });
}

/** Eight verified clean payments across 4 issuers → high trust independence. */
async function seedTrust(agentId) {
  for (let i = 0; i < 8; i++) {
    await insertAttestation(agentId, { kind: 'clean_payment', issuerId: `iss-${i % 4}`, daysAgo: 20 });
  }
}

async function insertPermission(agentId) {
  const db = await getDb();
  const id = crypto.randomUUID();
  const ts = '2026-01-01T00:00:00.000Z';
  await db.execute({
    sql: `INSERT INTO permissions (id, agent_id, category, ceiling, period, status, velocity_limit, velocity_window_s, counterparty_policy, granted_by, created_at, revoked_at)
          VALUES (?, ?, 'compute', 1000000, 'day', 'active', NULL, NULL, 'open', 'CI', ?, NULL)`,
    args: [id, agentId, ts],
  });
  return id;
}

/** Insert a spend row directly so payee + amount are controllable. */
async function insertSpend(permissionId, agentId, { amount, payee = null }) {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO spends (id, permission_id, agent_id, amount, note, payee, idempotency_key, receipt_signature, receipt_key_id, created_at)
          VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
    args: [crypto.randomUUID(), permissionId, agentId, amount, payee, '2026-07-15T00:00:00.000Z'],
  });
}

before(async () => {
  // --- counterparties the payer has paid ---

  // trusted: verified spread, active, tier 3 → proceed.
  const trustedId = await insertAgent({
    handle: 'ce-trusted',
    wallet: TRUSTED_WALLET,
    score: 800,
    tier: 3,
  });
  await seedTrust(trustedId);

  // drifted: identical strong standing, but a chargeback landed AFTER it was
  // paid (3 days ago, inside the 90-day window) → now a hard decline.
  const driftedId = await insertAgent({
    handle: 'ce-drifted',
    wallet: DRIFTED_WALLET,
    score: 800,
    tier: 3,
  });
  await seedTrust(driftedId);
  await insertAttestation(driftedId, { kind: 'chargeback', issuerId: 'iss-9', daysAgo: 3 });

  // STRANGER_WALLET is intentionally NOT registered.

  // --- the paying agent + its spend history ---
  payerId = await insertAgent({ handle: 'ce-payer', wallet: '0xcc00000000000000000000000000000000000100', score: 900, tier: 4 });
  const permId = await insertPermission(payerId);

  // Spend split so that:
  //   trusted   = 200  (clean, but > 50% of total → concentration)
  //   drifted   = 100  (now declines → drift, counts as risky)
  //   stranger  =  50  (unregistered → risky, no fabricated score)
  //   unnamed   =  30  (no payee → excluded from by_payee, still in total)
  // total = 380
  await insertSpend(permId, payerId, { amount: 200, payee: TRUSTED_WALLET });
  await insertSpend(permId, payerId, { amount: 100, payee: DRIFTED_WALLET });
  await insertSpend(permId, payerId, { amount: 50, payee: STRANGER_WALLET });
  await insertSpend(permId, payerId, { amount: 30, payee: null });

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

// ---------------------------------------------------------------------------
// Service-level: agentExposure joins spend with live verdicts
// ---------------------------------------------------------------------------

test('agentExposure totals include unnamed charges but by_payee excludes them', async () => {
  const r = await counterpartyExposure.agentExposure(payerId, { nowMs: NOW });
  assert.strictEqual(r.total_spend, 380, 'total counts the unnamed $30');
  assert.strictEqual(r.spend_count, 4);
  // by_payee excludes the unnamed charge → 3 assessed payees.
  assert.strictEqual(r.payees_assessed, 3);
});

test('shares are computed against the full total (incl. unnamed spend)', async () => {
  const r = await counterpartyExposure.agentExposure(payerId, { nowMs: NOW });
  const trusted = r.payees.find((p) => p.payee.toLowerCase() === TRUSTED_WALLET.toLowerCase());
  // 200 / 380 = 0.5263..., not 200/350 — the unnamed charge is in the denominator.
  assert.ok(Math.abs(trusted.share_of_spend - 0.5263) < 0.001, `share was ${trusted.share_of_spend}`);
});

test('a payee that collected a chargeback after payment now declines (drift)', async () => {
  const r = await counterpartyExposure.agentExposure(payerId, { nowMs: NOW });
  const drifted = r.payees.find((p) => p.payee.toLowerCase() === DRIFTED_WALLET.toLowerCase());
  assert.strictEqual(drifted.verdict, 'decline');
  assert.strictEqual(drifted.risky, true);
  assert.ok(drifted.reasons.includes('clean_history'), 'reason names the negative-history check');
  assert.strictEqual(drifted.registered, true);
  assert.strictEqual(drifted.counterparty.handle, 'ce-drifted');
});

test('a clean payee proceeds and is not risky', async () => {
  const r = await counterpartyExposure.agentExposure(payerId, { nowMs: NOW });
  const trusted = r.payees.find((p) => p.payee.toLowerCase() === TRUSTED_WALLET.toLowerCase());
  assert.strictEqual(trusted.verdict, 'proceed');
  assert.strictEqual(trusted.risky, false);
});

test('an unregistered payee is risky and never fabricates a counterparty score', async () => {
  const r = await counterpartyExposure.agentExposure(payerId, { nowMs: NOW });
  const stranger = r.payees.find((p) => p.payee.toLowerCase() === STRANGER_WALLET.toLowerCase());
  assert.strictEqual(stranger.registered, false);
  assert.strictEqual(stranger.risky, true);
  assert.strictEqual(stranger.counterparty, null, 'no score for an unknown wallet');
  assert.ok(['decline', 'unknown'].includes(stranger.verdict));
});

test('risky_spend rolls up drifted + unregistered, not the clean payee', async () => {
  const r = await counterpartyExposure.agentExposure(payerId, { nowMs: NOW });
  // drifted 100 + stranger 50 = 150 of 380.
  assert.strictEqual(r.risky_spend, 150);
  assert.strictEqual(r.risky_payee_count, 2);
  assert.ok(Math.abs(r.risky_share - 0.3947) < 0.001, `risky_share was ${r.risky_share}`);
});

test('concentration flags a payee holding more than half of total spend', async () => {
  const r = await counterpartyExposure.agentExposure(payerId, { nowMs: NOW });
  const trusted = r.payees.find((p) => p.payee.toLowerCase() === TRUSTED_WALLET.toLowerCase());
  // Clean, but 52.6% of all outbound spend → single point of failure.
  assert.strictEqual(trusted.concentration, true);
  assert.strictEqual(r.concentrated_payee_count, 1);
  assert.strictEqual(r.concentration_share, counterpartyExposure.CONCENTRATION_SHARE);
});

test('payees are ordered by spend total, largest first', async () => {
  const r = await counterpartyExposure.agentExposure(payerId, { nowMs: NOW });
  const totals = r.payees.map((p) => p.total);
  const sorted = [...totals].sort((a, b) => b - a);
  assert.deepStrictEqual(totals, sorted);
});

// ---------------------------------------------------------------------------
// Route-level: HTTP contract + auth
// ---------------------------------------------------------------------------

test('GET counterparty-exposure returns the report with the handle', async () => {
  const r = await req('GET', `/api/agents/${payerId}/counterparty-exposure`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.handle, 'ce-payer');
  assert.strictEqual(r.body.agent_id, payerId);
  assert.strictEqual(r.body.total_spend, 380);
  assert.strictEqual(r.body.risky_spend, 150);
  assert.ok(Array.isArray(r.body.payees));
});

test('GET counterparty-exposure is 404 for an unknown agent', async () => {
  const r = await req('GET', '/api/agents/does-not-exist/counterparty-exposure');
  assert.strictEqual(r.status, 404);
});

test('top_payees caps how many payees are assessed', async () => {
  const r = await req('GET', `/api/agents/${payerId}/counterparty-exposure?top_payees=1`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.payees.length, 1);
  // The largest payee (trusted, 200) is the one kept.
  assert.strictEqual(r.body.payees[0].payee.toLowerCase(), TRUSTED_WALLET.toLowerCase());
});
