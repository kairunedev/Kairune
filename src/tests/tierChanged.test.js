'use strict';

// Tests for the agent.tier_changed webhook event. Verifies that a rescore which
// moves an agent across a tier boundary fires a signed webhook, that it carries
// the direction + before/after tiers, and that no event fires when the tier is
// unchanged. Uses an in-memory DB and a local HTTP receiver.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');

const { getDb, closeDb } = require('../db');
const webhookService = require('../services/webhookService');
const agentService = require('../services/agentService');
const attestationService = require('../services/attestationService');

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

// Add a verified peer_vouch from a distinct issuer so the volume bonus (which is
// capped per-issuer) keeps growing and the score climbs across tiers.
async function verifiedVouch(agentId, i) {
  return attestationService.addAttestation(agentId, {
    kind: 'peer_vouch',
    verification_status: 'verified',
    issuer_id: 'issuer-' + i,
    issuer_key_id: 'key-' + i,
  });
}

test('agent.tier_changed fires with direction "up" when an agent is promoted', async () => {
  received.length = 0;
  const { webhook, secret } = await webhookService.createWebhook({
    url: receiverUrl,
    events: ['agent.tier_changed'],
  });

  const agent = await agentService.createAgent({
    handle: 'climber-' + crypto.randomUUID().slice(0, 8),
    wallet: '0x' + crypto.randomUUID().replace(/-/g, ''),
    operator: 'CI',
  });
  assert.strictEqual(Number(agent.tier), 0, 'new agent starts at tier 0');

  // Add verified vouches from distinct issuers until the tier rises.
  let last = agent;
  for (let i = 0; i < 40 && Number(last.tier) === 0; i++) {
    const r = await verifiedVouch(agent.id, i);
    last = r.agent;
  }
  assert.ok(Number(last.tier) > 0, 'agent should have climbed at least one tier');

  // At least one tier_changed delivery must have arrived.
  assert.ok(received.length >= 1, 'expected at least one tier_changed delivery');

  const first = received[0];
  assert.strictEqual(first.event, 'agent.tier_changed');

  // Signature must verify against the secret.
  const expected = 'sha256=' + webhookService.sign(secret, first.raw);
  assert.strictEqual(first.signature, expected, 'signature must verify');

  const d = first.body.data;
  assert.strictEqual(d.agent_id, agent.id);
  assert.strictEqual(d.agent_handle, agent.handle);
  assert.strictEqual(d.direction, 'up');
  assert.strictEqual(d.previous_tier, 0);
  assert.ok(d.tier > d.previous_tier, 'new tier is higher than previous');
  assert.ok(typeof d.label === 'string' && d.label.length > 0);
  assert.ok(Number.isFinite(d.score) && d.score > d.previous_score);

  await webhookService.deleteWebhook(webhook.id);
});

test('agent.tier_changed fires with direction "down" when an agent is demoted', async () => {
  received.length = 0;
  const { webhook } = await webhookService.createWebhook({
    url: receiverUrl,
    events: ['agent.tier_changed'],
  });

  // Promote an agent above tier 0 first.
  const agent = await agentService.createAgent({
    handle: 'faller-' + crypto.randomUUID().slice(0, 8),
    wallet: '0x' + crypto.randomUUID().replace(/-/g, ''),
    operator: 'CI',
  });
  let last = agent;
  for (let i = 0; i < 40 && Number(last.tier) === 0; i++) {
    const r = await verifiedVouch(agent.id, i);
    last = r.agent;
  }
  const promotedTier = Number(last.tier);
  assert.ok(promotedTier > 0, 'setup: agent must be promoted first');

  received.length = 0; // ignore the promotion event(s)

  // A severe negative attestation should drop the tier.
  const { agent: after } = await attestationService.addAttestation(agent.id, {
    kind: 'chargeback',
  });
  assert.ok(Number(after.tier) < promotedTier, 'tier should drop after chargeback');

  const down = received.find((r) => r.body.data.direction === 'down');
  assert.ok(down, 'expected a tier_changed delivery with direction "down"');
  assert.strictEqual(down.event, 'agent.tier_changed');
  assert.strictEqual(down.body.data.previous_tier, promotedTier);
  assert.ok(down.body.data.tier < down.body.data.previous_tier);

  await webhookService.deleteWebhook(webhook.id);
});

test('no tier_changed event when the tier does not move', async () => {
  const { webhook } = await webhookService.createWebhook({
    url: receiverUrl,
    events: ['agent.tier_changed'],
  });

  const agent = await agentService.createAgent({
    handle: 'steady-' + crypto.randomUUID().slice(0, 8),
    wallet: '0x' + crypto.randomUUID().replace(/-/g, ''),
    operator: 'CI',
  });
  received.length = 0;

  // A single small positive attestation should not cross a tier boundary from
  // the baseline, so no tier_changed event should be delivered.
  await attestationService.addAttestation(agent.id, { kind: 'task_completed' });

  // Give any stray delivery a moment to arrive.
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(
    received.filter((r) => r.event === 'agent.tier_changed').length,
    0,
    'no tier_changed event expected when tier is unchanged'
  );

  await webhookService.deleteWebhook(webhook.id);
});
