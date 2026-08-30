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

// Anti-farming volume cap. The volume bonus rewards consistent clean activity,
// but that is exactly the lever an agent could farm by having one friendly
// issuer vouch for it over and over. So each individual issuer's clean
// attestations contribute to the volume bonus only up to this cap. A single
// issuer vouching 1000× therefore counts the same as vouching this many times;
// to grow the volume bonus further you need *breadth* across independent
// issuers. At low volume the cap does not bite, so a legitimate first verified
// attestation still outscores an unverified one.
const PER_ISSUER_VOLUME_CAP = 25;

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
 * Epoch ms for an attestation row's created_at, memoised per row object.
 *
 * Parsing ISO strings dominates scoring cost when the same rows are scored
 * repeatedly — the tier planner rescores one agent's history ~90 times to
 * project its route to the next tier, and `Date` parsing accounted for nearly
 * all of that time. Keying on the row object means the cache only helps when
 * rows are genuinely reused and never grows for one-shot reads.
 *
 * The cached string is stored alongside the timestamp and re-checked, so a row
 * whose created_at is reassigned is re-parsed rather than served stale. A
 * WeakMap keeps this from retaining rows past their normal lifetime.
 *
 * @param {object} att attestation row
 * @param {string} createdAt the row's created_at, already resolved by the caller
 * @returns {number} epoch ms (NaN for unparseable input, as Date would give)
 */
const createdAtMsCache = new WeakMap();

function createdAtMs(att, createdAt) {
  const hit = createdAtMsCache.get(att);
  if (hit !== undefined && hit.iso === createdAt) return hit.ms;
  const ms = new Date(createdAt).getTime();
  createdAtMsCache.set(att, { iso: createdAt, ms });
  return ms;
}

/**
 * Decay factor for a row, using the memoised timestamp.
 * Identical arithmetic to recencyFactor — only the parse is shared.
 * @param {object} att attestation row
 * @param {number} now epoch ms
 * @returns {number} factor 0..1
 */
function rowRecencyFactor(att, now) {
  const createdAt = att.created_at;
  // Only objects can key a WeakMap; anything else falls back to a plain parse.
  const ms =
    att !== null && typeof att === 'object'
      ? createdAtMs(att, createdAt)
      : new Date(createdAt).getTime();
  const ageMs = now - ms;
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / 86_400_000 / HALF_LIFE_DAYS);
}

/**
 * Effective clean-attestation count that feeds the volume bonus, after
 * capping each issuer's contribution. Verified clean attestations from any
 * one issuer count only up to PER_ISSUER_VOLUME_CAP; clean attestations with
 * no issuer (unverified / legacy) are passed through uncapped so behavior for
 * data without issuer attribution is unchanged.
 *
 * This is the anti-farming lever: a single issuer vouching thousands of times
 * cannot inflate the volume bonus beyond the cap — growth requires breadth
 * across independent issuers.
 *
 * @param {number} uncappedClean clean attestations with no issuer_id
 * @param {Map<string, number>} cleanByIssuer issuer_id -> clean verified count
 * @returns {number} effective clean count for the volume bonus
 */
function cappedVolumeCount(uncappedClean, cleanByIssuer) {
  let total = uncappedClean;
  for (const count of cleanByIssuer.values()) {
    total += Math.min(count, PER_ISSUER_VOLUME_CAP);
  }
  return total;
}

// Misconduct is also priced as a *share* of an agent's record, not only as an
// absolute deduction, because an absolute deduction stops meaning anything once
// the positive side overflows the ceiling.
//
// That was a live bug: agents had accumulated a positive contribution several
// times MAX_SCORE, so subtracting a four-figure penalty still landed above 1000
// and the clamp quietly discarded it. Agents with a ~4-5% dispute-and-chargeback
// rate reported a perfect 1000 / PRIME, and therefore the best risk rating
// ERC-8126 has. The share survives the clamp because it is multiplicative.
//
// The denominator is the agent's total signal, so the factor is volume-
// normalised: a large honest operator is not punished merely for having had
// enough history to collect one dispute. INTEGRITY_SMOOTHING is a Laplace-style
// prior that keeps a single bad event from being fatal for an agent with almost
// no record.
//
// It reads the already-signed weights rather than a count of bad events, so
// severity is preserved: a chargeback (-70) costs more than a dispute (-40).
const INTEGRITY_SMOOTHING = 60;
const INTEGRITY_SLOPE = 1.5;
const MAX_INTEGRITY_DISCOUNT = 0.9; // never zero out a score on ratio alone

/**
 * Multiplier in [1 - MAX_INTEGRITY_DISCOUNT, 1] reflecting how much of an
 * agent's total attestation weight is misconduct.
 * @param {number} positive summed positive weight (decayed)
 * @param {number} negativeAmplified summed negative weight (decayed, amplified)
 * @returns {number} factor 0.1..1
 */
function integrityFactor(positive, negativeAmplified) {
  const badWeight = Math.abs(negativeAmplified);
  if (badWeight === 0) return 1;
  const goodWeight = Math.max(0, positive);
  const share = badWeight / (goodWeight + badWeight + INTEGRITY_SMOOTHING);
  return 1 - Math.min(MAX_INTEGRITY_DISCOUNT, share * INTEGRITY_SLOPE);
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

function labelFor(score) {
  return tierForScore(score).label;
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
  // Track clean (positive) attestations per issuer so a single issuer cannot
  // farm the volume bonus. Clean attestations without an issuer are counted
  // uncapped (legacy / unverified behavior is preserved).
  const cleanByIssuer = new Map();
  let uncappedClean = 0;

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
    const decayed = base * rowRecencyFactor(att, now) * vFactor;

    counts[att.kind] = (counts[att.kind] || 0) + 1;

    if (decayed >= 0) {
      positive += decayed;
      cleanCount += 1;
      // Attribute this clean event to its issuer for the per-issuer cap.
      if (status === 'verified' && att.issuer_id) {
        cleanByIssuer.set(
          att.issuer_id,
          (cleanByIssuer.get(att.issuer_id) || 0) + 1
        );
      } else {
        uncappedClean += 1;
      }
    } else {
      negative += decayed; // negatif
    }
  }

  // Volume bonus: rewards consistency, with diminishing returns via log.
  // Each issuer's clean attestations are capped so a single issuer cannot farm
  // the bonus; growth beyond the cap requires breadth across issuers.
  const effectiveClean = cappedVolumeCount(uncappedClean, cleanByIssuer);
  const volumeBonus = effectiveClean > 0 ? Math.log10(effectiveClean + 1) * 60 : 0;

  // Negative penalty is amplified (asymmetric).
  const negativeAmplified = negative * 1.15;
  const rawScore = BASELINE + positive + volumeBonus + negativeAmplified;

  // Two ways to price misconduct, and the stricter one wins.
  //
  // The additive path is the original model. The ratio path clamps the positive
  // side FIRST and then scales it, which is what makes the penalty survive the
  // ceiling. Taking the minimum means this can only ever lower a score relative
  // to the additive model, so no agent is handed trust it had not already
  // earned — the change is safe to apply to a live registry.
  const additiveScore = Math.max(0, Math.min(MAX_SCORE, Math.round(rawScore)));
  const integrity = integrityFactor(positive, negativeAmplified);
  const ratioScore = Math.max(
    0,
    Math.min(
      MAX_SCORE,
      Math.round(
        Math.min(MAX_SCORE, BASELINE + Math.max(0, positive) + volumeBonus) *
          integrity
      )
    )
  );

  const score = Math.min(additiveScore, ratioScore);
  const { tier, label } = tierForScore(score);

  return {
    score,
    tier,
    label,
    breakdown: {
      baseline: BASELINE,
      positive: Math.round(positive),
      volumeBonus: Math.round(volumeBonus),
      negative: Math.round(negativeAmplified),
      verifiedCount,
      unverifiedCount,
      excludedCount,
      distinctIssuers: cleanByIssuer.size,
      effectiveCleanVolume: effectiveClean,
      // Both candidates are published so a reader can see which rule bound the
      // score, rather than having to reverse-engineer it from the total.
      integrityFactor: Math.round(integrity * 1000) / 1000,
      additiveScore,
      ratioScore,
      boundBy: ratioScore < additiveScore ? 'misconduct-ratio' : 'additive',
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

// ---------------------------------------------------------------------------
// ERC-8126 derived risk — NOT a compliance claim.
//
// ERC-8126 risk is 0..100 where 0 = lowest risk. Kairune score is 0..1000
// where high = good, so this is an inverted, clamped mapping for
// interoperability (e.g. minVerificationScore-style policies). No ETV/MCV/
// SCV/WAV/WV, no PDV/ZKP, no ERC-8004 tokenId is claimed here.
// ---------------------------------------------------------------------------
function erc8126DerivedRiskScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(0, Math.min(MAX_SCORE, Math.round(n)));
  return Math.max(0, Math.min(100, 100 - Math.round(clamped / 10)));
}

function erc8126RiskTier(risk) {
  const n = Number(risk);
  if (!Number.isFinite(n)) return null;
  if (n <= 20) return 'Low';
  if (n <= 40) return 'Moderate';
  if (n <= 60) return 'Elevated';
  if (n <= 80) return 'High';
  return 'Critical';
}

module.exports = {
  KIND_WEIGHTS,
  TIER_THRESHOLDS,
  TIER_LABELS,
  MAX_SCORE,
  BASELINE,
  DEFAULT_UNVERIFIED_FACTOR,
  PER_ISSUER_VOLUME_CAP,
  INTEGRITY_SMOOTHING,
  INTEGRITY_SLOPE,
  MAX_INTEGRITY_DISCOUNT,
  computeScore,
  tierForScore,
  labelFor,
  suggestedDailyCeiling,
  cappedVolumeCount,
  integrityFactor,
  recencyFactor,
  resolveUnverifiedFactor,
  erc8126DerivedRiskScore,
  erc8126RiskTier,
};
