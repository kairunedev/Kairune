'use strict';

/**
 * Registry moderation helpers — keep the public leaderboard usable.
 */

const crypto = require('crypto');

const RESERVED = new Set([
  'admin', 'api', 'app', 'console', 'docs', 'health', 'kairune', 'null',
  'undefined', 'system', 'root', 'test', 'testing', 'demo',
]);

// A handle is public: it renders on the leaderboard, in share cards, and in any
// counterparty check another agent runs. A slur got registered and sat on the
// public registry, so this is enforced at registration rather than moderated
// away afterwards. Two tiers, because matching strategy has to differ:

// Tier 1 — long, unambiguous slurs. Matched as a SUBSTRING of the folded
// handle, so `xnigger1` is refused too. Safe to match loosely because these
// strings essentially never occur inside an innocent word.
const BANNED_SUBSTRINGS = [
  'nigger', 'nigga', 'faggot', 'chink', 'kike', 'tranny', 'rapist',
  'hitler', 'whore', 'fuck', 'shit', 'bitch', 'asshole', 'bastard',
  'pussy', 'slut', 'retard',
];

// Tier 2 — short words that appear inside perfectly ordinary names. Matched
// only as a WHOLE TOKEN, so `cockpit-ai`, `dickinson` and `scunthorpe` are
// accepted while a bare `cock` or `dick-bot` is not. (The Scunthorpe problem:
// a naive substring list refuses real names.)
const BANNED_WORDS = ['cunt', 'spic', 'pedo', 'dick', 'cock', 'nazi', 'ass'];

// Leet-speak folding so `n1gg3r` and `f4gg0t` do not slip past the list.
const LEET_MAP = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', $: 's', '@': 'a' };

function normalizeHandle(h) {
  return String(h || '').trim().toLowerCase();
}

/** Undo common leet substitutions: `n1gg3r` -> `nigger`. */
function unleet(s) {
  return s.replace(/[013457$@]/g, (ch) => LEET_MAP[ch] || ch);
}

/**
 * Fold a handle for substring comparison: strip separators and undo leet, so
 * `n_1-gg3r` collapses to `nigger`.
 * @param {string} h
 * @returns {string}
 */
function foldForProfanity(h) {
  return unleet(normalizeHandle(h).replace(/[-_.\s]/g, ''));
}

/**
 * True when a handle contains a banned slur, or consists of / contains a
 * banned word as a separator-delimited token.
 * @param {string} handle
 * @returns {boolean}
 */
function containsProfanity(handle) {
  const folded = foldForProfanity(handle);
  if (BANNED_SUBSTRINGS.some((bad) => folded.includes(bad))) return true;

  // Token pass: split on separators and digit runs, so `dick-bot`, `dick_01`
  // and `dick99` all yield the token `dick`, while `dickinson` yields only
  // `dickinson` and passes.
  const tokens = unleet(normalizeHandle(handle)).split(/[-_.\s]+|\d+/).filter(Boolean);
  return tokens.some((t) => BANNED_WORDS.includes(t));
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
  // A handle is a public identifier. Refuse slurs at the door rather than
  // moderating them off the leaderboard afterwards.
  if (containsProfanity(h)) {
    const err = new Error('Handle contains prohibited language — pick another name');
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
  BANNED_SUBSTRINGS,
  BANNED_WORDS,
  containsProfanity,
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
