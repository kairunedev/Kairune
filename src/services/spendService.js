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
const { isExpired, expiresInSeconds } = require('./permissionService');
const receiptService = require('./receiptService');

function nowIso() {
  return new Date().toISOString();
}

// Max length for a client-supplied idempotency key.
const MAX_IDEMPOTENCY_KEY_LEN = 255;

/**
 * Normalize and validate a client-supplied idempotency key.
 * Returns the trimmed key, or null when none was supplied. Throws a 400 for a
 * key that is present but malformed (non-string or too long).
 * @param {*} raw
 * @returns {string|null}
 */
function normalizeIdempotencyKey(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') {
    const err = new Error('idempotency_key must be a string');
    err.status = 400;
    throw err;
  }
  const key = raw.trim();
  if (!key) return null;
  if (key.length > MAX_IDEMPOTENCY_KEY_LEN) {
    const err = new Error(
      `idempotency_key must be at most ${MAX_IDEMPOTENCY_KEY_LEN} characters`
    );
    err.status = 400;
    throw err;
  }
  return key;
}

/**
 * Find a prior spend recorded under a given idempotency key for a permission.
 * @param {string} permissionId
 * @param {string} key
 * @returns {Promise<object|null>}
 */
async function findSpendByKey(permissionId, key) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM spends WHERE permission_id = ? AND idempotency_key = ? LIMIT 1`,
    args: [permissionId, key],
  });
  return res.rows[0] || null;
}

/**
 * Whether a DB error is a UNIQUE-constraint violation (idempotency race).
 * @param {*} err
 * @returns {boolean}
 */
function isUniqueConstraintError(err) {
  const msg = String((err && err.message) || '');
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
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
 * @param {'spend.approved'|'spend.blocked'|'spend.threshold'} event
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

// Default rolling window (seconds) for a permission's velocity limit when the
// grant sets a velocity_limit but leaves velocity_window_s unset.
const DEFAULT_VELOCITY_WINDOW_S = 60;

/**
 * Resolve a permission's effective velocity limit, or null when it has none.
 *
 * A velocity limit is a burst cap layered on top of the period ceiling: at most
 * `limit` may be spent within any rolling `windowSeconds` window. It catches a
 * runaway or compromised agent draining its whole budget in seconds — the
 * period ceiling alone wouldn't flag that until the ceiling itself is hit.
 * @param {object} permission
 * @returns {{limit:number, windowMs:number, windowSeconds:number}|null}
 */
function resolveVelocity(permission) {
  const limit = Number(permission.velocity_limit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const rawWindow = Number(permission.velocity_window_s);
  const windowSeconds =
    Number.isFinite(rawWindow) && rawWindow > 0
      ? Math.floor(rawWindow)
      : DEFAULT_VELOCITY_WINDOW_S;
  return { limit, windowMs: windowSeconds * 1000, windowSeconds };
}

/**
 * Total amount spent against a permission within the last `windowMs`.
 * @param {string} permissionId
 * @param {number} windowMs
 * @param {number} [nowMs]
 * @returns {Promise<number>}
 */
async function usedInVelocityWindow(permissionId, windowMs, nowMs) {
  const db = await getDb();
  const since = new Date((nowMs || Date.now()) - windowMs).toISOString();
  const res = await db.execute({
    sql: `SELECT COALESCE(SUM(amount), 0) AS used
          FROM spends
          WHERE permission_id = ? AND created_at >= ?`,
    args: [permissionId, since],
  });
  return Number(res.rows[0].used) || 0;
}

// Fraction of the ceiling at which an approved spend emits a `spend.threshold`
// warning, letting operators top up before the agent gets blocked. Overridable
// via SPEND_ALERT_THRESHOLD (a value in (0,1), e.g. 0.9 for 90%).
function resolveAlertThreshold() {
  const raw = Number(process.env.SPEND_ALERT_THRESHOLD);
  if (Number.isFinite(raw) && raw > 0 && raw < 1) return raw;
  return 0.8;
}

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

// Counterparty verdicts that a gated spend refuses to pay. `review` is a soft
// caution (emerging trust / large-for-tier amount), so it is allowed through;
// only an outright `decline` — unregistered, suspended, or recently
// chargeback/anomaly-flagged payee — blocks the charge.
const GATE_BLOCKING_VERDICTS = Object.freeze(['decline']);

/**
 * Enforce a permission's payee scope (its `counterparty_policy`).
 *
 * The trust gate can only run when a spend names a payee — so leaving that
 * field out skipped it entirely, which made the strongest guarantee in the
 * product opt-in. This resolves the scope declared on the GRANT, so the code
 * doing the spending cannot opt out of it:
 *
 *   open       payee optional (legacy)
 *   required   payee mandatory → `counterparty_required` when missing
 *   allowlist  payee mandatory AND pinned → `counterparty_not_allowed` otherwise
 *
 * Scope is checked BEFORE the trust assessment on purpose: an out-of-scope
 * payee is refused without disclosing anything about its trust standing, and
 * an in-scope payee is still fully trust-checked afterwards. Being on the
 * allowlist means "in scope", never "trusted".
 *
 * @param {object} permission
 * @param {string|null} counterparty
 * @returns {Promise<{ok:boolean, policy:string, reason?:string, message?:string, payee?:object|null}>}
 */
async function enforcePayeeScope(permission, counterparty) {
  const policy = String(permission.counterparty_policy || 'open');
  const ref = counterparty == null ? '' : String(counterparty).trim();

  if (policy === 'open') return { ok: true, policy };

  if (!ref) {
    return {
      ok: false,
      policy,
      reason: 'counterparty_required',
      message:
        policy === 'allowlist'
          ? 'This permission may only pay allowlisted payees — name a `counterparty` on the spend'
          : 'This permission requires every spend to name a `counterparty`',
    };
  }

  if (policy !== 'allowlist') return { ok: true, policy };

  const db = await getDb();
  const isWallet = /^0x[a-fA-F0-9]{40}$/.test(ref);
  const normalized = isWallet ? ref.toLowerCase() : ref;

  // Resolve the named payee so allowlist matching is by IDENTITY, not spelling:
  // an entry pinned by handle still matches a spend that names the wallet.
  const agent = isWallet
    ? await agentService.getAgentByWallet(normalized)
    : await agentService.getAgent(normalized);

  const res = await db.execute({
    sql: `SELECT * FROM permission_payees
          WHERE permission_id = ?
            AND (LOWER(reference) = LOWER(?) ${agent ? 'OR agent_id = ?' : ''})
          LIMIT 1`,
    args: agent
      ? [permission.id, normalized, agent.id]
      : [permission.id, normalized],
  });
  const match = res.rows[0];

  if (!match) {
    return {
      ok: false,
      policy,
      reason: 'counterparty_not_allowed',
      message: `Payee "${ref}" is not on this permission's allowlist — payment refused`,
      payee: null,
    };
  }

  return { ok: true, policy, payee: match };
}

/**
 * Assess a payee before a spend is charged to it.
 *
 * This is the bridge between the two halves of Kairune: the counterparty trust
 * check (who you're paying) and budget enforcement (how much you can spend).
 * When a spend names a `counterparty`, we run the exact same assessment as
 * `POST /api/counterparty/check` and refuse to release funds to a payee whose
 * verdict is a `decline`. Budget alone never protected against paying a bad
 * actor — this does.
 *
 * Returns `{ ok }` plus, when blocked, the machine-readable verdict/reasons so
 * the caller (and the emitted event) can explain exactly why. An unresolvable
 * non-wallet reference is itself a block: you asked to gate on a payee we can't
 * identify, so the safe answer is no.
 *
 * @param {string|null} counterparty payee id, handle, or wallet address
 * @param {{amount?:number|null, nowMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, assessment:object|null, verdict?:string, reasons?:string[]}>}
 */
async function assessSpendCounterparty(counterparty, { amount = null, nowMs } = {}) {
  const ref = typeof counterparty === 'string' ? counterparty.trim() : '';
  if (ref === '') return { ok: true, assessment: null };

  const assessment = await agentService.checkCounterparty(ref, { amount, nowMs });

  // A non-wallet reference we can't resolve → checkCounterparty returns null.
  // Gating was requested on a payee we cannot identify, so refuse.
  if (!assessment) {
    return {
      ok: false,
      assessment: null,
      verdict: 'decline',
      reasons: ['counterparty_unresolved'],
    };
  }

  if (GATE_BLOCKING_VERDICTS.includes(assessment.verdict)) {
    return {
      ok: false,
      assessment,
      verdict: assessment.verdict,
      reasons: assessment.reasons || [],
    };
  }

  return { ok: true, assessment };
}

/**
 * Authorize (and record) a spend against a permission.
 *
 * The charge is allowed only when the permission is active, its agent is
 * active, the payee (when a `counterparty` is named) passes its Kairune trust
 * check, and the amount fits under the remaining budget for the current
 * rolling window. On success the spend is recorded and the updated budget is
 * returned. On rejection an Error with a `status` is thrown.
 *
 * When an `idempotencyKey` is supplied, the charge is applied at most once
 * per (permission, key): a retry that reuses the same key returns the
 * original spend without touching the budget again. This makes spend
 * authorization safe for agents that retry on network failures. The returned
 * budget on a replay reflects the current window, and the result carries
 * `idempotent_replay: true` so callers can tell a replay from a fresh charge.
 *
 * @param {string} permissionId
 * @param {{amount:number, note?:string, idempotencyKey?:string, counterparty?:string}} input
 * @param {{nowMs?:number}} [opts]
 * @returns {Promise<object>}
 */
async function authorizeSpend(
  permissionId,
  { amount, note = null, idempotencyKey = null, counterparty = null },
  opts = {}
) {
  const db = await getDb();

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    const err = new Error('Amount must be a positive number');
    err.status = 400;
    throw err;
  }

  const key = normalizeIdempotencyKey(idempotencyKey);

  // Idempotent replay: if this key already charged this permission, return the
  // original spend without charging again. Checked before any budget math so a
  // retry never consumes budget or emits a duplicate event.
  if (key) {
    const replay = await findSpendByKey(permissionId, key);
    if (replay) {
      return {
        spend: replay,
        budget: await budgetSummary(permissionId, opts),
        idempotent_replay: true,
      };
    }
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

  // Expiry: a time-bound grant stops authorizing the moment its deadline
  // passes, with no sweeper job required. Checked immediately after the revoke
  // check because both answer the same question — is this grant still valid at
  // all — and neither depends on the amount or the payee.
  if (isExpired(permission, opts.nowMs)) {
    const err = new Error('Permission has expired');
    err.status = 409;
    err.details = {
      reason: 'permission_expired',
      expires_at: permission.expires_at,
    };
    // The agent isn't loaded yet at this point, but every other row on the
    // public feed is attributable, so resolve the handle rather than publishing
    // an anonymous block. Costs one read on a path that already failed.
    const expiredAgent = await agentService.getAgent(permission.agent_id).catch(() => null);
    await recordEvent('spend.blocked', {
      agent_id: permission.agent_id,
      agent_handle: expiredAgent ? expiredAgent.handle : null,
      amount: value,
      ceiling: Number(permission.ceiling),
      period: permission.period,
      reason: 'permission_expired',
    });
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

  // Payee scope: enforce the permission's own counterparty_policy before
  // anything else. A `required`/`allowlist` grant refuses a spend that omits a
  // payee or names one outside its scope, so the trust gate below can no longer
  // be skipped by simply leaving the field out.
  const scope = await enforcePayeeScope(permission, counterparty);
  if (!scope.ok) {
    const err = new Error(scope.message);
    err.status = 409;
    err.details = {
      counterparty: counterparty == null ? null : String(counterparty).trim(),
      counterparty_policy: scope.policy,
      reason: scope.reason,
    };
    await emitSpendEvent('spend.counterparty_blocked', {
      permission_id: permissionId,
      agent_id: permission.agent_id,
      requested: value,
      counterparty: counterparty == null ? null : String(counterparty).trim(),
      counterparty_policy: scope.policy,
      reason: scope.reason,
    });
    await recordEvent('spend.blocked', {
      agent_id: permission.agent_id,
      agent_handle: agent.handle,
      amount: value,
      ceiling: Number(permission.ceiling),
      period: permission.period,
      reason: scope.reason,
    });
    throw err;
  }

  // Counterparty gate: when the charge names a payee, refuse to release funds
  // to one that fails its Kairune trust check. This is the point of the whole
  // product — budget headroom never protected you from paying a bad actor.
  // Checked BEFORE budget math so a payment to a declined payee is stopped even
  // when the budget would allow it, and it emits its own distinct signal so an
  // operator can tell "we blocked a bad payee" apart from "out of budget".
  if (counterparty != null && String(counterparty).trim() !== '') {
    const gate = await assessSpendCounterparty(counterparty, {
      amount: value,
      nowMs: opts.nowMs,
    });
    if (!gate.ok) {
      const cp = gate.assessment && gate.assessment.counterparty;
      const err = new Error(
        `Counterparty failed trust check (verdict "${gate.verdict}") — payment refused`
      );
      err.status = 409;
      err.details = {
        counterparty: String(counterparty).trim(),
        verdict: gate.verdict,
        reasons: gate.reasons,
        registered: gate.assessment ? gate.assessment.registered : false,
      };
      await emitSpendEvent('spend.counterparty_blocked', {
        permission_id: permissionId,
        agent_id: permission.agent_id,
        requested: value,
        counterparty: String(counterparty).trim(),
        counterparty_handle: cp ? cp.handle : null,
        verdict: gate.verdict,
        reasons: gate.reasons,
        reason: 'counterparty_declined',
      });
      await recordEvent('spend.blocked', {
        agent_id: permission.agent_id,
        agent_handle: agent.handle,
        amount: value,
        ceiling: Number(permission.ceiling),
        period: permission.period,
        reason: 'counterparty_declined',
      });
      throw err;
    }
  }

  const ceiling = Number(permission.ceiling);

  // Refusal paths are factored out because the ceiling and velocity limits are
  // each checked TWICE: once here to fail fast with an accurate `used` figure,
  // and again inside the INSERT's WHERE clause so a concurrent charge cannot
  // slip past between the read and the write. Both checks must refuse
  // identically, so they share one implementation.
  const blockCeiling = async (usedNow) => {
    const err = new Error(
      `Spend exceeds remaining budget (requested ${value}, remaining ${Math.max(
        0,
        ceiling - usedNow
      )} per ${permission.period})`
    );
    err.status = 409;
    err.details = {
      requested: value,
      ceiling,
      used: usedNow,
      remaining: Math.max(0, ceiling - usedNow),
      period: permission.period,
    };
    await emitSpendEvent('spend.blocked', {
      permission_id: permissionId,
      agent_id: permission.agent_id,
      requested: value,
      ceiling,
      used: usedNow,
      remaining: Math.max(0, ceiling - usedNow),
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
  };

  const used = await usedInWindow(permissionId, permission.period, opts.nowMs);
  const remaining = ceiling - used;
  if (value > remaining) await blockCeiling(used);

  // Velocity guard: even when the spend fits the period ceiling, block it if it
  // would push spend past the burst cap within the short rolling window. This
  // is what catches a runaway or compromised agent trying to drain budget in
  // seconds. Checked after the ceiling so `ceiling_exceeded` always wins when
  // both would trip. Emits a distinct `spend.velocity` signal so operators can
  // treat a burst (possible compromise) differently from a normal denial.
  const velocity = resolveVelocity(permission);

  const blockVelocity = async (velUsed) => {
    const err = new Error(
      `Spend exceeds velocity limit (requested ${value}, ${Math.max(
        0,
        velocity.limit - velUsed
      )} available within ${velocity.windowSeconds}s window)`
    );
    err.status = 429;
    err.details = {
      requested: value,
      velocity_limit: velocity.limit,
      velocity_window_s: velocity.windowSeconds,
      velocity_used: velUsed,
      velocity_remaining: Math.max(0, velocity.limit - velUsed),
    };
    await emitSpendEvent('spend.velocity', {
      permission_id: permissionId,
      agent_id: permission.agent_id,
      requested: value,
      ceiling,
      period: permission.period,
      velocity_limit: velocity.limit,
      velocity_window_s: velocity.windowSeconds,
      velocity_used: velUsed,
      velocity_remaining: Math.max(0, velocity.limit - velUsed),
      reason: 'velocity_exceeded',
    });
    await recordEvent('spend.blocked', {
      agent_id: permission.agent_id,
      agent_handle: agent.handle,
      amount: value,
      ceiling,
      period: permission.period,
      reason: 'velocity_exceeded',
    });
    throw err;
  };

  if (velocity) {
    const velUsed = await usedInVelocityWindow(
      permissionId,
      velocity.windowMs,
      opts.nowMs
    );
    if (velUsed + value > velocity.limit) await blockVelocity(velUsed);
  }

  const spend = {
    id: crypto.randomUUID(),
    permission_id: permissionId,
    agent_id: permission.agent_id,
    amount: value,
    note,
    // The payee exactly as named on the charge (trimmed); NULL when the spend
    // did not name one. Part of the signed receipt, so a receipt proves not
    // just how much moved but WHO it moved to.
    payee:
      counterparty == null || String(counterparty).trim() === ''
        ? null
        : String(counterparty).trim(),
    idempotency_key: key,
    created_at: opts.nowMs ? new Date(opts.nowMs).toISOString() : nowIso(),
  };

  // Receipt: sign the exact charge fields with the platform key BEFORE the
  // insert, so the stored row carries its own proof. Best-effort — a signing
  // failure (e.g. a misconfigured RECEIPT_PRIVATE_KEY) records the spend
  // without a receipt rather than blocking a legitimate charge.
  try {
    const signed = await receiptService.signSpendReceipt(spend);
    spend.receipt_signature = signed.signature;
    spend.receipt_key_id = signed.keyId;
  } catch {
    spend.receipt_signature = null;
    spend.receipt_key_id = null;
  }

  // The checks above read `used`, compared it, and would then insert — three
  // separate round-trips. Two concurrent charges could both read the same
  // `used`, both pass, and both insert, taking the permission over its ceiling.
  // So the insert re-derives both sums in its own WHERE clause and only writes
  // if the limits still hold at write time. INSERT..SELECT..WHERE is a single
  // statement, so SQLite/libSQL evaluates the sums and appends the row without
  // another writer interleaving. Zero rows written means we lost the race.
  const windowSince = windowStart(permission.period, opts.nowMs);
  const velocitySince = velocity
    ? new Date((opts.nowMs || Date.now()) - velocity.windowMs).toISOString()
    : null;

  const guards = [
    `(SELECT COALESCE(SUM(amount), 0) FROM spends
        WHERE permission_id = ? AND created_at >= ?) + ? <= ?`,
  ];
  const guardArgs = [permissionId, windowSince, value, ceiling];
  if (velocity) {
    guards.push(
      `(SELECT COALESCE(SUM(amount), 0) FROM spends
          WHERE permission_id = ? AND created_at >= ?) + ? <= ?`
    );
    guardArgs.push(permissionId, velocitySince, value, velocity.limit);
  }

  let inserted;
  try {
    inserted = await db.execute({
      sql: `INSERT INTO spends
              (id, permission_id, agent_id, amount, note, payee, idempotency_key,
               receipt_signature, receipt_key_id, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE ${guards.join(' AND ')}`,
      args: [
        spend.id,
        spend.permission_id,
        spend.agent_id,
        spend.amount,
        spend.note,
        spend.payee,
        spend.idempotency_key,
        spend.receipt_signature,
        spend.receipt_key_id,
        spend.created_at,
        ...guardArgs,
      ],
    });
  } catch (e) {
    // Concurrent retry: another request with the same key won the unique-index
    // race. Return that original spend instead of charging twice or erroring.
    if (key && isUniqueConstraintError(e)) {
      const winner = await findSpendByKey(permissionId, key);
      if (winner) {
        return {
          spend: winner,
          budget: await budgetSummary(permissionId, opts),
          idempotent_replay: true,
        };
      }
    }
    throw e;
  }

  // Nothing written: a concurrent charge consumed the headroom this request had
  // already checked for. Re-read the sums and refuse with the same error the
  // fast path would have produced, so the caller cannot tell the difference
  // between losing a race and simply being over budget.
  if (Number(inserted.rowsAffected) === 0) {
    const usedNow = await usedInWindow(
      permissionId,
      permission.period,
      opts.nowMs
    );
    if (usedNow + value > ceiling) await blockCeiling(usedNow);
    if (velocity) {
      await blockVelocity(
        await usedInVelocityWindow(permissionId, velocity.windowMs, opts.nowMs)
      );
    }
    // Both limits read as satisfied on re-check, so the losing charge is gone
    // from the window already (a backdated `nowMs` in tests, or a deletion).
    // Refuse rather than retry: a spend that cannot be proven safe is not made.
    await blockCeiling(usedNow);
  }

  const usedAfter = used + value;
  await emitSpendEvent('spend.approved', {
    permission_id: permissionId,
    agent_id: permission.agent_id,
    spend_id: spend.id,
    amount: value,
    payee: spend.payee,
    ceiling,
    used: usedAfter,
    remaining: remaining - value,
    period: permission.period,
    receipt: spend.receipt_signature
      ? { signature: spend.receipt_signature, key_id: spend.receipt_key_id }
      : null,
  });
  await recordEvent('spend.approved', {
    agent_id: permission.agent_id,
    agent_handle: agent.handle,
    amount: value,
    ceiling,
    period: permission.period,
    createdAt: spend.created_at,
  });

  // Budget threshold alert: fire once, on the spend that pushes utilization
  // across the alert line (e.g. 80%). Computed from before/after usage so it
  // needs no stored state and never double-fires within a window. Lets an
  // operator top up or raise the ceiling before the agent starts getting
  // blocked. Best-effort, like the other notifications — never blocks a spend.
  if (ceiling > 0) {
    const threshold = resolveAlertThreshold();
    const line = ceiling * threshold;
    if (used < line && usedAfter >= line) {
      await emitSpendEvent('spend.threshold', {
        permission_id: permissionId,
        agent_id: permission.agent_id,
        spend_id: spend.id,
        ceiling,
        used: usedAfter,
        remaining: remaining - value,
        period: permission.period,
        threshold,
        utilization: usedAfter / ceiling,
      });
      await recordEvent('spend.threshold', {
        agent_id: permission.agent_id,
        agent_handle: agent.handle,
        amount: value,
        ceiling,
        period: permission.period,
        reason: `threshold_${Math.round(threshold * 100)}pct`,
        createdAt: spend.created_at,
      });
    }
  }

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
 * Preview whether a spend would be authorized — WITHOUT charging.
 *
 * Runs the exact same checks as {@link authorizeSpend} (amount validity,
 * permission + agent active, counterparty trust gate, budget headroom,
 * idempotent replay) but never writes a spend, touches the budget, or emits
 * any event. Built for payment rails and agents that want a go / no-go signal
 * before committing a charge.
 *
 * Always resolves (never throws for a business rejection): the result carries
 * `allowed` plus a machine-readable `reason` when blocked, so a caller can
 * branch on it directly. A malformed amount or idempotency key still throws a
 * 400, matching authorizeSpend's input contract.
 *
 * @param {string} permissionId
 * @param {{amount:number, idempotencyKey?:string, counterparty?:string}} input
 * @param {{nowMs?:number}} [opts]
 * @returns {Promise<{allowed:boolean, reason:string|null, requested:number, budget:object, idempotent_replay?:boolean, spend?:object, counterparty?:object}>}
 */
async function previewSpend(
  permissionId,
  { amount, idempotencyKey = null, counterparty = null },
  opts = {}
) {
  const db = await getDb();

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    const err = new Error('Amount must be a positive number');
    err.status = 400;
    throw err;
  }

  // Validate the key shape up front (throws 400 on malformed), same as a spend.
  const key = normalizeIdempotencyKey(idempotencyKey);

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

  const ceiling = Number(permission.ceiling);
  const used = await usedInWindow(permissionId, permission.period, opts.nowMs);
  const remaining = Math.max(0, ceiling - used);
  const vel = resolveVelocity(permission);
  const budget = {
    permission_id: permissionId,
    agent_id: permission.agent_id,
    category: permission.category,
    period: permission.period,
    status: permission.status,
    ceiling,
    used,
    remaining,
    velocity_limit: vel ? vel.limit : null,
    velocity_window_s: vel ? vel.windowSeconds : null,
    counterparty_policy: String(permission.counterparty_policy || 'open'),
    expires_at: permission.expires_at || null,
    expires_in_s: expiresInSeconds(permission, opts.nowMs),
    expired: isExpired(permission, opts.nowMs),
  };

  // Idempotent replay: a spend already exists for this key, so a real request
  // would return that original spend (allowed, no new charge).
  if (key) {
    const replay = await findSpendByKey(permissionId, key);
    if (replay) {
      return {
        allowed: true,
        reason: null,
        requested: value,
        budget,
        idempotent_replay: true,
        spend: replay,
      };
    }
  }

  // Same rejection order as authorizeSpend so a preview never disagrees with
  // the real decision that would follow.
  if (permission.status !== 'active') {
    return { allowed: false, reason: 'permission_revoked', requested: value, budget };
  }

  if (isExpired(permission, opts.nowMs)) {
    return { allowed: false, reason: 'permission_expired', requested: value, budget };
  }

  const agent = await agentService.getAgent(permission.agent_id);
  if (!agent) {
    return { allowed: false, reason: 'agent_not_found', requested: value, budget };
  }
  if (agent.status !== 'active') {
    return { allowed: false, reason: 'agent_suspended', requested: value, budget };
  }

  // Payee scope — same position and rule as authorizeSpend, so a preview of an
  // out-of-scope (or unnamed) payee matches the real refusal that would follow.
  const scope = await enforcePayeeScope(permission, counterparty);
  if (!scope.ok) {
    return {
      allowed: false,
      reason: scope.reason,
      requested: value,
      budget,
      counterparty: {
        reference: counterparty == null ? null : String(counterparty).trim(),
        counterparty_policy: scope.policy,
        message: scope.message,
      },
    };
  }

  // Counterparty gate — same position and rule as authorizeSpend, so a preview
  // of a payment to a declined payee is a no-go before we ever look at budget.
  if (counterparty != null && String(counterparty).trim() !== '') {
    const gate = await assessSpendCounterparty(counterparty, {
      amount: value,
      nowMs: opts.nowMs,
    });
    if (!gate.ok) {
      return {
        allowed: false,
        reason: 'counterparty_declined',
        requested: value,
        budget,
        counterparty: {
          reference: String(counterparty).trim(),
          verdict: gate.verdict,
          reasons: gate.reasons,
          registered: gate.assessment ? gate.assessment.registered : false,
          assessment: gate.assessment,
        },
      };
    }
    // Passed the gate — surface the assessment so a caller sees the trust
    // context behind the go signal, not just "allowed".
    budget.counterparty = gate.assessment
      ? {
          reference: String(counterparty).trim(),
          verdict: gate.assessment.verdict,
          handle: gate.assessment.counterparty
            ? gate.assessment.counterparty.handle
            : null,
        }
      : null;
  }

  if (value > remaining) {
    return { allowed: false, reason: 'ceiling_exceeded', requested: value, budget };
  }

  // Velocity guard, same order as authorizeSpend: ceiling wins, then burst cap.
  const velocity = resolveVelocity(permission);
  if (velocity) {
    const velUsed = await usedInVelocityWindow(
      permissionId,
      velocity.windowMs,
      opts.nowMs
    );
    if (velUsed + value > velocity.limit) {
      return { allowed: false, reason: 'velocity_exceeded', requested: value, budget };
    }
  }

  return { allowed: true, reason: null, requested: value, budget };
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
  const vel = resolveVelocity(permission);
  return {
    permission_id: permissionId,
    agent_id: permission.agent_id,
    category: permission.category,
    period: permission.period,
    status: permission.status,
    ceiling,
    used,
    remaining: Math.max(0, ceiling - used),
    velocity_limit: vel ? vel.limit : null,
    velocity_window_s: vel ? vel.windowSeconds : null,
    counterparty_policy: String(permission.counterparty_policy || 'open'),
    expires_at: permission.expires_at || null,
    expires_in_s: expiresInSeconds(permission, opts.nowMs),
    expired: isExpired(permission, opts.nowMs),
  };
}

/**
 * Fetch a single spend by its id (across all permissions).
 * @param {string} spendId
 * @returns {Promise<object|null>}
 */
async function getSpendById(spendId) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM spends WHERE id = ? LIMIT 1`,
    args: [spendId],
  });
  return res.rows[0] || null;
}

// Bounds for a spend history query. `limit` is clamped rather than rejected so
// a caller asking for "everything" gets a page instead of an error.
const MAX_SPEND_PAGE = 200;
const DEFAULT_SPEND_PAGE = 50;

/**
 * Clamp a requested page size into [1, MAX_SPEND_PAGE].
 * @param {*} raw
 * @returns {number}
 */
function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SPEND_PAGE;
  return Math.min(Math.max(1, Math.floor(n)), MAX_SPEND_PAGE);
}

/**
 * Clamp a requested offset to a non-negative integer.
 * @param {*} raw
 * @returns {number}
 */
function clampOffset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * Normalize an ISO-ish date boundary for a spend query.
 *
 * Accepts anything `Date` parses (a full ISO timestamp or a bare `YYYY-MM-DD`)
 * and returns a canonical ISO string, because `created_at` is stored as ISO
 * text and string comparison is only correct against the same format. A
 * present-but-unparseable value is a 400 rather than a silently ignored
 * filter — a caller asking for "spends since X" must never get everything.
 * @param {*} raw
 * @param {string} field name used in the error message
 * @returns {string|null}
 */
function normalizeDateBound(raw, field) {
  if (raw === null || raw === undefined || raw === '') return null;
  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) {
    const err = new Error(`${field} must be an ISO 8601 date or timestamp`);
    err.status = 400;
    throw err;
  }
  return new Date(ms).toISOString();
}

/**
 * Build the shared WHERE fragment + args for a spend history query.
 *
 * Filters are ANDed and every one is optional:
 *   since / until      half-open window on created_at ([since, until))
 *   payee              exact payee match, case-insensitive
 *   idempotency_key    exact key match (answers "did this retry land?")
 *
 * `until` is exclusive so consecutive windows (e.g. month boundaries) tile
 * without double-counting a charge that lands exactly on the boundary.
 * @param {{since?:*, until?:*, payee?:*, idempotencyKey?:*}} filters
 * @returns {{clause:string, args:any[]}}
 */
function buildSpendFilter(filters = {}) {
  const parts = [];
  const args = [];

  const since = normalizeDateBound(filters.since, 'since');
  if (since) {
    parts.push('created_at >= ?');
    args.push(since);
  }
  const until = normalizeDateBound(filters.until, 'until');
  if (until) {
    parts.push('created_at < ?');
    args.push(until);
  }
  if (filters.payee !== null && filters.payee !== undefined && filters.payee !== '') {
    // Payees are stored exactly as named on the charge, but a handle or wallet
    // is not case-significant, so match case-insensitively to make the filter
    // usable without knowing how the charge happened to be spelled.
    parts.push('payee IS NOT NULL AND LOWER(payee) = ?');
    args.push(String(filters.payee).trim().toLowerCase());
  }
  const key = filters.idempotencyKey;
  if (key !== null && key !== undefined && key !== '') {
    parts.push('idempotency_key = ?');
    args.push(String(key).trim());
  }

  return { clause: parts.length ? ` AND ${parts.join(' AND ')}` : '', args };
}

/**
 * List spends for a permission (most recent first), with optional filters.
 *
 * @param {string} permissionId
 * @param {{limit?:number, offset?:number, since?:string, until?:string, payee?:string, idempotencyKey?:string}} [opts]
 * @returns {Promise<object[]>}
 */
async function listSpends(permissionId, opts = {}) {
  const db = await getDb();
  const { clause, args } = buildSpendFilter(opts);
  const res = await db.execute({
    sql: `SELECT * FROM spends WHERE permission_id = ?${clause}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
    args: [permissionId, ...args, clampLimit(opts.limit), clampOffset(opts.offset)],
  });
  return res.rows;
}

/**
 * List spends across every permission held by an agent (most recent first).
 *
 * The per-permission history answers "what did this grant pay for"; an
 * operator running several grants on one agent needs the agent-wide view to
 * answer "what did this agent pay for" at all. Joins through `permissions` so
 * each row carries the granting permission's category, which is the dimension
 * operators actually reason about.
 * @param {string} agentId
 * @param {{limit?:number, offset?:number, since?:string, until?:string, payee?:string, idempotencyKey?:string, permissionId?:string}} [opts]
 * @returns {Promise<object[]>}
 */
async function listAgentSpends(agentId, opts = {}) {
  const db = await getDb();
  const { clause, args } = buildSpendFilter(opts);
  const extra = [];
  const extraArgs = [];
  if (opts.permissionId) {
    extra.push('s.permission_id = ?');
    extraArgs.push(String(opts.permissionId));
  }
  const extraClause = extra.length ? ` AND ${extra.join(' AND ')}` : '';
  // The filter fragment is written against bare column names, so qualify it
  // for the joined query — `payee`, `created_at` and `idempotency_key` all
  // live on `spends`.
  const qualified = clause.replace(
    /\b(created_at|payee|idempotency_key)\b/g,
    's.$1'
  );
  const res = await db.execute({
    sql: `SELECT s.*, p.category AS category, p.period AS period
          FROM spends s
          JOIN permissions p ON p.id = s.permission_id
          WHERE s.agent_id = ?${qualified}${extraClause}
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT ? OFFSET ?`,
    args: [
      agentId,
      ...args,
      ...extraArgs,
      clampLimit(opts.limit),
      clampOffset(opts.offset),
    ],
  });
  return res.rows;
}

/**
 * Aggregate an agent's spending across all of its permissions.
 *
 * Returns the total plus three rollups — by permission, by category, and by
 * payee — over an optional date window. This is the "how much did this agent
 * spend this month, and on whom" question that was previously unanswerable
 * without walking every permission's history client-side.
 *
 * Note the totals are computed over the requested window, NOT over each
 * permission's rolling ceiling window: a report and a budget check answer
 * different questions, and conflating them would make a month-to-date report
 * silently reset at each permission's period boundary. Use `budgetSummary`
 * for remaining headroom.
 * @param {string} agentId
 * @param {{since?:string, until?:string, payee?:string, topPayees?:number}} [opts]
 * @returns {Promise<object>}
 */
async function spendSummary(agentId, opts = {}) {
  const db = await getDb();
  const { clause, args } = buildSpendFilter(opts);
  const qualified = clause.replace(
    /\b(created_at|payee|idempotency_key)\b/g,
    's.$1'
  );
  const where = `WHERE s.agent_id = ?${qualified}`;
  const baseArgs = [agentId, ...args];

  const [totals, byPermission, byCategory, byPayee] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(*) AS count,
                   COALESCE(SUM(s.amount), 0) AS total,
                   MIN(s.created_at) AS first_at,
                   MAX(s.created_at) AS last_at
            FROM spends s ${where}`,
      args: baseArgs,
    }),
    db.execute({
      sql: `SELECT s.permission_id, p.category, p.period, p.ceiling, p.status,
                   COUNT(*) AS count, COALESCE(SUM(s.amount), 0) AS total
            FROM spends s
            JOIN permissions p ON p.id = s.permission_id
            ${where}
            GROUP BY s.permission_id
            ORDER BY total DESC`,
      args: baseArgs,
    }),
    db.execute({
      sql: `SELECT p.category,
                   COUNT(*) AS count, COALESCE(SUM(s.amount), 0) AS total
            FROM spends s
            JOIN permissions p ON p.id = s.permission_id
            ${where}
            GROUP BY p.category
            ORDER BY total DESC`,
      args: baseArgs,
    }),
    db.execute({
      // Charges with no named payee are excluded rather than bucketed under
      // NULL: "who did I pay" is a question about counterparties, and an
      // unnamed charge has no answer. The total above still counts them.
      sql: `SELECT s.payee,
                   COUNT(*) AS count, COALESCE(SUM(s.amount), 0) AS total,
                   MAX(s.created_at) AS last_at
            FROM spends s
            ${where} AND s.payee IS NOT NULL AND s.payee != ''
            GROUP BY LOWER(s.payee)
            ORDER BY total DESC
            LIMIT ?`,
      args: [...baseArgs, clampLimit(opts.topPayees)],
    }),
  ]);

  const head = totals.rows[0] || {};
  const num = (v) => Number(v) || 0;

  return {
    agent_id: agentId,
    since: normalizeDateBound(opts.since, 'since'),
    until: normalizeDateBound(opts.until, 'until'),
    total: num(head.total),
    count: num(head.count),
    first_spend_at: head.first_at || null,
    last_spend_at: head.last_at || null,
    by_permission: byPermission.rows.map((r) => ({
      permission_id: r.permission_id,
      category: r.category,
      period: r.period,
      ceiling: num(r.ceiling),
      status: r.status,
      count: num(r.count),
      total: num(r.total),
    })),
    by_category: byCategory.rows.map((r) => ({
      category: r.category,
      count: num(r.count),
      total: num(r.total),
    })),
    by_payee: byPayee.rows.map((r) => ({
      payee: r.payee,
      count: num(r.count),
      total: num(r.total),
      last_spend_at: r.last_at || null,
    })),
  };
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
  previewSpend,
  assessSpendCounterparty,
  budgetSummary,
  getSpendById,
  listSpends,
  listAgentSpends,
  spendSummary,
  listFeed,
  recordEvent,
  usedInWindow,
  windowStart,
  normalizeIdempotencyKey,
  findSpendByKey,
  resolveAlertThreshold,
  resolveVelocity,
  usedInVelocityWindow,
  buildSpendFilter,
  normalizeDateBound,
  clampLimit,
  clampOffset,
  PERIOD_MS,
  MAX_IDEMPOTENCY_KEY_LEN,
  DEFAULT_VELOCITY_WINDOW_S,
  MAX_SPEND_PAGE,
  DEFAULT_SPEND_PAGE,
  GATE_BLOCKING_VERDICTS,
  enforcePayeeScope,
};
