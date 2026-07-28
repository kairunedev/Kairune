'use strict';

// Tests for the agent.rank_changed webhook event. Verifies that a rescore which
// moves an agent's leaderboard position fires a signed webhook carrying the
// before/after rank + direction, that a lower rank number reads as direction
// "up", and that no event fires when the rank is unchanged or the agent has no
// public standing (demo/test). Uses an in-memory DB and a local HTTP receiver.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');

const { closeDb } = require('../db');
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

function rndHandle(prefix) {
  return prefix + '-' + crypto.randomUUID().slice(0, 8);
}
function rndWallet() {
  return '0x' + crypto.randomUUID().replace(/-/g, '');
}

// Add verified peer_vouches from distinct issuers to climb the score.
async function pump(agentId, n, offset = 0) {
  let last = null;
  for (let i = 0; i < n; i++) {
    const r = await attestationService.addAttestation(agentId, {
      kind: 'peer_vouch',
      verification_status: 'verified',
      issuer_id: 'issuer-' + (offset + i),
      issuer_key_id: 'key-' + (offset + i),
    });
    last = r.agent;
  }
  return last;
}

test('agent.rank_changed fires with direction "up" when an agent overtakes another', async () => {
  received.length = 0;
  const { webhook, secret } = await webhookService.createWebhook({
    url: receiverUrl,
    events: ['agent.rank_changed'],
  });

  // Leader gets a healthy score first.
  const leader = await agentService.createAgent({
    handle: rndHandle('rc-leader'), wallet: rndWallet(), operator: 'CI',
  });
  await pump(leader.id, 12, 0);

  // Challenger starts lower (fewer vouches) → ranks below the leader.
  const challenger = await agentService.createAgent({
    handle: rndHandle('rc-challenger'), wallet: rndWallet(), operator: 'CI',
  });
  await pump(challenger.id, 4, 100);

  const beforeLeader = await agentService.getRank(leader.id);
  const beforeChallenger = await agentService.getRank(challenger.id);
  assert.ok(
    beforeChallenger.rank > beforeLeader.rank,
    'setup: challenger must start ranked below the leader'
  );

  received.length = 0; // ignore setup deliveries

  // Pump the challenger past the leader → its rank number should decrease.
  await pump(challenger.id, 40, 200);

  const afterChallenger = await agentService.getRank(challenger.id);
  assert.ok(
    afterChallenger.rank < beforeChallenger.rank,
    'challenger rank number should decrease after overtaking'
  );

  // At least one rank_changed delivery for the challenger with direction "up".
  const up = received.find(
    (r) => r.event === 'agent.rank_changed'
      && r.body.data.agent_id === challenger.id
      && r.body.data.direction === 'up'
  );
  assert.ok(up, 'expected a rank_changed delivery with direction "up"');

  // Signature must verify against the secret.
  const expected = 'sha256=' + webhookService.sign(secret, up.raw);
  assert.strictEqual(up.signature, expected, 'signature must verify');

  const d = up.body.data;
  assert.strictEqual(d.agent_handle, challenger.handle);
  assert.ok(d.rank < d.previous_rank, 'new rank number is lower (better)');
  assert.ok(Number.isFinite(d.total) && d.total >= 2);
  assert.ok(Number.isFinite(d.percentile));
  assert.ok(typeof d.label === 'string' && d.label.length > 0);

  await webhookService.deleteWebhook(webhook.id);
});

test('agent.rank_changed fires with direction "down" when an agent\'s own score drops', async () => {
  received.length = 0;
  const { webhook } = await webhookService.createWebhook({
    url: receiverUrl,
    events: ['agent.rank_changed'],
  });

  // A ranks ahead of B. rank_changed fires for the agent being RESCORED based
  // on its own before/after position, so we drop A's own score (chargeback) and
  // watch A fall behind B — a genuine self-inflicted demotion.
  // Equal scores → A wins the tie-break (created first) and sits at rank #1,
  // B right behind it. A single chargeback then drops A below B.
  const a = await agentService.createAgent({
    handle: rndHandle('rc-a'), wallet: rndWallet(), operator: 'CI',
  });
  await pump(a.id, 8, 0);
  const b = await agentService.createAgent({
    handle: rndHandle('rc-b'), wallet: rndWallet(), operator: 'CI',
  });
  await pump(b.id, 8, 100);

  const aBefore = await agentService.getRank(a.id);
  const bBefore = await agentService.getRank(b.id);
  assert.ok(aBefore.rank < bBefore.rank, 'setup: A must start ahead of B');

  received.length = 0;

  // A chargeback on A drops its score below B → A's rank number increases.
  await attestationService.addAttestation(a.id, { kind: 'chargeback' });

  const aAfter = await agentService.getRank(a.id);
  assert.ok(
    aAfter.rank > aBefore.rank,
    'A rank number should increase (worsen) after its score drops'
  );

  const down = received.find(
    (r) => r.event === 'agent.rank_changed'
      && r.body.data.agent_id === a.id
      && r.body.data.direction === 'down'
  );
  assert.ok(down, 'expected a rank_changed delivery for A with direction "down"');
  assert.ok(down.body.data.rank > down.body.data.previous_rank);

  await webhookService.deleteWebhook(webhook.id);
});

test('no rank_changed event when an agent has no public standing (demo)', async () => {
  const { webhook } = await webhookService.createWebhook({
    url: receiverUrl,
    events: ['agent.rank_changed'],
  });

  // A demo agent is excluded from the leaderboard, so getRank() is null and no
  // rank event should ever fire for it — no matter how its score changes.
  const demo = await agentService.createAgent({
    handle: rndHandle('demo'), wallet: rndWallet(), operator: 'demo-loop',
  });
  received.length = 0;

  await pump(demo.id, 20, 0);

  await new Promise((r) => setTimeout(r, 200));
  const forDemo = received.filter(
    (r) => r.event === 'agent.rank_changed' && r.body.data.agent_id === demo.id
  );
  assert.strictEqual(forDemo.length, 0, 'demo agent must not emit rank_changed');

  await webhookService.deleteWebhook(webhook.id);
});

test('no rank_changed event when the rank does not move', async () => {
  const { webhook } = await webhookService.createWebhook({
    url: receiverUrl,
    events: ['agent.rank_changed'],
  });

  // A lone (or clearly-separated) agent whose small score bump doesn't change
  // its position should not emit a rank_changed event.
  const solo = await agentService.createAgent({
    handle: rndHandle('rc-solo'), wallet: rndWallet(), operator: 'CI',
  });
  await pump(solo.id, 6, 0);
  received.length = 0;

  // A single small positive attestation that keeps its rank the same.
  await attestationService.addAttestation(solo.id, { kind: 'task_completed' });

  await new Promise((r) => setTimeout(r, 200));
  const moved = received.filter(
    (r) => r.event === 'agent.rank_changed' && r.body.data.agent_id === solo.id
  );
  assert.strictEqual(moved.length, 0, 'no rank_changed expected when rank is stable');

  await webhookService.deleteWebhook(webhook.id);
});
