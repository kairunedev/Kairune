'use strict';

// Tests for the ERC-8126 read adapter:
//   - trustScore.erc8126DerivedRiskScore / erc8126RiskTier (the inverted mapping)
//   - erc8126.buildAdapterView (payload shape and honesty markers)
//   - GET /api/agents/:id/erc8126 and the /api/erc8126/agents/:id alias (HTTP)
//
// The adapter is the one endpoint where a wrong sign is worse than an outage: a
// consumer wiring it into a `minVerificationScore` gate inverts its own policy
// and admits exactly the agents it meant to refuse. So the mapping direction is
// asserted at both boundaries of the range, not just spot-checked in the middle.
//
// The negative assertions matter as much as the positive ones. The payload
// publicly claims `compliant: false`, `agentId: null`, and four
// `not_implemented` verification types; if a later refactor quietly starts
// emitting 0 for an unrun check, that reads as "lowest risk" to a spec reader —
// the opposite of "unknown". These tests pin that down.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const trustScore = require('../services/trustScore');
const erc8126 = require('../services/erc8126');
const agentService = require('../services/agentService');
const attestationService = require('../services/attestationService');
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

// The route recomputes the score before answering (a policy gate deciding
// whether money may move must not read a stale score), so seeding the agents
// row directly would be overwritten. Earn the score the way production does.
async function earn(agentId, count) {
  for (let i = 0; i < count; i += 1) {
    // A distinct issuer per attestation: the volume bonus is capped per issuer,
    // so reusing one issuer would plateau well below PRIME.
    await attestationService.addAttestation(agentId, {
      kind: 'peer_vouch',
      verification_status: 'verified',
      issuer_id: 'issuer-' + i,
      issuer_key_id: 'key-' + i,
    });
  }
}

let primeHandle;
let unratedHandle;

before(async () => {
  primeHandle = 'erc-prime-' + crypto.randomUUID().slice(0, 8);
  unratedHandle = 'erc-unrated-' + crypto.randomUUID().slice(0, 8);

  const prime = await agentService.createAgent({
    handle: primeHandle,
    wallet: '0xf100000000000000000000000000000000000001',
    operator: 'CI',
  });
  await earn(prime.id, 24);

  // Left with no attestations at all: the engine falls back to BASELINE, which
  // is the honest "nothing earned yet" state this endpoint has to represent.
  await agentService.createAgent({
    handle: unratedHandle,
    wallet: '0xf200000000000000000000000000000000000002',
    operator: 'CI',
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

// ---- the mapping ---------------------------------------------------------

test('erc8126DerivedRiskScore inverts: a perfect Kairune score is 0 risk', () => {
  assert.equal(trustScore.erc8126DerivedRiskScore(1000), 0);
});

test('erc8126DerivedRiskScore inverts: a zero Kairune score is 100 risk', () => {
  assert.equal(trustScore.erc8126DerivedRiskScore(0), 100);
});

test('erc8126DerivedRiskScore applies 100 - round(score/10)', () => {
  assert.equal(trustScore.erc8126DerivedRiskScore(357), 64);
  assert.equal(trustScore.erc8126DerivedRiskScore(250), 75);
  assert.equal(trustScore.erc8126DerivedRiskScore(900), 10);
});

test('erc8126DerivedRiskScore clamps out-of-range input into 0..100', () => {
  assert.equal(trustScore.erc8126DerivedRiskScore(5000), 0);
  assert.equal(trustScore.erc8126DerivedRiskScore(-500), 100);
});

test('erc8126DerivedRiskScore returns null for non-numeric input', () => {
  assert.equal(trustScore.erc8126DerivedRiskScore('abc'), null);
  assert.equal(trustScore.erc8126DerivedRiskScore(undefined), null);
});

test('erc8126RiskTier uses the spec bands with 0 as the best tier', () => {
  assert.equal(trustScore.erc8126RiskTier(0), 'Low');
  assert.equal(trustScore.erc8126RiskTier(20), 'Low');
  assert.equal(trustScore.erc8126RiskTier(21), 'Moderate');
  assert.equal(trustScore.erc8126RiskTier(60), 'Elevated');
  assert.equal(trustScore.erc8126RiskTier(80), 'High');
  assert.equal(trustScore.erc8126RiskTier(100), 'Critical');
});

// ---- payload shape ------------------------------------------------------

test('buildAdapterView never claims compliance or an ERC-8004 agentId', () => {
  const view = erc8126.buildAdapterView(
    { handle: 'x', wallet: '0xabc', score: 1000, status: 'active' },
    { proven: false, verified_at: null },
    { chainId: 4663, walletProofMethod: 'eip191-personal-sign' }
  );
  assert.equal(view.spec, 'ERC-8126');
  assert.equal(view.compliant, false);
  assert.equal(view.compliance, 'derived-adapter');
  assert.equal(view.agentId, null);
  assert.equal(view.agent_identity.erc8004_registered, false);
  assert.equal(view.erc8004.attestation_posted, false);
});

test('buildAdapterView reports four types not_implemented with null, not zero', () => {
  const view = erc8126.buildAdapterView(
    { handle: 'x', wallet: '0xabc', score: 500, status: 'active' },
    { proven: false, verified_at: null },
    { chainId: 4663, walletProofMethod: 'eip191-personal-sign' }
  );
  for (const type of ['ETV', 'MCV', 'SCV', 'WAV']) {
    assert.equal(view.verifications[type].status, 'not_implemented', type);
    // 0 would read as "lowest risk" on an inverted scale, so it must stay null.
    assert.equal(view.verifications[type].score, null, type);
  }
  assert.deepEqual(view.implemented_verification_types, ['WV (partial)']);
});

test('buildAdapterView marks WV partial and carries the proof state through', () => {
  const view = erc8126.buildAdapterView(
    { handle: 'x', wallet: '0xdead', score: 500, status: 'active' },
    { proven: true, verified_at: '2026-08-30T00:00:00.000Z' },
    { chainId: 4663, walletProofMethod: 'eip191-personal-sign' }
  );
  const wv = view.verifications.WV;
  assert.equal(wv.status, 'partial');
  assert.equal(wv.wallet_control_proven, true);
  assert.equal(wv.proven_at, '2026-08-30T00:00:00.000Z');
  assert.equal(wv.method, 'eip191-personal-sign');
  assert.equal(wv.chain_id, 4663);
});

test('buildAdapterView keeps PDV/ZKP and QCV absent', () => {
  const view = erc8126.buildAdapterView(
    { handle: 'x', wallet: '0xabc', score: 500, status: 'active' },
    { proven: false, verified_at: null },
    { chainId: 4663, walletProofMethod: 'eip191-personal-sign' }
  );
  assert.equal(view.pdv.status, 'not_implemented');
  assert.equal(view.pdv.zkp, false);
  assert.equal(view.qcv.status, 'not_implemented');
});

test('buildAdapterView exposes the source score so the translation is auditable', () => {
  const view = erc8126.buildAdapterView(
    { handle: 'voyager', wallet: '0xabc', score: 1000, status: 'active' },
    { proven: false, verified_at: null },
    { chainId: 4663, walletProofMethod: 'eip191-personal-sign' }
  );
  assert.equal(view.source.provider, 'kairune');
  assert.equal(view.source.score, 1000);
  assert.equal(view.source.max_score, trustScore.MAX_SCORE);
  assert.equal(view.source.tier_label, 'PRIME');
  assert.equal(view.overallRiskScore, 0);
  assert.equal(view.riskTier, 'Low');
  assert.match(view.overall_risk_source.formula, /100 - Math\.round/);
  assert.match(view.disclosure, /not an ERC-8126 verification provider/);
});

// ---- HTTP ---------------------------------------------------------------

test('GET /api/agents/:id/erc8126 derives risk from the recomputed score', async () => {
  const res = await get(`/api/agents/${primeHandle}/erc8126`);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.compliant, false);
  assert.equal(body.agentId, null);
  // Assert the invariant rather than a hardcoded number: the route recalculates,
  // so pinning an exact score here would make this test a tripwire for any
  // future weighting change rather than a check on the adapter.
  assert.equal(body.overallRiskScore, trustScore.erc8126DerivedRiskScore(body.source.score));
  assert.equal(body.riskTier, trustScore.erc8126RiskTier(body.overallRiskScore));
});

test('a well-attested agent lands in a better risk tier than an unattested one', async () => {
  const prime = (await get(`/api/agents/${primeHandle}/erc8126`)).json();
  const unrated = (await get(`/api/agents/${unratedHandle}/erc8126`)).json();
  // Lower risk is better on this scale, and earning attestations must move the
  // number in that direction or the whole mapping is pointing the wrong way.
  assert.ok(
    prime.overallRiskScore < unrated.overallRiskScore,
    `expected earned risk ${prime.overallRiskScore} < unattested risk ${unrated.overallRiskScore}`
  );
  assert.ok(prime.source.score > unrated.source.score);
});

test('an unattested agent is never reported as wallet-proven', async () => {
  const res = await get(`/api/agents/${unratedHandle}/erc8126`);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.verifications.WV.status, 'partial');
  assert.equal(body.verifications.WV.wallet_control_proven, false);
  assert.equal(body.source.wallet_proven, false);
});

test('the /api/erc8126/agents/:id alias returns the same payload', async () => {
  const direct = (await get(`/api/agents/${primeHandle}/erc8126`)).json();
  const alias = (await get(`/api/erc8126/agents/${primeHandle}`)).json();
  // generated_at is a timestamp, so compare everything else.
  delete direct.generated_at;
  delete alias.generated_at;
  assert.deepEqual(alias, direct);
});

test('GET /api/agents/:id/erc8126 is 404 for an unknown agent', async () => {
  const res = await get('/api/agents/no-such-agent/erc8126');
  assert.equal(res.status, 404);
});

test('GET /api/meta advertises the adapter as non-compliant', async () => {
  const res = await get('/api/meta');
  assert.equal(res.status, 200);
  const meta = res.json();
  assert.equal(meta.erc8126_adapter.compliant, false);
  assert.ok(meta.erc8126_adapter.endpoints.includes('/api/agents/:id/erc8126'));
  assert.equal(meta.erc8126_derived_risk.example.kairune_score_1000, 0);
  assert.equal(meta.erc8126_derived_risk.example.kairune_score_0, 100);
});
