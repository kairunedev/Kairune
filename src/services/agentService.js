'use strict';

/**
 * Agent service — agent CRUD + trust score recalculation (async / libSQL).
 */

const crypto = require('crypto');
const { getDb } = require('../db');
const { computeScore, suggestedDailyCeiling } = require('./trustScore');

function nowIso() {
  return new Date().toISOString();
}
function uuid() {
  return crypto.randomUUID();
}

/**
 * Create a new agent and score it immediately (baseline).
 * @param {{handle:string, wallet:string, operator?:string}} input
 * @returns {Promise<object>}
 */
async function createAgent({ handle, wallet, operator = null }) {
  const db = await getDb();
  const ts = nowIso();
  const agent = {
    id: uuid(),
    handle: String(handle).trim().toLowerCase(),
    wallet: String(wallet).trim(),
    operator,
    status: 'active',
    score: 0,
    tier: 0,
    created_at: ts,
    updated_at: ts,
  };

  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      agent.id, agent.handle, agent.wallet, agent.operator, agent.status,
      agent.score, agent.tier, agent.created_at, agent.updated_at,
    ],
  });

  return recalcAgent(agent.id);
}

/**
 * Get a single agent by id or handle.
 * @param {string} idOrHandle
 * @returns {Promise<object|null>}
 */
async function getAgent(idOrHandle) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM agents WHERE id = ? OR handle = ? LIMIT 1`,
    args: [idOrHandle, String(idOrHandle).toLowerCase()],
  });
  return res.rows[0] || null;
}

/**
 * Get an agent by wallet (exact match).
 * @param {string} wallet
 * @returns {Promise<object|null>}
 */
async function getAgentByWallet(wallet) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM agents WHERE wallet = ? LIMIT 1`,
    args: [String(wallet).trim()],
  });
  return res.rows[0] || null;
}

/**
 * List agents (leaderboard), ordered by highest score.
 * @param {{limit?:number, offset?:number, status?:string}} [opts]
 * @returns {Promise<object[]>}
 */
async function listAgents({ limit = 50, offset = 0, status, includeDemo = false } = {}) {
  const db = await getDb();
  const demoFilter = includeDemo
    ? ''
    : ` AND NOT (
         lower(handle) LIKE 'demo-%'
         OR lower(handle) LIKE 'try-%'
         OR lower(COALESCE(operator,'')) IN ('demo-loop','demo user')
       )`;
  if (status) {
    const res = await db.execute({
      sql: `SELECT * FROM agents WHERE status = ?${demoFilter}
            ORDER BY score DESC, created_at ASC LIMIT ? OFFSET ?`,
      args: [status, limit, offset],
    });
    return res.rows;
  }
  // When no status filter, still apply demo filter via WHERE 1=1
  const res = await db.execute({
    sql: `SELECT * FROM agents WHERE 1=1${demoFilter}
          ORDER BY score DESC, created_at ASC LIMIT ? OFFSET ?`,
    args: [limit, offset],
  });
  return res.rows;
}

/**
 * Change an agent's status (active/suspended).
 * @param {string} id
 * @param {string} status
 * @returns {Promise<object|null>}
 */
async function setAgentStatus(id, status) {
  const db = await getDb();
  const res = await db.execute({
    sql: `UPDATE agents SET status = ?, updated_at = ? WHERE id = ?`,
    args: [status, nowIso(), id],
  });
  return res.rowsAffected ? getAgent(id) : null;
}

/**
 * Recalculate an agent's score from all its attestations and persist to the DB.
 * @param {string} id
 * @returns {Promise<object>}
 */
async function recalcAgent(id) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT kind, weight, created_at FROM attestations WHERE agent_id = ?`,
    args: [id],
  });

  const result = computeScore(res.rows);

  await db.execute({
    sql: `UPDATE agents SET score = ?, tier = ?, updated_at = ? WHERE id = ?`,
    args: [result.score, result.tier, nowIso(), id],
  });

  const agent = await getAgent(id);
  return {
    ...agent,
    label: result.label,
    breakdown: result.breakdown,
    totals: result.totals,
    suggested_daily_ceiling: suggestedDailyCeiling(result.score),
  };
}

/**
 * Delete an agent (cascades to attestations & permissions).
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function deleteAgent(id) {
  const db = await getDb();
  const res = await db.execute({
    sql: `DELETE FROM agents WHERE id = ?`,
    args: [id],
  });
  return res.rowsAffected > 0;
}

/**
 * Remove ephemeral demo agents older than DEMO_TTL_HOURS (default 6).
 * Lazy cleanup — called from read endpoints so serverless doesn't need a cron.
 * @returns {Promise<number>} deleted count
 */
async function purgeExpiredDemos() {
  const hours = parseInt(process.env.DEMO_TTL_HOURS, 10);
  const ttlHours = Number.isFinite(hours) && hours > 0 ? hours : 6;
  const cutoff = new Date(Date.now() - ttlHours * 3600 * 1000).toISOString();
  const db = await getDb();
  const found = await db.execute({
    sql: `SELECT id FROM agents WHERE created_at < ?
            AND (
              lower(handle) LIKE 'try-%'
              OR lower(handle) LIKE 'demo-%'
              OR lower(COALESCE(operator,'')) IN ('demo-loop','demo user')
            )`,
    args: [cutoff],
  });
  let n = 0;
  for (const row of found.rows) {
    if (await deleteAgent(row.id)) n += 1;
  }
  return n;
}

module.exports = {
  createAgent,
  getAgent,
  getAgentByWallet,
  listAgents,
  setAgentStatus,
  recalcAgent,
  deleteAgent,
  purgeExpiredDemos,
};
