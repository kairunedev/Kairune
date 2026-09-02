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

// Kairune is scoped to Robinhood Chain (an EVM chain, chainId 4663). A valid
// agent identity must therefore be a well-formed EVM address: 0x + 40 hex
// characters. This keeps the registry single-chain and rejects Solana / junk
// / truncated wallets at the door instead of hiding them later.
const ROBINHOOD_CHAIN_ID = 4663;
const ROBINHOOD_CHAIN_NAME = 'Robinhood Chain';
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate a wallet as a Robinhood Chain (EVM) address.
 * Throws Error with .status = 400 on failure. Returns the normalized
 * (lower-cased) address on success.
 * @param {string} wallet
 * @returns {string}
 */
function assertValidRobinhoodWallet(wallet) {
  const w = String(wallet || '').trim();
  if (!EVM_ADDRESS_RE.test(w)) {
    const err = new Error(
      'Wallet must be a valid Robinhood Chain address (0x followed by 40 hex characters)'
    );
    err.status = 400;
    throw err;
  }
  return w.toLowerCase();
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

// ---------------------------------------------------------------------------
// Free-text field sanitisation — the NOTE / SPEND-NOTE surface
// ---------------------------------------------------------------------------
//
// XSS is already handled at the rendering layer (escapeText/esc over every
// innerHTML sink, application/json; charset=utf-8, nosniff). The remaining
// concern is LLM-context pollution: `note` is served verbatim in
// GET /api/agents/:id and attestation history, and an AI consumer that reads
// that JSON as context can mistake attacker-supplied prose for an instruction.
//
// So this function is intentionally *not* an HTML sanitiser. It enforces three
// properties that make prompt-framing harder without touching the read path:
//
//   1. Short — 500 chars max. Today 100k is accepted (only 1M hits Express's
//      body limit). A useful human note fits well under 500; an exfiltrated
//      payload does not.
//   2. Flat — strip C0/C1 controls, zero-width/bidi/formatting codepoints, and
//      collapse all whitespace runs (including embedded newlines) to a single
//      ASCII space. No block breaks means no fake `SYSTEM:` preamble.
//   3. Plain — reject `<>` brackets and backticks. That blocks tag-shaped
//      framing (`<|im_start|>`, `[INST]`, `<system>`) without needing a
//      continually-outdated blocklist of model-specific tokens.

const NOTE_MAX = 500;

// Codepoints the normaliser drops. Keeping the set explicit rather than
// reaching for a Unicode property escape makes the contract auditable without
// needing to know which ES version the runtime supports.
//
//   C0 (\\u0000-\\u001f) + DEL, C1 (\\u007f-\\u009f)
//   Zero-width + word-joiner + BOM, bidi isolates/overrides, soft hyphen
const FORMATTING_RE =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u00ad]/g;

function assertValidNote(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') {
    const err = new Error('Note must be a string');
    err.status = 400;
    throw err;
  }
  let s = raw.replace(FORMATTING_RE, '');
  // Brackets and backticks are never legitimate in a payment/attestation note
  // and they are the characters every instruction-framing syntax relies on.
  if (/[<>`]/.test(s)) {
    const err = new Error('Note must not contain <, > or `');
    err.status = 400;
    throw err;
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > NOTE_MAX) {
    const err = new Error(`Note must be at most ${NOTE_MAX} characters`);
    err.status = 400;
    throw err;
  }
  return s;
}

module.exports = {
  RESERVED,
  normalizeHandle,
  assertValidHandle,
  assertValidRobinhoodWallet,
  isDemoAgent,
  requireAdmin,
  assertValidNote,
  NOTE_MAX,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_CHAIN_NAME,
  EVM_ADDRESS_RE,
};
