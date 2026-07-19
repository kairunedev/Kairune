'use strict';

/**
 * Registry moderation helpers — keep the public leaderboard usable.
 */

const crypto = require('crypto');

const RESERVED = new Set([
  'admin', 'api', 'app', 'console', 'docs', 'health', 'kairune', 'null',
  'undefined', 'system', 'root', 'test', 'testing', 'demo',
]);

function normalizeHandle(h) {
  return String(h || '').trim().toLowerCase();
}

/**
 * Validate a new agent handle. Throws Error with .status = 400 on failure.
 * @param {string} handle
 * @param {{allowTry?:boolean}} [opts]
 */
function assertValidHandle(handle, opts = {}) {
  const h = normalizeHandle(handle);
  if (h.length < 3) {
    const err = new Error('Handle must be at least 3 characters');
    err.status = 400;
    throw err;
  }
  if (h.length > 32) {
    const err = new Error('Handle must be at most 32 characters');
    err.status = 400;
    throw err;
  }
  if (!/^[a-z0-9][a-z0-9\-_]*$/.test(h)) {
    const err = new Error('Handle must start with a letter/number and use only letters, numbers, hyphens, underscores');
    err.status = 400;
    throw err;
  }
  if (/^\d+$/.test(h)) {
    const err = new Error('Handle cannot be only digits');
    err.status = 400;
    throw err;
  }
  if (RESERVED.has(h) || h.startsWith('demo-')) {
    const err = new Error('Handle is reserved — pick another name');
    err.status = 400;
    throw err;
  }
  if (h.startsWith('try-') && !opts.allowTry) {
    const err = new Error('Handle prefix try- is reserved for the console demo loop');
    err.status = 400;
    throw err;
  }
  return h;
}

function isDemoAgent(agent) {
  if (!agent) return false;
  const h = normalizeHandle(agent.handle);
  const op = String(agent.operator || '').toLowerCase();
  return h.startsWith('demo-') || op === 'demo-loop' || op === 'demo user';
}

/**
 * Admin key check for destructive actions.
 *
 * Fail-closed: in a non-test environment, if ADMIN_KEY is unset the route is
 * REFUSED (503) rather than left open. This prevents a misconfigured / reset
 * deploy from silently exposing destructive endpoints to the public.
 *
 * - NODE_ENV=test        -> allowed (fixtures need it)
 * - ADMIN_KEY unset (dev)-> allowed (local convenience, not production)
 * - ADMIN_KEY unset (prod)-> REFUSED (fail-closed safety net)
 * - ADMIN_KEY set        -> require matching X-Admin-Key header
 */
function requireAdmin(req) {
  if (process.env.NODE_ENV === 'test') return true;

  const key = process.env.ADMIN_KEY;
  if (!key) {
    // In production an unset key must never open the route.
    if (process.env.NODE_ENV === 'production') {
      const err = new Error('Admin endpoint disabled: ADMIN_KEY not configured');
      err.status = 503;
      throw err;
    }
    // Local/dev convenience only.
    return true;
  }

  const provided = req.get('x-admin-key') || '';
  // Constant-time comparison to avoid timing side-channels.
  if (provided && provided.length === key.length) {
    const a = Buffer.from(provided);
    const b = Buffer.from(key);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  const err = new Error('Admin key required to delete agents');
  err.status = 401;
  throw err;
}

module.exports = {
  RESERVED,
  normalizeHandle,
  assertValidHandle,
  isDemoAgent,
  requireAdmin,
};
