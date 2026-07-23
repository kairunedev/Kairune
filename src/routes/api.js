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
 *   PATCH  /api/agents/:id/status             suspend / activate an agent
 *   DELETE /api/agents/:id                    delete an agent
 *   GET    /api/agents/:id/attestations       attestation history
 *   POST   /api/agents/:id/attestations       add attestation (triggers rescore)
 *   GET    /api/agents/:id/permissions        list permissions
 *   POST   /api/agents/:id/permissions        grant permission
 *   POST   /api/permissions/:pid/revoke       revoke permission
 *   GET    /api/permissions/:pid/budget        remaining spend budget
 *   GET    /api/permissions/:pid/spends        spend history
 *   POST   /api/permissions/:pid/spends        authorize a spend (enforces ceiling)
 *   POST   /api/webhooks                        register a spend-event webhook
 *   GET    /api/webhooks                        list webhooks
 *   GET    /api/webhooks/:id/deliveries         webhook delivery log
 *   DELETE /api/webhooks/:id                     delete a webhook
 *   GET    /api/stats                          global statistics
 *   GET    /api/feed                           public spend activity feed
 *   GET    /api/meta                           metadata (kinds, tiers)
 *   POST   /api/verify                          public, stateless Ed25519 signature check
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
const replayGuard = require('../services/replayGuard');
const trustScore = require('../services/trustScore');
const issuerDiversity = require('../services/issuerDiversity');
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
    wallet_lookup_endpoint: '/api/wallets/:wallet',
    idempotency_header: 'Idempotency-Key',
    idempotency_max_key_length: spendService.MAX_IDEMPOTENCY_KEY_LEN,
    diversity_target_issuers: issuerDiversity.DIVERSITY_TARGET_ISSUERS,
    webhook_events: webhookService.EVENTS,
    chain: ROBINHOOD_CHAIN_NAME,
    chain_id: ROBINHOOD_CHAIN_ID,
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
    await agentService.purgeExpiredDemos().catch(() => 0);
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
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    res.json({ events: await spendService.listFeed({ limit }) });
  })
);

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
router.get(
  '/agents',
  wrap(async (req, res) => {
    await agentService.purgeExpiredDemos().catch(() => 0);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
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
    res.json({ agent, attestations, permissions });
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

    const agent = await agentService.recalcAgent(base.id);
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
      // A suspended agent should never be trusted to spend, regardless of score.
      trusted: agent.status === 'active' && tier >= 1,
      updated_at: agent.updated_at,
    });
  })
);

router.patch(
  '/agents/:id/status',
  wrap(async (req, res) => {
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
        limit: Math.min(parseInt(req.query.limit, 10) || 50, 200),
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
    if (present === 0) {
      const result = await attestationService.addAttestation(agent.id, {
        kind: req.body.kind,
        amount: req.body.amount,
        note: req.body.note,
        weight: req.body.weight,
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

    const result = await attestationService.addAttestation(agent.id, {
      kind: req.body.kind,
      amount: req.body.amount,
      note: req.body.note,
      weight: req.body.weight,
      verification_status: outcome.status,
      issuer_id,
      issuer_key_id,
    });
    res.status(201).json(result);
  })
);

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------
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
    requireAdmin(req);
    requireFields(req.body, ['category', 'ceiling']);
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) {
      const err = new Error('Agent not found');
      err.status = 404;
      throw err;
    }
    const permission = await permissionService.grantPermission(agent.id, {
      category: req.body.category,
      ceiling: req.body.ceiling,
      period: req.body.period,
      granted_by: req.body.granted_by,
    });
    res.status(201).json({ permission });
  })
);

router.post(
  '/permissions/:pid/revoke',
  wrap(async (req, res) => {
    requireAdmin(req);
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

router.get(
  '/permissions/:pid/spends',
  wrap(async (req, res) => {
    const budget = await spendService.budgetSummary(req.params.pid);
    if (!budget) {
      const err = new Error('Permission not found');
      err.status = 404;
      throw err;
    }
    res.json({
      spends: await spendService.listSpends(req.params.pid, {
        limit: parseInt(req.query.limit, 10) || 50,
      }),
    });
  })
);

router.post(
  '/permissions/:pid/spends',
  wrap(async (req, res) => {
    requireAdmin(req);
    requireFields(req.body, ['amount']);
    // Idempotency key: standard `Idempotency-Key` header wins, else body field.
    // Retries that reuse the same key never double-charge the budget.
    const idempotencyKey = req.get('Idempotency-Key') || req.body.idempotency_key;
    const result = await spendService.authorizeSpend(req.params.pid, {
      amount: req.body.amount,
      note: req.body.note,
      idempotencyKey,
    });
    // A replay returns the original spend (200), a fresh charge is created (201).
    res.status(result.idempotent_replay ? 200 : 201).json(result);
  })
);

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
