'use strict';

/**
 * Kairune REST API.
 * All endpoints are mounted at /api by server.js.
 *
 * Summary:
 *   GET    /api/agents                       list agents (leaderboard)
 *   POST   /api/agents                       register a new agent
 *   GET    /api/agents/:id                    agent detail + score breakdown
 *   GET    /api/agents/:id/trust-sources      issuer-diversity of verified trust
 *   GET    /api/agents/:id/rank               live leaderboard rank + percentile
 *   GET    /api/agents/:id/rank/neighbors     agents ranked just above & below
 *   GET    /api/agents/:id/tier               tier progress + points to next tier
 *   GET    /api/agents/:id/next-steps         simulated route to the next tier + downgrade risk
 *   GET    /api/agents/:id/spends             merged spend history across all of the agent's permissions
 *   GET    /api/agents/:id/spend-summary      aggregated spend totals by permission / category / payee
 *   POST   /api/counterparty/check           pre-flight go/no-go before paying another agent
 *   POST   /api/counterparty/compare         rank competing counterparties, pick a winner
 *   PATCH  /api/agents/:id/status             suspend / activate an agent
 *   DELETE /api/agents/:id                    delete an agent
 *   GET    /api/agents/:id/attestations       attestation history
 *   POST   /api/agents/:id/attestations       add attestation (triggers rescore)
 *   POST   /api/agents/:id/lock                owner-lock an agent (needs a fresh wallet proof)
 *   POST   /api/agents/:id/unlock              remove the owner lock (needs a fresh wallet proof)
 *   GET    /api/agents/:id/permissions        list permissions
 *   POST   /api/agents/:id/permissions        grant permission
 *   POST   /api/permissions/:pid/revoke       revoke permission
 *   POST   /api/permissions/:pid/expiry        set / extend / clear the expiry deadline
 *   GET    /api/permissions/:pid/budget        remaining spend budget
 *   GET    /api/permissions/:pid/spends        spend history (filter: since/until/payee/idempotency_key)
 *   POST   /api/permissions/:pid/spends/preview dry-run a spend (no charge, go/no-go)
 *   POST   /api/permissions/:pid/spends        authorize a spend (enforces ceiling)
 *   GET    /api/spends/:sid/receipt            public, independently-verifiable spend receipt
 *   GET    /api/platform-key                   the platform's current receipt-signing public key
 *   POST   /api/issuer-requests                create an issuer verification request
 *   GET    /api/agents/:id/requests            list an agent's requests
 *   GET    /api/issuer-requests/:id            fetch a single request
 *   GET    /api/issuers/:id/requests           list requests for the authenticated issuer
 *   POST   /api/issuer-requests/:id/respond    accept or reject a request (issuer-only)
 *   POST   /api/webhooks                        register a spend-event webhook
 *   GET    /api/webhooks                        list webhooks
 *   GET    /api/webhooks/:id/deliveries         webhook delivery log
 *   DELETE /api/webhooks/:id                     delete a webhook
 *   GET    /api/stats                          global statistics
 *   GET    /api/feed                           public spend activity feed
 *   GET    /api/meta                           metadata (kinds, tiers)
 *   POST   /api/verify                          public, stateless Ed25519 signature check
 *   GET    /api/erc8126/agents/:id              ERC-8126 derived adapter (not compliant) — same as /api/agents/:id/erc8126
 *   GET    /api/agents/:id/erc8126              ERC-8126 derived adapter (not compliant)
 */

const express = require('express');
const agentService = require('../services/agentService');
const attestationService = require('../services/attestationService');
const permissionService = require('../services/permissionService');
const spendService = require('../services/spendService');
const issuerService = require('../services/issuerService');
const issuerRequestService = require('../services/issuerRequestService');
const webhookService = require('../services/webhookService');
const verification = require('../services/verification');
const receiptService = require('../services/receiptService');
const replayGuard = require('../services/replayGuard');
const trustScore = require('../services/trustScore');
const issuerDiversity = require('../services/issuerDiversity');
const walletProof = require('../services/walletProof');
const erc8126 = require('../services/erc8126');
const { rateLimit } = require('../middleware/rateLimit');
const { requireIssuer } = require('../middleware/issuerAuth');
const {
  assertValidHandle,
  assertValidRobinhoodWallet,
  requireAdmin,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_CHAIN_NAME,
  EVM_ADDRESS_RE,
} = require('../middleware/moderation');
const { tokenStatus } = require('../services/tokenGate');

const router = express.Router();

// Throttle mutating requests (POST/PATCH/DELETE) per client IP. Reads are free.
router.use(rateLimit);

// Helper: wrap an async handler so errors are forwarded to the error middleware.
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Helper to validate required fields.
function requireFields(body, fields) {
  const missing = fields.filter(
    (f) => body[f] === undefined || body[f] === null || body[f] === ''
  );
  if (missing.length) {
    const err = new Error(`Missing required field(s): ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

// Clamp a ?limit= into [1, max]. The lower bound matters: SQLite reads a
// negative LIMIT as "no limit", so Math.min(-1, 200) would hand back the whole
// table. Non-numeric input falls back to the route's default.
function pageLimit(raw, fallback, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(n, max));
}

// Offsets are floored at 0 for the same reason — a negative OFFSET is an error.
function pageOffset(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// Meta & stats
// ---------------------------------------------------------------------------
router.get('/meta', (req, res) => {
  res.json({
    attestation_kinds: attestationService.VALID_KINDS,
    kind_weights: trustScore.KIND_WEIGHTS,
    tiers: trustScore.TIER_LABELS.map((label, i) => ({
      tier: i,
      label,
      threshold: trustScore.TIER_THRESHOLDS[i],
    })),
    periods: permissionService.VALID_PERIODS,
    max_score: trustScore.MAX_SCORE,
    unverified_weight_factor: trustScore.resolveUnverifiedFactor(),
    signature_algorithm: 'ed25519',
    signature_max_age_seconds: replayGuard.maxAgeSeconds(),
    verify_endpoint: '/api/verify',
    trust_sources_endpoint: '/api/agents/:id/trust-sources',
    rank_endpoint: '/api/agents/:id/rank',
    rank_neighbors_endpoint: '/api/agents/:id/rank/neighbors',
    tier_progress_endpoint: '/api/agents/:id/tier',
    next_steps_endpoint: '/api/agents/:id/next-steps',
    counterparty_check_endpoint: '/api/counterparty/check',
    counterparty_compare_endpoint: '/api/counterparty/compare',
    counterparty_compare_max_candidates: agentService.MAX_COMPARE_CANDIDATES,
    spend_counterparty_gate: true,
    spend_counterparty_blocking_verdicts: spendService.GATE_BLOCKING_VERDICTS,
    counterparty_policies: permissionService.COUNTERPARTY_POLICIES,
    payees_endpoint: '/api/permissions/:pid/payees',
    counterparty_policy_endpoint: '/api/permissions/:pid/counterparty-policy',
    max_payees_per_permission: permissionService.MAX_PAYEES_PER_PERMISSION,
    permission_expiry: true,
    permission_expiry_endpoint: '/api/permissions/:pid/expiry',
    max_expires_in_s: permissionService.MAX_EXPIRES_IN_S,
    rank_badge_endpoint: '/a/:handle/rank.svg',
    wallet_lookup_endpoint: '/api/wallets/:wallet',
    spend_preview_endpoint: '/api/permissions/:pid/spends/preview',
    spend_reporting: true,
    agent_spends_endpoint: '/api/agents/:id/spends',
    spend_summary_endpoint: '/api/agents/:id/spend-summary',
    spend_history_filters: ['since', 'until', 'payee', 'idempotency_key'],
    max_spend_page: spendService.MAX_SPEND_PAGE,
    spend_receipts: true,
    spend_receipt_endpoint: '/api/spends/:sid/receipt',
    platform_key_endpoint: '/api/platform-key',
    receipt_signed_fields: receiptService.RECEIPT_CANONICAL_FIELDS,
    spend_alert_threshold: spendService.resolveAlertThreshold(),
    default_velocity_window_s: spendService.DEFAULT_VELOCITY_WINDOW_S,
    idempotency_header: 'Idempotency-Key',
    idempotency_max_key_length: spendService.MAX_IDEMPOTENCY_KEY_LEN,
    diversity_target_issuers: issuerDiversity.DIVERSITY_TARGET_ISSUERS,
    webhook_events: webhookService.EVENTS,
    chain: ROBINHOOD_CHAIN_NAME,
    chain_id: ROBINHOOD_CHAIN_ID,
    // Wallet proof — an agent can prove on-chain control of its address, so a
    // payer can tell a claimed wallet from a demonstrated one.
    wallet_proof: true,
    wallet_proof_method: 'eip191-personal-sign',
    wallet_proof_challenge_endpoint: '/api/agents/:id/wallet-proof/challenge',
    wallet_proof_endpoint: '/api/agents/:id/wallet-proof',
    wallet_proof_ttl_s: walletProof.CHALLENGE_TTL_S,
    // Owner lock — opt-in. Unlocked agents accept unauthenticated permission
    // writes (what the public console uses); locked agents require a fresh
    // wallet proof for any change to their spending authority.
    owner_lock: {
      opt_in: true,
      default: 'unlocked',
      lock_endpoint: '/api/agents/:id/lock',
      unlock_endpoint: '/api/agents/:id/unlock',
      proof_header: 'X-Owner-Proof: <nonce>:<signature>',
      protects: [
        'POST /api/agents/:id/permissions',
        'POST /api/permissions/:pid/revoke',
        'POST /api/permissions/:pid/spends',
        'POST /api/permissions/:pid/expiry',
        'POST /api/permissions/:pid/counterparty-policy',
        'POST /api/permissions/:pid/payees',
        'DELETE /api/permissions/:pid/payees/:ref',
      ],
    },
    // ERC-8126 derived risk — verifiable interoperability view, NOT a
    // compliance claim. Kairune does NOT implement ETV/MCV/SCV/WAV/WV,
    // PDV/ZKP, or ERC-8004 tokenId. This is an inverted mapping so an
    // 8196-style policy can consume Kairune's behavioral score.
    erc8126_derived_risk: {
      formula: '100 - Math.round(score/10)',
      score_range: '0..100 where 0 = lowest risk (inverted vs Kairune 0..1000 high=good)',
      tiers: { Low: '0-20', Moderate: '21-40', Elevated: '41-60', High: '61-80', Critical: '81-100' },
      example: { kairune_score_357: 64, kairune_score_1000: 0, kairune_score_0: 100 },
      note: 'Derived view only — Kairune is not an ERC-8126 verification provider. Use as minVerificationScore-style input, not as a substitute for ETV/MCV/SCV/WAV/WV.',
    },
    // Full derived adapter for ERC-8126-shaped consumers — explicitly NOT
    // compliant, with a per-type breakdown that says which checks are missing.
    erc8126_adapter: {
      compliant: false,
      endpoints: ['/api/agents/:id/erc8126', '/api/erc8126/agents/:id'],
      note: 'Same derived risk; adds per-type breakdown (ETV/MCV/SCV/WAV not_implemented, WV partial via EIP-191). No ZKP, no ERC-8004 agentId.',
    },
    // Notion sidecar — push-only ship log + content queue. The registry/spends
    // stay in libSQL; Notion only stores the changelog and tweet drafts that
    // disappeared in chat. No token in code — read from NOTION_API_KEY at call
    // time, writes gated by X-Admin-Key, token never echoed.
    notion_sidecar: {
      enabled: Boolean(process.env.NOTION_API_KEY),
      notion_version: '2026-03-11',
      status_endpoint: '/api/notion/status',
      setup_endpoint: '/api/notion/setup',
      ship_log_endpoint: '/api/notion/ship-log',
      queue_endpoint: '/api/notion/queue',
      query_endpoint: '/api/notion/query',
      data_source_api: '/v1/data_sources/{id}/query',
      note: 'Push-only; registry stays in libSQL. Set NOTION_API_KEY env (never committed).',
    },
  });
});

// ---------------------------------------------------------------------------
// Public signature verification — stateless, no auth, no storage.
//
// Anyone can independently check that a signature over a set of attestation
// fields is valid for a given Ed25519 public key. Kairune never has to be
// trusted: paste the public key, the exact signed fields, and the signature,
// and this endpoint recomputes the canonical payload and verifies the
// signature locally. "Don't trust, verify."
//
//   POST /api/verify
//   {
//     "public_key": "-----BEGIN PUBLIC KEY-----\n...",  // SPKI PEM (Ed25519)
//     "signature":  "<base64>",
//     "fields": { agent_id, kind, amount?, note?, issuer_id, issuer_key_id, issued_at }
//   }
//
// Response: { verified: bool, algorithm, canonical, reason }
// ---------------------------------------------------------------------------
router.post('/verify', (req, res) => {
  const { public_key, signature, fields } = req.body || {};

  if (typeof public_key !== 'string' || public_key.trim() === '') {
    const err = new Error('Field "public_key" (SPKI PEM) is required');
    err.status = 400;
    throw err;
  }
  if (typeof signature !== 'string' || signature.trim() === '') {
    const err = new Error('Field "signature" (base64) is required');
    err.status = 400;
    throw err;
  }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    const err = new Error('Field "fields" (object) is required');
    err.status = 400;
    throw err;
  }

  // Recompute the exact canonical bytes that would have been signed.
  const canonical = verification.canonicalPayload(fields);
  const verified = verification.verifySignature({
    publicKeyPem: public_key,
    canonical,
    signatureB64: signature,
  });

  res.json({
    verified,
    algorithm: 'ed25519',
    canonical,
    signed_fields: verification.CANONICAL_FIELDS,
    reason: verified ? 'ok' : 'signature_invalid',
  });
});

router.get('/token', (req, res) => {
  res.json(tokenStatus(req));
});

router.get(
  '/stats',
  wrap(async (req, res) => {
    // Lazy GC of ephemeral demo agents. Best-effort and off the critical path
    // so the caller never pays its latency. A request-response that carries
    // garbage collection also makes the faster machine pay for the slower one's
    // demo.
    agentService.purgeExpiredDemos().catch(() => {});
    // Apply the SAME demo/test exclusion the leaderboard uses so public stats
    // match what visitors actually see. include_demo=1 counts everything.
    const includeDemo =
      req.query.include_demo === '1' || req.query.include_demo === 'true';
    res.json(await agentService.getStats({ includeDemo }));
  })
);

// Public spend activity feed — real approved/blocked decisions, no auth, no PII.
// Powers the live feed on the landing page.
router.get(
  '/feed',
  wrap(async (req, res) => {
    const limit = pageLimit(req.query.limit, 20, 100);
    res.json({ events: await spendService.listFeed({ limit }) });
  })
);

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
router.get(
  '/agents',
  wrap(async (req, res) => {
    agentService.purgeExpiredDemos().catch(() => {});
    const limit = pageLimit(req.query.limit, 50, 200);
    const offset = pageOffset(req.query.offset);
    const status = req.query.status;
    const includeDemo =
      req.query.include_demo === '1' || req.query.include_demo === 'true';
    res.json({
      agents: await agentService.listAgents({
        limit,
        offset,
        status,
        includeDemo,
      }),
    });
  })
);

router.post(
  '/agents',
  wrap(async (req, res) => {
    requireFields(req.body, ['handle', 'wallet']);
    const op = String(req.body.operator || '').toLowerCase();
    const handle = assertValidHandle(req.body.handle, {
      allowTry: op === 'demo-loop',
    });
    // Kairune is a single-chain registry: agents live on Robinhood Chain, so
    // the identity must be a valid Robinhood Chain (EVM) address.
    const wallet = assertValidRobinhoodWallet(req.body.wallet);
    const existingHandle = await agentService.getAgent(handle);
    if (existingHandle) {
      const err = new Error('Handle already registered — try a different name');
      err.status = 409;
      throw err;
    }
    const existingWallet = await agentService.getAgentByWallet(wallet);
    if (existingWallet) {
      const err = new Error('Wallet already registered — use a unique identity');
      err.status = 409;
      throw err;
    }
    const agent = await agentService.createAgent({
      handle,
      wallet,
      operator: req.body.operator,
    });
    res.status(201).json({ agent });
  })
);

router.get(
  '/agents/:id',
  wrap(async (req, res) => {
    const base = await agentService.getAgent(req.params.id);
    if (!base) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    const [agent, attestations, permissions] = await Promise.all([
      agentService.recalcAgent(base.id),
      attestationService.listAttestations(base.id, { limit: 20 }),
      permissionService.listPermissions(base.id),
    ]);
    const derivedRisk = trustScore.erc8126DerivedRiskScore(agent.score);
    res.json({
      // `owner_locked` as an explicit boolean alongside the raw timestamp: a
      // payer reading this wants a yes/no on whether this agent's budget can be
      // altered by anyone who knows its permission id.
      agent: { ...agent, owner_locked: Boolean(agent.owner_locked_at) },
      erc8126: {
        derived_risk_score: derivedRisk,
        derived_risk_tier: trustScore.erc8126RiskTier(derivedRisk),
        formula: '100 - Math.round(score/10)',
        note: 'Derived view only — not ERC-8126 compliance (no ETV/MCV/SCV/WAV/WV, no PDV/ZKP, no ERC-8004 tokenId).',
      },
      attestations,
      permissions,
    });
  })
);

// ERC-8126 derived adapter — a read view for consumers written against
// ERC-8126 (AI Agent Verification), which is off-chain by design.
//
// This does NOT claim compliance, and the payload says so: `compliant: false`,
// plus a per-type breakdown marking ETV/MCV/SCV/WAV `not_implemented` and WV
// `partial` (Kairune proves wallet *control* via EIP-191 personal_sign, but the
// spec's WV also wants transaction-history and threat-database checks).
// PDV/ZKP/QCV are absent and `agentId` is null because Kairune identity is a
// handle plus a Robinhood Chain address, not an ERC-8004 ERC-721 token id.
//
// The value it adds is the inversion: ERC-8126 risk is 0..100 with 0 = lowest
// risk, while the Kairune score is 0..1000 with high = good. A consumer wiring
// the raw score into a `minVerificationScore` gate would invert its own policy
// and admit the agents it meant to refuse. Publishing the mapping once removes
// that footgun.
//
// Public, read-only, nothing persisted. 404 for an unknown agent.
const erc8126Handler = wrap(async (req, res) => {
  const base = await agentService.getAgent(req.params.id);
  if (!base) {
    const err = new Error('Agent not found');
    err.status = 404;
    throw err;
  }
  // Recompute rather than read stored: a policy gate deciding whether to let
  // money move should not act on a stale score.
  const [agent, proof] = await Promise.all([
    agentService.recalcAgent(base.id),
    walletProof.proofStatus(base.id, base.wallet),
  ]);
  res.json(
    erc8126.buildAdapterView(agent, proof, {
      chainId: ROBINHOOD_CHAIN_ID,
      walletProofMethod: 'eip191-personal-sign',
    })
  );
});

router.get('/agents/:id/erc8126', erc8126Handler);
// Alias so a consumer that namespaces by spec can call it that way too.
router.get('/erc8126/agents/:id', erc8126Handler);

// Live leaderboard rank for an agent — the competitive, shareable "where do I
// stand?" signal. Same universe/ordering as GET /api/agents (the public
// leaderboard), so #3 here is exactly the 3rd row there. Public, no auth.
// 404 for an unknown agent; a demo/test agent (no public standing) returns
// ranked:false with a null rank rather than a fake position.
router.get(
  '/agents/:id/rank',
  wrap(async (req, res) => {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    // Rank is a snapshot across ALL agents, so it must compare like-for-like:
    // every agent's *stored* score (kept fresh on attestation writes and detail
    // reads). Rescoring only the queried agent here would compare a fresh score
    // against everyone else's stored score — an inconsistent ordering — and add
    // a DB write to a frequently hotlinked endpoint. So we read as-is.
    const rank = await agentService.getRank(agent.id);
    if (!rank) {
      return res.json({ ranked: false, handle: agent.handle, rank: null });
    }
    res.json({ ranked: true, ...rank });
  })
);

// Rank neighbours — "who am I chasing, who is chasing me". Returns the agent
// one rank above (the target to overtake) and one rank below (the challenger
// on your heels), with the score gaps to each. Same universe/ordering as the
// leaderboard and GET /api/agents/:id/rank. Public, no auth. 404 for an
// unknown agent; a demo/test agent (no public standing) returns ranked:false.
router.get(
  '/agents/:id/rank/neighbors',
  wrap(async (req, res) => {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    // Read stored scores as-is (same rationale as /rank): rescoring only this
    // agent would compare a fresh score against everyone else's stored score.
    const neighbors = await agentService.getRankNeighbors(agent.id);
    if (!neighbors) {
      return res.json({ ranked: false, handle: agent.handle, self: null });
    }
    res.json({ ranked: true, ...neighbors });
  })
);

// Tier progress — how far this agent is through its current trust tier and
// what the next tier costs. Where /rank is relative to other agents, this is
// relative to the fixed bar: current tier floor, next threshold, points to
// go, and a 0..100 progress through the band. Well-defined for every agent
// (score exists even without public standing), so no demo exclusion here.
// Public, no auth. 404 for an unknown agent. Reads the stored score as-is.
router.get(
  '/agents/:id/tier',
  wrap(async (req, res) => {
    const progress = await agentService.getTierProgress(req.params.id);
    if (!progress) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    res.json(progress);
  })
);

// Next steps — the actionable companion to /tier.
//
// /tier says "94 points to PRIME". This says *how to get them*: for every
// positive attestation kind, how many events it takes to cross the next
// threshold, compared across three sourcing strategies (verified from distinct
// issuers / verified from one issuer / unverified). It also reports the
// downside: how many disputes, chargebacks or anomaly flags would drop the
// agent out of its current tier.
//
// The numbers come from re-running the real scoring engine over the agent's
// real attestation history plus hypothetical events, so they account for the
// log volume bonus, the per-issuer cap and the asymmetric negative weighting
// that make naive points/weight arithmetic wrong.
//
// Public, read-only, no auth, nothing persisted. 404 for an unknown agent.
router.get(
  '/agents/:id/next-steps',
  wrap(async (req, res) => {
    const plan = await agentService.getNextSteps(req.params.id);
    if (!plan) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    res.json(plan);
  })
);

// Counterparty check — the one call an agent makes BEFORE it pays another agent.
//
// Built for agent-to-agent commerce (e.g. an ACP job where one agent hires and
// pays another): instead of stitching together score + tier + diversity +
// recent negatives + a spend ceiling itself, the payer names the counterparty
// (by id, handle, or 0x… wallet) and optionally the amount it means to spend,
// and gets one verdict — proceed / review / decline — plus the exact checks
// that produced it. A valid but unregistered wallet is a first-class "decline"
// (no basis to trust), not a 404.
//
// Public, read-only, no auth, nothing persisted. Deterministic: the verdict is
// a pure function of the counterparty's stored profile and attestation history.
router.post(
  '/counterparty/check',
  wrap(async (req, res) => {
    requireFields(req.body, ['counterparty']);
    const { counterparty, amount = null } = req.body;

    if (amount != null) {
      const n = Number(amount);
      if (!Number.isFinite(n) || n <= 0) {
        const err = new Error('amount, when provided, must be a positive number');
        err.status = 400;
        throw err;
      }
    }

    const result = await agentService.checkCounterparty(counterparty, { amount });
    if (!result) {
      const err = new Error('Counterparty not found');
      err.status = 404;
      throw err;
    }
    res.json(result);
  })
);

// Counterparty compare — pick between competing counterparties in one call.
//
// /counterparty/check answers "is this one safe?". An agent holding several
// competing bids has the harder question: "which of these do I pay?" Answering
// that today costs N round-trips plus client-side tie-break logic that every
// caller reinvents differently. This runs the identical assessment per
// candidate and returns them ranked by one explicit, documented rule, so two
// different callers comparing the same agents always agree.
//
// Ranked best-first by: verdict, then fewest recent severe negatives, then
// fewest disputes, then score, then trust independence, then handle. Severity
// sits above score because scores saturate — without it a slate of equally
// scored declines would order alphabetically and ranked[0] could be the worst
// actor of the set.
//
// `recommended` is the best candidate that actually clears (verdict=proceed),
// or null when none do — deliberately not "the least-bad option".
// Unresolvable handles land in `unresolved[]` instead of failing the batch.
//
// Public, read-only, no auth, nothing persisted, deterministic.
router.post(
  '/counterparty/compare',
  wrap(async (req, res) => {
    requireFields(req.body, ['counterparties']);
    const { counterparties, amount = null } = req.body;

    if (!Array.isArray(counterparties)) {
      const err = new Error('counterparties must be an array');
      err.status = 400;
      throw err;
    }
    if (counterparties.length < 2) {
      const err = new Error('counterparties must contain at least 2 entries to compare');
      err.status = 400;
      throw err;
    }
    if (counterparties.length > agentService.MAX_COMPARE_CANDIDATES) {
      const err = new Error(
        `counterparties accepts at most ${agentService.MAX_COMPARE_CANDIDATES} entries`
      );
      err.status = 400;
      throw err;
    }

    if (amount != null) {
      const n = Number(amount);
      if (!Number.isFinite(n) || n <= 0) {
        const err = new Error('amount, when provided, must be a positive number');
        err.status = 400;
        throw err;
      }
    }

    const result = await agentService.compareCounterparties(counterparties, { amount });

    // Every reference was unresolvable → the caller named nothing we know, which
    // is a bad request shape rather than a successful empty comparison.
    if (result.candidate_count === 0) {
      const err = new Error('None of the supplied counterparties could be resolved');
      err.status = 404;
      throw err;
    }

    res.json(result);
  })
);

// Issuer diversity — where does this agent's *verified* trust come from?
//
// A trusted tier built on a single issuer is a collusion / self-dealing risk;
// the same tier backed by several independent issuers is far harder to fake.
// This endpoint makes the source of trust transparent and measurable.
// Public, no auth, deterministic (re-computable from the raw attestations).
router.get(
  '/agents/:id/trust-sources',
  wrap(async (req, res) => {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    const sources = await attestationService.listVerificationSources(agent.id);
    const diversity = issuerDiversity.computeDiversity(sources);

    // Attach issuer display names to the per-issuer breakdown for readability.
    const nameById = new Map(
      sources
        .filter((s) => s.issuer_id)
        .map((s) => [s.issuer_id, s.issuer_name])
    );
    const per_issuer = diversity.per_issuer.map((p) => ({
      issuer_id: p.issuer_id,
      issuer_name: nameById.get(p.issuer_id) || null,
      verified_count: p.verified_count,
      share: p.share,
    }));

    res.json({
      agent_id: agent.id,
      handle: agent.handle,
      verified_count: diversity.verified_count,
      unverified_count: diversity.unverified_count,
      distinct_issuers: diversity.distinct_issuers,
      top_issuer_share: diversity.top_issuer_share,
      diversity_index: diversity.diversity_index,
      confidence: diversity.confidence,
      target_issuers: issuerDiversity.DIVERSITY_TARGET_ISSUERS,
      per_issuer,
    });
  })
);

// ---------------------------------------------------------------------------
// Agent-level spend reporting
//
// Per-permission history answers "what did this grant pay for". An operator
// running several grants on one agent could not answer "what did this agent
// spend this month" without walking every permission client-side. These two
// endpoints close that gap: a merged history and an aggregated rollup.
//
// Admin-gated like the spend write path — a grant's charge history is operator
// data, unlike the anonymised public /api/feed.
// ---------------------------------------------------------------------------
router.get(
  '/agents/:id/spends',
  wrap(async (req, res) => {
    requireAdmin(req);
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    const filters = {
      limit: req.query.limit,
      offset: req.query.offset,
      since: req.query.since,
      until: req.query.until,
      payee: req.query.payee,
      idempotencyKey: req.query.idempotency_key,
      permissionId: req.query.permission_id,
    };
    const spends = await spendService.listAgentSpends(agent.id, filters);
    res.json({
      agent_id: agent.id,
      handle: agent.handle,
      spends,
      paging: {
        limit: spendService.clampLimit(filters.limit),
        offset: spendService.clampOffset(filters.offset),
        returned: spends.length,
      },
    });
  })
);

// Aggregated spend rollup: total plus breakdowns by permission, category and
// payee over an optional [since, until) window. Totals are computed over the
// requested window, not each permission's rolling ceiling window — use
// GET /api/permissions/:pid/budget for remaining headroom.
router.get(
  '/agents/:id/spend-summary',
  wrap(async (req, res) => {
    requireAdmin(req);
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    const summary = await spendService.spendSummary(agent.id, {
      since: req.query.since,
      until: req.query.until,
      payee: req.query.payee,
      topPayees: req.query.top_payees,
    });
    res.json({ summary: { ...summary, handle: agent.handle } });
  })
);

// Wallet proof — challenge / response.
//
// Every agent claims a wallet at registration, and until now that claim was
// only ever checked for *shape*. These two routes let an operator prove
// *control* with a standard EIP-191 `personal_sign`, which every EVM wallet
// already implements — so no new tooling, and no private key ever reaches us.
//
// Both are public on purpose. Minting a challenge grants nothing (it is a nonce
// and a sentence), and submitting a signature is self-authenticating: only the
// wallet holder can produce one that recovers to the claimed address. Requiring
// an admin key here would mean only Kairune operators could prove wallets,
// which defeats the point.
router.post(
  '/agents/:id/wallet-proof/challenge',
  wrap(async (req, res) => {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    // Always challenge the wallet actually on record. Letting the caller name
    // the target would allow minting challenges for arbitrary addresses.
    const challenge = await walletProof.createChallenge(agent.id, agent.wallet);
    res.status(201).json({ handle: agent.handle, ...challenge });
  })
);

router.post(
  '/agents/:id/wallet-proof',
  wrap(async (req, res) => {
    requireFields(req.body, ['nonce', 'signature']);
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    const result = await walletProof.verifyProof(agent.id, req.body.nonce, req.body.signature);
    res.json({ proven: true, handle: agent.handle, ...result });
  })
);

// Owner lock — opt in to requiring a wallet proof for spending-authority changes.
//
// Until an agent is locked, its permission routes accept unauthenticated writes.
// That is what makes the public console work: a visitor can grant a budget and
// spend against it without holding a key. It also means anyone can revoke, drain
// or re-scope someone else's grant, because a permission id is public.
//
// Locking is the operator's answer to that. It takes a fresh wallet proof to
// turn on and a fresh one to turn off, so only the wallet holder can change the
// setting — and once on, every mutating permission action for that agent needs a
// proof too. Opt-in rather than mandatory because making it mandatory would
// strand every agent already registered, none of which has proved a wallet.
router.post(
  '/agents/:id/lock',
  wrap(async (req, res) => {
    requireFields(req.body, ['nonce', 'signature']);
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    // Self-authenticating: only the wallet holder can produce this.
    const proof = await walletProof.verifyProof(agent.id, req.body.nonce, req.body.signature);
    const updated = await agentService.setOwnerLock(agent.id, true);
    res.json({
      locked: true,
      handle: updated.handle,
      owner_locked_at: updated.owner_locked_at,
      wallet: proof.wallet,
      note:
        'Mutating permission routes for this agent now require ' +
        'X-Owner-Proof: <nonce>:<signature>.',
    });
  })
);

router.post(
  '/agents/:id/unlock',
  wrap(async (req, res) => {
    requireFields(req.body, ['nonce', 'signature']);
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    // Unlocking is as sensitive as locking: it removes a protection, so it takes
    // the same proof. An unauthenticated unlock would make the lock decorative.
    await walletProof.verifyProof(agent.id, req.body.nonce, req.body.signature);
    const updated = await agentService.setOwnerLock(agent.id, false);
    res.json({ locked: false, handle: updated.handle, owner_locked_at: null });
  })
);

// Proof status — public read. A payer deciding whether to release funds wants
// to know whether the address it is about to pay was ever proven, and that
// answer is not a secret.
router.get(
  '/agents/:id/wallet-proof',
  wrap(async (req, res) => {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    const status = await walletProof.proofStatus(agent.id, agent.wallet);
    res.json({ agent_id: agent.id, handle: agent.handle, ...status });
  })
);

// Wallet trust lookup — resolve a Robinhood Chain wallet address to its live
// trust profile. Built for payment rails / spend gateways that only know the
// wallet (not the internal id/handle) and need a fast go / no-go signal before
// approving a charge. Public, read-only, no PII beyond what the leaderboard
// already exposes. Score/tier are recomputed live so the answer is never stale.
router.get(
  '/wallets/:wallet',
  wrap(async (req, res) => {
    const raw = String(req.params.wallet || '').trim();
    // Single-chain registry: only Robinhood Chain (EVM) addresses are valid.
    if (!EVM_ADDRESS_RE.test(raw)) {
      const err = new Error(
        'Wallet must be a valid Robinhood Chain address (0x followed by 40 hex characters)'
      );
      err.status = 400;
      throw err;
    }
    const wallet = raw.toLowerCase();

    const base = await agentService.getAgentByWallet(wallet);
    if (!base) {
      // Unknown wallet is a valid, useful answer for a gateway: "not registered".
      return res.status(404).json({
        registered: false,
        wallet,
        chain: ROBINHOOD_CHAIN_NAME,
        chain_id: ROBINHOOD_CHAIN_ID,
        message: 'Wallet is not registered in the Kairune trust registry',
      });
    }

    // Recompute and read the proof concurrently — independent reads, and this
    // route is the hot path for payment gateways.
    const [agent, proof] = await Promise.all([
      agentService.recalcAgent(base.id),
      walletProof.proofStatus(base.id, wallet),
    ]);
    const { tier, label } = trustScore.tierForScore(agent.score);

    res.json({
      registered: true,
      wallet,
      chain: ROBINHOOD_CHAIN_NAME,
      chain_id: ROBINHOOD_CHAIN_ID,
      agent_id: agent.id,
      handle: agent.handle,
      status: agent.status,
      score: agent.score,
      tier,
      tier_label: label,
      max_score: trustScore.MAX_SCORE,
      suggested_daily_ceiling: trustScore.suggestedDailyCeiling(agent.score),
      // Whether anyone ever proved control of this address. Reported separately
      // from `trusted` rather than folded into it: an unproven wallet with a
      // real history is a different risk from a proven wallet with none, and
      // collapsing the two would hide which one the caller is looking at.
      wallet_proven: proof.proven,
      wallet_proven_at: proof.verified_at,
      // A suspended agent should never be trusted to spend, regardless of score.
      trusted: agent.status === 'active' && tier >= 1,
      updated_at: agent.updated_at,
    });
  })
);

router.patch(
  '/agents/:id/status',
  wrap(async (req, res) => {
    // Suspending an agent stops it spending; un-suspending undoes a moderator's
    // decision. Both are operator actions, same as DELETE below.
    requireAdmin(req);
    requireFields(req.body, ['status']);
    if (!['active', 'suspended'].includes(req.body.status)) {
      const err = new Error('Status must be "active" or "suspended"');
      err.status = 400;
      throw err;
    }
    const agent = await agentService.setAgentStatus(
      req.params.id,
      req.body.status
    );
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    res.json({ agent });
  })
);

router.delete(
  '/agents/:id',
  wrap(async (req, res) => {
    requireAdmin(req);
    const ok = await agentService.deleteAgent(req.params.id);
    if (!ok) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    res.json({ deleted: true });
  })
);

// ---------------------------------------------------------------------------
// Attestations
// ---------------------------------------------------------------------------
router.get(
  '/agents/:id/attestations',
  wrap(async (req, res) => {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    res.json({
      attestations: await attestationService.listAttestations(agent.id, {
        limit: pageLimit(req.query.limit, 50, 200),
      }),
    });
  })
);

router.post(
  '/agents/:id/attestations',
  wrap(async (req, res) => {
    requireFields(req.body, ['kind']);
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }

    const { issuer_id, issuer_key_id, signature } = req.body;
    const present = [issuer_id, issuer_key_id, signature].filter(
      (v) => v !== undefined && v !== null && v !== ''
    ).length;

    // Unsigned (backward-compatible) path.
    //
    // `weight` is deliberately not read from the body: it is derived from `kind`
    // server-side. This path needs no credentials, so honouring a caller's
    // weight let anyone set any agent's score to anything.
    if (present === 0) {
      // Praise may be anonymous. Accusations may not.
      //
      // A negative attestation is a claim about someone else's conduct, and this
      // path requires no credentials at all. Measured before this guard existed:
      // 50 anonymous `anomaly_flag` posts took an agent with 300 clean records
      // from 869/TRUSTED to 0 — roughly two minutes of requests to destroy any
      // agent in the registry, from a caller who never identified themselves.
      // Attribution is the whole point of a penalty: someone has to be on record
      // as having made the claim, so it can be disputed and the issuer can be
      // held responsible for a false one.
      if (trustScore.NEGATIVE_KINDS.includes(req.body.kind)) {
        const err = new Error(
          'Negative attestations require issuer attribution: submit with issuer_id, ' +
            'issuer_key_id and signature. Anonymous submissions may only report ' +
            'positive outcomes.'
        );
        err.status = 401;
        throw err;
      }
      // LLM-context surface. `note` is served verbatim on every
      // GET /api/agents/:id and is therefore readable by any AI consumer that
      // treats an agent's history as context. Anonymously appending a
      // free-text note to another agent's history is how instruction-shaped
      // text reaches a model, while a bare `kind` never carries prose.
      // So a note to a locked agent must prove wallet control, while a
      // note-less attestation is still 201 for compatibility.
      if (req.body.note != null && String(req.body.note).trim() !== '') {
        await walletProof.requireOwner(req, agent);
      }
      const result = await attestationService.addAttestation(agent.id, {
        kind: req.body.kind,
        amount: req.body.amount,
        note: req.body.note,
        verification_status: 'unverified',
      });
      return res.status(201).json(result);
    }

    // Partial credentials → 400 (all three are required together).
    if (present < 3) {
      const err = new Error(
        'Signed submissions require issuer_id, issuer_key_id and signature together'
      );
      err.status = 400;
      throw err;
    }

    // Freshness: issued_at must be present and within the replay window.
    const fresh = replayGuard.checkFreshness(req.body.issued_at);
    if (!fresh.ok) {
      const err = new Error(fresh.reason);
      err.status = 400;
      throw err;
    }

    // Referenced issuer must exist.
    const referenced = await issuerService.getIssuer(issuer_id);
    if (!referenced) {
      const err = new Error('Referenced issuer not found');
      err.status = 400;
      throw err;
    }

    // API key must be present and match the referenced issuer.
    const apiKey = req.get('x-issuer-key') || '';
    const authed = apiKey
      ? await issuerService.getIssuerByApiKey(apiKey)
      : null;
    if (!authed || authed.id !== issuer_id) {
      const err = new Error('Issuer authentication failed');
      err.status = 401;
      throw err;
    }

    // Referenced key must exist for this issuer.
    const key = await issuerService.getKey(issuer_id, issuer_key_id);
    if (!key) {
      const err = new Error('Referenced issuer key not found');
      err.status = 400;
      throw err;
    }

    const fields = {
      agent_id: agent.id,
      kind: req.body.kind,
      amount: req.body.amount,
      note: req.body.note,
      issuer_id,
      issuer_key_id,
      issued_at: req.body.issued_at,
      signature,
    };
    const outcome = verification.evaluate({ fields, issuerKey: key });

    // A valid signature over an active key → verified. A valid signature over
    // a revoked key → recorded unverified. An invalid signature → reject.
    if (outcome.status !== 'verified' && outcome.reason !== 'key_revoked') {
      const err = new Error('Signature verification failed');
      err.status = 400;
      throw err;
    }

    // Replay guard: each valid signature may be used once.
    const firstUse = await replayGuard.reserveSignature(signature, issuer_id);
    if (!firstUse) {
      const err = new Error('Signature already used (replay rejected)');
      err.status = 409;
      throw err;
    }

    // Weight is derived from `kind`, not taken from the body. A signature would
    // not have protected it anyway — `weight` is not in CANONICAL_FIELDS, so it
    // was the one field a verified submission could alter freely.
    const result = await attestationService.addAttestation(agent.id, {
      kind: req.body.kind,
      amount: req.body.amount,
      note: req.body.note,
      verification_status: outcome.status,
      issuer_id,
      issuer_key_id,
    });
    res.status(201).json(result);
  })
);

router.delete(
  '/agents/:id/attestations/:aid',
  wrap(async (req, res) => {
    // Admin-only. Attestations are append-only for everyone else: a trust
    // history that the subject can edit is not evidence of anything. This is
    // the escape hatch for rows that should never have been written — bad-faith
    // submissions, or operational mistakes.
    requireAdmin(req);
    const { deleted, agent } = await attestationService.deleteAttestation(
      req.params.id,
      req.params.aid
    );
    if (!deleted) {
      const err = new Error('Attestation not found for this agent');
      err.status = 404;
      throw err;
    }
    res.json({ deleted: true, agent });
  })
);

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Authorize a change to an existing permission.
 *
 * The `/permissions/:pid/...` routes are addressed by permission id and never
 * name the agent, so the owning agent has to be resolved before the owner lock
 * can be checked. A permission id is public (it is returned by
 * `GET /agents/:id/permissions`), which is exactly why possessing one cannot be
 * treated as authority on its own.
 *
 * @param {object} req express request
 * @param {string} permissionId
 * @returns {Promise<object>} the permission row, once the caller is authorized
 */
async function authorizePermissionChange(req, permissionId) {
  const permission = await permissionService.getPermissionOr404(permissionId);
  const agent = await agentService.getAgent(permission.agent_id);
  await walletProof.requireOwner(req, agent);
  return permission;
}

router.get(
  '/agents/:id/permissions',
  wrap(async (req, res) => {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    res.json({
      permissions: await permissionService.listPermissions(agent.id, {
        activeOnly: req.query.active === 'true',
      }),
    });
  })
);

router.post(
  '/agents/:id/permissions',
  wrap(async (req, res) => {
    requireFields(req.body, ['category', 'ceiling']);
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    await walletProof.requireOwner(req, agent);
    const permission = await permissionService.grantPermission(agent.id, {
      category: req.body.category,
      ceiling: req.body.ceiling,
      period: req.body.period,
      granted_by: req.body.granted_by,
      velocity_limit: req.body.velocity_limit,
      velocity_window_s: req.body.velocity_window_s,
      counterparty_policy: req.body.counterparty_policy,
      payees: req.body.payees,
      expires_in_s: req.body.expires_in_s,
      expires_at: req.body.expires_at,
    });
    res.status(201).json({ permission });
  })
);

router.post(
  '/permissions/:pid/revoke',
  wrap(async (req, res) => {
    await authorizePermissionChange(req, req.params.pid);
    const permission = await permissionService.revokePermission(req.params.pid);
    if (!permission) {
      const err = new Error('Active permission not found');
      err.status = 404;
      throw err;
    }
    res.json({ permission });
  })
);

// ---------------------------------------------------------------------------
// Payee scope — WHO a permission is allowed to pay.
//
// A ceiling caps how much; this caps who. Setting a permission's
// counterparty_policy to `required` or `allowlist` makes the counterparty trust
// gate mandatory instead of opt-in, so a caller can no longer skip it by
// omitting the field. The allowlist itself says "in scope", never "trusted" —
// an allowlisted payee that starts collecting chargebacks is still refused.
// ---------------------------------------------------------------------------
router.get(
  '/permissions/:pid/payees',
  wrap(async (req, res) => {
    const budget = await spendService.budgetSummary(req.params.pid);
    if (!budget) {
      const err = new Error('Permission not found');
      err.status = 404;
      throw err;
    }
    res.json({
      counterparty_policy: budget.counterparty_policy,
      payees: await permissionService.listPayees(req.params.pid),
    });
  })
);

router.post(
  '/permissions/:pid/payees',
  wrap(async (req, res) => {
    requireFields(req.body, ['counterparty']);
    await authorizePermissionChange(req, req.params.pid);
    const payee = await permissionService.addPayee(req.params.pid, req.body.counterparty, {
      label: req.body.label,
    });
    res.status(201).json({ payee });
  })
);

router.delete(
  '/permissions/:pid/payees/:ref',
  wrap(async (req, res) => {
    await authorizePermissionChange(req, req.params.pid);
    const removed = await permissionService.removePayee(req.params.pid, req.params.ref);
    if (!removed) {
      const err = new Error('Payee not found on this allowlist');
      err.status = 404;
      throw err;
    }
    res.json({ removed });
  })
);

// Set, extend, or clear a grant's expiry deadline. Body takes `expires_in_s`
// (relative seconds) or `expires_at` (absolute ISO8601); an empty body clears
// the deadline so the permission never expires again.
router.post(
  '/permissions/:pid/expiry',
  wrap(async (req, res) => {
    const body = req.body || {};
    await authorizePermissionChange(req, req.params.pid);
    const permission = await permissionService.setExpiry(req.params.pid, {
      expires_in_s: body.expires_in_s,
      expires_at: body.expires_at,
    });
    res.json({ permission });
  })
);

// Tighten (or loosen) an existing grant's payee scope without revoking it, so
// the permission id and its spend history survive the change.
router.post(
  '/permissions/:pid/counterparty-policy',
  wrap(async (req, res) => {
    requireFields(req.body, ['counterparty_policy']);
    await authorizePermissionChange(req, req.params.pid);
    const permission = await permissionService.setCounterpartyPolicy(
      req.params.pid,
      req.body.counterparty_policy,
      { payees: req.body.payees }
    );
    res.json({ permission });
  })
);

// ---------------------------------------------------------------------------
// Spends (enforce the permission ceiling per rolling period)
// ---------------------------------------------------------------------------
router.get(
  '/permissions/:pid/budget',
  wrap(async (req, res) => {
    const budget = await spendService.budgetSummary(req.params.pid);
    if (!budget) {
      const err = new Error('Permission not found');
      err.status = 404;
      throw err;
    }
    res.json({ budget });
  })
);

// Spend history for one permission. Supports paging (`limit`/`offset`) and
// filters on `since`/`until` (ISO date or timestamp), `payee`, and
// `idempotency_key` — so "did that retry actually land?" and "have I paid this
// vendor before?" are one request instead of a client-side scan.
router.get(
  '/permissions/:pid/spends',
  wrap(async (req, res) => {
    const budget = await spendService.budgetSummary(req.params.pid);
    if (!budget) {
      const err = new Error('Permission not found');
      err.status = 404;
      throw err;
    }
    const filters = {
      limit: req.query.limit,
      offset: req.query.offset,
      since: req.query.since,
      until: req.query.until,
      payee: req.query.payee,
      idempotencyKey: req.query.idempotency_key,
    };
    const spends = await spendService.listSpends(req.params.pid, filters);
    res.json({
      spends,
      paging: {
        limit: spendService.clampLimit(filters.limit),
        offset: spendService.clampOffset(filters.offset),
        returned: spends.length,
      },
    });
  })
);

// Dry-run a spend: same checks as a real charge, but nothing is written and no
// budget is consumed. Public + read-only (like /budget) so a payment rail or
// agent can get a go / no-go signal before committing. Returns 200 always with
// `allowed` + a machine-readable `reason` when blocked; a bad amount/key is 400.
router.post(
  '/permissions/:pid/spends/preview',
  wrap(async (req, res) => {
    requireFields(req.body, ['amount']);
    const idempotencyKey = req.get('Idempotency-Key') || req.body.idempotency_key;
    const result = await spendService.previewSpend(req.params.pid, {
      amount: req.body.amount,
      idempotencyKey,
      counterparty: req.body.counterparty,
    });
    res.json(result);
  })
);

// Authorize a real charge. Enforces the period ceiling (409 when exceeded),
// an optional burst velocity cap (429 + a spend.velocity webhook), and — when
// the body names a `counterparty` (payee id/handle/wallet) — a Kairune trust
// gate that refuses (409 + a spend.counterparty_blocked webhook) to release
// funds to a payee whose trust check verdict is `decline`. Every rejection
// carries a `details` object describing exactly why.
router.post(
  '/permissions/:pid/spends',
  wrap(async (req, res) => {
    requireFields(req.body, ['amount']);
    // Releasing funds is the action the lock exists to protect, so it is gated
    // like the rest. The dry-run `/spends/preview` stays open: it writes nothing
    // and consumes no budget, so a payment rail can still get a go / no-go
    // signal without holding the owner's wallet.
    await authorizePermissionChange(req, req.params.pid);
    // Idempotency key: standard `Idempotency-Key` header wins, else body field.
    // Retries that reuse the same key never double-charge the budget.
    const idempotencyKey = req.get('Idempotency-Key') || req.body.idempotency_key;
    const result = await spendService.authorizeSpend(req.params.pid, {
      amount: req.body.amount,
      note: req.body.note,
      idempotencyKey,
      counterparty: req.body.counterparty,
    });
    // A replay returns the original spend (200), a fresh charge is created (201).
    res.status(result.idempotent_replay ? 200 : 201).json(result);
  })
);

// ---------------------------------------------------------------------------
// Spend receipts — "show me the receipt", cryptographically.
//
// Every approved spend is signed with the platform Ed25519 key at charge
// time. This endpoint returns the signed fields, the canonical payload, the
// signature, and the public key — and verifies the signature on the spot —
// so a payee or third party can prove a charge happened without trusting any
// database. Public + read-only, like /api/verify.
// ---------------------------------------------------------------------------
router.get(
  '/spends/:sid/receipt',
  wrap(async (req, res) => {
    const spend = await spendService.getSpendById(req.params.sid);
    if (!spend) {
      const err = new Error('Spend not found');
      err.status = 404;
      throw err;
    }
    res.json({ receipt: await receiptService.buildReceipt(spend) });
  })
);

// The platform's current receipt-signing public key, so verifiers can pin it
// out-of-band (docs, pinned tweet, DNS TXT) instead of fetching it from the
// same server whose receipts they are checking.
router.get('/platform-key', (req, res) => {
  const { publicKeyPem, ephemeral } = receiptService.getPlatformKey();
  res.json({
    algorithm: 'ed25519',
    purpose: 'receipt',
    public_key: publicKeyPem,
    ephemeral,
    receipt_endpoint: '/api/spends/:sid/receipt',
  });
});

// ---------------------------------------------------------------------------
// Webhooks (outbound spend event notifications) — admin-guarded
// ---------------------------------------------------------------------------
router.post(
  '/webhooks',
  wrap(async (req, res) => {
    requireAdmin(req);
    requireFields(req.body, ['url']);
    const { webhook, secret } = await webhookService.createWebhook({
      url: req.body.url,
      events: req.body.events,
      secret: req.body.secret,
    });
    // secret returned exactly once, here.
    res.status(201).json({ webhook, secret });
  })
);

router.get(
  '/webhooks',
  wrap(async (req, res) => {
    requireAdmin(req);
    res.json({ webhooks: await webhookService.listWebhooks() });
  })
);

router.get(
  '/webhooks/:id/deliveries',
  wrap(async (req, res) => {
    requireAdmin(req);
    res.json({
      deliveries: await webhookService.listDeliveries(req.params.id, {
        limit: parseInt(req.query.limit, 10) || 50,
      }),
    });
  })
);

router.delete(
  '/webhooks/:id',
  wrap(async (req, res) => {
    requireAdmin(req);
    const removed = await webhookService.deleteWebhook(req.params.id);
    if (!removed) {
      const err = new Error('Webhook not found');
      err.status = 404;
      throw err;
    }
    res.json({ deleted: true });
  })
);

// ---------------------------------------------------------------------------
// Issuers (verifiable attestations)
// ---------------------------------------------------------------------------
router.post(
  '/issuer-requests',
  wrap(async (req, res) => {
    // Any operator can request that an issuer verify their agent — no special
    // key is needed to ask. The issuer decides, not the platform.
    requireFields(req.body, ['agent_id', 'issuer_id']);
    const reqDoc = await issuerRequestService.createRequest({
      agentId: String(req.body.agent_id).trim(),
      issuerId: String(req.body.issuer_id).trim(),
      message: req.body.message,
    });
    res.status(201).json({ request: reqDoc });
  })
);

router.get(
  '/agents/:id/requests',
  wrap(async (req, res) => {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    res.json({ requests: await issuerRequestService.listRequestsByAgent(agent.id) });
  })
);

router.get(
  '/issuer-requests/:id',
  wrap(async (req, res) => {
    const doc = await issuerRequestService.getRequest(String(req.params.id).trim());
    if (!doc) {
      const err = new Error('Request not found');
      err.status = 404;
      throw err;
    }
    // The owning agent and the addressed issuer may view; others get the
    // existence check (above) without the paywalled `message` body.
    res.json({ request: doc });
  })
);

router.get(
  '/issuers/:id/requests',
  requireIssuer,
  wrap(async (req, res) => {
    if (req.issuer.id !== req.params.id) {
      const err = new Error('Cannot list requests for another issuer');
      err.status = 403;
      throw err;
    }
    res.json({ requests: await issuerRequestService.listRequestsByIssuer(req.issuer.id) });
  })
);

router.post(
  '/issuer-requests/:id/respond',
  requireIssuer,
  wrap(async (req, res) => {
    requireFields(req.body, ['decision']);
    const decision = String(req.body.decision).trim().toLowerCase();
    const doc = await issuerRequestService.respondToRequest({
      requestId: String(req.params.id).trim(),
      issuerId: req.issuer.id,
      decision,
      responseMsg: req.body.response_msg != null ? String(req.body.response_msg) : null,
    });
    res.json({ request: doc });
  })
);

router.post(
  '/issuers',
  wrap(async (req, res) => {
    requireAdmin(req);
    requireFields(req.body, ['display_name']);
    const { issuer, apiKey } = await issuerService.createIssuer({
      displayName: req.body.display_name,
    });
    // api_key returned exactly once, here.
    res.status(201).json({ issuer, api_key: apiKey });
  })
);

router.get(
  '/issuers',
  wrap(async (req, res) => {
    requireAdmin(req);
    res.json({ issuers: await issuerService.listIssuers() });
  })
);

router.post(
  '/issuers/:id/keys',
  requireIssuer,
  wrap(async (req, res) => {
    if (req.issuer.id !== req.params.id) {
      const err = new Error('Cannot manage keys for another issuer');
      err.status = 403;
      throw err;
    }
    requireFields(req.body, ['public_key']);
    const key = await issuerService.addKey(req.params.id, {
      publicKeyPem: req.body.public_key,
      algo: req.body.algo,
    });
    res.status(201).json({ key });
  })
);

router.delete(
  '/issuers/:id/keys/:kid',
  requireIssuer,
  wrap(async (req, res) => {
    if (req.issuer.id !== req.params.id) {
      const err = new Error('Cannot manage keys for another issuer');
      err.status = 403;
      throw err;
    }
    const key = await issuerService.revokeKey(req.params.id, req.params.kid);
    res.json({ key });
  })
);

module.exports = router;
