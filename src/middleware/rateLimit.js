'use strict';

/**
 * Lightweight in-memory rate limiter (no external dependency).
 *
 * Designed to protect mutating endpoints (POST/PATCH/DELETE) from bursts and
 * spam. Uses a fixed-window counter keyed by client IP.
 *
 * NOTE on serverless: on Vercel each function instance keeps its own memory,
 * so this throttles per-instance bursts rather than enforcing a strict global
 * limit. For strict global limits, back this with Turso/Redis later. It still
 * meaningfully blunts abuse from a single client hitting a warm instance.
 *
 * Config via env:
 *   RATE_LIMIT_WINDOW_MS  (default 60000)  — window size in ms
 *   RATE_LIMIT_MAX        (default 40)     — max mutating requests / window / IP
 *   RATE_LIMIT_DISABLED   ('1' to disable)
 */

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 40;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ip -> { count, resetAt }
const buckets = new Map();

// Periodic cleanup so the map can't grow unbounded. unref() so it never keeps
// the process alive on its own (important for tests / graceful shutdown).
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(ip);
  }
}, WINDOW_MS);
if (typeof sweeper.unref === 'function') sweeper.unref();

function clientIp(req) {
  // trust proxy is enabled in server.js, so req.ip reflects X-Forwarded-For.
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

/**
 * Express middleware. Only counts mutating requests; reads are never limited.
 */
function rateLimit(req, res, next) {
  // Disabled entirely in tests or via env flag.
  if (process.env.NODE_ENV === 'test' || process.env.RATE_LIMIT_DISABLED === '1') {
    return next();
  }
  if (!MUTATING.has(req.method)) return next();

  const now = Date.now();
  const ip = clientIp(req);
  let b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(ip, b);
  }
  b.count += 1;

  const remaining = Math.max(0, MAX - b.count);
  res.setHeader('X-RateLimit-Limit', String(MAX));
  res.setHeader('X-RateLimit-Remaining', String(remaining));

  if (b.count > MAX) {
    const retryAfter = Math.ceil((b.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: 'Too many requests — slow down and try again in a moment.',
      retry_after_seconds: retryAfter,
    });
  }
  next();
}

module.exports = { rateLimit };
