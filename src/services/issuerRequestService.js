'use strict';

/**
 * Issuer Request Service — marketplace flow for agents to request verification.
 *
 * Agents discover issuers and request that they verify their trust score.
 * Issuers can accept (signalling willingness to verify) or reject requests.
 * This is the discovery/handshake layer; the actual signed attestation still
 * flows through the normal verifiable-attestation path.
 */

const crypto = require('crypto');
const { getDb } = require('../db');

const MESSAGE_MAX = 500;

function nowIso() {
  return new Date().toISOString();
}
function uuid() {
  return crypto.randomUUID();
}
function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function publicRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    agent_id: row.agent_id,
    issuer_id: row.issuer_id,
    status: row.status,
    message: row.message,
    response_msg: row.response_msg,
    created_at: row.created_at,
    responded_at: row.responded_at,
    // denormalised joins (present depending on query)
    issuer_name: row.issuer_name,
    agent_handle: row.agent_handle,
    agent_wallet: row.agent_wallet,
  };
}

/**
 * Create a new verification request from an agent to an issuer.
 * Rejects duplicates (an open pending request for the same pair).
 */
async function createRequest({ agentId, issuerId, message }) {
  const msg = message == null ? null : String(message).trim();
  if (msg && msg.length > MESSAGE_MAX) {
    throw httpError(`Field "message" must be <= ${MESSAGE_MAX} characters`, 400);
  }

  const db = await getDb();

  // Ensure the agent exists.
  const agent = await db.execute({
    sql: `SELECT id FROM agents WHERE id = ?`,
    args: [agentId],
  });
  if (!agent.rows[0]) throw httpError('Agent not found', 404);

  // Ensure the issuer exists and is active.
  const issuer = await db.execute({
    sql: `SELECT id, status FROM issuers WHERE id = ?`,
    args: [issuerId],
  });
  if (!issuer.rows[0]) throw httpError('Issuer not found', 404);
  if (issuer.rows[0].status !== 'active') {
    throw httpError('Issuer is not active', 409);
  }

  // Duplicate guard: one open pending request per (agent, issuer).
  const dup = await db.execute({
    sql: `SELECT id FROM issuer_requests
          WHERE agent_id = ? AND issuer_id = ? AND status = 'pending'`,
    args: [agentId, issuerId],
  });
  if (dup.rows[0]) {
    throw httpError('A pending request already exists for this issuer', 409);
  }

  const row = {
    id: uuid(),
    agent_id: agentId,
    issuer_id: issuerId,
    status: 'pending',
    message: msg,
    response_msg: null,
    created_at: nowIso(),
    responded_at: null,
  };

  await db.execute({
    sql: `INSERT INTO issuer_requests
            (id, agent_id, issuer_id, status, message, response_msg, created_at, responded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id, row.agent_id, row.issuer_id, row.status,
      row.message, row.response_msg, row.created_at, row.responded_at,
    ],
  });

  return publicRequest(row);
}

/** Get a single request by id. */
async function getRequest(requestId) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM issuer_requests WHERE id = ?`,
    args: [requestId],
  });
  return publicRequest(res.rows[0]);
}

/** List requests an agent has created (with issuer names). */
async function listRequestsByAgent(agentId) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT ir.*, i.display_name AS issuer_name
          FROM issuer_requests ir
          LEFT JOIN issuers i ON ir.issuer_id = i.id
          WHERE ir.agent_id = ?
          ORDER BY ir.created_at DESC`,
    args: [agentId],
  });
  return res.rows.map(publicRequest);
}

/** List requests an issuer has received (with agent handles). */
async function listRequestsByIssuer(issuerId) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT ir.*, a.handle AS agent_handle, a.wallet AS agent_wallet
          FROM issuer_requests ir
          LEFT JOIN agents a ON ir.agent_id = a.id
          WHERE ir.issuer_id = ?
          ORDER BY ir.created_at DESC`,
    args: [issuerId],
  });
  return res.rows.map(publicRequest);
}

/**
 * Respond to a request: accept or reject. Only pending requests can change.
 */
async function respondToRequest({ requestId, issuerId, decision, responseMsg }) {
  if (!['accepted', 'rejected'].includes(decision)) {
    throw httpError('decision must be "accepted" or "rejected"', 400);
  }
  const resMsg = responseMsg == null ? null : String(responseMsg).trim();
  if (resMsg && resMsg.length > MESSAGE_MAX) {
    throw httpError(`Field "response_msg" must be <= ${MESSAGE_MAX} characters`, 400);
  }

  const db = await getDb();
  const existing = await db.execute({
    sql: `SELECT * FROM issuer_requests WHERE id = ?`,
    args: [requestId],
  });
  const row = existing.rows[0];
  if (!row) throw httpError('Request not found', 404);
  if (row.issuer_id !== issuerId) {
    throw httpError('Cannot respond to another issuer\'s request', 403);
  }
  if (row.status !== 'pending') {
    throw httpError(`Request already ${row.status}`, 409);
  }

  const respondedAt = nowIso();
  await db.execute({
    sql: `UPDATE issuer_requests
          SET status = ?, response_msg = ?, responded_at = ?
          WHERE id = ?`,
    args: [decision, resMsg, respondedAt, requestId],
  });

  return getRequest(requestId);
}

module.exports = {
  createRequest,
  getRequest,
  listRequestsByAgent,
  listRequestsByIssuer,
  respondToRequest,
  MESSAGE_MAX,
};
