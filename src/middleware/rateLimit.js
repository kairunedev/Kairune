'use strict';

/**
 * Lightweight in-memory rate limiter (no external dependency).
 *
 * Soft $KAIRUNE utility: wallets in TOKEN_HOLDER_WALLETS get a higher write cap.
 * No chain RPC — allowlist only.
 *
 * Config via env:
 *   RATE_LIMIT_WINDOW_MS     (default 60000)
 *   RATE_LIMIT_MAX           (default 40)
 *   TOKEN_HOLDER_RATE_MAX    (default 120)
 *   TOKEN_HOLDER_WALLETS     comma-separated
 *   RATE_LIMIT_DISABLED      ('1' to disable)
 */

const { walletFromReq, isHolder, HOLDER_MAX } = require('../services/tokenGate');

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 40;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const buckets = new Map();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(ip);
  }
}, WINDOW_MS);
if (typeof sweeper.unref === 'function') sweeper.unref();

function clientIp(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function rateLimit(req, res, next) {
  if (process.env.NODE_ENV === 'test' || process.env.RATE_LIMIT_DISABLED === '1') {
    return next();
  }
  if (!MUTATING.has(req.method)) return next();

  const wallet = walletFromReq(req);
  const holder = isHolder(wallet);
  const limit = holder ? HOLDER_MAX : MAX;
  const key = holder ? 'w:' + wallet : 'ip:' + clientIp(req);

  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, b);
  }
  b.count += 1;

  const remaining = Math.max(0, limit - b.count);
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  if (holder) res.setHeader('X-Kairune-Holder', '1');

  if (b.count > limit) {
    const retryAfter = Math.ceil((b.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: 'Too many requests — slow down and try again in a moment.',
      retry_after_seconds: retryAfter,
      holder,
    });
  }
  next();
}

module.exports = { rateLimit };
