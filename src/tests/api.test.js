'use strict';

// Integration test for the REST API. Uses an in-memory DB (DB_PATH=:memory:)
// so it never touches real data. The server starts on a random port.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const app = require('../../server');
let server;
let base;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      base + path,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
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

test('GET /health returns ok', async () => {
  const r = await req('GET', '/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'ok');
});

test('GET /api/meta returns kinds and tiers', async () => {
  const r = await req('GET', '/api/meta');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.attestation_kinds));
  assert.ok(r.body.attestation_kinds.includes('task_completed'));
});

test('full lifecycle: create → attest → score up → permission → revoke', async () => {
  // create
  const create = await req('POST', '/api/agents', {
    handle: 'itest-01',
    wallet: '0xabc0000000000000000000000000000000000001',
    operator: 'CI',
  });
  assert.strictEqual(create.status, 201);
  const id = create.body.agent.id;
  assert.strictEqual(create.body.agent.score, 120); // baseline

  // add positive attestations
  for (let i = 0; i < 15; i++) {
    await req('POST', '/api/agents/' + id + '/attestations', { kind: 'task_completed' });
  }
  const vouch = await req('POST', '/api/agents/' + id + '/attestations', { kind: 'peer_vouch' });
  assert.strictEqual(vouch.status, 201);
  assert.ok(vouch.body.agent.score > 120, 'score should rise above the baseline');

  // grant permission (should be capped by tier)
  const grant = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'compute',
    ceiling: 99999,
  });
  assert.strictEqual(grant.status, 201);
  assert.ok(grant.body.permission.capped, 'ceiling should be capped by tier');
  const pid = grant.body.permission.id;

  // revoke
  const revoke = await req('POST', '/api/permissions/' + pid + '/revoke');
  assert.strictEqual(revoke.status, 200);
  assert.strictEqual(revoke.body.permission.status, 'revoked');

  // cleanup
  const del = await req('DELETE', '/api/agents/' + id);
  assert.strictEqual(del.status, 200);
});

test('validation: missing fields → 400', async () => {
  const r = await req('POST', '/api/agents', {});
  assert.strictEqual(r.status, 400);
});

test('validation: duplicate handle → 409', async () => {
  await req('POST', '/api/agents', { handle: 'dup-01', wallet: '0xdup001' });
  const r = await req('POST', '/api/agents', { handle: 'dup-01', wallet: '0xdup002' });
  assert.strictEqual(r.status, 409);
});

test('validation: duplicate wallet → 409', async () => {
  await req('POST', '/api/agents', { handle: 'wal-a', wallet: '0xwalletdup1' });
  const r = await req('POST', '/api/agents', { handle: 'wal-b', wallet: '0xwalletdup1' });
  assert.strictEqual(r.status, 409);
});

test('validation: short wallet → 400', async () => {
  const r = await req('POST', '/api/agents', { handle: 'short-01', wallet: '0xab' });
  assert.strictEqual(r.status, 400);
});

test('validation: invalid attestation kind → 400', async () => {
  const c = await req('POST', '/api/agents', { handle: 'kind-01', wallet: '0xkind001' });
  const r = await req('POST', '/api/agents/' + c.body.agent.id + '/attestations', {
    kind: 'malicious',
  });
  assert.strictEqual(r.status, 400);
});

test('unknown api route → 404 JSON', async () => {
  const r = await req('GET', '/api/does-not-exist');
  assert.strictEqual(r.status, 404);
  assert.ok(r.body.error);
});

test('suspended agent cannot get permission → 409', async () => {
  const c = await req('POST', '/api/agents', { handle: 'susp-01', wallet: '0xsusp001' });
  const id = c.body.agent.id;
  await req('PATCH', '/api/agents/' + id + '/status', { status: 'suspended' });
  const r = await req('POST', '/api/agents/' + id + '/permissions', {
    category: 'x',
    ceiling: 10,
  });
  assert.strictEqual(r.status, 409);
});
