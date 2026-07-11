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
 *   GET    /api/stats                          global statistics
 *   GET    /api/meta                           metadata (kinds, tiers)
 */

const express = require('express');
const agentService = require('../services/agentService');
const attestationService = require('../services/attestationService');
const permissionService = require('../services/permissionService');
const trustScore = require('../services/trustScore');
const { getDb } = require('../db');
const { rateLimit } = require('../middleware/rateLimit');
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
    const result = await attestationService.addAttestation(agent.id, {
      kind: req.body.kind,
      amount: req.body.amount,
      note: req.body.note,
      weight: req.body.weight,
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
    const permission = await permissionService.revokePermission(req.params.pid);
    if (!permission) {
      const err = new Error('Active permission not found');
      err.status = 404;
      throw err;
    }
    res.json({ permission });
  })
);

module.exports = router;
