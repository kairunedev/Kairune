'use strict';

// Integration tests for verifiable attestations: issuer registration,
// key management, and signed attestation submission. In-memory DB.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const app = require('../../server');
const { canonicalPayload } = require('../services/verification');

let server;
let base;

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      base + path,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : {} })
        );
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

async function newAgent(handle) {
  const r = await req('POST', '/api/agents', {
    handle,
    wallet: '0x' + crypto.randomBytes(8).toString('hex'),
  });
  return r.body.agent.id;
}

async function registerIssuer(name) {
  const r = await req('POST', '/api/issuers', { display_name: name });
  return { id: r.body.issuer.id, apiKey: r.body.api_key, res: r };
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
});

test('issuer registration returns api_key once; list never exposes it', async () => {
  const { apiKey, res } = await registerIssuer('CI Issuer');
  assert.strictEqual(res.status, 201);
  assert.ok(apiKey && apiKey.length >= 32);
  const list = await req('GET', '/api/issuers');
  assert.strictEqual(list.status, 200);
  const serialized = JSON.stringify(list.body);
  assert.ok(!serialized.includes(apiKey), 'api key must not appear in listing');
});

test('issuer registration rejects empty display name', async () => {
  const r = await req('POST', '/api/issuers', { display_name: '   ' });
  assert.strictEqual(r.status, 400);
});

test('key registration rejects a malformed public key', async () => {
  const { id, apiKey } = await registerIssuer('bad-key-iss');
  const r = await req('POST', `/api/issuers/${id}/keys`, { public_key: 'nope' }, { 'X-Issuer-Key': apiKey });
  assert.strictEqual(r.status, 400);
});

test('cross-issuer key management is forbidden (403)', async () => {
  const a = await registerIssuer('iss-a');
  const b = await registerIssuer('iss-b');
  const { pem } = keypair();
  const r = await req('POST', `/api/issuers/${a.id}/keys`, { public_key: pem }, { 'X-Issuer-Key': b.apiKey });
  assert.strictEqual(r.status, 403);
});

test('key management without an issuer key is unauthorized (401)', async () => {
  const { id } = await registerIssuer('iss-noauth');
  const { pem } = keypair();
  const r = await req('POST', `/api/issuers/${id}/keys`, { public_key: pem });
  assert.strictEqual(r.status, 401);
});

test('signed attestation is recorded verified and outscores unsigned', async () => {
  const { id: issuerId, apiKey } = await registerIssuer('signer');
  const { pem, privateKey } = keypair();
  const keyRes = await req('POST', `/api/issuers/${issuerId}/keys`, { public_key: pem }, { 'X-Issuer-Key': apiKey });
  const keyId = keyRes.body.key.id;

  const agentId = await newAgent('signed-agent');
  const issued_at = new Date().toISOString();
  const fields = {
    agent_id: agentId,
    kind: 'clean_payment',
    amount: 0,
    note: null,
    issuer_id: issuerId,
    issuer_key_id: keyId,
    issued_at,
  };
  const signature = crypto
    .sign(null, Buffer.from(canonicalPayload(fields)), privateKey)
    .toString('base64');

  const signed = await req(
    'POST',
    `/api/agents/${agentId}/attestations`,
    { kind: 'clean_payment', issuer_id: issuerId, issuer_key_id: keyId, signature, issued_at },
    { 'X-Issuer-Key': apiKey }
  );
  assert.strictEqual(signed.status, 201);
  assert.strictEqual(signed.body.attestation.verification_status, 'verified');

  // Same event unsigned on a fresh agent should score lower.
  const agent2 = await newAgent('unsigned-agent');
  await req('POST', `/api/agents/${agent2}/attestations`, { kind: 'clean_payment' });

  const signedAgent = await req('GET', `/api/agents/${agentId}`);
  const unsignedAgent = await req('GET', `/api/agents/${agent2}`);
  assert.ok(
    signedAgent.body.agent.score > unsignedAgent.body.agent.score,
    'verified attestation should outscore unverified'
  );
});

test('bad signature is rejected (400) and records nothing', async () => {
  const { id: issuerId, apiKey } = await registerIssuer('badsig');
  const { pem } = keypair();
  const keyRes = await req('POST', `/api/issuers/${issuerId}/keys`, { public_key: pem }, { 'X-Issuer-Key': apiKey });
  const keyId = keyRes.body.key.id;
  const agentId = await newAgent('badsig-agent');

  const r = await req(
    'POST',
    `/api/agents/${agentId}/attestations`,
    { kind: 'task_completed', issuer_id: issuerId, issuer_key_id: keyId, signature: 'AAAA', issued_at: new Date().toISOString() },
    { 'X-Issuer-Key': apiKey }
  );
  assert.strictEqual(r.status, 400);

  const hist = await req('GET', `/api/agents/${agentId}/attestations`);
  assert.strictEqual(hist.body.attestations.length, 0);
});

test('partial credentials are rejected (400)', async () => {
  const agentId = await newAgent('partial-agent');
  const r = await req('POST', `/api/agents/${agentId}/attestations`, {
    kind: 'task_completed',
    issuer_id: 'x',
  });
  assert.strictEqual(r.status, 400);
});

test('unknown issuer in a signed submission is rejected (400)', async () => {
  const agentId = await newAgent('unknown-iss-agent');
  const r = await req('POST', `/api/agents/${agentId}/attestations`, {
    kind: 'task_completed',
    issuer_id: 'does-not-exist',
    issuer_key_id: 'nope',
    signature: 'AAAA',
    issued_at: new Date().toISOString(),
  });
  assert.strictEqual(r.status, 400);
});

test('wrong API key for referenced issuer is unauthorized (401)', async () => {
  const good = await registerIssuer('auth-good');
  const other = await registerIssuer('auth-other');
  const { pem } = keypair();
  const keyRes = await req('POST', `/api/issuers/${good.id}/keys`, { public_key: pem }, { 'X-Issuer-Key': good.apiKey });
  const keyId = keyRes.body.key.id;
  const agentId = await newAgent('auth-agent');

  const r = await req(
    'POST',
    `/api/agents/${agentId}/attestations`,
    { kind: 'task_completed', issuer_id: good.id, issuer_key_id: keyId, signature: 'AAAA', issued_at: new Date().toISOString() },
    { 'X-Issuer-Key': other.apiKey }
  );
  assert.strictEqual(r.status, 401);
});

test('revoked key: signed submission is recorded unverified', async () => {
  const { id: issuerId, apiKey } = await registerIssuer('revoker');
  const { pem, privateKey } = keypair();
  const keyRes = await req('POST', `/api/issuers/${issuerId}/keys`, { public_key: pem }, { 'X-Issuer-Key': apiKey });
  const keyId = keyRes.body.key.id;

  const revoke = await req('DELETE', `/api/issuers/${issuerId}/keys/${keyId}`, null, { 'X-Issuer-Key': apiKey });
  assert.strictEqual(revoke.status, 200);
  // idempotent re-revoke
  const revoke2 = await req('DELETE', `/api/issuers/${issuerId}/keys/${keyId}`, null, { 'X-Issuer-Key': apiKey });
  assert.strictEqual(revoke2.status, 200);

  const agentId = await newAgent('revoked-agent');
  const issued_at = new Date().toISOString();
  const fields = {
    agent_id: agentId,
    kind: 'task_completed',
    amount: 0,
    note: null,
    issuer_id: issuerId,
    issuer_key_id: keyId,
    issued_at,
  };
  const signature = crypto
    .sign(null, Buffer.from(canonicalPayload(fields)), privateKey)
    .toString('base64');

  const r = await req(
    'POST',
    `/api/agents/${agentId}/attestations`,
    { kind: 'task_completed', issuer_id: issuerId, issuer_key_id: keyId, signature, issued_at },
    { 'X-Issuer-Key': apiKey }
  );
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.attestation.verification_status, 'unverified');
});

test('revoking a non-existent key returns 404', async () => {
  const { id, apiKey } = await registerIssuer('revoke404');
  const r = await req('DELETE', `/api/issuers/${id}/keys/nope`, null, { 'X-Issuer-Key': apiKey });
  assert.strictEqual(r.status, 404);
});

test('stale issued_at is rejected (400) — freshness window', async () => {
  const { id: issuerId, apiKey } = await registerIssuer('stale-iss');
  const { pem, privateKey } = keypair();
  const keyRes = await req('POST', `/api/issuers/${issuerId}/keys`, { public_key: pem }, { 'X-Issuer-Key': apiKey });
  const keyId = keyRes.body.key.id;
  const agentId = await newAgent('stale-agent');

  const issued_at = new Date(Date.now() - 3600 * 1000).toISOString(); // 1h old
  const fields = {
    agent_id: agentId,
    kind: 'task_completed',
    amount: 0,
    note: null,
    issuer_id: issuerId,
    issuer_key_id: keyId,
    issued_at,
  };
  const signature = crypto
    .sign(null, Buffer.from(canonicalPayload(fields)), privateKey)
    .toString('base64');

  const r = await req(
    'POST',
    `/api/agents/${agentId}/attestations`,
    { kind: 'task_completed', issuer_id: issuerId, issuer_key_id: keyId, signature, issued_at },
    { 'X-Issuer-Key': apiKey }
  );
  assert.strictEqual(r.status, 400);
});

test('reusing a signature is rejected as replay (409)', async () => {
  const { id: issuerId, apiKey } = await registerIssuer('replay-iss');
  const { pem, privateKey } = keypair();
  const keyRes = await req('POST', `/api/issuers/${issuerId}/keys`, { public_key: pem }, { 'X-Issuer-Key': apiKey });
  const keyId = keyRes.body.key.id;
  const agentId = await newAgent('replay-agent');

  const issued_at = new Date().toISOString();
  const fields = {
    agent_id: agentId,
    kind: 'clean_payment',
    amount: 0,
    note: null,
    issuer_id: issuerId,
    issuer_key_id: keyId,
    issued_at,
  };
  const signature = crypto
    .sign(null, Buffer.from(canonicalPayload(fields)), privateKey)
    .toString('base64');
  const body = { kind: 'clean_payment', issuer_id: issuerId, issuer_key_id: keyId, signature, issued_at };

  const first = await req('POST', `/api/agents/${agentId}/attestations`, body, { 'X-Issuer-Key': apiKey });
  assert.strictEqual(first.status, 201);
  assert.strictEqual(first.body.attestation.verification_status, 'verified');

  const second = await req('POST', `/api/agents/${agentId}/attestations`, body, { 'X-Issuer-Key': apiKey });
  assert.strictEqual(second.status, 409);
});

// ---------------------------------------------------------------------------
// Public, stateless signature verification: POST /api/verify
// ---------------------------------------------------------------------------
test('POST /api/verify confirms a valid Ed25519 signature (no auth)', async () => {
  const { pem, privateKey } = keypair();
  const fields = {
    agent_id: 'agent-x',
    kind: 'clean_payment',
    amount: 12.5,
    note: 'demo',
    issuer_id: 'iss-x',
    issuer_key_id: 'key-x',
    issued_at: '2026-07-20T10:00:00.000Z',
  };
  const signature = crypto
    .sign(null, Buffer.from(canonicalPayload(fields)), privateKey)
    .toString('base64');

  const r = await req('POST', '/api/verify', { public_key: pem, signature, fields });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.verified, true);
  assert.strictEqual(r.body.algorithm, 'ed25519');
  assert.strictEqual(r.body.reason, 'ok');
  assert.strictEqual(r.body.canonical, canonicalPayload(fields));
});

test('POST /api/verify rejects a tampered field', async () => {
  const { pem, privateKey } = keypair();
  const fields = {
    agent_id: 'agent-y',
    kind: 'task_completed',
    amount: 1,
    issuer_id: 'iss-y',
    issuer_key_id: 'key-y',
    issued_at: '2026-07-20T10:00:00.000Z',
  };
  const signature = crypto
    .sign(null, Buffer.from(canonicalPayload(fields)), privateKey)
    .toString('base64');

  // Same signature, but the amount was changed after signing.
  const r = await req('POST', '/api/verify', {
    public_key: pem,
    signature,
    fields: { ...fields, amount: 999 },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.verified, false);
  assert.strictEqual(r.body.reason, 'signature_invalid');
});

test('POST /api/verify requires public_key, signature and fields', async () => {
  const missingKey = await req('POST', '/api/verify', { signature: 'AAAA', fields: {} });
  assert.strictEqual(missingKey.status, 400);

  const missingSig = await req('POST', '/api/verify', { public_key: 'x', fields: {} });
  assert.strictEqual(missingSig.status, 400);

  const missingFields = await req('POST', '/api/verify', { public_key: 'x', signature: 'AAAA' });
  assert.strictEqual(missingFields.status, 400);
});

// ---------------------------------------------------------------------------
// Issuer diversity: GET /api/agents/:id/trust-sources
// ---------------------------------------------------------------------------

// Create an issuer with a signing key. Returns a submit() that posts a
// verified attestation from THIS issuer to any agent (so a single issuer can
// vouch multiple times).
async function makeSigningIssuer(issuerName) {
  const { id: issuerId, apiKey } = await registerIssuer(issuerName);
  const { pem, privateKey } = keypair();
  const keyRes = await req(
    'POST',
    `/api/issuers/${issuerId}/keys`,
    { public_key: pem },
    { 'X-Issuer-Key': apiKey }
  );
  const keyId = keyRes.body.key.id;

  async function submit(agentId, kind = 'clean_payment') {
    const issued_at = new Date().toISOString();
    const fields = {
      agent_id: agentId,
      kind,
      amount: 0,
      note: null,
      issuer_id: issuerId,
      issuer_key_id: keyId,
      issued_at,
    };
    const signature = crypto
      .sign(null, Buffer.from(canonicalPayload(fields)), privateKey)
      .toString('base64');
    const r = await req(
      'POST',
      `/api/agents/${agentId}/attestations`,
      { kind, issuer_id: issuerId, issuer_key_id: keyId, signature, issued_at },
      { 'X-Issuer-Key': apiKey }
    );
    assert.strictEqual(r.status, 201);
    return r;
  }

  return { issuerId, submit };
}

// Convenience: one verified attestation from a brand-new issuer.
async function verifiedFromIssuer(agentId, issuerName, kind = 'clean_payment') {
  const iss = await makeSigningIssuer(issuerName);
  await iss.submit(agentId, kind);
  return iss.issuerId;
}

test('trust-sources: self-posted (unverified) attestations give zero diversity', async () => {
  const agentId = await newAgent('div-selffarm');
  // Post many unsigned attestations — the "farm your own tier" attempt.
  for (let i = 0; i < 8; i++) {
    await req('POST', `/api/agents/${agentId}/attestations`, { kind: 'task_completed' });
  }
  const r = await req('GET', `/api/agents/${agentId}/trust-sources`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.distinct_issuers, 0);
  assert.strictEqual(r.body.verified_count, 0);
  assert.strictEqual(r.body.confidence, 0);
  assert.ok(r.body.unverified_count >= 8);
});

test('trust-sources: a single issuer vouching many times still caps confidence at 0', async () => {
  const agentId = await newAgent('div-single');
  // One issuer, THREE verified attestations for the same agent.
  const iss = await makeSigningIssuer('div-mono');
  await iss.submit(agentId, 'clean_payment');
  await iss.submit(agentId, 'task_completed');
  await iss.submit(agentId, 'peer_vouch');

  const r = await req('GET', `/api/agents/${agentId}/trust-sources`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.distinct_issuers, 1);
  assert.strictEqual(r.body.verified_count, 3);
  assert.strictEqual(r.body.top_issuer_share, 1);
  // A single source = no independence, so diversity + confidence are zero
  // even though the agent has several verified attestations.
  assert.strictEqual(r.body.diversity_index, 0);
  assert.strictEqual(r.body.confidence, 0);
});

test('trust-sources: multiple independent issuers raise confidence and diversity', async () => {
  const concentrated = await newAgent('div-concentrated');
  const diverse = await newAgent('div-diverse');

  // Concentrated: 1 issuer.
  await verifiedFromIssuer(concentrated, 'solo-issuer', 'clean_payment');

  // Diverse: 4 different issuers.
  await verifiedFromIssuer(diverse, 'iss-alpha', 'clean_payment');
  await verifiedFromIssuer(diverse, 'iss-beta', 'clean_payment');
  await verifiedFromIssuer(diverse, 'iss-gamma', 'clean_payment');
  await verifiedFromIssuer(diverse, 'iss-delta', 'clean_payment');

  const c = await req('GET', `/api/agents/${concentrated}/trust-sources`);
  const d = await req('GET', `/api/agents/${diverse}/trust-sources`);

  assert.strictEqual(c.body.distinct_issuers, 1);
  assert.strictEqual(d.body.distinct_issuers, 4);
  assert.ok(
    d.body.confidence > c.body.confidence,
    'more independent issuers must yield higher confidence'
  );
  assert.ok(
    d.body.diversity_index > c.body.diversity_index,
    'spread across issuers must yield higher diversity index'
  );
  assert.ok(d.body.top_issuer_share <= 0.5, 'no single issuer should dominate the diverse agent');
});
