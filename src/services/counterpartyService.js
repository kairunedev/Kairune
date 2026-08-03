'use strict';

/**
 * Counterparty check — Kairune.
 *
 * The single call an agent makes *before it pays another agent*.
 *
 * Kairune's other endpoints answer "how trustworthy is this agent?" one
 * dimension at a time (score, tier, rank, diversity, spend budget). An agent
 * about to transact with a stranger doesn't want five reads and a decision
 * tree — it wants one go / no-go. This composes every trust primitive Kairune
 * already computes into a single verdict:
 *
 *   proceed  — safe to transact up to the recommended amount
 *   review   — transact with caution / a human-in-the-loop / a smaller amount
 *   decline  — do not transact
 *
 * Built for agent-to-agent commerce (e.g. Virtuals' ACP): the payer names a
 * counterparty (and optionally how much it intends to spend), and gets back a
 * verdict plus the exact checks that produced it — no hidden scoring.
 *
 * Fully deterministic and read-only: the verdict is a pure function of the
 * counterparty's stored profile and its raw attestation history, so it is
 * reproducible and testable without touching the database or any clock beyond
 * the one passed in.
 */

const {
  tierForScore,
  suggestedDailyCeiling,
  TIER_LABELS,
  MAX_SCORE,
} = require('./trustScore');
const { computeDiversity } = require('./issuerDiversity');

// Negatives older than this no longer force a verdict downgrade on their own —
// they have already been priced into the decayed score. Matches the score
// engine's half-life so the two views of "recent" agree.
const NEGATIVE_LOOKBACK_DAYS = 90;

// A recent chargeback or anomaly flag is a hard stop: these are the events that
// mean "this counterparty has already burned someone", not just "unproven".
const SEVERE_NEGATIVE_KINDS = ['chargeback', 'anomaly_flag'];

// A recent dispute is a caution, not a hard stop.
const CAUTION_NEGATIVE_KINDS = ['dispute'];

// Verified trust concentrated below this confidence looks farmable (one issuer
// vouching for itself). Above it, the trust is spread across enough independent
// issuers to be credible. Expressed on the same 0..100 scale computeDiversity
// returns.
const MIN_TRUST_INDEPENDENCE = 20;

const VERDICT_RANK = { proceed: 0, review: 1, decline: 2 };

/**
 * Combine two verdicts, keeping the more cautious one.
 * @param {'proceed'|'review'|'decline'} a
 * @param {'proceed'|'review'|'decline'} b
 * @returns {'proceed'|'review'|'decline'}
 */
function worse(a, b) {
  return VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a;
}

/**
 * Count negative attestations of the given kinds inside the lookback window.
 * @param {Array<object>} attestations rows: { kind, created_at }
 * @param {string[]} kinds
 * @param {number} nowMs
 * @returns {number}
 */
function countRecentNegatives(attestations, kinds, nowMs) {
  const cutoff = nowMs - NEGATIVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  let n = 0;
  for (const att of attestations) {
    if (!kinds.includes(att.kind)) continue;
    const t = Date.parse(att.created_at);
    // A row with an unparseable/absent timestamp is treated as recent (safe
    // default: a negative we cannot date should still count against trust).
    if (Number.isNaN(t) || t >= cutoff) n += 1;
  }
  return n;
}

/**
 * Assess whether it is safe to transact with a counterparty agent.
 *
 * Pure: no I/O, no mutation. The caller supplies the counterparty's stored
 * profile and its raw attestation rows (the same projection the score engine
 * consumes) plus an optional intended `amount`.
 *
 * The verdict starts at `proceed` and is only ever downgraded by a check that
 * fires. Each check is reported explicitly in `checks[]` with a pass/warn/fail
 * status and a human-readable detail, so a caller can show *why*, not just the
 * answer. `reasons[]` is the machine-readable subset (codes of every check
 * that did not pass), ordered worst-first.
 *
 * @param {object|null} agent stored agent row, or null when unregistered
 * @param {Array<{kind:string, created_at:string, verification_status?:string, issuer_id?:string|null}>} attestations
 * @param {{amount?:number|null, nowMs?:number, wallet?:string|null}} [opts]
 * @returns {object} verdict payload
 */
function assessCounterparty(agent, attestations = [], opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const rawAmount = opts.amount == null ? null : Number(opts.amount);
  const amount =
    rawAmount != null && Number.isFinite(rawAmount) && rawAmount > 0
      ? rawAmount
      : null;

  const checks = [];
  let verdict = 'proceed';

  const add = (id, label, status, detail) => {
    checks.push({ id, label, status, detail });
    if (status === 'fail') verdict = worse(verdict, 'decline');
    else if (status === 'warn') verdict = worse(verdict, 'review');
  };

  // ── Unregistered counterparty ────────────────────────────────────────────
  // A valid-but-unknown counterparty is not an error; it is the single most
  // important answer this endpoint gives: "you have no basis to trust this".
  if (!agent) {
    add(
      'registration',
      'Registered in Kairune',
      'fail',
      'Counterparty is not registered in the trust registry — no history to judge.'
    );
    return {
      registered: false,
      wallet: opts.wallet ? String(opts.wallet).toLowerCase() : null,
      requested_amount: amount,
      verdict: 'decline',
      trust_independence: 0,
      suggested_max_amount: 0,
      within_suggested_ceiling: amount == null ? null : false,
      reasons: ['not_registered'],
      checks,
      signals: null,
    };
  }

  const score = Number(agent.score) || 0;
  const { tier, label } = tierForScore(score);
  const suggestedMax = suggestedDailyCeiling(score);
  const diversity = computeDiversity(attestations);

  add(
    'registration',
    'Registered in Kairune',
    'pass',
    `Known agent @${agent.handle}, scored ${score}/${MAX_SCORE}.`
  );

  // ── Account status ────────────────────────────────────────────────────────
  if (agent.status !== 'active') {
    add(
      'status',
      'Account active',
      'fail',
      `Counterparty status is "${agent.status}" — suspended agents must not be paid.`
    );
  } else {
    add('status', 'Account active', 'pass', 'Counterparty account is active.');
  }

  // ── Recent severe negatives (chargeback / anomaly) — hard stop ─────────────
  const severe = countRecentNegatives(attestations, SEVERE_NEGATIVE_KINDS, nowMs);
  if (severe > 0) {
    add(
      'clean_history',
      'No recent chargebacks or anomalies',
      'fail',
      `${severe} chargeback/anomaly event(s) in the last ${NEGATIVE_LOOKBACK_DAYS} days.`
    );
  } else {
    const disputes = countRecentNegatives(attestations, CAUTION_NEGATIVE_KINDS, nowMs);
    if (disputes > 0) {
      add(
        'clean_history',
        'No recent disputes',
        'warn',
        `${disputes} dispute(s) in the last ${NEGATIVE_LOOKBACK_DAYS} days — transact with caution.`
      );
    } else {
      add(
        'clean_history',
        'No recent negative events',
        'pass',
        `No disputes, chargebacks, or anomalies in the last ${NEGATIVE_LOOKBACK_DAYS} days.`
      );
    }
  }

  // ── Trust tier ─────────────────────────────────────────────────────────────
  // Tier 0 (UNRATED) means there is no established trust to lean on — declining
  // is the honest default; the payer can still choose to proceed at their own
  // risk after a manual review, but the verdict should say "no".
  if (tier <= 0) {
    add(
      'tier',
      'Established trust tier',
      'fail',
      `Counterparty is ${TIER_LABELS[0]} (tier 0) — no established trust.`
    );
  } else if (tier === 1) {
    add(
      'tier',
      'Established trust tier',
      'warn',
      `Counterparty is ${label} (tier 1) — emerging trust, review larger amounts.`
    );
  } else {
    add(
      'tier',
      'Established trust tier',
      'pass',
      `Counterparty is ${label} (tier ${tier}).`
    );
  }

  // ── Trust independence (anti-farming) ──────────────────────────────────────
  // A high score built on a single issuer's attestations is a collusion risk.
  // Only flag it when the agent actually claims verified trust — a purely
  // self-reported agent is already caught by its low tier above.
  if (diversity.verified_count > 0 && diversity.confidence < MIN_TRUST_INDEPENDENCE) {
    add(
      'trust_independence',
      'Independent trust sources',
      'warn',
      `Verified trust is concentrated (independence ${diversity.confidence}/100 across ` +
        `${diversity.distinct_issuers} issuer(s)) — could be self-dealt.`
    );
  } else {
    add(
      'trust_independence',
      'Independent trust sources',
      'pass',
      `Verified trust spans ${diversity.distinct_issuers} independent issuer(s) ` +
        `(independence ${diversity.confidence}/100).`
    );
  }

  // ── Exposure vs recommended ceiling (only when an amount is supplied) ──────
  let withinCeiling = null;
  if (amount != null) {
    withinCeiling = amount <= suggestedMax;
    if (!withinCeiling) {
      add(
        'exposure',
        'Within recommended exposure',
        'warn',
        `Requested $${amount} exceeds the recommended max of $${suggestedMax} for a ` +
          `${label} counterparty — split the transaction or review it.`
      );
    } else {
      add(
        'exposure',
        'Within recommended exposure',
        'pass',
        `Requested $${amount} is within the recommended max of $${suggestedMax}.`
      );
    }
  }

  const reasons = checks
    .filter((c) => c.status !== 'pass')
    .sort((a, b) => (a.status === 'fail' ? -1 : 1) - (b.status === 'fail' ? -1 : 1))
    .map((c) => c.id);

  return {
    registered: true,
    counterparty: {
      agent_id: agent.id,
      handle: agent.handle,
      wallet: agent.wallet ?? null,
      status: agent.status,
      score,
      tier,
      tier_label: label,
      max_score: MAX_SCORE,
    },
    requested_amount: amount,
    verdict,
    trust_independence: diversity.confidence,
    suggested_max_amount: suggestedMax,
    within_suggested_ceiling: withinCeiling,
    reasons,
    checks,
    signals: {
      tier,
      trust_independence: diversity.confidence,
      distinct_issuers: diversity.distinct_issuers,
      verified_count: diversity.verified_count,
      unverified_count: diversity.unverified_count,
      recent_severe_negatives: severe,
      recent_disputes: countRecentNegatives(attestations, CAUTION_NEGATIVE_KINDS, nowMs),
      negative_lookback_days: NEGATIVE_LOOKBACK_DAYS,
    },
  };
}

module.exports = {
  NEGATIVE_LOOKBACK_DAYS,
  SEVERE_NEGATIVE_KINDS,
  CAUTION_NEGATIVE_KINDS,
  MIN_TRUST_INDEPENDENCE,
  assessCounterparty,
};
