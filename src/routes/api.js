'use strict';

/**
 * Kairune REST API.
 * All endpoints are mounted at /api by server.js.
 *
 * Summary:
 *   GET    /api/agents                       list agents (leaderboard)
 *   POST   /api/agents                       register a new agent
 *   GET    /api/agents/:id                    agent detail + score breakdown
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
 *   GET    /api/meta                           metadata (kinds, tiers)
 */

const express = require('express');
const agentService = require('../services/agentService');
const attestationService = require('../services/attestationService');
const permissionService = require('../services/permissionService');
const spendService = require('../services/spendService');
const issuerService = require('../services/issuerService');
const webhookService = require('../services/webhookService');
const verification = require('../services/verification');
const replayGuard = require('../services/replayGuard');
const trustScore = require('../services/trustScore');
const { getDb } = require('../db');
const { rateLimit } = require('../middleware/rateLimit');
const { requireIssuer } = require('../middleware/issuerAuth');
const {
  assertValidHandle,
  requireAdmin,
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
  });
});

router.get('/token', (req, res) => {
  res.json(tokenStatus(req));
});

router.get(
  '/stats',
  wrap(async (req, res) => {
    await agentService.purgeExpiredDemos().catch(() => 0);
    const db = await getDb();
    const one = async (sql) => (await db.execute(sql)).rows[0];

    const agents = (await one(`SELECT COUNT(*) c FROM agents`)).c;
    const active = (
      await one(`SELECT COUNT(*) c FROM agents WHERE status = 'active'`)
    ).c;
    const attestations = (await one(`SELECT COUNT(*) c FROM attestations`)).c;
    const activePerms = (
      await one(`SELECT COUNT(*) c FROM permissions WHERE status = 'active'`)
    ).c;
    const totalSpend = (await one(`SELECT COALESCE(SUM(amount), 0) s FROM spends`)).s;
    const avgScore = (await one(`SELECT AVG(score) a FROM agents`)).a || 0;
    const tierDist = (
      await db.execute(
        `SELECT tier, COUNT(*) c FROM agents GROUP BY tier ORDER BY tier`
      )
    ).rows;

    res.json({
      total_agents: agents,
      active_agents: active,
      total_attestations: attestations,
      active_permissions: activePerms,
      total_spend: Math.round((Number(totalSpend) || 0) * 100) / 100,
      avg_score: Math.round(avgScore),
      tier_distribution: tierDist,
    });
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
    const wallet = String(req.body.wallet).trim();
    if (wallet.length < 6) {
      const err = new Error('Wallet / identity must be at least 6 characters');
      err.status = 400;
      throw err;
    }
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
      wallet: req.body.wallet,
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
    const result = await spendService.authorizeSpend(req.params.pid, {
      amount: req.body.amount,
      note: req.body.note,
    });
    res.status(201).json(result);
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
