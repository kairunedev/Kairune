'use strict';

// Integration tests for the ISSUER REQUEST MARKETPLACE.
//
// The handshake: an operator asks an issuer to verify their agent, the issuer
// accepts or rejects. Anyone may ask (asking is not a privilege), but only the
// addressed issuer may answer, and only once.
//
// The load-bearing behaviours asserted here:
//   * creating is public, answering needs the issuer's own key (401/403)
//   * one open pending request per (agent, issuer) — a second ask is a 409
//   * unknown agent or issuer is a 404, never a dangling request row
//   * a decided request is final: re-deciding is a 409
//
// Uses an in-memory DB so it never touches real data.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const app = require('../../server');
const { getDb, closeDb } = require('../db');
const agentService = require('../services/agentService');
const issuerService = require('../services/issuerService');
const issuerRequestService = require('../services/issuerRequestService');

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

let server;
let base;
let a1, a2, iss1, iss2, iss1Key, iss2Key;

function hexWallet() {
  return '0x' + crypto.randomBytes(20).toString('hex');
}

function seedAgent(handle) {
  return agentService.createAgent({ handle, wallet: hexWallet() });
}

/** HTTP helper. `issuerKey` is sent as the issuer credential when provided. */
function call(method, path, issuerKey, payload) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? undefined : JSON.stringify(payload);
    const headers = {};
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    if (issuerKey) headers['x-issuer-key'] = issuerKey;
    const r = http.request(base + path, { method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json;
        try {
          json = buf ? JSON.parse(buf) : {};
        } catch {
          json = buf;
        }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

before(async () => {
  await getDb();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });

  a1 = await seedAgent('req-alice');
  a2 = await seedAgent('req-bob');
  const r1 = await issuerService.createIssuer({ displayName: 'Req Issuer One' });
  const r2 = await issuerService.createIssuer({ displayName: 'Req Issuer Two' });
  iss1 = r1.issuer;
  iss1Key = r1.apiKey;
  iss2 = r2.issuer;
  iss2Key = r2.apiKey;
});

after(() => {
  if (server) server.close();
  return closeDb();
});

// -- create -----------------------------------------------------------------

test('POST /api/issuer-requests creates a pending request without any key', async () => {
  const r = await call('POST', '/api/issuer-requests', null, {
    agent_id: a1.id,
    issuer_id: iss1.id,
    message: 'please verify',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.request.status, 'pending');
  assert.equal(r.body.request.agent_id, a1.id);
  assert.equal(r.body.request.issuer_id, iss1.id);
  assert.equal(r.body.request.message, 'please verify');
  assert.equal(r.body.request.responded_at, null);
});

test('POST /api/issuer-requests rejects a duplicate pending request', async () => {
  const r = await call('POST', '/api/issuer-requests', null, {
    agent_id: a1.id,
    issuer_id: iss1.id,
  });
  assert.equal(r.status, 409);
});

test('POST /api/issuer-requests 404s an unknown agent', async () => {
  const r = await call('POST', '/api/issuer-requests', null, {
    agent_id: MISSING_ID,
    issuer_id: iss1.id,
  });
  assert.equal(r.status, 404);
});

test('POST /api/issuer-requests 404s an unknown issuer', async () => {
  const r = await call('POST', '/api/issuer-requests', null, {
    agent_id: a1.id,
    issuer_id: MISSING_ID,
  });
  assert.equal(r.status, 404);
});

test('POST /api/issuer-requests 400s when required fields are missing', async () => {
  const r = await call('POST', '/api/issuer-requests', null, { agent_id: a1.id });
  assert.equal(r.status, 400);
});

// -- read -------------------------------------------------------------------

test('GET /api/agents/:id/requests lists that agent own requests', async () => {
  await issuerRequestService.createRequest({
    agentId: a1.id,
    issuerId: iss2.id,
    message: 'second issuer',
  });
  const r = await call('GET', '/api/agents/' + a1.id + '/requests');
  assert.equal(r.status, 200);
  assert.ok(r.body.requests.length >= 2);
  assert.ok(r.body.requests.every((x) => x.agent_id === a1.id));
});

test('GET /api/agents/:id/requests 404s an unknown agent', async () => {
  const r = await call('GET', '/api/agents/' + MISSING_ID + '/requests');
  assert.equal(r.status, 404);
});

test('GET /api/issuer-requests/:id fetches one', async () => {
  const created = await issuerRequestService.createRequest({
    agentId: a2.id,
    issuerId: iss2.id,
  });
  const r = await call('GET', '/api/issuer-requests/' + created.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.request.id, created.id);
  assert.equal(r.body.request.status, 'pending');
});

test('GET /api/issuer-requests/:id 404s when missing', async () => {
  const r = await call('GET', '/api/issuer-requests/' + MISSING_ID);
  assert.equal(r.status, 404);
});

test('GET /api/issuers/:id/requests is the issuer own inbox only', async () => {
  const anon = await call('GET', '/api/issuers/' + iss1.id + '/requests');
  assert.equal(anon.status, 401);

  const other = await call('GET', '/api/issuers/' + iss1.id + '/requests', iss2Key);
  assert.equal(other.status, 403);

  const own = await call('GET', '/api/issuers/' + iss1.id + '/requests', iss1Key);
  assert.equal(own.status, 200);
  assert.ok(Array.isArray(own.body.requests));
  assert.ok(own.body.requests.every((x) => x.issuer_id === iss1.id));
});

// -- respond ----------------------------------------------------------------

test('POST /api/issuer-requests/:id/respond accepts', async () => {
  // A fresh agent per respond test: the duplicate-pending rule is scoped to
  // the (agent, issuer) pair, so reusing a fixture pair would 409 on setup.
  const agent = await seedAgent('req-accept');
  const pending = await issuerRequestService.createRequest({
    agentId: agent.id,
    issuerId: iss1.id,
    message: 'accept me',
  });
  const r = await call('POST', '/api/issuer-requests/' + pending.id + '/respond', iss1Key, {
    decision: 'accepted',
    response_msg: 'welcome',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.request.status, 'accepted');
  assert.equal(r.body.request.response_msg, 'welcome');
  assert.ok(r.body.request.responded_at);
});

test('POST /api/issuer-requests/:id/respond rejects', async () => {
  const agent = await seedAgent('req-reject');
  const pending = await issuerRequestService.createRequest({
    agentId: agent.id,
    issuerId: iss2.id,
    message: 'reject me',
  });
  const r = await call('POST', '/api/issuer-requests/' + pending.id + '/respond', iss2Key, {
    decision: 'rejected',
    response_msg: 'no thanks',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.request.status, 'rejected');
});

test('POST /api/issuer-requests/:id/respond needs the addressed issuer key', async () => {
  const agent = await seedAgent('req-auth');
  const pending = await issuerRequestService.createRequest({
    agentId: agent.id,
    issuerId: iss1.id,
    message: 'auth needed',
  });

  const anon = await call('POST', '/api/issuer-requests/' + pending.id + '/respond', null, {
    decision: 'accepted',
  });
  assert.equal(anon.status, 401);

  const wrong = await call('POST', '/api/issuer-requests/' + pending.id + '/respond', iss2Key, {
    decision: 'accepted',
  });
  assert.equal(wrong.status, 403);

  // Still untouched after the two refusals.
  const after = await call('GET', '/api/issuer-requests/' + pending.id);
  assert.equal(after.body.request.status, 'pending');
});

test('POST /api/issuer-requests/:id/respond cannot re-decide a decided request', async () => {
  const agent = await seedAgent('req-final');
  const pending = await issuerRequestService.createRequest({
    agentId: agent.id,
    issuerId: iss1.id,
    message: 'double decide',
  });

  const first = await call('POST', '/api/issuer-requests/' + pending.id + '/respond', iss1Key, {
    decision: 'accepted',
  });
  assert.equal(first.status, 200);

  const again = await call('POST', '/api/issuer-requests/' + pending.id + '/respond', iss1Key, {
    decision: 'rejected',
  });
  assert.equal(again.status, 409);
});

test('POST /api/issuer-requests/:id/respond 400s an unknown decision', async () => {
  const agent = await seedAgent('req-baddecision');
  const pending = await issuerRequestService.createRequest({
    agentId: agent.id,
    issuerId: iss1.id,
    message: 'bad decision',
  });
  const r = await call('POST', '/api/issuer-requests/' + pending.id + '/respond', iss1Key, {
    decision: 'maybe',
  });
  assert.equal(r.status, 400);
});
