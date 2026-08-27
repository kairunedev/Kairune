'use strict';

/**
 * Wallet Proof — Kairune.
 *
 * The gap this closes
 * -------------------
 * Every agent in the registry claims a Robinhood Chain wallet, and until now
 * that claim was never tested. `assertValidRobinhoodWallet` checks *shape*
 * (0x + 40 hex) — it cannot check *control*. So anyone could register an agent
 * naming a wallet they do not own, and every downstream surface would show that
 * wallet as the agent's identity: the share card, `GET /wallets/:wallet`, the
 * leaderboard, the counterparty verdict a payer relies on.
 *
 * That matters most for the two audiences Kairune serves. A Virtuals ACP buyer
 * calling `/counterparty/check` is deciding whether to release escrow to a
 * wallet. A Robinhood Chain holder looking up an agent is deciding whether the
 * on-chain address in front of them is the agent they think it is. Both are
 * trusting an unproven string.
 *
 * How it works
 * ------------
 * Standard EIP-191 `personal_sign` — the same primitive every EVM wallet
 * already implements, so an agent operator needs no new tooling and never
 * exposes a private key to us:
 *
 *   1. `POST /agents/:id/wallet-proof/challenge` mints a single-use nonce
 *      bound to that agent and wallet, valid for a short window.
 *   2. The operator signs the returned `message` with the claimed wallet.
 *   3. `POST /agents/:id/wallet-proof` submits the signature. We recover the
 *      signer address from the signature and compare it to the claimed wallet.
 *
 * Recovery, not verification, is the operation: secp256k1 lets you derive who
 * signed from the signature alone, so there is no public key to register and
 * nothing to store beyond the outcome.
 *
 * Design decisions worth knowing
 * ------------------------------
 * - **Proof is a property of the (agent, wallet) pair, not the agent.** If an
 *   agent's wallet ever changes, the old proof must not carry over. The stored
 *   row pins the exact wallet that was proven.
 * - **Nonces are single-use and consumed on *any* verification attempt**, pass
 *   or fail. A nonce that survived a failed attempt would let an attacker
 *   grind signatures against a live challenge.
 * - **Chain id is inside the signed message.** The same wallet exists on every
 *   EVM chain; a signature harvested from a Base dapp must not be replayable
 *   here. Binding 4663 into the text makes the proof chain-specific.
 * - **The domain string and agent id are in the message too**, so a signature
 *   collected by an unrelated site cannot be repurposed, and a proof for agent
 *   A cannot be submitted for agent B.
 * - **This is additive and non-breaking.** Nothing requires a proof. Unproven
 *   agents behave exactly as before; proven ones gain a verifiable flag that
 *   counterparty checks and share surfaces can report. Making it mandatory
 *   would be a product decision with a migration cost for every existing agent.
 */

const crypto = require('crypto');
const secp = require('@noble/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');
const { getDb } = require('../db');

// Bound to the same chain the registry is scoped to (see moderation.js). A
// proof is only meaningful for the chain it names.
const CHAIN_ID = 4663;

// Namespace for the signed text. Present so a signature gathered by any other
// application cannot be replayed as a Kairune wallet proof.
const DOMAIN = 'kairune.online';

// How long a challenge stays usable. Long enough for a human to approve a
// wallet prompt, short enough that a leaked nonce is worthless quickly.
const CHALLENGE_TTL_S = 600;

// Hex-encoded 65-byte signature: r (32) + s (32) + v (1).
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const nowIso = () => new Date().toISOString();

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Build the exact text a wallet is asked to sign.
 *
 * Every field that scopes the proof is inside the string, because only the
 * signed bytes are cryptographically committed — anything passed alongside the
 * signature could be swapped by the submitter.
 *
 * @param {{agentId:string, wallet:string, nonce:string, issuedAt:string}} p
 * @returns {string}
 */
function challengeMessage({ agentId, wallet, nonce, issuedAt }) {
  return [
    `${DOMAIN} wants you to prove control of this wallet.`,
    '',
    `Wallet: ${wallet}`,
    `Agent: ${agentId}`,
    `Chain: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
    '',
    'Signing this proves wallet control. It authorizes no transaction and moves no funds.',
  ].join('\n');
}

/**
 * Hash a message the way `personal_sign` does (EIP-191).
 *
 * The prefix is what makes a signed message unusable as a transaction
 * signature: a wallet will never sign transaction bytes with this envelope,
 * so a proof collected here can never be replayed as a transfer.
 *
 * @param {string} message
 * @returns {Uint8Array} 32-byte digest
 */
function hashPersonalMessage(message) {
  const body = Buffer.from(message, 'utf8');
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8');
  return keccak_256(Buffer.concat([prefix, body]));
}

/**
 * Recover the signing address from a personal_sign signature.
 *
 * Returns null rather than throwing on any malformed input: a signature that
 * cannot be parsed is a failed proof, not a server error, and the caller should
 * not have to distinguish "wrong signer" from "unparseable" — both mean the
 * claim is unproven.
 *
 * @param {string} message the exact text that was signed
 * @param {string} signature 0x-prefixed 65-byte hex
 * @returns {string|null} lower-cased address, or null
 */
function recoverSigner(message, signature) {
  try {
    if (!SIGNATURE_RE.test(String(signature || '').trim())) return null;
    const bytes = Buffer.from(String(signature).trim().slice(2), 'hex');

    const r = BigInt('0x' + bytes.subarray(0, 32).toString('hex'));
    const s = BigInt('0x' + bytes.subarray(32, 64).toString('hex'));
    let v = bytes[64];

    if (v >= 35) v = (v - 35) % 2;
    else if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;

    const n = secp.CURVE.n;
    if (r <= 0n || r >= n || s <= 0n || s > n / 2n) return null;

    const digest = hashPersonalMessage(message);
    // @noble/secp256k1 1.7 (CJS) — Signature is (r,s) only; recovery bit is a
    // separate argument to recoverPublicKey which returns raw bytes directly.
    const sig = new secp.Signature(r, s);
    const pub = secp.recoverPublicKey(digest, sig.toCompactRawBytes(), v);

    return '0x' + Buffer.from(keccak_256(pub.subarray(1))).subarray(-20).toString('hex');
  } catch {
    return null;
  }
}

/**
 * Mint a single-use challenge for an (agent, wallet) pair.
 *
 * Any unconsumed challenge for the same pair is deleted first. Otherwise an
 * operator who clicked twice would leave a live nonce behind, and every
 * abandoned challenge would stay valid for its full TTL.
 *
 * @param {string} agentId
 * @param {string} wallet claimed address (normalized by the caller)
 * @returns {Promise<{nonce:string, message:string, wallet:string, agent_id:string,
 *                    issued_at:string, expires_at:string, expires_in_s:number,
 *                    chain_id:number}>}
 */
async function createChallenge(agentId, wallet) {
  if (!ADDRESS_RE.test(String(wallet || ''))) {
    throw httpError('wallet must be a valid EVM address (0x + 40 hex characters)', 400);
  }
  const target = String(wallet).toLowerCase();
  const db = await getDb();

  await db.execute({
    sql: 'DELETE FROM wallet_challenges WHERE agent_id = ? AND wallet = ?',
    args: [agentId, target],
  });

  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = nowIso();
  const expiresAt = new Date(Date.parse(issuedAt) + CHALLENGE_TTL_S * 1000).toISOString();
  const message = challengeMessage({ agentId, wallet: target, nonce, issuedAt });

  await db.execute({
    sql: `INSERT INTO wallet_challenges (nonce, agent_id, wallet, message, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [nonce, agentId, target, message, issuedAt, expiresAt],
  });

  return {
    agent_id: agentId,
    wallet: target,
    chain_id: CHAIN_ID,
    nonce,
    message,
    issued_at: issuedAt,
    expires_at: expiresAt,
    expires_in_s: CHALLENGE_TTL_S,
  };
}

/**
 * Verify a signature against a live challenge and record the proof.
 *
 * The nonce is consumed before the signature is judged, so a failed attempt
 * burns the challenge. That is deliberate: leaving it alive would turn a
 * one-shot proof into an oracle an attacker could hammer.
 *
 * @param {string} agentId
 * @param {string} nonce
 * @param {string} signature
 * @returns {Promise<{agent_id:string, wallet:string, chain_id:number,
 *                    verified_at:string, method:string}>}
 */
async function verifyProof(agentId, nonce, signature) {
  const db = await getDb();
  const key = String(nonce || '').trim();

  const found = await db.execute({
    sql: `SELECT nonce, agent_id, wallet, message, expires_at
            FROM wallet_challenges
           WHERE nonce = ? AND agent_id = ?`,
    args: [key, agentId],
  });
  const challenge = found.rows[0];
  if (!challenge) throw httpError('Challenge not found, already used, or not for this agent', 404);

  // Consume first, judge second.
  await db.execute({ sql: 'DELETE FROM wallet_challenges WHERE nonce = ?', args: [key] });

  if (Date.parse(challenge.expires_at) <= Date.now()) {
    throw httpError('Challenge expired — request a new one', 400);
  }

  const signer = recoverSigner(challenge.message, signature);
  if (!signer) throw httpError('Signature could not be recovered', 400);
  if (signer !== String(challenge.wallet).toLowerCase()) {
    throw httpError('Signature does not match the claimed wallet', 401);
  }

  const verifiedAt = nowIso();

  // Re-proving is idempotent on the pair. A wallet change writes a new row and
  // leaves the old pair's proof behind, which is correct: that pair really was
  // proven, and the agent's current wallet simply has no proof until it earns
  // one.
  await db.execute({
    sql: `INSERT INTO wallet_proofs (agent_id, wallet, chain_id, verified_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(agent_id, wallet)
          DO UPDATE SET verified_at = excluded.verified_at`,
    args: [agentId, signer, CHAIN_ID, verifiedAt],
  });

  return {
    agent_id: agentId,
    wallet: signer,
    chain_id: CHAIN_ID,
    verified_at: verifiedAt,
    method: 'eip191-personal-sign',
  };
}

/**
 * Proof status for an agent's *current* wallet.
 *
 * Looks up the pair, not the agent, so an agent that proved one wallet and then
 * moved to another reads as unproven — which is the honest answer.
 *
 * @param {string} agentId
 * @param {string} wallet the agent's current wallet
 * @returns {Promise<{proven:boolean, wallet:string, chain_id:number, verified_at:string|null}>}
 */
async function proofStatus(agentId, wallet) {
  const target = String(wallet || '').toLowerCase();
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT verified_at FROM wallet_proofs WHERE agent_id = ? AND wallet = ?`,
    args: [agentId, target],
  });
  const row = res.rows[0];
  return {
    proven: Boolean(row),
    wallet: target,
    chain_id: CHAIN_ID,
    verified_at: row ? row.verified_at : null,
  };
}

/**
 * Proof status for many agents in one query.
 *
 * Exists so list surfaces (leaderboard, compare) can report proof without
 * issuing one lookup per row. Returns a Map keyed by `agentId|wallet` so the
 * caller matches on the pair and never mistakes a stale proof for a live one.
 *
 * @param {Array<{id:string, wallet:string}>} agents
 * @returns {Promise<Map<string, string>>} pair key → verified_at
 */
async function proofMap(agents) {
  const rows = Array.isArray(agents) ? agents.filter((a) => a && a.id) : [];
  if (!rows.length) return new Map();

  const db = await getDb();
  const placeholders = rows.map(() => '?').join(', ');
  const res = await db.execute({
    sql: `SELECT agent_id, wallet, verified_at FROM wallet_proofs WHERE agent_id IN (${placeholders})`,
    args: rows.map((a) => a.id),
  });

  const out = new Map();
  for (const r of res.rows) {
    out.set(`${r.agent_id}|${String(r.wallet).toLowerCase()}`, r.verified_at);
  }
  return out;
}

module.exports = {
  CHAIN_ID,
  DOMAIN,
  CHALLENGE_TTL_S,
  challengeMessage,
  hashPersonalMessage,
  recoverSigner,
  createChallenge,
  verifyProof,
  proofStatus,
  proofMap,
};
