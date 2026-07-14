'use strict';

// Tests for webhookService: signing/validation helpers plus real end-to-end
// delivery of spend.approved / spend.blocked events to a local HTTP receiver.
// Uses an in-memory DB so it never touches real data.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');

const { getDb, closeDb } = require('../db');
const webhookService = require('../services/webhookService');
const spendService = require('../services/spendService');

// A tiny receiver that records every webhook POST it gets.
const received = [];
let server;
let receiverUrl;

before(async () => {
  server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      received.push({
        event: req.headers['x-kairune-event'],
        signature: req.headers['x-kairune-signature'],
        raw: buf,
        body: buf ? JSON.parse(buf) : null,
      });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  receiverUrl = `http://127.0.0.1:${port}/hook`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
});

// Seed an active agent + active permission, returning the permission id.
async function seedPermission({ ceiling, period = 'day' }) {
  const db = await getDb();
  const ts = new Date().toISOString();
  const agentId = crypto.randomUUID();
  const permId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO agents (id, handle, wallet, operator, status, score, tier, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', 800, 3, ?, ?)`,
    args: [agentId, 'u-' + agentId.slice(0, 8), 'w-' + agentId.slice(0, 8), 'CI', ts, ts],
  });
  await db.execute({
    sql: `INSERT INTO permissions (id, agent_id, category, ceiling, period, status, granted_by, created_at, revoked_at)
          VALUES (?, ?, 'compute', ?, ?, 'active', 'CI', ?, NULL)`,
    args: [permId, agentId, ceiling, period, ts],
  });
  return { agentId, permId };
}

// Wait until at least `n` webhooks have been received (deliveries are async).
async function waitForDeliveries(n, timeoutMs = 3000) {
  const started = Date.now();
  while (received.length < n) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`only ${received.length}/${n} deliveries arrived in time`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('normalizeEvents accepts *, known events, and rejects unknown', () => {
  assert.strictEqual(webhookService.normalizeEvents(undefined), '*');
  assert.strictEqual(webhookService.normalizeEvents('*'), '*');
  assert.strictEqual(
    webhookService.normalizeEvents(['spend.blocked']),
    'spend.blocked'
  );
  assert.strictEqual(
    webhookService.normalizeEvents('spend.approved, spend.blocked'),
    'spend.approved,spend.blocked'
  );
  assert.throws(
    () => webhookService.normalizeEvents(['spend.nope']),
    (err) => err.status === 400
  );
});

test('isValidUrl only allows http(s)', () => {
  assert.ok(webhookService.isValidUrl('https://example.com/hook'));
  assert.ok(webhookService.isValidUrl('http://127.0.0.1:9/hook'));
  assert.ok(!webhookService.isValidUrl('ftp://example.com'));
  assert.ok(!webhookService.isValidUrl('not-a-url'));
});

test('sign produces a verifiable HMAC-SHA256 over the body', () => {
  const sig = webhookService.sign('secret', 'payload');
  const expected = crypto
    .createHmac('sha256', 'secret')
    .update('payload')
    .digest('hex');
  assert.strictEqual(sig, expected);
});

test('createWebhook returns a secret once and hides it afterwards', async () => {
  const { webhook, secret } = await webhookService.createWebhook({
    url: receiverUrl,
    events: '*',
  });
  assert.ok(secret && secret.length >= 32);
  assert.strictEqual(webhook.has_secret, true);
  assert.strictEqual(webhook.secret, undefined);

  const list = await webhookService.listWebhooks();
  const found = list.find((w) => w.id === webhook.id);
  assert.ok(found);
  assert.strictEqual(found.secret, undefined);

  // Clean up so it doesn't fire during the delivery test below.
  await webhookService.deleteWebhook(webhook.id);
});

test('spend.approved and spend.blocked are delivered with a valid signature', async () => {
  received.length = 0;
  const { webhook, secret } = await webhookService.createWebhook({
    url: receiverUrl,
    events: '*',
  });

  const { permId } = await seedPermission({ ceiling: 100, period: 'day' });
  const now = Date.now();

  // Approved spend → one delivery.
  await spendService.authorizeSpend(permId, { amount: 30 }, { nowMs: now });
  // Blocked spend (over ceiling) → another delivery.
  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 5000 }, { nowMs: now }),
    (err) => err.status === 409
  );

  await waitForDeliveries(2);

  const events = received.map((r) => r.event).sort();
  assert.deepStrictEqual(events, ['spend.approved', 'spend.blocked']);

  // Every delivery must carry a signature that verifies against the secret.
  for (const d of received) {
    const expected = 'sha256=' + webhookService.sign(secret, d.raw);
    assert.strictEqual(d.signature, expected, 'signature must verify');
    assert.ok(d.body.delivered_at, 'envelope has delivered_at');
    assert.ok(d.body.data.permission_id === permId);
  }

  const blocked = received.find((r) => r.event === 'spend.blocked');
  assert.strictEqual(blocked.body.data.reason, 'ceiling_exceeded');

  // Delivery attempts are recorded in the audit log.
  const deliveries = await webhookService.listDeliveries(webhook.id);
  assert.ok(deliveries.length >= 2);
  assert.ok(deliveries.every((d) => d.ok === 1));

  await webhookService.deleteWebhook(webhook.id);
});

test('events filter: a webhook only gets its subscribed event', async () => {
  received.length = 0;
  const { webhook } = await webhookService.createWebhook({
    url: receiverUrl,
    events: ['spend.blocked'],
  });

  const { permId } = await seedPermission({ ceiling: 50, period: 'day' });
  const now = Date.now();

  await spendService.authorizeSpend(permId, { amount: 10 }, { nowMs: now }); // approved, NOT subscribed
  await assert.rejects(
    () => spendService.authorizeSpend(permId, { amount: 9999 }, { nowMs: now }),
    (err) => err.status === 409
  ); // blocked, subscribed

  await waitForDeliveries(1);
  // Give any stray delivery a moment; there should be exactly one.
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].event, 'spend.blocked');

  await webhookService.deleteWebhook(webhook.id);
});
