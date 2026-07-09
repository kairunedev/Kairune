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
 * @param {{kind:string, amount?:number, note?:string, weight?:number}} input
 * @returns {Promise<{attestation:object, agent:object}>}
 */
async function addAttestation(agentId, { kind, amount = 0, note = null, weight }) {
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
    created_at: nowIso(),
  };

  await db.execute({
    sql: `INSERT INTO attestations (id, agent_id, kind, weight, amount, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      attestation.id, attestation.agent_id, attestation.kind,
      attestation.weight, attestation.amount, attestation.note,
      attestation.created_at,
    ],
  });

  const updatedAgent = await agentService.recalcAgent(agent.id);
  return { attestation, agent: updatedAgent };
}

/**
 * List an agent's attestations (newest first).
 * @param {string} agentId
 * @param {{limit?:number}} [opts]
 * @returns {Promise<object[]>}
 */
async function listAttestations(agentId, { limit = 50 } = {}) {
  const db = await getDb();
  const res = await db.execute({
    sql: `SELECT * FROM attestations WHERE agent_id = ?
          ORDER BY created_at DESC LIMIT ?`,
    args: [agentId, limit],
  });
  return res.rows;
}

module.exports = { addAttestation, listAttestations, VALID_KINDS };
