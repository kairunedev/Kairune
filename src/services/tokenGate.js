'use strict';

/**
 * Soft $KAIRUNE utility — no chain RPC.
 *
 * Holders are declared via env allowlist (TOKEN_HOLDER_WALLETS). Clients can
 * send X-Kairune-Wallet (or body.payer_wallet). Matching wallets get higher
 * write rate limits. Hard pay-to-write stays off until a chain path is ready.
 *
 * Env:
 *   TOKEN_HOLDER_WALLETS   comma-separated wallets (case-insensitive)
 *   TOKEN_HOLDER_RATE_MAX  write limit for holders (default 120)
 *   RATE_LIMIT_MAX         write limit for everyone else (default 40)
 */

const HOLDERS = new Set(
  String(process.env.TOKEN_HOLDER_WALLETS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const HOLDER_MAX = parseInt(process.env.TOKEN_HOLDER_RATE_MAX, 10) || 120;

function normalizeWallet(w) {
  if (!w) return '';
  return String(w).trim().toLowerCase();
}

function walletFromReq(req) {
  return normalizeWallet(
    req.get('x-kairune-wallet') ||
      req.get('x-wallet') ||
      (req.body && (req.body.payer_wallet || req.body.wallet)) ||
      ''
  );
}

function isHolder(wallet) {
  const w = normalizeWallet(wallet);
  return Boolean(w && HOLDERS.has(w));
}

function tokenStatus(req) {
  const wallet = walletFromReq(req);
  const holder = isHolder(wallet);
  return {
    utility: 'soft',
    chain: 'Robinhood Chain',
    launchpad: 'Virtuals',
    contract_address: '0xc5ac3b7664ba1ac915145cc58f50b89ec3a2970d',
    virtuals: 'https://app.virtuals.io/virtuals/100623',
    hard_gate: false,
    holders_configured: HOLDERS.size,
    wallet: wallet || null,
    is_holder: holder,
    write_rate_limit: holder ? HOLDER_MAX : parseInt(process.env.RATE_LIMIT_MAX, 10) || 40,
    note: 'Reads free. Soft utility: listed $KAIRUNE holder wallets get higher write rate limits. No on-chain check yet.',
  };
}

module.exports = {
  HOLDERS,
  HOLDER_MAX,
  walletFromReq,
  isHolder,
  tokenStatus,
};
