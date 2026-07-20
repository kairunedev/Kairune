'use strict';

/**
 * Issuer Diversity — Kairune.
 *
 * Trust that comes from many independent issuers is worth more than trust
 * that comes from a single source. A high score built entirely on one
 * issuer's attestations is a collusion risk (or a self-dealing risk); the
 * same score backed by several unrelated issuers is far harder to fake.
 *
 * This module answers the question RUDIE asked publicly: "what stops an
 * agent from farming its own trusted tier?" — by making the *source* of an
 * agent's verified trust transparent and measurable.
 *
 * The metric is deterministic and re-computable from the raw attestation
 * rows, exactly like the trust score itself.
 */

// Verified attestations from this many distinct issuers is treated as the
// point of full diversity credit. Beyond this, extra issuers still help but
// the confidence bonus saturates.
const DIVERSITY_TARGET_ISSUERS = 4;

/**
 * Compute issuer-diversity metrics for one agent's attestation history.
 *
 * Only *verified* attestations carry an issuer; unverified/self-posted rows
 * have no issuer and therefore contribute nothing to diversity — which is the
 * whole point (you cannot farm diversity by posting to yourself).
 *
 * @param {Array<{verification_status?:string, issuer_id?:string|null}>} attestations
 * @returns {{
 *   verified_count:number,
 *   unverified_count:number,
 *   distinct_issuers:number,
 *   top_issuer_share:number,       // 0..1 — fraction of verified from the single biggest issuer
 *   diversity_index:number,        // 0..1 — normalized Herfindahl-based spread
 *   confidence:number,             // 0..100 — headline "how independent is this trust?"
 *   per_issuer: Array<{issuer_id:string, verified_count:number, share:number}>
 * }}
 */
function computeDiversity(attestations) {
  const list = Array.isArray(attestations) ? attestations : [];

  let verifiedCount = 0;
  let unverifiedCount = 0;
  const byIssuer = new Map();

  for (const att of list) {
    const status =
      att.verification_status == null ? 'unverified' : att.verification_status;
    if (status === 'verified' && att.issuer_id) {
      verifiedCount += 1;
      byIssuer.set(att.issuer_id, (byIssuer.get(att.issuer_id) || 0) + 1);
    } else if (status === 'unverified') {
      unverifiedCount += 1;
    }
    // any other status (excluded) is ignored, mirroring the score engine
  }

  const distinctIssuers = byIssuer.size;

  // No verified trust at all → zero on every diversity dimension.
  if (verifiedCount === 0) {
    return {
      verified_count: 0,
      unverified_count: unverifiedCount,
      distinct_issuers: 0,
      top_issuer_share: 0,
      diversity_index: 0,
      confidence: 0,
      per_issuer: [],
    };
  }

  // Per-issuer breakdown, largest share first.
  const perIssuer = [...byIssuer.entries()]
    .map(([issuer_id, count]) => ({
      issuer_id,
      verified_count: count,
      share: round4(count / verifiedCount),
    }))
    .sort((a, b) => b.verified_count - a.verified_count);

  const topIssuerShare = perIssuer[0].share;

  // Herfindahl-Hirschman Index: sum of squared shares. 1 = one issuer holds
  // everything (concentrated), lower = spread out. We convert it into a 0..1
  // "diversity index" where 1 = maximally diverse.
  const hhi = perIssuer.reduce((sum, p) => sum + p.share * p.share, 0);
  const diversityIndex = round4(1 - hhi);

  // Confidence blends two ideas:
  //  - breadth: how many distinct issuers, up to the target
  //  - spread: how evenly the verified attestations are distributed
  // Both must be healthy for high confidence. A single issuer (even with
  // 1000 attestations) caps confidence low, which is exactly the anti-farming
  // property we want to expose.
  const breadth = Math.min(distinctIssuers / DIVERSITY_TARGET_ISSUERS, 1);
  const confidence = Math.round(breadth * diversityIndex * 100);

  return {
    verified_count: verifiedCount,
    unverified_count: unverifiedCount,
    distinct_issuers: distinctIssuers,
    top_issuer_share: topIssuerShare,
    diversity_index: diversityIndex,
    confidence,
    per_issuer: perIssuer,
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

module.exports = {
  DIVERSITY_TARGET_ISSUERS,
  computeDiversity,
};
