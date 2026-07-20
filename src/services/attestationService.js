'use strict';

/**
 * Attestation service — record an agent's behavior event, then trigger a score recalculation (async).
 */

const crypto = require('crypto');
const { getDb } = require('../db');
const { KIND_WEIGHTS } = require('./trustScore');
const agentService = require('./agentService');

const VALID_KINDS = Object.keys(KIND_WEIGHTS);

function nowIso() {
  return new Date().toISOString();
}

/**
 * Add an attestation for an agent and recalculate the score automatically.
 * @param {string} agentId
 * @param {{kind:string, amount?:number, note?:string, weight?:number,
 *          verification_status?:string, issuer_id?:string, issuer_key_id?:string,
 *          created_at?:string}} input
 * @returns {Promise<{attestation:object, agent:object}>}
 */
async function addAttestation(
  agentId,
  {
    kind,
    amount = 0,
    note = null,
    weight,
    verification_status = 'unverified',
    issuer_id = null,
    issuer_key_id = null,
    created_at,
  }
) {
  const db = await getDb();

  const agent = await agentService.getAgent(agentId);
  if (!agent) {
    const err = new Error('Agent not found');
    err.status = 404;
    throw err;
  }
  if (!VALID_KINDS.includes(kind)) {
    const err = new Error(
      `Invalid attestation kind. Allowed: ${VALID_KINDS.join(', ')}`
    );
    err.status = 400;
    throw err;
  }

  const attestation = {
    id: crypto.randomUUID(),
    agent_id: agent.id,
    kind,
    weight: typeof weight === 'number' ? weight : KIND_WEIGHTS[kind],
    amount: Number(amount) || 0,
    note,
    verification_status:
      verification_status === 'verified' ? 'verified' : 'unverified',
    issuer_id: verification_status === 'verified' ? issuer_id : null,
    issuer_key_id: verification_status === 'verified' ? issuer_key_id : null,
    created_at: created_at || nowIso(),
  };

  await db.execute({
    sql: `INSERT INTO attestations
            (id, agent_id, kind, weight, amount, note, verification_status, issuer_id, issuer_key_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      attestation.id, attestation.agent_id, attestation.kind,
      attestation.weight, attestation.amount, attestation.note,
      attestation.verification_status, attestation.issuer_id,
      attestation.issuer_key_id, attestation.created_at,
    ],
  });

  const updatedAgent = await agentService.recalcAgent(agent.id);
  return { attestation, agent: updatedAgent };
}

/**
 * List an agent's attestations (newest first). Surfaces verification_status;
 * for verified rows includes the issuer id + display name, for unverified rows
 * omits issuer fields. Never exposes signatures or key material.
 * @param {string} agentId
 * @param {{limit?:number}} [opts]
 * @returns {Promise<object[]>}
 */
async function listAttestations(agentId, { limit = 50 } = {}) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT a.id, a.agent_id, a.kind, a.weight, a.amount, a.note,
                 a.verification_status, a.issuer_id, a.created_at,
                 i.display_name AS issuer_name
          FROM attestations a
          LEFT JOIN issuers i ON i.id = a.issuer_id
          WHERE a.agent_id = ?
          ORDER BY a.created_at DESC LIMIT ?`,
    args: [agentId, limit],
  });
  return res.rows.map((r) => {
    const verified = r.verification_status === 'verified';
    return {
      id: r.id,
      agent_id: r.agent_id,
      kind: r.kind,
      weight: r.weight,
      amount: r.amount,
      note: r.note,
      verification_status: verified ? 'verified' : 'unverified',
      created_at: r.created_at,
      ...(verified
        ? { issuer_id: r.issuer_id, issuer_name: r.issuer_name }
        : {}),
    };
  });
}

/**
 * Return the minimal rows needed to measure issuer diversity for an agent:
 * verification status plus the (verified-only) issuer id and display name.
 * Never exposes signatures or key material.
 * @param {string} agentId
 * @returns {Promise<Array<{verification_status:string, issuer_id:string|null, issuer_name:string|null}>>}
 */
async function listVerificationSources(agentId) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT a.verification_status, a.issuer_id, i.display_name AS issuer_name
          FROM attestations a
          LEFT JOIN issuers i ON i.id = a.issuer_id
          WHERE a.agent_id = ?`,
    args: [agentId],
  });
  return res.rows.map((r) => ({
    verification_status:
      r.verification_status === 'verified' ? 'verified' : 'unverified',
    issuer_id: r.verification_status === 'verified' ? r.issuer_id : null,
    issuer_name: r.verification_status === 'verified' ? r.issuer_name : null,
  }));
}

module.exports = {
  addAttestation,
  listAttestations,
  listVerificationSources,
  VALID_KINDS,
};
