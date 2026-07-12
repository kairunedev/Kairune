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
