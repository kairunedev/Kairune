'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  computeScore,
  tierForScore,
  suggestedDailyCeiling,
  recencyFactor,
  integrityFactor,
  MAX_INTEGRITY_DISCOUNT,
  corroborationCeiling,
  UNCORROBORATED_CEILING,
  CEILING_LIFT_PER_ISSUER,
  TIER_THRESHOLDS,
  MAX_SCORE,
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
  // Issuer attribution is spread across four issuers because the score is
  // bounded by corroboration: the real verified path always carries an
  // issuer_id, and reaching the top tiers requires breadth across issuers.
  const atts = [];
  for (let i = 0; i < 40; i++) atts.push({ kind: 'task_completed', created_at: fresh, verification_status: 'verified', issuer_id: `iss-${i % 4}` });
  for (let i = 0; i < 30; i++) atts.push({ kind: 'clean_payment', created_at: fresh, verification_status: 'verified', issuer_id: `iss-${i % 4}` });
  for (let i = 0; i < 10; i++) atts.push({ kind: 'peer_vouch', created_at: fresh, verification_status: 'verified', issuer_id: `iss-${i % 4}` });
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

// ---------------------------------------------------------------------------
// Misconduct must survive the MAX_SCORE ceiling.
//
// These pin a bug that was live in production: with a large enough history the
// positive contribution overflowed 1000 several times over, so the additive
// penalty was subtracted and the result still landed above the ceiling. The
// clamp then discarded it. Three agents with a ~4-5% dispute-and-chargeback
// rate were reporting a perfect 1000 / PRIME, and via the ERC-8126 adapter the
// best risk rating the spec has — a payer gating on that would have funded
// exactly the agents it meant to refuse.
// ---------------------------------------------------------------------------

// Build a history big enough that the positive side overflows MAX_SCORE, which
// is the precondition for the bug. Mirrors the shape of the real production
// rows: overwhelmingly clean, a small percentage disputed.
// Attestations are attributed across DIVERSITY_TARGET_ISSUERS issuers so the
// corroboration ceiling is fully lifted and these tests isolate the misconduct
// rule they are actually about. Without attribution every one of them would be
// pinned at the uncorroborated ceiling and the monotonicity they assert would be
// invisible.
function highVolume(badCount, badKind = 'dispute', total = 2200) {
  const atts = [];
  for (let i = 0; i < total - badCount; i += 1) {
    atts.push({ kind: 'task_completed', created_at: fresh, verification_status: 'verified', issuer_id: `iss-${i % 4}` });
  }
  for (let i = 0; i < badCount; i += 1) {
    atts.push({ kind: badKind, created_at: fresh, verification_status: 'verified', issuer_id: `iss-${i % 4}` });
  }
  return atts;
}

test('a high-volume agent with a bad record cannot sit at a perfect 1000', () => {
  const atts = highVolume(100);
  const r = computeScore(atts, now);

  // Confirm we actually reproduced the precondition, otherwise this test would
  // pass for the wrong reason.
  assert.ok(
    r.breakdown.positive + r.breakdown.volumeBonus > 1000,
    'precondition: the positive side must overflow the ceiling, got ' +
      (r.breakdown.positive + r.breakdown.volumeBonus)
  );
  assert.ok(r.score < 1000, 'a disputed agent must not report a perfect score, got ' + r.score);
  assert.strictEqual(r.breakdown.boundBy, 'misconduct-ratio');
});

test('a spotless high-volume agent can still reach 1000', () => {
  const r = computeScore(highVolume(0), now);
  assert.strictEqual(r.score, 1000);
  assert.strictEqual(r.breakdown.integrityFactor, 1);
  assert.strictEqual(r.breakdown.boundBy, 'additive');
});

test('at equal volume, more misconduct always scores lower', () => {
  const scores = [0, 10, 50, 100, 200].map((bad) => computeScore(highVolume(bad), now).score);
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(
      scores[i] < scores[i - 1],
      'scores must decrease monotonically, got ' + scores.join(' > ')
    );
  }
});

test('misconduct cannot be diluted by piling on clean volume', () => {
  // Same 5% bad rate at two very different volumes. If the penalty were purely
  // additive against a clamped ceiling, the larger agent would look better.
  const small = computeScore(highVolume(15, 'dispute', 300), now).score;
  const large = computeScore(highVolume(500, 'dispute', 10000), now).score;
  assert.ok(
    Math.abs(large - small) < 120,
    'the same bad rate should score similarly regardless of volume, got ' +
      small + ' vs ' + large
  );
  assert.ok(large < 1000 && small < 1000);
});

test('severity is preserved: chargebacks cost more than disputes', () => {
  const disputed = computeScore(highVolume(60, 'dispute'), now).score;
  const chargedBack = computeScore(highVolume(60, 'chargeback'), now).score;
  assert.ok(
    chargedBack < disputed,
    'the same count of a heavier kind must score lower, got ' +
      chargedBack + ' vs ' + disputed
  );
});

test('the ratio discount is capped, so a score is never zeroed on ratio alone', () => {
  // An agent whose record is almost entirely misconduct still keeps a floor,
  // because reaching exactly 0 should require the additive path.
  const r = computeScore(highVolume(2100, 'chargeback', 2200), now);
  assert.ok(r.breakdown.integrityFactor >= 1 - MAX_INTEGRITY_DISCOUNT - 1e-9);
  assert.ok(r.score >= 0);
});

test('integrityFactor is 1 with no misconduct and falls as its share rises', () => {
  assert.strictEqual(integrityFactor(500, 0), 1);
  const light = integrityFactor(1000, -50);
  const heavy = integrityFactor(1000, -800);
  assert.ok(light < 1 && light > 0.9, 'a small share barely moves it, got ' + light);
  assert.ok(heavy < light, 'a larger share discounts more');
  assert.ok(heavy >= 1 - MAX_INTEGRITY_DISCOUNT, 'the discount stays capped');
});

test('the breakdown publishes every candidate score and which one bound', () => {
  const r = computeScore(highVolume(100), now);
  assert.strictEqual(typeof r.breakdown.additiveScore, 'number');
  assert.strictEqual(typeof r.breakdown.ratioScore, 'number');
  assert.strictEqual(typeof r.breakdown.corroborationCeiling, 'number');
  // The reported score is always the strictest bound, so each rule can only
  // ever lower a score relative to the model without it.
  assert.strictEqual(
    r.score,
    Math.min(
      r.breakdown.additiveScore,
      r.breakdown.ratioScore,
      r.breakdown.corroborationCeiling
    )
  );
  assert.strictEqual(
    r.breakdown.earnedScore,
    Math.min(r.breakdown.additiveScore, r.breakdown.ratioScore)
  );
  assert.ok(
    ['additive', 'misconduct-ratio', 'corroboration-ceiling'].includes(
      r.breakdown.boundBy
    )
  );
});

// ---------------------------------------------------------------------------
// Corroboration ceiling.
//
// These pin a second bug that was live: PER_ISSUER_VOLUME_CAP capped the volume
// bonus, but the volume bonus is only ~200 of a 1000-point scale and `positive`
// was never capped. So raw repetition of the cheapest possible input — an
// unverified peer_vouch, which needs no issuer, no signature and no credentials
// — still reached a perfect 1000 / PRIME. The #1 agent on the public
// leaderboard held 1000 on 2216 self-posted rows and 0 distinct issuers, and
// therefore the best risk rating the ERC-8126 adapter can emit plus the largest
// suggested spend ceiling.
// ---------------------------------------------------------------------------

function selfPosted(n, kind = 'peer_vouch') {
  return Array.from({ length: n }, () => ({
    kind,
    created_at: fresh,
    verification_status: 'unverified',
  }));
}

function corroborated(n, issuers, kind = 'clean_payment') {
  return Array.from({ length: n }, (_, i) => ({
    kind,
    created_at: fresh,
    verification_status: 'verified',
    issuer_id: `iss-${i % issuers}`,
  }));
}

test('self-reported history alone cannot buy the top tiers, at any volume', () => {
  const trustedThreshold = TIER_THRESHOLDS[3];
  for (const n of [200, 1000, 5000]) {
    const r = computeScore(selfPosted(n), now);
    assert.strictEqual(r.breakdown.distinctIssuers, 0);
    assert.ok(
      r.score < trustedThreshold,
      `${n} self-posted vouches must stay below TRUSTED, got ${r.score}`
    );
    assert.ok(r.tier <= 2, `tier must stay <= 2, got ${r.tier}`);
    // The engine must be honest that it clipped the result rather than quietly
    // reporting a lower number.
    assert.strictEqual(r.breakdown.boundBy, 'corroboration-ceiling');
    assert.strictEqual(r.breakdown.corroborationCapped, true);
    assert.ok(
      r.breakdown.earnedScore > r.score,
      'earnedScore should record what the raw history would have scored'
    );
  }
});

test('the uncorroborated ceiling is exactly UNCORROBORATED_CEILING', () => {
  const r = computeScore(selfPosted(5000), now);
  assert.strictEqual(r.score, UNCORROBORATED_CEILING);
  assert.strictEqual(r.breakdown.corroborationCeiling, UNCORROBORATED_CEILING);
});

test('each independent issuer lifts the ceiling, saturating at MAX_SCORE', () => {
  assert.strictEqual(corroborationCeiling(0), UNCORROBORATED_CEILING);
  assert.strictEqual(
    corroborationCeiling(1),
    UNCORROBORATED_CEILING + CEILING_LIFT_PER_ISSUER
  );
  assert.strictEqual(corroborationCeiling(4), MAX_SCORE);
  assert.strictEqual(corroborationCeiling(99), MAX_SCORE, 'saturates, never exceeds');
  assert.strictEqual(corroborationCeiling(-5), UNCORROBORATED_CEILING, 'negatives floor at 0 issuers');
  assert.strictEqual(corroborationCeiling(NaN), UNCORROBORATED_CEILING, 'non-finite floors at 0 issuers');
});

test('breadth across issuers is what unlocks PRIME, not volume', () => {
  // One issuer vouching 300 times cannot reach PRIME; four issuers can, on far
  // fewer attestations. That is the incentive the ceiling is meant to create.
  const oneIssuer = computeScore(corroborated(300, 1), now);
  const fourIssuers = computeScore(corroborated(120, 4), now);

  assert.strictEqual(oneIssuer.breakdown.distinctIssuers, 1);
  assert.strictEqual(fourIssuers.breakdown.distinctIssuers, 4);
  assert.ok(oneIssuer.tier < 4, 'a single issuer must not reach PRIME, got tier ' + oneIssuer.tier);
  assert.strictEqual(fourIssuers.tier, 4, 'four issuers should reach PRIME');
  assert.ok(fourIssuers.score > oneIssuer.score);
});

test('the ceiling never raises a score, only clips it', () => {
  // A modest corroborated history is nowhere near its ceiling, so the ceiling
  // must be inert — it is a bound, not a bonus.
  const r = computeScore(corroborated(6, 2), now);
  assert.ok(r.score < r.breakdown.corroborationCeiling);
  assert.strictEqual(r.score, r.breakdown.earnedScore);
  assert.strictEqual(r.breakdown.corroborationCapped, false);
  assert.notStrictEqual(r.breakdown.boundBy, 'corroboration-ceiling');
});

test('misconduct still binds when it is stricter than the ceiling', () => {
  // Fully corroborated (ceiling lifted to MAX_SCORE) but a bad record, so the
  // misconduct rule must be the one reported.
  const r = computeScore(highVolume(100), now);
  assert.strictEqual(r.breakdown.corroborationCeiling, MAX_SCORE);
  assert.strictEqual(r.breakdown.boundBy, 'misconduct-ratio');
  assert.ok(r.score < MAX_SCORE);
});

test('a new agent is unaffected by the ceiling', () => {
  const r = computeScore([], now);
  assert.strictEqual(r.score, 120);
  assert.strictEqual(r.breakdown.corroborationCapped, false);
});
