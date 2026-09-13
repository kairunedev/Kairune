'use strict';

/**
 * Counterparty exposure — joins the two halves of the product.
 *
 * The registry already answers each half in isolation:
 *   - `spendService.spendSummary(...).by_payee` says HOW MUCH this agent has
 *     paid each named counterparty over a window.
 *   - `agentService.checkCounterparty(ref)` says whether a single counterparty
 *     is SAFE TO PAY right now.
 *
 * Nothing joins them, so the one question an operator most needs after the fact
 * has no answer today: "how much of my spend is riding on counterparties that
 * have since become risky?" A payee that cleared cleanly at grant time can
 * collect a chargeback or get suspended a week later; the money already spent
 * doesn't move, but the exposure it represents just changed.
 *
 * This module recomputes a live verdict for every payee the agent has actually
 * paid, attaches each payee's spend total and share of the agent's outbound
 * spend, and surfaces two things that matter:
 *   - concentration: a single payee holding a large share of total spend
 *   - drift:         a payee whose live verdict is now `review` or `decline`
 *
 * It is read-only, persists nothing, and reuses the exact assessment the
 * counterparty endpoint uses, so a payee flagged here would be flagged there.
 *
 * A payee reference is whatever was recorded on the spend row (`spends.payee`):
 * usually a wallet, sometimes a handle or agent id. `checkCounterparty` already
 * resolves all three. An unregistered wallet is not an error — it comes back
 * with `registered:false` and a `decline` verdict, which is itself a finding:
 * you've been paying an address with no trust basis at all.
 */

const spendService = require('./spendService');
const agentService = require('./agentService');

// A payee holding at least this share of the agent's total outbound spend is
// flagged as a concentration risk regardless of its verdict. 0.5 = "more than
// half of everything you spent went to one counterparty" — an operator should
// know that even when the counterparty is perfectly healthy, because it is a
// single point of failure for the agent's whole spend program.
const CONCENTRATION_SHARE = 0.5;

// Verdicts that count as "risky" for the exposure rollup. Mirrors the spend
// gate's blocking set conceptually, but review is included here on purpose:
// unlike the write-time gate (which must decide allow/deny), this is a report,
// and "you should look at this" is exactly what it exists to say.
const RISKY_VERDICTS = Object.freeze(['review', 'decline']);

// Cap how many distinct payees we assess in one call. Each payee is one profile
// read + one attestation read (via checkCounterparty), so this bounds the fan-
// out and stops the endpoint being used to sweep the registry. The busiest
// real agents pay a handful of counterparties; 50 is generous headroom.
const MAX_PAYEES_ASSESSED = 50;

/**
 * Clamp the requested payee count into [1, MAX_PAYEES_ASSESSED].
 * @param {*} raw
 * @returns {number}
 */
function clampPayees(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return MAX_PAYEES_ASSESSED;
  return Math.min(Math.max(1, Math.floor(n)), MAX_PAYEES_ASSESSED);
}

/**
 * Build a counterparty-exposure report for one agent.
 *
 * @param {string} agentId  the paying agent's id
 * @param {object} [opts]
 * @param {string} [opts.since]  ISO-ish lower bound (inclusive) for spend window
 * @param {string} [opts.until]  ISO-ish upper bound (exclusive) for spend window
 * @param {*} [opts.topPayees]   max distinct payees to assess (clamped)
 * @param {number} [opts.nowMs]  clock override, for deterministic assessment
 * @returns {Promise<object>} the exposure report
 */
async function agentExposure(agentId, opts = {}) {
  const limit = clampPayees(opts.topPayees);

  // Pull the spend rollup. by_payee is already ordered by total DESC and
  // excludes unnamed charges (an unnamed charge has no counterparty to assess),
  // but `total` below still counts them, so shares are honest.
  const summary = await spendService.spendSummary(agentId, {
    since: opts.since,
    until: opts.until,
    topPayees: limit,
  });

  const totalSpend = summary.total;

  // Assess each payee. These are independent reads, so run them together rather
  // than serially — one round of profile+attestation lookups per payee.
  const payees = await Promise.all(
    summary.by_payee.map(async (p) => {
      const verdict = await agentService.checkCounterparty(p.payee, {
        nowMs: opts.nowMs,
      });

      // A share of 0 when there is no spend at all, rather than dividing by
      // zero. by_payee can't be non-empty with a zero total, but guard anyway.
      const share = totalSpend > 0 ? p.total / totalSpend : 0;

      // checkCounterparty returns null only for an unresolvable non-wallet ref
      // (a handle/id that isn't in the registry). Recorded payees are usually
      // wallets, which always resolve (to registered:false if unknown), but a
      // handle that was later deleted could land here. Treat it as "cannot
      // assess" rather than dropping the row, so the spend is still visible.
      const unresolved = verdict === null;
      const effectiveVerdict = unresolved ? 'unknown' : verdict.verdict;

      return {
        payee: p.payee,
        total: p.total,
        count: p.count,
        last_spend_at: p.last_spend_at,
        share_of_spend: Math.round(share * 10000) / 10000,
        registered: unresolved ? false : verdict.registered,
        verdict: effectiveVerdict,
        // Only meaningful for a registered counterparty; null otherwise so a
        // caller never reads a fabricated score for an unknown address.
        counterparty:
          unresolved || !verdict.registered
            ? null
            : {
                agent_id: verdict.counterparty.agent_id,
                handle: verdict.counterparty.handle,
                status: verdict.counterparty.status,
                score: verdict.counterparty.score,
                tier: verdict.counterparty.tier,
                tier_label: verdict.counterparty.tier_label,
              },
        // The concrete reasons behind a non-proceed verdict, so the report is
        // actionable without a second call. Empty for a clean payee.
        reasons: unresolved ? ['not_registered'] : verdict.reasons,
        concentration: share >= CONCENTRATION_SHARE,
        risky: unresolved ? true : RISKY_VERDICTS.includes(verdict.verdict),
      };
    })
  );

  // Roll up the exposure that lands on risky payees — the headline number an
  // operator wants: "$X of your spend is on counterparties that are not clear".
  const risky = payees.filter((p) => p.risky);
  const riskyTotal = risky.reduce((sum, p) => sum + p.total, 0);
  const concentrated = payees.filter((p) => p.concentration);

  return {
    agent_id: agentId,
    since: summary.since,
    until: summary.until,
    total_spend: totalSpend,
    spend_count: summary.count,
    payees_assessed: payees.length,
    // Money on counterparties whose live verdict is review/decline (or that
    // can't be resolved), plus its share of total spend.
    risky_spend: riskyTotal,
    risky_share: totalSpend > 0 ? Math.round((riskyTotal / totalSpend) * 10000) / 10000 : 0,
    risky_payee_count: risky.length,
    concentration_share: CONCENTRATION_SHARE,
    concentrated_payee_count: concentrated.length,
    payees,
  };
}

module.exports = {
  agentExposure,
  clampPayees,
  CONCENTRATION_SHARE,
  RISKY_VERDICTS,
  MAX_PAYEES_ASSESSED,
};
