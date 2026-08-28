'use strict';

/**
 * ERC-8126 read adapter — Kairune.
 *
 * What this is
 * ------------
 * A translation layer so a consumer written against ERC-8126 (AI Agent
 * Verification) can read Kairune's existing trust data without knowing
 * Kairune's own shape. ERC-8126 is off-chain by design, so an adapter is the
 * sanctioned way to participate without deploying a contract.
 *
 * What this is NOT
 * ----------------
 * This is deliberately NOT a claim of ERC-8126 compliance, and the payload says
 * so in `compliant: false` plus a per-check breakdown. A compliant verification
 * provider MUST implement all five verification types (ETV, MCV, SCV, WAV, WV),
 * MUST generate ZKPs via PDV, and MUST resolve metadata from an ERC-8004
 * `agentId` via `tokenURI()`. Kairune implements none of those:
 *
 *   - ETV / MCV / SCV / WAV — not implemented. Kairune holds no contract
 *     address, media, Solidity source or endpoint for an agent, and makes no
 *     RPC calls at all, so there is nothing to scan.
 *   - WV — PARTIAL only. Kairune proves wallet *control* via EIP-191
 *     personal_sign (which ERC-8126 lists as a required standard), but the
 *     spec's WV also requires transaction-history and threat-database checks.
 *     Those are absent.
 *   - PDV / ZKP / QCV — absent.
 *   - ERC-8004 `agentId` — absent. Kairune identity is a handle plus a
 *     Robinhood Chain address, not an ERC-721 token id, so `agentId` is null.
 *
 * Overstating any of that to a reader of the spec would be trivially falsifiable
 * — the spec is co-authored by Virtuals — so the adapter reports the gaps as
 * data rather than hiding them in prose.
 *
 * The one thing it does add
 * -------------------------
 * ERC-8126 risk runs 0..100 where 0 is *lowest* risk. Kairune's score runs
 * 0..1000 where high is *good*. The two are inverted, not merely rescaled, so a
 * naive consumer wiring Kairune's raw score into a `minVerificationScore`-style
 * policy would invert its own gate and admit exactly the agents it meant to
 * refuse. Publishing the mapping once, here, removes that footgun.
 *
 * Kairune's signal is also orthogonal to the spec's five types: those assess
 * technical posture (is the contract sound, is the endpoint TLS-valid), while
 * Kairune assesses economic behaviour (did this agent settle cleanly, or does it
 * carry disputes and chargebacks). Useful as an additional input to a policy,
 * never a substitute for the required checks.
 */

const trustScore = require('./trustScore');

// The five verification types a compliant provider MUST implement, in the
// alphabetical order the spec presents them.
const VERIFICATION_TYPES = Object.freeze(['ETV', 'MCV', 'SCV', 'WAV', 'WV']);

// Risk bands, copied from the spec so a consumer can compare tiers directly.
const RISK_TIERS = Object.freeze({
  Low: '0-20',
  Moderate: '21-40',
  Elevated: '41-60',
  High: '61-80',
  Critical: '81-100',
});

const DISCLOSURE =
  'Derived adapter, not an ERC-8126 verification provider. ETV/MCV/SCV/WAV are ' +
  'not implemented, WV is partial (EIP-191 wallet-control proof only, no ' +
  'transaction-history or threat-database check), and PDV/ZKP/QCV and ERC-8004 ' +
  'agentId resolution are absent. Suitable as one input to a policy (e.g. an ' +
  'ERC-8196 minVerificationScore gate), never as a substitute for the five ' +
  'required verification types.';

/**
 * Per-type breakdown. Every entry carries an explicit status so a consumer can
 * see which checks are missing instead of inferring it from a single score.
 *
 * `null` scores are deliberate: a type that was never run has no score, and
 * emitting 0 would read as "lowest risk" — the exact opposite of "unknown".
 *
 * @param {{proven:boolean, verified_at:string|null, wallet:string|null,
 *          method:string, chain_id:number}} wv
 */
function verificationBreakdown(wv) {
  const missing = {
    status: 'not_implemented',
    score: null,
    proofId: null,
  };
  return {
    ETV: { ...missing, reason: 'no contract address held for an agent; Kairune makes no RPC calls' },
    MCV: { ...missing, reason: 'no agent media held; no C2PA/provenance analysis' },
    SCV: { ...missing, reason: 'no Solidity source held' },
    WAV: { ...missing, reason: 'no per-agent endpoint held; no OWASP WSTG scan' },
    WV: {
      status: 'partial',
      score: null,
      proofId: null,
      wallet_control_proven: wv.proven,
      proven_at: wv.verified_at,
      wallet: wv.wallet,
      method: wv.method,
      chain_id: wv.chain_id,
      reason:
        'wallet control is proven via EIP-191 personal_sign, but the spec also ' +
        'requires transaction-history and threat-database checks, which are absent',
    },
  };
}

/**
 * Build the adapter payload for one agent.
 *
 * `overallRiskScore` is NOT the spec's mean-of-applicable-scores: none of the
 * five types produce a score here, so averaging them would be averaging
 * nothing. It is the inverted Kairune behavioural score, and the payload labels
 * it as such via `overall_risk_source`.
 *
 * @param {object} agent agent row (needs score, handle, wallet, status, updated_at)
 * @param {{proven:boolean, verified_at:string|null}} proof wallet-proof status
 * @param {{chainId:number, walletProofMethod:string}} ctx
 */
function buildAdapterView(agent, proof, ctx) {
  const score = Number(agent.score) || 0;
  const risk = trustScore.erc8126DerivedRiskScore(score);
  const { tier, label } = trustScore.tierForScore(score);

  const wv = {
    proven: Boolean(proof && proof.proven),
    verified_at: (proof && proof.verified_at) || null,
    wallet: agent.wallet || null,
    method: ctx.walletProofMethod,
    chain_id: ctx.chainId,
  };

  return {
    spec: 'ERC-8126',
    // The single most important field in this payload.
    compliant: false,
    compliance: 'derived-adapter',
    // ERC-8126 keys verification to an ERC-8004 ERC-721 token id. Kairune has
    // no such identity, and inventing one would break any consumer that tried
    // to resolve it against the canonical Identity Registry.
    agentId: null,
    agent_identity: {
      scheme: 'kairune-handle+wallet',
      handle: agent.handle,
      walletAddress: agent.wallet || null,
      chain_id: ctx.chainId,
      erc8004_registered: false,
    },
    overallRiskScore: risk,
    riskTier: trustScore.erc8126RiskTier(risk),
    risk_tiers: RISK_TIERS,
    overall_risk_source: {
      basis: 'kairune-behavioural-score',
      formula: '100 - Math.round(score/10)',
      note:
        'Inverted mapping: ERC-8126 risk is 0..100 with 0 = lowest risk, while ' +
        'the Kairune score is 0..1000 with high = good. Not the spec mean of ' +
        'ETV/MCV/SCV/WAV/WV scores — none of those are implemented.',
    },
    required_verification_types: VERIFICATION_TYPES,
    implemented_verification_types: ['WV (partial)'],
    verifications: verificationBreakdown(wv),
    pdv: { status: 'not_implemented', zkp: false, proofId: null },
    qcv: { status: 'not_implemented' },
    erc8004: { identity_registry: null, validation_registry: null, attestation_posted: false },
    // The underlying Kairune data, so a reader can audit the translation rather
    // than take the derived number on faith.
    source: {
      provider: 'kairune',
      score,
      max_score: trustScore.MAX_SCORE,
      tier,
      tier_label: label,
      status: agent.status,
      wallet_proven: wv.proven,
      verify_endpoint: '/api/verify',
      agent_endpoint: `/api/agents/${agent.handle}`,
    },
    disclosure: DISCLOSURE,
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  VERIFICATION_TYPES,
  RISK_TIERS,
  DISCLOSURE,
  buildAdapterView,
};
