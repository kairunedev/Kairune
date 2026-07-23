'use strict';

/**
 * Webhook service — outbound event notifications.
 *
 * This is what turns Kairune from a passive ledger into an active enforcement
 * layer: whenever a spend is approved or blocked, every registered webhook is
 * POSTed a signed JSON event. Consumers (agent runners, dashboards, alerting)
 * can react in real time — e.g. halt an agent the moment it hits its ceiling.
 *
 * Deliveries are fire-and-forget (they never block or fail a spend) and every
 * attempt is recorded in webhook_deliveries for auditing.
 */

const crypto = require('crypto');
const { getDb } = require('../db');

function nowIso() {
  return new Date().toISOString();
}

// Event names the platform can emit. '*' subscribes to all of them.
//   spend.approved     — a spend was authorized within its ceiling
//   spend.blocked      — a spend was denied (ceiling exceeded / no budget)
//   agent.tier_changed — an agent's trust tier moved up or down after a rescore
const EVENTS = Object.freeze([
  'spend.approved',
  'spend.blocked',
  'agent.tier_changed',
]);

// Delivery tuning. Kept short: on serverless the spend request awaits delivery,
// so a slow consumer must not stall the caller for long.
const DELIVERY_TIMEOUT_MS = 2500;
const MAX_DELIVERY_LOG = 200;

/**
 * Compute the hex HMAC-SHA256 signature of a raw body with a secret.
 * @param {string} secret
 * @param {string} body
 * @returns {string}
 */
function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Validate that a string is an acceptable http(s) URL.
 * @param {string} url
 * @returns {boolean}
 */
function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Normalize + validate a list/CSV of event names.
 * @param {string|string[]|undefined} events
 * @returns {string} canonical CSV ('*' or comma-separated event names)
 */
function normalizeEvents(events) {
  if (events === undefined || events === null || events === '*' || events === '') {
    return '*';
  }
  const list = Array.isArray(events)
    ? events
    : String(events).split(',').map((e) => e.trim());
  const cleaned = list.filter(Boolean);
  if (cleaned.length === 0) return '*';
  const invalid = cleaned.filter((e) => !EVENTS.includes(e));
  if (invalid.length) {
    const err = new Error(
      `Unknown event(s): ${invalid.join(', ')}. Allowed: ${EVENTS.join(', ')}`
    );
    err.status = 400;
    throw err;
  }
  return [...new Set(cleaned)].join(',');
}

/**
 * Register a new webhook. A signing secret is generated if not supplied and
 * returned exactly once (like an API key).
 * @param {{url:string, events?:string|string[], secret?:string}} input
 * @returns {Promise<{webhook:object, secret:string}>}
 */
async function createWebhook({ url, events, secret } = {}) {
  if (!isValidUrl(url)) {
    const err = new Error('A valid http(s) url is required');
    err.status = 400;
    throw err;
  }
  const eventsCsv = normalizeEvents(events);
  const signingSecret = secret || crypto.randomBytes(24).toString('hex');

  const db = await getDb();
  const webhook = {
    id: crypto.randomUUID(),
    url,
    secret: signingSecret,
    events: eventsCsv,
    status: 'active',
    created_at: nowIso(),
  };
  await db.execute({
    sql: `INSERT INTO webhooks (id, url, secret, events, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      webhook.id,
      webhook.url,
      webhook.secret,
      webhook.events,
      webhook.status,
      webhook.created_at,
    ],
  });

  return { webhook: publicView(webhook), secret: signingSecret };
}

/**
 * Strip the secret from a webhook row before returning it over the API.
 * @param {object} row
 * @returns {object}
 */
function publicView(row) {
  if (!row) return row;
  const { secret, ...rest } = row;
  return { ...rest, has_secret: Boolean(secret) };
}

/**
 * List registered webhooks (secrets omitted).
 * @returns {Promise<object[]>}
 */
async function listWebhooks() {
  const db = await getDb();
  const res = await db.execute(
    'SELECT * FROM webhooks ORDER BY created_at DESC'
  );
  return res.rows.map(publicView);
}

/**
 * Delete a webhook by id.
 * @param {string} id
 * @returns {Promise<boolean>} true if a row was removed
 */
async function deleteWebhook(id) {
  const db = await getDb();
  const res = await db.execute({
    sql: 'DELETE FROM webhooks WHERE id = ?',
    args: [id],
  });
  return (res.rowsAffected || 0) > 0;
}

/**
 * List recent delivery attempts for a webhook (most recent first).
 * @param {string} webhookId
 * @param {{limit?:number}} [opts]
 * @returns {Promise<object[]>}
 */
async function listDeliveries(webhookId, { limit = 50 } = {}) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT id, webhook_id, event, status_code, ok, error, created_at
          FROM webhook_deliveries
          WHERE webhook_id = ?
          ORDER BY created_at DESC LIMIT ?`,
    args: [webhookId, Math.min(Math.max(1, limit), MAX_DELIVERY_LOG)],
  });
  return res.rows;
}

/**
 * Return active webhooks subscribed to a given event.
 * @param {string} event
 * @returns {Promise<object[]>}
 */
async function subscribersFor(event) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM webhooks WHERE status = 'active'`,
    args: [],
  });
  return res.rows.filter((w) => {
    if (w.events === '*' || !w.events) return true;
    return w.events.split(',').map((e) => e.trim()).includes(event);
  });
}

/**
 * POST a single event to one webhook and record the attempt.
 * Never throws — delivery failures are logged, not propagated.
 * @param {object} webhook raw row (with secret)
 * @param {string} event
 * @param {object} data
 * @param {string} deliveredAt ISO timestamp for the envelope
 */
async function deliverOne(webhook, event, data, deliveredAt) {
  const db = await getDb();
  const body = JSON.stringify({ event, delivered_at: deliveredAt, data });
  const signature = sign(webhook.secret, body);

  let statusCode = null;
  let ok = 0;
  let errorMsg = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Kairune-Webhook/1.0',
          'X-Kairune-Event': event,
          'X-Kairune-Signature': `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });
      statusCode = res.status;
      ok = res.status >= 200 && res.status < 300 ? 1 : 0;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    errorMsg = err.name === 'AbortError' ? 'timeout' : String(err.message || err);
  }

  const at = nowIso();
  // Record the delivery attempt (best-effort).
  try {
    await db.execute({
      sql: `INSERT INTO webhook_deliveries
              (id, webhook_id, event, payload, status_code, ok, error, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        webhook.id,
        event,
        body,
        statusCode,
        ok,
        errorMsg,
        at,
      ],
    });
    await db.execute({
      sql: `UPDATE webhooks SET last_status = ?, last_error = ?, last_at = ? WHERE id = ?`,
      args: [statusCode, errorMsg, at, webhook.id],
    });
  } catch {
    // Never let audit logging break the caller.
  }

  return { ok: Boolean(ok), statusCode, error: errorMsg };
}

/**
 * Emit an event to every subscribed active webhook.
 *
 * Fire-and-forget: returns a promise that resolves when all deliveries settle,
 * but callers typically do NOT await it so a slow consumer can't delay a spend.
 * @param {string} event
 * @param {object} data
 * @returns {Promise<void>}
 */
async function emit(event, data) {
  let hooks;
  try {
    hooks = await subscribersFor(event);
  } catch {
    return; // no db / no hooks — nothing to do
  }
  if (!hooks || hooks.length === 0) return;
  const at = nowIso();
  await Promise.allSettled(hooks.map((w) => deliverOne(w, event, data, at)));
}

module.exports = {
  EVENTS,
  sign,
  isValidUrl,
  normalizeEvents,
  createWebhook,
  listWebhooks,
  deleteWebhook,
  listDeliveries,
  subscribersFor,
  emit,
};
