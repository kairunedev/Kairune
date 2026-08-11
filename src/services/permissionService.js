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
 * Payee scope for a permission — WHO this budget is allowed to pay.
 *
 * The counterparty trust gate on a spend is only as good as the caller's
 * willingness to invoke it: because `counterparty` is a per-request field,
 * omitting it silently skips the gate entirely. That makes the strongest
 * safety property in the product opt-in, which is backwards. This makes the
 * scope a property of the GRANT instead, so it cannot be argued away by the
 * code doing the spending:
 *
 *   open       legacy behaviour — naming a payee is optional (gate only runs
 *              when one is named). Default, fully backward compatible.
 *   required   every spend MUST name a payee. Closes the omission bypass, so
 *              the trust gate always runs.
 *   allowlist  every spend must name a payee that is pinned to this permission
 *              (see permission_payees). Expresses "this budget may only ever
 *              pay these vendors" — the thing a ceiling could never say.
 *
 * `allowlist` implies `required`. Neither replaces the trust gate: an
 * allowlisted payee that later starts collecting chargebacks is still refused.
 */
const COUNTERPARTY_POLICIES = Object.freeze(['open', 'required', 'allowlist']);

// Matches a bare EVM address used as a payee reference.
const WALLET_REF_RE = /^0x[a-fA-F0-9]{40}$/;

// Keeps an allowlist bounded: cheap to read on every spend, and not usable as
// a general-purpose key/value store hanging off a permission.
const MAX_PAYEES_PER_PERMISSION = 50;

const PAYEE_LABEL_MAX = 120;

// Upper bound on `expires_in_s` (365 days). Not a security control — it exists
// so an obvious unit mistake (passing milliseconds, or a JS timestamp) fails
// loudly at grant time instead of silently creating a grant that outlives the
// company. An absolute `expires_at` far in the future is still accepted.
const MAX_EXPIRES_IN_S = 365 * 24 * 60 * 60;

/**
 * Resolve a requested expiry into an ISO8601 deadline.
 *
 * Accepts either form, never both:
 *   expires_in_s  relative seconds from now (ergonomic: "this grant lasts 1h")
 *   expires_at    absolute ISO8601 instant (precise: "expires at market close")
 *
 * Returns null for "no expiry", which is the default and preserves the
 * behaviour of every permission granted before this existed.
 *
 * @param {{expires_in_s?:*, expires_at?:*, nowMs?:number}} input
 * @returns {string|null}
 */
function resolveExpiry({ expires_in_s = null, expires_at = null, nowMs } = {}) {
  const hasIn = expires_in_s !== null && expires_in_s !== undefined && expires_in_s !== '';
  const hasAt = expires_at !== null && expires_at !== undefined && expires_at !== '';

  if (hasIn && hasAt) {
    const err = new Error('Provide either expires_in_s or expires_at, not both');
    err.status = 400;
    throw err;
  }
  if (!hasIn && !hasAt) return null;

  const now = typeof nowMs === 'number' ? nowMs : Date.now();

  if (hasIn) {
    const secs = Number(expires_in_s);
    if (!Number.isInteger(secs) || secs <= 0) {
      const err = new Error('expires_in_s must be a positive integer (seconds)');
      err.status = 400;
      throw err;
    }
    if (secs > MAX_EXPIRES_IN_S) {
      const err = new Error(
        `expires_in_s must be at most ${MAX_EXPIRES_IN_S} (365 days) — pass expires_at for a longer horizon`
      );
      err.status = 400;
      throw err;
    }
    return new Date(now + secs * 1000).toISOString();
  }

  const parsed = new Date(String(expires_at));
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) {
    const err = new Error('expires_at must be a valid ISO8601 date-time');
    err.status = 400;
    throw err;
  }
  // A deadline in the past would create a grant that is dead on arrival. That
  // is never what the caller meant, so refuse instead of silently accepting it.
  if (ms <= now) {
    const err = new Error('expires_at must be in the future');
    err.status = 400;
    throw err;
  }
  return parsed.toISOString();
}

/**
 * Has this permission passed its expiry deadline?
 * NULL expires_at → never expires. Comparison is on absolute time, so it is
 * independent of the row's `status`.
 * @param {object} permission
 * @param {number} [nowMs]
 * @returns {boolean}
 */
function isExpired(permission, nowMs) {
  if (!permission || !permission.expires_at) return false;
  const deadline = new Date(String(permission.expires_at)).getTime();
  if (Number.isNaN(deadline)) return false;
  return deadline <= (typeof nowMs === 'number' ? nowMs : Date.now());
}

/**
 * Seconds until a permission expires (null when it never does, 0 once past).
 * @param {object} permission
 * @param {number} [nowMs]
 * @returns {number|null}
 */
function expiresInSeconds(permission, nowMs) {
  if (!permission || !permission.expires_at) return null;
  const deadline = new Date(String(permission.expires_at)).getTime();
  if (Number.isNaN(deadline)) return null;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  return Math.max(0, Math.round((deadline - now) / 1000));
}

// A permission is usable when a human hasn't revoked it AND its deadline
// hasn't passed. Kept as one string so every "active" query agrees; SQLite
// compares ISO8601 lexicographically, which is why the stored format matters.
const ACTIVE_PERMISSION_SQL = `status = 'active' AND (expires_at IS NULL OR expires_at > ?)`;

/**
 * Normalize a payee reference for storage/comparison.
 * Wallets are lowercased (checksum-insensitive); everything else keeps its
 * case but is compared case-insensitively via `reference_key`.
 * @param {*} raw
 * @returns {string}
 */
function normalizePayeeRef(raw) {
  const ref = String(raw ?? '').trim();
  return WALLET_REF_RE.test(ref) ? ref.toLowerCase() : ref;
}

/**
 * Validate a requested counterparty policy.
 * @param {*} raw
 * @returns {string}
 */
function normalizeCounterpartyPolicy(raw) {
  if (raw === null || raw === undefined || raw === '') return 'open';
  const policy = String(raw).trim().toLowerCase();
  if (!COUNTERPARTY_POLICIES.includes(policy)) {
    const err = new Error(
      `Invalid counterparty_policy. Allowed: ${COUNTERPARTY_POLICIES.join(', ')}`
    );
    err.status = 400;
    throw err;
  }
  return policy;
}

/**
 * Grant a spending permission to an agent (ceiling capped by tier).
 * @param {string} agentId
 * @param {{category:string, ceiling:number, period?:string, granted_by?:string, counterparty_policy?:string, payees?:Array, expires_in_s?:number, expires_at?:string}} input
 * @returns {Promise<object>}
 */
async function grantPermission(
  agentId,
  {
    category,
    ceiling,
    period = 'day',
    granted_by = null,
    velocity_limit = null,
    velocity_window_s = null,
    counterparty_policy = 'open',
    payees = null,
    expires_in_s = null,
    expires_at = null,
    nowMs = undefined,
  }
) {
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

  // Optional velocity (burst) limit: a max spend within a short rolling window,
  // layered on top of the period ceiling to catch runaway/compromised agents.
  // Omitted → NULL → no velocity limit (fully backward compatible).
  let velLimit = null;
  let velWindow = null;
  if (velocity_limit !== null && velocity_limit !== undefined && velocity_limit !== '') {
    velLimit = Number(velocity_limit);
    if (!Number.isFinite(velLimit) || velLimit <= 0) {
      const err = new Error('velocity_limit must be a positive number');
      err.status = 400;
      throw err;
    }
    if (velocity_window_s !== null && velocity_window_s !== undefined && velocity_window_s !== '') {
      velWindow = Number(velocity_window_s);
      if (!Number.isFinite(velWindow) || velWindow <= 0 || !Number.isInteger(velWindow)) {
        const err = new Error('velocity_window_s must be a positive integer (seconds)');
        err.status = 400;
        throw err;
      }
    }
  } else if (velocity_window_s !== null && velocity_window_s !== undefined && velocity_window_s !== '') {
    const err = new Error('velocity_window_s requires velocity_limit to be set');
    err.status = 400;
    throw err;
  }

  const policy = normalizeCounterpartyPolicy(counterparty_policy);

  // Time-bound the grant. Validated before the tier check so a malformed
  // deadline is reported as the caller's input error, not as a trust problem.
  const expiry = resolveExpiry({ expires_in_s, expires_at, nowMs });

  // An allowlist with nothing on it would authorize a budget that can never
  // pay anyone — almost certainly a mistake in the caller, so say so loudly
  // instead of granting a permission that blocks every spend.
  const payeeList = Array.isArray(payees) ? payees.filter((p) => p !== null && p !== undefined && String(p).trim() !== '') : [];
  if (policy === 'allowlist' && payeeList.length === 0) {
    const err = new Error(
      'counterparty_policy "allowlist" requires a non-empty payees array'
    );
    err.status = 400;
    throw err;
  }
  if (policy !== 'allowlist' && payeeList.length > 0) {
    const err = new Error(
      'payees can only be set when counterparty_policy is "allowlist"'
    );
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
    velocity_limit: velLimit,
    velocity_window_s: velLimit ? (velWindow || 60) : null,
    counterparty_policy: policy,
    expires_at: expiry,
    granted_by,
    created_at: nowIso(),
    revoked_at: null,
  };

  await db.execute({
    sql: `INSERT INTO permissions (id, agent_id, category, ceiling, period, status, velocity_limit, velocity_window_s, counterparty_policy, expires_at, granted_by, created_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      permission.id, permission.agent_id, permission.category, permission.ceiling,
      permission.period, permission.status, permission.velocity_limit,
      permission.velocity_window_s, permission.counterparty_policy, permission.expires_at,
      permission.granted_by, permission.created_at, permission.revoked_at,
    ],
  });

  // Seed the allowlist in the same call, so a scoped grant is atomic from the
  // caller's point of view (no window where the permission exists but can pay
  // nobody). Each entry resolves through the same path a spend will use.
  const added = [];
  for (const ref of payeeList) {
    added.push(await addPayee(permission.id, ref, { skipPermissionCheck: true }));
  }

  return {
    ...permission,
    capped: finalCeiling < requested,
    requested_ceiling: requested,
    payees: added,
    expires_in_s: expiresInSeconds(permission, nowMs),
  };
}

/**
 * Load a permission row, or throw a 404.
 * @param {string} permissionId
 * @returns {Promise<object>}
 */
async function getPermissionOr404(permissionId) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM permissions WHERE id = ?`,
    args: [permissionId],
  });
  const permission = res.rows[0];
  if (!permission) {
    const err = new Error('Permission not found');
    err.status = 404;
    throw err;
  }
  return permission;
}

/**
 * Pin a payee to a permission's allowlist.
 *
 * The reference is resolved to a Kairune agent when possible and BOTH the
 * agent id and the literal reference are stored. That way an entry added by
 * handle still matches a spend that names the same payee by wallet — matching
 * on identity, not on how the caller happened to spell it.
 *
 * A valid-but-unregistered `0x…` wallet is accepted (agent_id NULL): operators
 * legitimately allowlist a vendor that has not registered yet. It will still be
 * refused at spend time by the trust gate until it registers, which is the
 * correct layering — the allowlist says "in scope", not "trusted".
 *
 * @param {string} permissionId
 * @param {string} ref payee id, handle, or wallet
 * @param {{label?:string, skipPermissionCheck?:boolean}} [opts]
 * @returns {Promise<object>}
 */
async function addPayee(permissionId, ref, { label = null, skipPermissionCheck = false } = {}) {
  const db = await getDb();

  if (!skipPermissionCheck) await getPermissionOr404(permissionId);

  const reference = normalizePayeeRef(ref);
  if (!reference) {
    const err = new Error('Payee reference is required');
    err.status = 400;
    throw err;
  }

  let cleanLabel = null;
  if (label !== null && label !== undefined && String(label).trim() !== '') {
    cleanLabel = String(label).trim();
    if (cleanLabel.length > PAYEE_LABEL_MAX) {
      const err = new Error(`label must be at most ${PAYEE_LABEL_MAX} characters`);
      err.status = 400;
      throw err;
    }
  }

  const countRes = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM permission_payees WHERE permission_id = ?`,
    args: [permissionId],
  });
  if (Number(countRes.rows[0].n) >= MAX_PAYEES_PER_PERMISSION) {
    const err = new Error(
      `Allowlist is full (max ${MAX_PAYEES_PER_PERMISSION} payees per permission)`
    );
    err.status = 409;
    throw err;
  }

  // Resolve to an agent so the entry matches by identity later.
  const isWallet = WALLET_REF_RE.test(reference);
  const agent = isWallet
    ? await agentService.getAgentByWallet(reference)
    : await agentService.getAgent(reference);

  if (!agent && !isWallet) {
    const err = new Error(
      `Payee "${reference}" could not be resolved to a registered agent (use an id, handle, or 0x wallet)`
    );
    err.status = 404;
    throw err;
  }

  const row = {
    id: crypto.randomUUID(),
    permission_id: permissionId,
    agent_id: agent ? agent.id : null,
    reference,
    label: cleanLabel,
    created_at: nowIso(),
  };

  try {
    await db.execute({
      sql: `INSERT INTO permission_payees (id, permission_id, agent_id, reference, label, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [row.id, row.permission_id, row.agent_id, row.reference, row.label, row.created_at],
    });
  } catch (err) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String(err && err.message))) {
      const dup = new Error(`Payee "${reference}" is already on this allowlist`);
      dup.status = 409;
      throw dup;
    }
    throw err;
  }

  return { ...row, handle: agent ? agent.handle : null, registered: Boolean(agent) };
}

/**
 * List a permission's allowlisted payees (with current handle when resolved).
 * @param {string} permissionId
 * @returns {Promise<object[]>}
 */
async function listPayees(permissionId) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT p.*, a.handle AS handle
          FROM permission_payees p
          LEFT JOIN agents a ON a.id = p.agent_id
          WHERE p.permission_id = ?
          ORDER BY p.created_at ASC`,
    args: [permissionId],
  });
  return res.rows.map((r) => ({
    id: r.id,
    permission_id: r.permission_id,
    agent_id: r.agent_id,
    reference: r.reference,
    label: r.label,
    handle: r.handle,
    registered: Boolean(r.agent_id),
    created_at: r.created_at,
  }));
}

/**
 * Remove a payee from a permission's allowlist by its row id or reference.
 * @param {string} permissionId
 * @param {string} idOrRef
 * @returns {Promise<object|null>}
 */
async function removePayee(permissionId, idOrRef) {
  const db = await getDb();
  const needle = normalizePayeeRef(idOrRef);
  const found = await db.execute({
    sql: `SELECT * FROM permission_payees
          WHERE permission_id = ?
            AND (id = ? OR LOWER(reference) = LOWER(?))
          LIMIT 1`,
    args: [permissionId, needle, needle],
  });
  const row = found.rows[0];
  if (!row) return null;
  await db.execute({
    sql: `DELETE FROM permission_payees WHERE id = ?`,
    args: [row.id],
  });
  return row;
}

/**
 * Change a permission's payee scope after the fact.
 *
 * Lets an operator TIGHTEN an existing grant (open → allowlist) without
 * revoking and re-granting, which would lose the permission id, its
 * created_at, and the spend history hanging off it. Switching to `allowlist`
 * requires the allowlist to be non-empty already (or supplied here), so a
 * permission is never left in a state where it can pay nobody.
 *
 * @param {string} permissionId
 * @param {string} policy open | required | allowlist
 * @param {{payees?:Array}} [opts]
 * @returns {Promise<object>}
 */
async function setCounterpartyPolicy(permissionId, policy, { payees = null } = {}) {
  const db = await getDb();
  await getPermissionOr404(permissionId);
  const next = normalizeCounterpartyPolicy(policy);

  const incoming = Array.isArray(payees)
    ? payees.filter((p) => p !== null && p !== undefined && String(p).trim() !== '')
    : [];
  for (const ref of incoming) {
    // Ignore a duplicate that is already pinned — makes this idempotent.
    try {
      await addPayee(permissionId, ref, { skipPermissionCheck: true });
    } catch (err) {
      if (err.status !== 409) throw err;
    }
  }

  if (next === 'allowlist') {
    const current = await listPayees(permissionId);
    if (current.length === 0) {
      const err = new Error(
        'counterparty_policy "allowlist" requires at least one payee on the allowlist'
      );
      err.status = 400;
      throw err;
    }
  }

  await db.execute({
    sql: `UPDATE permissions SET counterparty_policy = ? WHERE id = ?`,
    args: [next, permissionId],
  });

  const updated = await getPermissionOr404(permissionId);
  return { ...updated, payees: await listPayees(permissionId) };
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
 * Change (or clear) an existing grant's expiry without revoking it, so the
 * permission id and its spend history survive the change.
 *
 * Passing neither field clears the deadline (back to "never expires").
 *
 * NOTE: this can revive an already-expired grant by giving it a new future
 * deadline. That is intentional — "the job needs another 30 minutes" is the
 * common case, it requires the same admin auth as granting a fresh permission,
 * and so it grants no privilege the caller didn't already have. Revocation
 * stays final and is deliberately NOT reversible this way.
 *
 * @param {string} permissionId
 * @param {{expires_in_s?:*, expires_at?:*, nowMs?:number}} [input]
 * @returns {Promise<object>}
 */
async function setExpiry(permissionId, { expires_in_s = null, expires_at = null, nowMs } = {}) {
  const db = await getDb();
  const permission = await getPermissionOr404(permissionId);

  if (permission.status !== 'active') {
    const err = new Error('Cannot change the expiry of a revoked permission');
    err.status = 409;
    throw err;
  }

  const wasExpired = isExpired(permission, nowMs);
  const expiry = resolveExpiry({ expires_in_s, expires_at, nowMs });

  await db.execute({
    sql: `UPDATE permissions SET expires_at = ? WHERE id = ?`,
    args: [expiry, permissionId],
  });

  const got = await db.execute({
    sql: `SELECT * FROM permissions WHERE id = ?`,
    args: [permissionId],
  });
  const updated = got.rows[0];
  return {
    ...updated,
    expires_in_s: expiresInSeconds(updated, nowMs),
    expired: isExpired(updated, nowMs),
    revived: wasExpired && !isExpired(updated, nowMs),
  };
}

/**
 * List an agent's permissions.
 * `activeOnly` means usable NOW — not revoked and not past its deadline.
 * @param {string} agentId
 * @param {{activeOnly?:boolean, nowMs?:number}} [opts]
 * @returns {Promise<object[]>}
 */
async function listPermissions(agentId, { activeOnly = false, nowMs } = {}) {
  const db = await getDb();
  const decorate = (rows) =>
    rows.map((r) => ({
      ...r,
      expires_in_s: expiresInSeconds(r, nowMs),
      expired: isExpired(r, nowMs),
    }));

  if (activeOnly) {
    const res = await db.execute({
      sql: `SELECT * FROM permissions WHERE agent_id = ? AND ${ACTIVE_PERMISSION_SQL}
            ORDER BY created_at DESC`,
      args: [agentId, new Date(typeof nowMs === 'number' ? nowMs : Date.now()).toISOString()],
    });
    return decorate(res.rows);
  }
  const res = await db.execute({
    sql: `SELECT * FROM permissions WHERE agent_id = ? ORDER BY created_at DESC`,
    args: [agentId],
  });
  return decorate(res.rows);
}

module.exports = {
  grantPermission,
  revokePermission,
  listPermissions,
  addPayee,
  listPayees,
  removePayee,
  setCounterpartyPolicy,
  setExpiry,
  normalizeCounterpartyPolicy,
  normalizePayeeRef,
  resolveExpiry,
  isExpired,
  expiresInSeconds,
  VALID_PERIODS,
  COUNTERPARTY_POLICIES,
  MAX_PAYEES_PER_PERMISSION,
  MAX_EXPIRES_IN_S,
  ACTIVE_PERMISSION_SQL,
};
