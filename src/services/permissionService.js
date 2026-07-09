'use strict';

/**
 * Permission service — scoped spending grants that can be revoked at any time (async).
 */

const crypto = require('crypto');
const { getDb } = require('../db');
const agentService = require('./agentService');
const { suggestedDailyCeiling } = require('./trustScore');

function nowIso() {
  return new Date().toISOString();
}

const VALID_PERIODS = ['day', 'week', 'month'];

/**
 * Grant a spending permission to an agent (ceiling capped by tier).
 * @param {string} agentId
 * @param {{category:string, ceiling:number, period?:string, granted_by?:string}} input
 * @returns {Promise<object>}
 */
async function grantPermission(agentId, { category, ceiling, period = 'day', granted_by = null }) {
  const db = await getDb();

  const agent = await agentService.getAgent(agentId);
  if (!agent) {
    const err = new Error('Agent not found');
    err.status = 404;
    throw err;
  }
  if (agent.status !== 'active') {
    const err = new Error('Cannot grant permission to a suspended agent');
    err.status = 409;
    throw err;
  }
  if (!VALID_PERIODS.includes(period)) {
    const err = new Error(`Invalid period. Allowed: ${VALID_PERIODS.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const requested = Number(ceiling);
  if (!Number.isFinite(requested) || requested <= 0) {
    const err = new Error('Ceiling must be a positive number');
    err.status = 400;
    throw err;
  }

  const maxCeiling = suggestedDailyCeiling(agent.score);
  if (maxCeiling === 0) {
    const err = new Error(
      `Agent tier too low (tier ${agent.tier}) to receive spending permission`
    );
    err.status = 409;
    throw err;
  }
  const finalCeiling = Math.min(requested, maxCeiling);

  const permission = {
    id: crypto.randomUUID(),
    agent_id: agent.id,
    category: String(category).trim(),
    ceiling: finalCeiling,
    period,
    status: 'active',
    granted_by,
    created_at: nowIso(),
    revoked_at: null,
  };

  await db.execute({
    sql: `INSERT INTO permissions (id, agent_id, category, ceiling, period, status, granted_by, created_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      permission.id, permission.agent_id, permission.category, permission.ceiling,
      permission.period, permission.status, permission.granted_by,
      permission.created_at, permission.revoked_at,
    ],
  });

  return {
    ...permission,
    capped: finalCeiling < requested,
    requested_ceiling: requested,
  };
}

/**
 * Revoke a permission (instant revocation).
 * @param {string} permissionId
 * @returns {Promise<object|null>}
 */
async function revokePermission(permissionId) {
  const db = await getDb();
  const res = await db.execute({
    sql: `UPDATE permissions SET status = 'revoked', revoked_at = ?
          WHERE id = ? AND status = 'active'`,
    args: [nowIso(), permissionId],
  });
  if (!res.rowsAffected) return null;
  const got = await db.execute({
    sql: `SELECT * FROM permissions WHERE id = ?`,
    args: [permissionId],
  });
  return got.rows[0] || null;
}

/**
 * List an agent's permissions.
 * @param {string} agentId
 * @param {{activeOnly?:boolean}} [opts]
 * @returns {Promise<object[]>}
 */
async function listPermissions(agentId, { activeOnly = false } = {}) {
  const db = await getDb();
  if (activeOnly) {
    const res = await db.execute({
      sql: `SELECT * FROM permissions WHERE agent_id = ? AND status = 'active'
            ORDER BY created_at DESC`,
      args: [agentId],
    });
    return res.rows;
  }
  const res = await db.execute({
    sql: `SELECT * FROM permissions WHERE agent_id = ? ORDER BY created_at DESC`,
    args: [agentId],
  });
  return res.rows;
}

module.exports = {
  grantPermission,
  revokePermission,
  listPermissions,
  VALID_PERIODS,
};
