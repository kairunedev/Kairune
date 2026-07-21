'use strict';

// Unit tests for verification-weighted trust scoring.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  computeScore,
  BASELINE,
  DEFAULT_UNVERIFIED_FACTOR,
  PER_ISSUER_VOLUME_CAP,
  cappedVolumeCount,
} = require('../services/trustScore');

const now = Date.parse('2026-07-12T00:00:00.000Z');
const fresh = new Date(now).toISOString();

function atts(n, status) {
  return Array.from({ length: n }, () => ({
    kind: 'task_completed',
    created_at: fresh,
    verification_status: status,
  }));
}

// Verified attestations attributed to a specific issuer.
function verifiedFrom(n, issuerId) {
  return Array.from({ length: n }, () => ({
    kind: 'task_completed',
    created_at: fresh,
    verification_status: 'verified',
    issuer_id: issuerId,
  }));
}

test('verified attestations score higher than the same unverified set', () => {
  const verified = computeScore(atts(10, 'verified'), now);
  const unverified = computeScore(atts(10, 'unverified'), now);
  assert.ok(verified.score > unverified.score, 'verified dominance');
});

test('default unverified factor is applied when none configured', () => {
  const r = computeScore(atts(5, 'unverified'), now);
  assert.strictEqual(r.breakdown.unverifiedCount, 5);
  assert.strictEqual(DEFAULT_UNVERIFIED_FACTOR, 0.25);
});

test('configurable unverified factor changes the score', () => {
  const low = computeScore(atts(10, 'unverified'), now, { unverifiedFactor: 0 });
  const high = computeScore(atts(10, 'unverified'), now, { unverifiedFactor: 1 });
  assert.ok(high.score > low.score);
});

test('invalid unverified factor falls back to default (no crash)', () => {
  const bad = computeScore(atts(10, 'unverified'), now, { unverifiedFactor: 5 });
  const def = computeScore(atts(10, 'unverified'), now);
  assert.strictEqual(bad.score, def.score);
});

test('breakdown counts conserve the total attestation count', () => {
  const list = [...atts(3, 'verified'), ...atts(2, 'unverified'), ...atts(1, 'weird')];
  const r = computeScore(list, now);
  const { verifiedCount, unverifiedCount, excludedCount } = r.breakdown;
  assert.strictEqual(verifiedCount, 3);
  assert.strictEqual(unverifiedCount, 2);
  assert.strictEqual(excludedCount, 1);
  assert.strictEqual(verifiedCount + unverifiedCount + excludedCount, list.length);
});

test('empty input returns baseline with zero counts', () => {
  const r = computeScore([], now);
  assert.strictEqual(r.score, BASELINE);
  assert.strictEqual(r.breakdown.verifiedCount, 0);
  assert.strictEqual(r.breakdown.unverifiedCount, 0);
  assert.strictEqual(r.breakdown.excludedCount, 0);
});

test('scoring is deterministic for identical inputs', () => {
  const list = atts(7, 'verified');
  assert.deepStrictEqual(computeScore(list, now), computeScore(list, now));
});

test('missing verification_status defaults to unverified weighting', () => {
  const noStatus = [{ kind: 'task_completed', created_at: fresh }];
  const r = computeScore(noStatus, now);
  assert.strictEqual(r.breakdown.unverifiedCount, 1);
});

// ---- anti-farming per-issuer volume cap -------------------------------------

test('clean attestations without an issuer feed the volume bonus uncapped', () => {
  // backward-compatibility: no issuer_id → effective volume equals clean count
  const r = computeScore(atts(10, 'verified'), now);
  assert.strictEqual(r.breakdown.effectiveCleanVolume, 10);
  assert.strictEqual(r.breakdown.distinctIssuers, 0);
});

test('single-issuer trust scores lower than many-issuer trust of equal volume', () => {
  const many = PER_ISSUER_VOLUME_CAP * 2; // beyond one issuer's cap
  const single = computeScore(verifiedFrom(many, 'iss-a'), now);
  const spread = computeScore(
    [
      ...verifiedFrom(many / 2, 'iss-a'),
      ...verifiedFrom(many / 2, 'iss-b'),
    ],
    now
  );
  assert.ok(
    spread.score > single.score,
    `expected diverse (${spread.score}) > single (${single.score})`
  );
  // The single issuer's contribution is capped; breadth is not.
  assert.strictEqual(single.breakdown.effectiveCleanVolume, PER_ISSUER_VOLUME_CAP);
  assert.strictEqual(spread.breakdown.effectiveCleanVolume, many);
});

test('a single issuer vouching thousands of times is capped at the per-issuer cap', () => {
  const flooded = computeScore(verifiedFrom(1000, 'iss-a'), now);
  assert.strictEqual(
    flooded.breakdown.effectiveCleanVolume,
    PER_ISSUER_VOLUME_CAP,
    'one issuer cannot inflate volume beyond the cap'
  );
});

test('a single verified attestation still outscores a single unverified one', () => {
  // low-volume legitimacy must not be punished by the cap
  const oneVerified = computeScore(verifiedFrom(1, 'iss-a'), now);
  const oneUnverified = computeScore(atts(1, 'unverified'), now);
  assert.ok(oneVerified.score > oneUnverified.score);
});

test('cappedVolumeCount: caps each issuer independently, passes uncapped through', () => {
  const byIssuer = new Map([
    ['a', 100], // capped to PER_ISSUER_VOLUME_CAP
    ['b', 3], // under cap, counted fully
  ]);
  const expected = PER_ISSUER_VOLUME_CAP + 3 + 5; // + 5 uncapped
  assert.strictEqual(cappedVolumeCount(5, byIssuer), expected);
});
