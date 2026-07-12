'use strict';

/**
 * Trust Score Engine — Kairune.
 *
 * Computes an agent's trust score (0..1000) from its attestation history.
 * The score is deterministic and can be re-verified from the raw data.
 *
 * Scoring philosophy:
 *  - Positive events (completed task, clean payment, peer vouch) raise the score.
 *  - Negative events (dispute, chargeback, anomaly) lower the score more sharply
 *    (asymmetric — trust is hard to build, easy to lose).
 *  - There is a volume factor (more clean activity means more trust) with
 *    diminishing returns (logarithmic) so it can't be spammed.
 *  - Recency: older events decay a little so the score reflects recent behavior.
 */

// Base weight for each attestation kind.
const KIND_WEIGHTS = Object.freeze({
  task_completed: 6,
  clean_payment: 8,
  peer_vouch: 14,
  dispute: -40,
  chargeback: -70,
  anomaly_flag: -90,
});

// Threshold for each tier. Array index = tier.
const TIER_THRESHOLDS = Object.freeze([0, 250, 500, 750, 900]);

const TIER_LABELS = Object.freeze([
  'UNRATED',
  'EMERGING',
  'ESTABLISHED',
  'TRUSTED',
  'PRIME',
]);

const MAX_SCORE = 1000;
const BASELINE = 120; // neutral starting score for a new agent
const HALF_LIFE_DAYS = 90; // events decay to half their weight every 90 days
const DEFAULT_UNVERIFIED_FACTOR = 0.25; // unverified attestations count at 25%

/**
 * Resolve the unverified weight factor from an explicit option or the
 * UNVERIFIED_WEIGHT_FACTOR env var, falling back to the default when invalid.
 * @param {number} [override]
 * @returns {number} factor in [0,1]
 */
function resolveUnverifiedFactor(override) {
  const raw =
    override !== undefined ? override : process.env.UNVERIFIED_WEIGHT_FACTOR;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_UNVERIFIED_FACTOR;
  return n;
}

/**
 * Decay factor based on the event's age (exponential decay).
 * @param {string} createdAt ISO timestamp
 * @param {number} now epoch ms
 * @returns {number} factor 0..1
 */
function recencyFactor(createdAt, now) {
  const ageMs = now - new Date(createdAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  const ageDays = ageMs / 86_400_000;
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/**
 * Determine the tier from a score.
 * @param {number} score
 * @returns {{ tier:number, label:string }}
 */
function tierForScore(score) {
  let tier = 0;
  for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
    if (score >= TIER_THRESHOLDS[i]) {
      tier = i;
      break;
    }
  }
  return { tier, label: TIER_LABELS[tier] };
}

/**
 * Compute the score from a list of attestations.
 * @param {Array<{kind:string, weight?:number, created_at:string, verification_status?:string}>} attestations
 * @param {number} [nowMs] time override (for tests)
 * @param {{unverifiedFactor?:number}} [opts]
 * @returns {{
 *   score:number, tier:number, label:string,
 *   breakdown: object, totals: object
 * }}
 */
function computeScore(attestations, nowMs, opts = {}) {
  const now = nowMs || Date.now();
  const unverifiedFactor = resolveUnverifiedFactor(opts.unverifiedFactor);

  let positive = 0;
  let negative = 0;
  let cleanCount = 0;
  let verifiedCount = 0;
  let unverifiedCount = 0;
  let excludedCount = 0;
  const counts = {};

  for (const att of attestations) {
    // Verification factor: verified counts fully, unverified is discounted,
    // any other status is excluded from the score entirely.
    const status =
      att.verification_status == null ? 'unverified' : att.verification_status;
    let vFactor;
    if (status === 'verified') {
      vFactor = 1.0;
      verifiedCount += 1;
    } else if (status === 'unverified') {
      vFactor = unverifiedFactor;
      unverifiedCount += 1;
    } else {
      excludedCount += 1;
      continue;
    }

    const base =
      typeof att.weight === 'number' && att.weight !== 0
        ? att.weight
        : KIND_WEIGHTS[att.kind] || 0;
    const decayed = base * recencyFactor(att.created_at, now) * vFactor;

    counts[att.kind] = (counts[att.kind] || 0) + 1;

    if (decayed >= 0) {
      positive += decayed;
      cleanCount += 1;
    } else {
      negative += decayed; // negatif
    }
  }

  // Volume bonus: rewards consistency, with diminishing returns via log.
  const volumeBonus = cleanCount > 0 ? Math.log10(cleanCount + 1) * 60 : 0;

  // Negative penalty is amplified (asymmetric).
  const rawScore = BASELINE + positive + volumeBonus + negative * 1.15;

  const score = Math.max(0, Math.min(MAX_SCORE, Math.round(rawScore)));
  const { tier, label } = tierForScore(score);

  return {
    score,
    tier,
    label,
    breakdown: {
      baseline: BASELINE,
      positive: Math.round(positive),
      volumeBonus: Math.round(volumeBonus),
      negative: Math.round(negative * 1.15),
      verifiedCount,
      unverifiedCount,
      excludedCount,
    },
    totals: {
      attestations: attestations.length,
      verified: verifiedCount,
      unverified: unverifiedCount,
      excluded: excludedCount,
      byKind: counts,
    },
  };
}

/**
 * Suggested daily spend ceiling (USD) based on the score.
 * The higher the tier, the larger the suggested limit.
 * @param {number} score
 * @returns {number}
 */
function suggestedDailyCeiling(score) {
  const { tier } = tierForScore(score);
  const table = [0, 50, 150, 420, 1200];
  return table[tier];
}

module.exports = {
  KIND_WEIGHTS,
  TIER_THRESHOLDS,
  TIER_LABELS,
  MAX_SCORE,
  BASELINE,
  DEFAULT_UNVERIFIED_FACTOR,
  computeScore,
  tierForScore,
  suggestedDailyCeiling,
  recencyFactor,
  resolveUnverifiedFactor,
};
