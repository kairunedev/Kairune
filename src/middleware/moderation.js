'use strict';

/**
 * Registry moderation helpers — keep the public leaderboard usable.
 */

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
 * If ADMIN_KEY is unset, deletes stay open (dev / current prod behavior).
 * If set, require header X-Admin-Key to match.
 */
function requireAdmin(req) {
  const key = process.env.ADMIN_KEY;
  if (!key) return true;
  if (process.env.NODE_ENV === 'test') return true;
  const provided = req.get('x-admin-key') || '';
  if (provided && provided === key) return true;
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
