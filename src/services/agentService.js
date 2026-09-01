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
  TIER_THRESHOLDS,
  MAX_SCORE,
} = require('./trustScore');
const { planNextTier } = require('./tierPlanner');
const { assessCounterparty } = require('./counterpartyService');
const webhookService = require('./webhookService');

// A Robinhood Chain (EVM) address: 0x + 40 hex chars. Used to decide whether a
// counterparty reference should be resolved by wallet vs id/handle.
const WALLET_REF_RE = /^0x[a-fA-F0-9]{40}$/;

// Verdict ordering for compareCounterparties: lower sorts first (better pick).
const COMPARE_VERDICT_RANK = { proceed: 0, review: 1, decline: 2 };

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
 * How far along is this agent within its trust tier, and what does the next
 * tier cost? A rank tells you where you sit relative to others; this tells you
 * where you sit relative to the *bar*. Tiers are score bands
 * (TIER_THRESHOLDS = [0, 250, 500, 750, 900]); this reports the floor of the
 * current band, the threshold of the next tier, how many points remain to
 * reach it, and a 0..100 progress value through the current band.
 *
 * At the top tier (PRIME) there is no next threshold: `next_tier` is null,
 * `points_to_next` is 0, and progress is measured across the final open-ended
 * band up to MAX_SCORE so a maxed-out agent reads as 100.
 *
 * Unlike rank, this needs no cross-agent comparison, so it is well-defined for
 * EVERY agent — including demo/test agents, which have a real score even
 * without public standing. The route reads the stored score as-is.
 *
 * @param {string} idOrHandle
 * @returns {Promise<{handle:string, score:number, tier:number, label:string,
 *   tier_floor:number, next_tier:number|null, next_label:string|null,
 *   next_threshold:number|null, points_to_next:number, progress:number}|null>}
 */
async function getTierProgress(idOrHandle) {
  const agent = await getAgent(idOrHandle);
  if (!agent) return null;

  const score = Number(agent.score) || 0;
  const tier = Number(agent.tier) || 0;
  const tierFloor = TIER_THRESHOLDS[tier] ?? 0;

  const isTop = tier >= TIER_THRESHOLDS.length - 1;
  // The ceiling of the current band: the next tier's threshold, or MAX_SCORE
  // for the open-ended top band. This is what progress is measured against.
  const bandCeiling = isTop ? MAX_SCORE : TIER_THRESHOLDS[tier + 1];
  const nextThreshold = isTop ? null : TIER_THRESHOLDS[tier + 1];

  // Points still needed to cross into the next tier (0 at the top).
  const pointsToNext = nextThreshold === null ? 0 : Math.max(0, nextThreshold - score);

  // Progress through the current band, clamped to 0..100 and rounded to one
  // decimal. Guard against a zero-width band (shouldn't happen with the
  // current thresholds).
  const span = bandCeiling - tierFloor;
  const pct = span > 0 ? ((score - tierFloor) / span) * 100 : 100;
  const progress = Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;

  return {
    handle: agent.handle,
    score,
    tier,
    label: TIER_LABELS[tier] || 'UNRATED',
    tier_floor: tierFloor,
    next_tier: isTop ? null : tier + 1,
    next_label: isTop ? null : TIER_LABELS[tier + 1] || null,
    next_threshold: nextThreshold,
    points_to_next: pointsToNext,
    progress,
  };
}

/**
 * Actionable route to the next trust tier for one agent.
 *
 * Where `getTierProgress` reports the *distance* to the next tier, this reports
 * the *route*: how many attestations of each kind it would take to get there,
 * how much faster verified-and-spread-out trust is than verified-from-one-place,
 * and how many negative events would cost the agent its current tier.
 *
 * The plan is produced by re-running the real scoring engine against the
 * agent's real attestation history plus hypothetical events — not by dividing
 * points by weights — so it stays exact even though the score is non-linear
 * (log volume bonus, per-issuer cap, asymmetric negatives).
 *
 * Read-only: nothing is written and no score is mutated. Well-defined for every
 * agent (no cross-agent comparison), so demo agents work too.
 *
 * @param {string} idOrHandle
 * @param {{nowMs?:number}} [opts] clock override for deterministic tests
 * @returns {Promise<object|null>} null when the agent does not exist
 */
async function getNextSteps(idOrHandle, { nowMs } = {}) {
  const agent = await getAgent(idOrHandle);
  if (!agent) return null;

  const db = await getDb();
  // Same projection recalcAgent feeds to computeScore, so the simulation runs
  // against exactly the data that produced the stored score.
  const res = await db.execute({
    sql: `SELECT kind, weight, created_at, verification_status, issuer_id
          FROM attestations WHERE agent_id = ?`,
    args: [agent.id],
  });

  return planNextTier(agent, res.rows, nowMs);
}

/**
 * Pre-flight trust check for transacting with a counterparty agent.
 *
 * This is the one call an agent makes before it *pays another agent*: it names
 * the counterparty (by id, handle, or wallet) and optionally how much it means
 * to spend, and gets back a single `proceed` / `review` / `decline` verdict
 * plus the individual checks that produced it.
 *
 * Resolution is reference-shape aware: a `0x…` reference is looked up by wallet
 * (the identity a payer usually holds), anything else by id or handle. A valid
 * but unregistered wallet is NOT null here — it resolves to a `decline`
 * verdict ("no basis to trust"), because that is the useful answer for a payer.
 * A reference that is neither a wallet nor a known id/handle returns null so
 * the route can 404.
 *
 * Read-only: composes the stored profile and raw attestation history through
 * the pure {@link assessCounterparty} engine. Nothing is written.
 *
 * @param {string} ref counterparty id, handle, or wallet address
 * @param {{amount?:number|null, nowMs?:number}} [opts]
 * @returns {Promise<object|null>} verdict payload, or null for an unresolvable
 *   non-wallet reference
 */
async function checkCounterparty(ref, { amount = null, nowMs } = {}) {
  const raw = String(ref ?? '').trim();
  const isWallet = WALLET_REF_RE.test(raw);

  const agent = isWallet
    ? await getAgentByWallet(raw.toLowerCase())
    : await getAgent(raw);

  // Unknown, non-wallet reference: nothing to assess and no meaningful
  // "unregistered wallet" answer to give → let the caller 404.
  if (!agent && !isWallet) return null;

  let rows = [];
  if (agent) {
    const db = await getDb();
    const res = await db.execute({
      sql: `SELECT kind, weight, created_at, verification_status, issuer_id
            FROM attestations WHERE agent_id = ?`,
      args: [agent.id],
    });
    rows = res.rows;
  }

  return assessCounterparty(agent, rows, {
    amount,
    nowMs,
    wallet: isWallet ? raw.toLowerCase() : null,
  });
}

// Hard cap on a single compare call. Keeps the endpoint cheap and predictable
// (each candidate is one profile read + one attestation read) and stops it
// being used as a bulk-export channel for the whole registry.
const MAX_COMPARE_CANDIDATES = 10;

/**
 * Rank several candidate counterparties in one call and name a winner.
 *
 * `checkCounterparty` answers "is THIS one safe?". An agent choosing between
 * competing offers has the harder question: "which of these should I pay?"
 * Doing that today means N round-trips and re-implementing the tie-breaks
 * client-side — and every client invents slightly different ones. This runs the
 * exact same assessment per candidate, then orders them by a single explicit
 * rule so the choice is reproducible across callers.
 *
 * Ordering (worst-first fields inverted, so index 0 is the best pick):
 *   1. verdict            proceed > review > decline
 *   2. recent severe negatives   fewer chargebacks/anomalies is better
 *   3. recent disputes           fewer is better
 *   4. score              higher is better
 *   5. trust_independence higher is better (harder-to-fake trust)
 *   6. handle             lexical, purely to make ties deterministic
 *
 * Severity outranks score on purpose. Scores saturate — a slate of agents can
 * all sit at the ceiling while differing wildly in recent harm, and sorting
 * those by score alone falls through to alphabetical order, which would put the
 * worst actor at index 0.
 *
 * `recommended` is the first candidate whose verdict is `proceed`. When none
 * qualifies it is null — the honest answer is "none of these clear", not
 * "here's the least-bad one". Callers that want a fallback can read
 * `ranked[0]` themselves and make that call knowingly.
 *
 * Unresolvable non-wallet references are not an error for the batch: they come
 * back in `unresolved[]` so one typo can't sink the whole comparison.
 *
 * Read-only, nothing persisted, deterministic.
 *
 * @param {Array<string>} refs counterparty ids, handles, or wallet addresses
 * @param {{amount?:number|null, nowMs?:number}} [opts]
 * @returns {Promise<{requested_amount:number|null, candidate_count:number,
 *   recommended:object|null, ranked:Array<object>, unresolved:Array<string>}>}
 */
async function compareCounterparties(refs, { amount = null, nowMs } = {}) {
  // De-duplicate so the same agent named twice can't occupy two slots (and
  // can't be used to inflate the candidate count past the cap).
  const seen = new Set();
  const unique = [];
  for (const ref of refs) {
    const raw = String(ref ?? '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(raw);
  }

  const assessed = [];
  const unresolved = [];

  // Up to MAX_COMPARE_CANDIDATES candidates, each owning one profile read + one
  // attestation read. No ordering dependency across candidates, so run in
  // parallel rather than N sequential Turso round-trips.
  const assessedRows = await Promise.all(
    unique.map(async (ref) => {
      const result = await checkCounterparty(ref, { amount, nowMs });
      if (!result) return { unresolved: ref };
      return { assessed: { ref, result } };
    })
  );
  for (const row of assessedRows) {
    if (row.unresolved) unresolved.push(row.unresolved);
    else assessed.push(row.assessed);
  }

  const ranked = assessed
    .map(({ ref, result }) => ({
      ref,
      handle: result.counterparty?.handle ?? null,
      registered: result.registered,
      verdict: result.verdict,
      score: result.counterparty?.score ?? 0,
      tier: result.counterparty?.tier ?? 0,
      tier_label: result.counterparty?.tier_label ?? null,
      trust_independence: result.trust_independence ?? 0,
      suggested_max_amount: result.suggested_max_amount ?? null,
      within_suggested_ceiling: result.within_suggested_ceiling ?? null,
      reasons: result.reasons ?? [],
      checks: result.checks ?? [],
      signals: result.signals ?? {},
    }))
    .sort(
      (a, b) =>
        COMPARE_VERDICT_RANK[a.verdict] - COMPARE_VERDICT_RANK[b.verdict] ||
        // Fewer recent severe negatives (chargebacks/anomalies) first. This sits
        // above score deliberately: once two candidates share a verdict, "who
        // has burned fewer people lately" is more decisive than a score that has
        // already decayed the same events away. Without it, a slate of equally
        // scored declines would order alphabetically and ranked[0] could be the
        // *worst* actor — actively misleading for callers that read ranked[0].
        (a.signals?.recent_severe_negatives ?? 0) - (b.signals?.recent_severe_negatives ?? 0) ||
        (a.signals?.recent_disputes ?? 0) - (b.signals?.recent_disputes ?? 0) ||
        b.score - a.score ||
        b.trust_independence - a.trust_independence ||
        String(a.handle ?? a.ref).localeCompare(String(b.handle ?? b.ref))
    );

  ranked.forEach((c, i) => {
    c.rank = i + 1;
  });

  const recommended = ranked.find((c) => c.verdict === 'proceed') ?? null;

  return {
    requested_amount:
      amount != null && Number.isFinite(Number(amount)) && Number(amount) > 0
        ? Number(amount)
        : null,
    candidate_count: ranked.length,
    recommended,
    ranked,
    unresolved,
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

  // Seven independent aggregates — no ordering dependency, so run in parallel
  // rather than adding a Turso round-trip per row.
  const [total, active, attestations, activePerms, totalSpend, avgScore, tierDistRaw] = await Promise.all([
    one(`SELECT COUNT(*) c FROM agents WHERE 1=1${demoFilter}`),
    one(`SELECT COUNT(*) c FROM agents WHERE status = 'active'${demoFilter}`),
    one(`SELECT COUNT(*) c FROM attestations WHERE agent_id IN (${agentIds})`),
    one(`SELECT COUNT(*) c FROM permissions WHERE status = 'active' AND agent_id IN (${agentIds})`),
    one(`SELECT COALESCE(SUM(amount), 0) s FROM spends WHERE permission_id IN (SELECT id FROM permissions WHERE agent_id IN (${agentIds}))`),
    one(`SELECT AVG(score) a FROM agents WHERE 1=1${demoFilter}`),
    db.execute(`SELECT tier, COUNT(*) c FROM agents WHERE 1=1${demoFilter} GROUP BY tier ORDER BY tier`),
  ]);
  const c = (r) => Number((r && r.c) || 0);
  const sum = Number((totalSpend && totalSpend.s) || 0);
  const avg = Number((avgScore && avgScore.a) || 0);

  return {
    total_agents: c(total),
    active_agents: c(active),
    total_attestations: c(attestations),
    active_permissions: c(activePerms),
    total_spend: Math.round(sum * 100) / 100,
    avg_score: Math.round(avg),
    tier_distribution: tierDistRaw.rows,
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
 * Turn the owner lock on or off for an agent.
 *
 * Locking is what moves an agent from "anyone may adjust its budget" to "only
 * the wallet holder may". The caller is responsible for having verified a fresh
 * wallet proof first — this function only records the decision.
 *
 * @param {string} id
 * @param {boolean} locked
 * @returns {Promise<object|null>} the updated agent, or null when not found
 */
async function setOwnerLock(id, locked) {
  const db = await getDb();
  const ts = nowIso();
  const res = await db.execute({
    sql: `UPDATE agents SET owner_locked_at = ?, updated_at = ? WHERE id = ?`,
    args: [locked ? ts : null, ts, id],
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
 * Set-based — deletes child rows via FK cascades (or explicit IN for backfill)
 * in bulk. No longer walks the result set and deletes one agent per round-trip.
 * @returns {Promise<number>} deleted count
 */
async function purgeExpiredDemos() {
  const hours = parseInt(process.env.DEMO_TTL_HOURS, 10);
  const ttlHours = Number.isFinite(hours) && hours > 0 ? hours : 6;
  const cutoff = new Date(Date.now() - ttlHours * 3600 * 1000).toISOString();
  const db = await getDb();
  const res = await db.execute({
    sql: `DELETE FROM agents
            WHERE created_at < ?
              AND (
                lower(handle) LIKE 'try-%'
                OR lower(handle) LIKE 'demo-%'
                OR lower(COALESCE(operator,'')) IN ('demo-loop','demo user')
              )`,
    args: [cutoff],
  });
  return res.rowsAffected || 0;
}

module.exports = {
  createAgent,
  getAgent,
  getAgentByWallet,
  listAgents,
  getRank,
  getRankNeighbors,
  getTierProgress,
  getNextSteps,
  checkCounterparty,
  compareCounterparties,
  MAX_COMPARE_CANDIDATES,
  getStats,
  setAgentStatus,
  setOwnerLock,
  recalcAgent,
  deleteAgent,
  purgeExpiredDemos,
  DEMO_EXCLUSION_SQL,
};
