'use strict';

/**
 * Agent service — agent CRUD + trust score recalculation (async / libSQL).
 */

const crypto = require('crypto');
const { getDb } = require('../db');
const {
  computeScore,
  suggestedDailyCeiling,
  TIER_LABELS,
} = require('./trustScore');
const webhookService = require('./webhookService');

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

// Shared SQL predicate that excludes demo / test / junk agents from public
// surfaces (leaderboard AND stats — they must agree). Data stays in the DB
// (nothing is deleted); it just never surfaces publicly. `wallet NOT LIKE 0x%`
// intentionally excludes non-EVM identities too, matching current behavior.
// Prefixed with " AND " so it can be appended to a WHERE clause.
const DEMO_EXCLUSION_SQL = ` AND NOT (
         lower(handle) LIKE 'demo-%'
         OR lower(handle) LIKE 'try-%'
         OR lower(handle) LIKE 'sdk-test-%'
         OR lower(handle) LIKE '%-test-%'
         OR lower(handle) LIKE 'dd-test%'
         OR lower(COALESCE(operator,'')) IN ('demo-loop','demo user','dd check')
         OR lower(COALESCE(wallet,'')) LIKE '0x00000000%'
         OR lower(COALESCE(wallet,'')) NOT LIKE '0x%'
       )`;

/**
 * List agents (leaderboard), ordered by highest score.
 * @param {{limit?:number, offset?:number, status?:string}} [opts]
 * @returns {Promise<object[]>}
 */
async function listAgents({ limit = 50, offset = 0, status, includeDemo = false } = {}) {
  const db = await getDb();
  const demoFilter = includeDemo ? '' : DEMO_EXCLUSION_SQL;
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
 * Live leaderboard rank for a single agent.
 *
 * Position is computed with the EXACT same universe and ordering as
 * `listAgents` (the public leaderboard): non-demo agents only, ordered by
 * `score DESC, created_at ASC`. Rank is 1-based; ties are broken by the older
 * agent ranking higher (matching the leaderboard's stable order). Percentile
 * is "top X%" — smaller is better — so a #1 of 200 reads as top 0.5%.
 *
 * Demo/test agents (and the agent itself, if excluded) return null: they have
 * no public standing to rank. This powers the embeddable rank badge and the
 * "rank up" share moment, so it must agree with what the leaderboard shows.
 *
 * @param {string} idOrHandle
 * @returns {Promise<{rank:number, total:number, percentile:number,
 *   score:number, tier:number, label:string, handle:string}|null>}
 */
async function getRank(idOrHandle) {
  const agent = await getAgent(idOrHandle);
  if (!agent) return null;

  const db = await getDb();

  // Total ranked population (same exclusion as the leaderboard/stats).
  const totalRow = (
    await db.execute(`SELECT COUNT(*) c FROM agents WHERE 1=1${DEMO_EXCLUSION_SQL}`)
  ).rows[0];
  const total = Number(totalRow.c) || 0;

  // Is this agent part of the ranked universe at all? A demo/test/non-EVM
  // agent is filtered out of the leaderboard, so it has no public rank.
  const includedRow = (
    await db.execute({
      sql: `SELECT COUNT(*) c FROM agents WHERE id = ?${DEMO_EXCLUSION_SQL}`,
      args: [agent.id],
    })
  ).rows[0];
  if (!Number(includedRow.c)) return null;

  // Count how many ranked agents strictly outrank this one. The ordering is
  // (score DESC, created_at ASC), so an agent outranks us if it has a higher
  // score, OR the same score but an earlier created_at (with id as the final
  // deterministic tiebreak, mirroring a stable sort).
  const aheadRow = (
    await db.execute({
      sql: `SELECT COUNT(*) c FROM agents
            WHERE 1=1${DEMO_EXCLUSION_SQL}
              AND (
                score > ?
                OR (score = ? AND created_at < ?)
                OR (score = ? AND created_at = ? AND id < ?)
              )`,
      args: [
        agent.score,
        agent.score, agent.created_at,
        agent.score, agent.created_at, agent.id,
      ],
    })
  ).rows[0];

  const rank = Number(aheadRow.c) + 1;
  // "Top X%" — a #1 of 200 is top 0.5%. Guard against divide-by-zero.
  const percentile = total > 0 ? Math.round((rank / total) * 1000) / 10 : 100;

  return {
    handle: agent.handle,
    rank,
    total,
    percentile,
    score: Number(agent.score) || 0,
    tier: Number(agent.tier) || 0,
    label: TIER_LABELS[Number(agent.tier) || 0] || 'UNRATED',
  };
}

/**
 * Shape a raw agent row into the compact neighbour view used by
 * getRankNeighbors — just enough to render "who's above / below me".
 * @param {object} row
 * @param {number} rank
 */
function neighborView(row, rank) {
  return {
    rank,
    handle: row.handle,
    score: Number(row.score) || 0,
    tier: Number(row.tier) || 0,
    label: TIER_LABELS[Number(row.tier) || 0] || 'UNRATED',
  };
}

/**
 * The agents immediately above and below this one on the leaderboard — the
 * "who am I chasing, who is chasing me" view. Above = the agent one rank
 * better (the target to overtake); below = the agent one rank worse (the
 * challenger on your heels). Uses the EXACT same universe and ordering as the
 * leaderboard / getRank (non-demo, score DESC, created_at ASC, id ASC).
 *
 * `gap_above` is how many score points you need to catch the agent above you;
 * `gap_below` is your current lead over the agent below you. Both are null at
 * the edges (the #1 agent has no one above; the last agent has no one below).
 *
 * Demo/test agents (no public standing) return null, matching getRank.
 *
 * @param {string} idOrHandle
 * @returns {Promise<{self:object, above:object|null, below:object|null,
 *   gap_above:number|null, gap_below:number|null}|null>}
 */
async function getRankNeighbors(idOrHandle) {
  const agent = await getAgent(idOrHandle);
  if (!agent) return null;
  const self = await getRank(agent.id);
  if (!self) return null;

  const db = await getDb();

  // The agent one rank BETTER than us: the worst-ranked agent that still
  // outranks us. We reverse the leaderboard ordering over the "ahead" set and
  // take the first row — that's the one directly above us. The predicate and
  // tiebreak (score, created_at, id) mirror getRank exactly for consistency.
  const aboveRow = (
    await db.execute({
      sql: `SELECT handle, score, tier FROM agents
            WHERE 1=1${DEMO_EXCLUSION_SQL}
              AND (
                score > ?
                OR (score = ? AND created_at < ?)
                OR (score = ? AND created_at = ? AND id < ?)
              )
            ORDER BY score ASC, created_at DESC, id DESC
            LIMIT 1`,
      args: [
        agent.score,
        agent.score, agent.created_at,
        agent.score, agent.created_at, agent.id,
      ],
    })
  ).rows[0];

  // The agent one rank WORSE than us: the best-ranked agent that we outrank.
  const belowRow = (
    await db.execute({
      sql: `SELECT handle, score, tier FROM agents
            WHERE 1=1${DEMO_EXCLUSION_SQL}
              AND (
                score < ?
                OR (score = ? AND created_at > ?)
                OR (score = ? AND created_at = ? AND id > ?)
              )
            ORDER BY score DESC, created_at ASC, id ASC
            LIMIT 1`,
      args: [
        agent.score,
        agent.score, agent.created_at,
        agent.score, agent.created_at, agent.id,
      ],
    })
  ).rows[0];

  const above = aboveRow ? neighborView(aboveRow, self.rank - 1) : null;
  const below = belowRow ? neighborView(belowRow, self.rank + 1) : null;

  return {
    self,
    above,
    below,
    gap_above: above ? above.score - self.score : null,
    gap_below: below ? self.score - below.score : null,
  };
}

/**
 * Public platform statistics. Applies the SAME demo/test exclusion as the
 * leaderboard so the headline numbers match what visitors actually see.
 * Set includeDemo=true to count everything (internal/debug use).
 * @param {{includeDemo?:boolean}} [opts]
 * @returns {Promise<{total_agents:number, active_agents:number,
 *   total_attestations:number, active_permissions:number, total_spend:number,
 *   avg_score:number, tier_distribution:Array<{tier:number,c:number}>}>}
 */
async function getStats({ includeDemo = false } = {}) {
  const db = await getDb();
  const demoFilter = includeDemo ? '' : DEMO_EXCLUSION_SQL;
  const one = async (sql) => (await db.execute(sql)).rows[0];

  // Attestations / permissions / spends are only counted for non-excluded
  // agents so the totals are internally consistent with the agent count.
  const agentIds = `SELECT id FROM agents WHERE 1=1${demoFilter}`;

  const total = (await one(`SELECT COUNT(*) c FROM agents WHERE 1=1${demoFilter}`)).c;
  const active = (
    await one(
      `SELECT COUNT(*) c FROM agents WHERE status = 'active'${demoFilter}`
    )
  ).c;
  const attestations = (
    await one(
      `SELECT COUNT(*) c FROM attestations WHERE agent_id IN (${agentIds})`
    )
  ).c;
  const activePerms = (
    await one(
      `SELECT COUNT(*) c FROM permissions WHERE status = 'active' AND agent_id IN (${agentIds})`
    )
  ).c;
  const totalSpend = (
    await one(
      `SELECT COALESCE(SUM(amount), 0) s FROM spends WHERE permission_id IN (
         SELECT id FROM permissions WHERE agent_id IN (${agentIds}))`
    )
  ).s;
  const avgScore = (await one(`SELECT AVG(score) a FROM agents WHERE 1=1${demoFilter}`)).a || 0;
  const tierDist = (
    await db.execute(
      `SELECT tier, COUNT(*) c FROM agents WHERE 1=1${demoFilter} GROUP BY tier ORDER BY tier`
    )
  ).rows;

  return {
    total_agents: Number(total) || 0,
    active_agents: Number(active) || 0,
    total_attestations: Number(attestations) || 0,
    active_permissions: Number(activePerms) || 0,
    total_spend: Math.round((Number(totalSpend) || 0) * 100) / 100,
    avg_score: Math.round(Number(avgScore) || 0),
    tier_distribution: tierDist,
  };
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

  // Snapshot the tier/score before rescoring so we can detect a tier change.
  const prev = await getAgent(id);
  const prevTier = prev ? Number(prev.tier) : null;
  const prevScore = prev ? Number(prev.score) : null;

  // Snapshot the leaderboard rank before rescoring too. null means the agent
  // has no public standing (demo/test/non-EVM) — those never emit rank events.
  const prevRankInfo = prev ? await getRank(id) : null;

  const res = await db.execute({
    sql: `SELECT kind, weight, created_at, verification_status, issuer_id FROM attestations WHERE agent_id = ?`,
    args: [id],
  });

  const result = computeScore(res.rows);

  await db.execute({
    sql: `UPDATE agents SET score = ?, tier = ?, updated_at = ? WHERE id = ?`,
    args: [result.score, result.tier, nowIso(), id],
  });

  const agent = await getAgent(id);

  // Emit an agent.tier_changed webhook when the tier actually moves. This lets
  // integrators react to trust changes in real time — e.g. freeze spending on a
  // downgrade or raise ceilings on a promotion. Best-effort: never let a
  // notification failure affect the rescore result. Skipped when there was no
  // prior tier (brand-new agent) or the tier is unchanged.
  if (agent && prevTier !== null && Number(result.tier) !== prevTier) {
    const newTier = Number(result.tier);
    await emitTierChanged({
      agent_id: agent.id,
      agent_handle: agent.handle,
      previous_tier: prevTier,
      previous_label: TIER_LABELS[prevTier] || null,
      previous_score: prevScore,
      tier: newTier,
      label: result.label,
      score: result.score,
      direction: newTier > prevTier ? 'up' : 'down',
    });
  }

  // Emit an agent.rank_changed webhook when the agent's leaderboard position
  // actually moves. This is the competitive share hook: an operator learns the
  // moment their agent overtakes (or gets overtaken by) others. A lower rank
  // number is better, so direction 'up' means the number decreased. Skipped
  // when the agent has no public standing before/after (demo/test) or its rank
  // is unchanged. Best-effort — a notification failure never affects scoring.
  if (agent && prevRankInfo) {
    const newRankInfo = await getRank(id);
    if (newRankInfo && newRankInfo.rank !== prevRankInfo.rank) {
      await emitRankChanged({
        agent_id: agent.id,
        agent_handle: agent.handle,
        previous_rank: prevRankInfo.rank,
        rank: newRankInfo.rank,
        total: newRankInfo.total,
        previous_percentile: prevRankInfo.percentile,
        percentile: newRankInfo.percentile,
        score: newRankInfo.score,
        tier: newRankInfo.tier,
        label: newRankInfo.label,
        // Lower rank number = better position, so a decrease is a promotion.
        direction: newRankInfo.rank < prevRankInfo.rank ? 'up' : 'down',
      });
    }
  }

  return {
    ...agent,
    label: result.label,
    breakdown: result.breakdown,
    totals: result.totals,
    suggested_daily_ceiling: suggestedDailyCeiling(result.score),
  };
}

/**
 * Fire an agent.tier_changed webhook event. Fully swallowed on failure so a
 * webhook problem can never break a rescore. Awaited by recalcAgent so the
 * delivery completes before the serverless (Vercel) process is frozen when the
 * HTTP response is sent — same reason spend events are awaited.
 * @param {object} data
 * @returns {Promise<void>}
 */
async function emitTierChanged(data) {
  try {
    await webhookService.emit('agent.tier_changed', data);
  } catch {
    /* never let notifications affect scoring */
  }
}

/**
 * Fire an agent.rank_changed webhook event. Fully swallowed on failure so a
 * webhook problem can never break a rescore. Awaited by recalcAgent so the
 * delivery completes before the serverless (Vercel) process is frozen when the
 * HTTP response is sent — same reason tier events are awaited.
 * @param {object} data
 * @returns {Promise<void>}
 */
async function emitRankChanged(data) {
  try {
    await webhookService.emit('agent.rank_changed', data);
  } catch {
    /* never let notifications affect scoring */
  }
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
  getRank,
  getRankNeighbors,
  getStats,
  setAgentStatus,
  recalcAgent,
  deleteAgent,
  purgeExpiredDemos,
  DEMO_EXCLUSION_SQL,
};
