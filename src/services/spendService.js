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

function nowIso() {
  return new Date().toISOString();
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

module.exports = {
  authorizeSpend,
  budgetSummary,
  listSpends,
  usedInWindow,
  windowStart,
  PERIOD_MS,
};
