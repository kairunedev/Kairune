'use strict';

/**
 * Spend service — authorizes and records actual charges against a permission.
 *
 * This is what makes Kairune "the trust layer for agents that spend": a
 * permission grants a ceiling per rolling period, and every spend is checked
 * against how much has already been used inside that window before it is
 * allowed. Spends are append-only and can be summarised at any time.
 */

const crypto = require('crypto');
const { getDb } = require('../db');
const agentService = require('./agentService');
const webhookService = require('./webhookService');

function nowIso() {
  return new Date().toISOString();
}

/**
 * Emit a spend event to registered webhooks.
 *
 * Awaited by the caller so deliveries complete before the request finishes —
 * required on serverless (Vercel) where the process is frozen the moment the
 * HTTP response is sent, which would otherwise drop fire-and-forget work.
 * All failures are swallowed here, so notifications can never block or fail a
 * spend; if no webhooks are registered the overhead is a single empty query.
 * @param {string} event
 * @param {object} data
 * @returns {Promise<void>}
 */
async function emitSpendEvent(event, data) {
  try {
    await webhookService.emit(event, data);
  } catch {
    /* never let notifications affect spend authorization */
  }
}

/**
 * Append a spend decision to the public activity log (spend_events).
 *
 * This powers the landing-page live feed. It is best-effort: any failure is
 * swallowed so logging can never block or fail a spend authorization. No PII
 * is stored — only the agent handle, amount, ceiling, and decision.
 * @param {'spend.approved'|'spend.blocked'} event
 * @param {{agent_id?:string, agent_handle?:string, amount:number, ceiling?:number, period?:string, reason?:string, createdAt?:string}} data
 * @returns {Promise<void>}
 */
async function recordEvent(event, data) {
  try {
    const db = await getDb();
    await db.execute({
      sql: `INSERT INTO spend_events
              (id, event, agent_id, agent_handle, amount, ceiling, period, reason, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        event,
        data.agent_id ?? null,
        data.agent_handle ?? null,
        Number(data.amount) || 0,
        data.ceiling ?? null,
        data.period ?? null,
        data.reason ?? null,
        data.createdAt || nowIso(),
      ],
    });
  } catch {
    /* never let activity logging affect spend authorization */
  }
}

// Rolling window length (ms) for each permission period.
const PERIOD_MS = Object.freeze({
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
});

/**
 * Start of the current rolling window for a period, as an ISO timestamp.
 * @param {string} period day | week | month
 * @param {number} [nowMs] time override (for tests)
 * @returns {string}
 */
function windowStart(period, nowMs) {
  const now = nowMs || Date.now();
  const span = PERIOD_MS[period] || PERIOD_MS.day;
  return new Date(now - span).toISOString();
}

/**
 * Total amount already spent against a permission within its current window.
 * @param {string} permissionId
 * @param {string} period
 * @param {number} [nowMs]
 * @returns {Promise<number>}
 */
async function usedInWindow(permissionId, period, nowMs) {
  const db = await getDb();
  const since = windowStart(period, nowMs);
  const res = await db.execute({
    sql: `SELECT COALESCE(SUM(amount), 0) AS used
          FROM spends
          WHERE permission_id = ? AND created_at >= ?`,
    args: [permissionId, since],
  });
  return Number(res.rows[0].used) || 0;
}

/**
 * Authorize (and record) a spend against a permission.
 *
 * The charge is allowed only when the permission is active, its agent is
 * active, and the amount fits under the remaining budget for the current
 * rolling window. On success the spend is recorded and the updated budget is
 * returned. On rejection an Error with a `status` is thrown.
 *
 * @param {string} permissionId
 * @param {{amount:number, note?:string}} input
 * @param {{nowMs?:number}} [opts]
 * @returns {Promise<object>}
 */
async function authorizeSpend(permissionId, { amount, note = null }, opts = {}) {
  const db = await getDb();

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    const err = new Error('Amount must be a positive number');
    err.status = 400;
    throw err;
  }

  const permRes = await db.execute({
    sql: `SELECT * FROM permissions WHERE id = ?`,
    args: [permissionId],
  });
  const permission = permRes.rows[0];
  if (!permission) {
    const err = new Error('Permission not found');
    err.status = 404;
    throw err;
  }
  if (permission.status !== 'active') {
    const err = new Error('Permission is revoked');
    err.status = 409;
    throw err;
  }

  const agent = await agentService.getAgent(permission.agent_id);
  if (!agent) {
    const err = new Error('Agent not found');
    err.status = 404;
    throw err;
  }
  if (agent.status !== 'active') {
    const err = new Error('Cannot spend for a suspended agent');
    err.status = 409;
    throw err;
  }

  const ceiling = Number(permission.ceiling);
  const used = await usedInWindow(permissionId, permission.period, opts.nowMs);
  const remaining = ceiling - used;
  if (value > remaining) {
    const err = new Error(
      `Spend exceeds remaining budget (requested ${value}, remaining ${Math.max(
        0,
        remaining
      )} per ${permission.period})`
    );
    err.status = 409;
    err.details = {
      requested: value,
      ceiling,
      used,
      remaining: Math.max(0, remaining),
      period: permission.period,
    };
    await emitSpendEvent('spend.blocked', {
      permission_id: permissionId,
      agent_id: permission.agent_id,
      requested: value,
      ceiling,
      used,
      remaining: Math.max(0, remaining),
      period: permission.period,
      reason: 'ceiling_exceeded',
    });
    await recordEvent('spend.blocked', {
      agent_id: permission.agent_id,
      agent_handle: agent.handle,
      amount: value,
      ceiling,
      period: permission.period,
      reason: 'ceiling_exceeded',
    });
    throw err;
  }

  const spend = {
    id: crypto.randomUUID(),
    permission_id: permissionId,
    agent_id: permission.agent_id,
    amount: value,
    note,
    created_at: opts.nowMs ? new Date(opts.nowMs).toISOString() : nowIso(),
  };

  await db.execute({
    sql: `INSERT INTO spends (id, permission_id, agent_id, amount, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      spend.id,
      spend.permission_id,
      spend.agent_id,
      spend.amount,
      spend.note,
      spend.created_at,
    ],
  });

  await emitSpendEvent('spend.approved', {
    permission_id: permissionId,
    agent_id: permission.agent_id,
    spend_id: spend.id,
    amount: value,
    ceiling,
    used: used + value,
    remaining: remaining - value,
    period: permission.period,
  });
  await recordEvent('spend.approved', {
    agent_id: permission.agent_id,
    agent_handle: agent.handle,
    amount: value,
    ceiling,
    period: permission.period,
    createdAt: spend.created_at,
  });

  return {
    spend,
    budget: {
      ceiling,
      period: permission.period,
      used: used + value,
      remaining: remaining - value,
    },
  };
}

/**
 * Current budget summary for a permission (no charge applied).
 * @param {string} permissionId
 * @param {{nowMs?:number}} [opts]
 * @returns {Promise<object|null>}
 */
async function budgetSummary(permissionId, opts = {}) {
  const db = await getDb();
  const permRes = await db.execute({
    sql: `SELECT * FROM permissions WHERE id = ?`,
    args: [permissionId],
  });
  const permission = permRes.rows[0];
  if (!permission) return null;

  const ceiling = Number(permission.ceiling);
  const used = await usedInWindow(permissionId, permission.period, opts.nowMs);
  return {
    permission_id: permissionId,
    agent_id: permission.agent_id,
    category: permission.category,
    period: permission.period,
    status: permission.status,
    ceiling,
    used,
    remaining: Math.max(0, ceiling - used),
  };
}

/**
 * List recent spends for a permission (most recent first).
 * @param {string} permissionId
 * @param {{limit?:number}} [opts]
 * @returns {Promise<object[]>}
 */
async function listSpends(permissionId, { limit = 50 } = {}) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM spends WHERE permission_id = ?
          ORDER BY created_at DESC LIMIT ?`,
    args: [permissionId, Math.min(Math.max(1, limit), 200)],
  });
  return res.rows;
}

/**
 * Public activity feed: recent spend decisions (approved + blocked) across all
 * agents. Read-only, no auth, no PII — safe to expose on the landing page.
 * @param {{limit?:number}} [opts]
 * @returns {Promise<object[]>}
 */
async function listFeed({ limit = 20 } = {}) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT event, agent_handle, amount, ceiling, period, reason, created_at
          FROM spend_events
          ORDER BY created_at DESC LIMIT ?`,
    args: [Math.min(Math.max(1, limit), 100)],
  });
  return res.rows;
}

module.exports = {
  authorizeSpend,
  budgetSummary,
  listSpends,
  listFeed,
  recordEvent,
  usedInWindow,
  windowStart,
  PERIOD_MS,
};
