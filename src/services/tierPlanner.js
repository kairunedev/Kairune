'use strict';

/**
 * Tier Planner — Kairune.
 *
 * `GET /api/agents/:id/tier` tells an agent how many points stand between it
 * and the next tier. It does not tell it *what to do*. This module answers the
 * follow-up question an autonomous agent actually needs answered:
 *
 *   "What is the shortest honest path from where I am to the next tier,
 *    and what would knock me back down?"
 *
 * Why this cannot be simple arithmetic
 * ------------------------------------
 * You cannot just divide points_to_next by a kind's weight. The score engine
 * applies, in order: per-attestation recency decay, a verification factor
 * (unverified counts at 25%), a logarithmic volume bonus with a per-issuer cap,
 * and a 1.15x amplification on negatives. Those interact — the 10th clean
 * payment is worth less than the 1st because the volume bonus is logarithmic.
 *
 * So instead of approximating, the planner *simulates*: it appends hypothetical
 * attestations to the agent's real history and re-runs the real `computeScore`
 * until the target is crossed. The answer is therefore exact by construction
 * and stays correct automatically if the scoring weights ever change.
 *
 * Everything here is read-only and deterministic. Nothing is persisted and no
 * stored score is mutated — this is a projection, not a write.
 */

const {
  KIND_WEIGHTS,
  TIER_THRESHOLDS,
  TIER_LABELS,
  MAX_SCORE,
  computeScore,
} = require('./trustScore');

// Hard stop on the simulation loop. Any honest path to the next tier is far
// shorter than this; hitting the cap means the target is not reachable by that
// route alone (e.g. an agent deep enough in negatives that one kind of clean
// event cannot dig it out before the log volume bonus flattens).
const MAX_SIMULATED_EVENTS = 400;

// Issuer id prefix for simulated verified attestations. Each simulated event
// gets its own issuer so the per-issuer volume cap never artificially throttles
// the projection — the plan answers "how few events could do this".
const SIM_ISSUER_PREFIX = '__sim_issuer__';

// Positive kinds are routes to the next tier. Negative kinds are risks to the
// current one. They are reported separately because they answer different
// questions.
const POSITIVE_KINDS = Object.freeze(
  Object.keys(KIND_WEIGHTS).filter((k) => KIND_WEIGHTS[k] > 0)
);

const NEGATIVE_KINDS = Object.freeze(
  Object.keys(KIND_WEIGHTS).filter((k) => KIND_WEIGHTS[k] < 0)
);

/**
 * Build a hypothetical attestation shaped exactly like the rows computeScore
 * reads from the DB. created_at is "now" so the simulated event carries zero
 * decay — the projection is therefore a best-case-timing answer (act now),
 * not an arbitrary one.
 *
 * @param {string} kind
 * @param {'verified'|'unverified'} status
 * @param {string|null} issuerId
 * @param {string} nowIso
 */
function hypothetical(kind, status, issuerId, nowIso) {
  return {
    kind,
    weight: KIND_WEIGHTS[kind],
    created_at: nowIso,
    verification_status: status,
    issuer_id: status === 'verified' ? issuerId : null,
  };
}

/**
 * Smallest number of identical hypothetical attestations that moves the score
 * across `target`, found by re-running the real scoring engine.
 *
 * Linear rather than binary search on purpose: each step is cheap, the counts
 * that matter are small, and a linear scan stays obviously correct against a
 * non-linear (log-volume, per-issuer-capped) scoring function without assuming
 * anything about its shape beyond monotonicity in the event count.
 *
 * @param {object[]} history real attestation rows
 * @param {number} target score to reach
 * @param {(i:number)=>object} makeEvent factory for the i-th simulated event
 * @param {number} nowMs fixed clock so every simulation is comparable
 * @returns {{count:number, score:number}|null} null when unreachable within MAX_SIMULATED_EVENTS
 */
function eventsToReach(history, target, makeEvent, nowMs) {
  const simulated = [];
  for (let i = 0; i < MAX_SIMULATED_EVENTS; i++) {
    simulated.push(makeEvent(i));
    const { score } = computeScore([...history, ...simulated], nowMs);
    if (score >= target) return { count: simulated.length, score };
  }
  return null;
}

/**
 * Smallest number of identical negative attestations that drops the score below
 * `floor` — i.e. what it would take to lose the current tier.
 *
 * Verified negatives are simulated because they carry full weight: an agent
 * planning around risk wants the worst case, not the discounted one.
 *
 * @param {object[]} history
 * @param {number} floor score to fall below
 * @param {string} kind negative attestation kind
 * @param {number} nowMs
 * @returns {{count:number, score:number}|null}
 */
function eventsToFallBelow(history, floor, kind, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const simulated = [];
  for (let i = 0; i < MAX_SIMULATED_EVENTS; i++) {
    simulated.push(hypothetical(kind, 'verified', `${SIM_ISSUER_PREFIX}${i}`, nowIso));
    const { score } = computeScore([...history, ...simulated], nowMs);
    if (score < floor) return { count: simulated.length, score };
  }
  return null;
}

/**
 * Plan an agent's route to the next trust tier from its real attestation
 * history.
 *
 * Returns three things an agent can act on:
 *
 *  1. `paths` — for each positive attestation kind, how many events it takes
 *     to reach the next tier, verified vs unverified. Unverified attestations
 *     count at 25%, so the gap between the two columns is the cost of not
 *     getting an issuer to sign — expressed as a number instead of a lecture.
 *
 *  2. `risks` — for each negative kind, how many would drop the agent out of
 *     its current tier. Small numbers here are the real story: trust is
 *     asymmetric, and this quantifies the asymmetry per agent.
 *
 *  3. `fastest` — the single cheapest route across all paths, so an agent that
 *     just wants an instruction gets one without ranking anything itself.
 *
 * At PRIME there is no next tier: `paths` is empty and `target` is null, but
 * `risks` is still computed (the top tier is the one with the most to lose).
 *
 * @param {object} agent agent row (needs score + tier)
 * @param {object[]} history real attestation rows for the agent
 * @param {number} [nowMs] clock override for tests
 */
function planNextTier(agent, history, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowIso = new Date(now).toISOString();
  const rows = Array.isArray(history) ? history : [];

  // The stored score is the one every public surface shows, so the plan is
  // anchored to it. We recompute here too, purely to report drift when the
  // stored score is stale relative to the raw rows.
  const storedScore = Number(agent.score) || 0;
  const storedTier = Number(agent.tier) || 0;
  const live = computeScore(rows, now);

  const isTop = storedTier >= TIER_THRESHOLDS.length - 1;
  const nextTier = isTop ? null : storedTier + 1;
  const target = isTop ? null : TIER_THRESHOLDS[storedTier + 1];
  const tierFloor = TIER_THRESHOLDS[storedTier] ?? 0;

  const paths = [];
  if (target !== null) {
    for (const kind of POSITIVE_KINDS) {
      const verified = eventsToReach(
        rows,
        target,
        (i) => hypothetical(kind, 'verified', `${SIM_ISSUER_PREFIX}${i}`, nowIso),
        now
      );
      const unverified = eventsToReach(
        rows,
        target,
        () => hypothetical(kind, 'unverified', null, nowIso),
        now
      );

      paths.push({
        kind,
        weight: KIND_WEIGHTS[kind],
        verified_events: verified ? verified.count : null,
        unverified_events: unverified ? unverified.count : null,
        // Where the score actually lands via the verified route. Usually a
        // little past the threshold, because events are discrete.
        projected_score: verified ? verified.score : null,
      });
    }

    // Cheapest first, so paths[0] is always the recommendation. Unreachable
    // routes (null) sort last rather than pretending to be free.
    paths.sort((a, b) => {
      const av = a.verified_events ?? Infinity;
      const bv = b.verified_events ?? Infinity;
      return av - bv;
    });
  }

  const risks = NEGATIVE_KINDS.map((kind) => {
    // Only meaningful when there is a floor to fall below. UNRATED (tier 0)
    // has a floor of 0 and the score is clamped at 0, so it cannot be lost.
    const drop =
      storedTier > 0 ? eventsToFallBelow(rows, tierFloor, kind, now) : null;
    return {
      kind,
      weight: KIND_WEIGHTS[kind],
      events_to_lose_tier: drop ? drop.count : null,
      projected_score: drop ? drop.score : null,
    };
  });

  const cheapest = paths.find((p) => p.verified_events !== null) || null;

  return {
    handle: agent.handle,
    score: storedScore,
    tier: storedTier,
    label: TIER_LABELS[storedTier] || 'UNRATED',
    tier_floor: tierFloor,
    next_tier: nextTier,
    next_label: nextTier === null ? null : TIER_LABELS[nextTier] || null,
    target_score: target,
    points_to_next: target === null ? 0 : Math.max(0, target - storedScore),
    at_top_tier: isTop,
    max_score: MAX_SCORE,
    // Reported so a caller can tell the plan was built from history that no
    // longer matches the stored score (stale rescore) instead of guessing.
    live_score: live.score,
    score_is_stale: live.score !== storedScore,
    attestations_considered: rows.length,
    fastest: cheapest
      ? {
          kind: cheapest.kind,
          verified_events_needed: cheapest.verified_events,
          unverified_events_needed: cheapest.unverified_events,
        }
      : null,
    paths,
    risks,
  };
}

module.exports = {
  MAX_SIMULATED_EVENTS,
  POSITIVE_KINDS,
  NEGATIVE_KINDS,
  planNextTier,
};
