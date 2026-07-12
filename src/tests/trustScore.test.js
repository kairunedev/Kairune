'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  computeScore,
  tierForScore,
  suggestedDailyCeiling,
  recencyFactor,
} = require('../services/trustScore');

const now = Date.now();
const fresh = new Date(now).toISOString();

test('a new agent (no attestations) gets the baseline score', () => {
  const r = computeScore([], now);
  assert.strictEqual(r.score, 120);
  assert.strictEqual(r.tier, 0);
  assert.strictEqual(r.label, 'UNRATED');
});

test('positive activity raises the score & tier', () => {
  const atts = [];
  for (let i = 0; i < 40; i++) atts.push({ kind: 'task_completed', created_at: fresh, verification_status: 'verified' });
  for (let i = 0; i < 30; i++) atts.push({ kind: 'clean_payment', created_at: fresh, verification_status: 'verified' });
  for (let i = 0; i < 10; i++) atts.push({ kind: 'peer_vouch', created_at: fresh, verification_status: 'verified' });
  const r = computeScore(atts, now);
  assert.ok(r.score > 700, 'score should be high, got ' + r.score);
  assert.ok(r.tier >= 3, 'tier should be >= 3');
});

test('negative events lower the score sharply (asymmetric)', () => {
  const positive = [];
  for (let i = 0; i < 10; i++) positive.push({ kind: 'task_completed', created_at: fresh, verification_status: 'verified' });
  const clean = computeScore(positive, now).score;

  const withBad = positive.concat([
    { kind: 'chargeback', created_at: fresh, verification_status: 'verified' },
    { kind: 'anomaly_flag', created_at: fresh, verification_status: 'verified' },
  ]);
  const dirty = computeScore(withBad, now).score;
  assert.ok(dirty < clean, 'score with bad events should be lower');
  assert.ok(clean - dirty > 100, 'the penalty should be significant');
});

test('verification weighting: verified counts fully, unverified is discounted', () => {
  const verified = [];
  const unverified = [];
  for (let i = 0; i < 20; i++) {
    verified.push({ kind: 'clean_payment', created_at: fresh, verification_status: 'verified' });
    unverified.push({ kind: 'clean_payment', created_at: fresh, verification_status: 'unverified' });
  }
  const rv = computeScore(verified, now);
  const ru = computeScore(unverified, now);
  assert.ok(rv.score > ru.score, 'verified should score higher than unverified');
  assert.strictEqual(rv.breakdown.verifiedCount, 20);
  assert.strictEqual(ru.breakdown.unverifiedCount, 20);
});

test('unverified factor defaults to 0.25 and clamps invalid config', () => {
  const atts = [];
  for (let i = 0; i < 10; i++) atts.push({ kind: 'clean_payment', created_at: fresh, verification_status: 'unverified' });
  const dflt = computeScore(atts, now, {});
  const explicit = computeScore(atts, now, { unverifiedFactor: 0.25 });
  const invalid = computeScore(atts, now, { unverifiedFactor: 9 });
  assert.strictEqual(dflt.score, explicit.score);
  assert.strictEqual(invalid.score, explicit.score, 'invalid factor falls back to default');
  const full = computeScore(atts, now, { unverifiedFactor: 1 });
  assert.ok(full.score > dflt.score, 'factor 1.0 scores higher than 0.25');
});

test('breakdown counts conserve the number of attestations', () => {
  const atts = [
    { kind: 'clean_payment', created_at: fresh, verification_status: 'verified' },
    { kind: 'task_completed', created_at: fresh, verification_status: 'unverified' },
    { kind: 'peer_vouch', created_at: fresh, verification_status: 'weird' },
  ];
  const r = computeScore(atts, now);
  const { verifiedCount, unverifiedCount, excludedCount } = r.breakdown;
  assert.strictEqual(verifiedCount + unverifiedCount + excludedCount, atts.length);
  assert.strictEqual(excludedCount, 1);
});

test('tierForScore maps thresholds correctly', () => {
  assert.strictEqual(tierForScore(0).tier, 0);
  assert.strictEqual(tierForScore(250).tier, 1);
  assert.strictEqual(tierForScore(500).tier, 2);
  assert.strictEqual(tierForScore(750).tier, 3);
  assert.strictEqual(tierForScore(900).tier, 4);
  assert.strictEqual(tierForScore(1000).label, 'PRIME');
});

test('suggestedDailyCeiling rises with tier', () => {
  assert.strictEqual(suggestedDailyCeiling(0), 0);
  assert.strictEqual(suggestedDailyCeiling(300), 50);
  assert.ok(suggestedDailyCeiling(950) > suggestedDailyCeiling(300));
});

test('recencyFactor decays for old events', () => {
  const old = new Date(now - 90 * 86400000).toISOString();
  const f = recencyFactor(old, now);
  assert.ok(f > 0.4 && f < 0.6, 'after 1 half-life (~90d) the factor is ~0.5, got ' + f);
});

test('the score always stays within 0..1000', () => {
  const spam = [];
  for (let i = 0; i < 5000; i++) spam.push({ kind: 'peer_vouch', created_at: fresh });
  const r = computeScore(spam, now);
  assert.ok(r.score <= 1000 && r.score >= 0);
});
