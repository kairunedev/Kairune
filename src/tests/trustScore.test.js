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
  for (let i = 0; i < 40; i++) atts.push({ kind: 'task_completed', created_at: fresh });
  for (let i = 0; i < 30; i++) atts.push({ kind: 'clean_payment', created_at: fresh });
  for (let i = 0; i < 10; i++) atts.push({ kind: 'peer_vouch', created_at: fresh });
  const r = computeScore(atts, now);
  assert.ok(r.score > 700, 'score should be high, got ' + r.score);
  assert.ok(r.tier >= 3, 'tier should be >= 3');
});

test('negative events lower the score sharply (asymmetric)', () => {
  const positive = [];
  for (let i = 0; i < 10; i++) positive.push({ kind: 'task_completed', created_at: fresh });
  const clean = computeScore(positive, now).score;

  const withBad = positive.concat([
    { kind: 'chargeback', created_at: fresh },
    { kind: 'anomaly_flag', created_at: fresh },
  ]);
  const dirty = computeScore(withBad, now).score;
  assert.ok(dirty < clean, 'score with bad events should be lower');
  assert.ok(clean - dirty > 100, 'the penalty should be significant');
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
