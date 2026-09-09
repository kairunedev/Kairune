'use strict';

// Tests for movement CAUSE attribution.
//
// The gap these cover: a rank is a position in a shared ordering, so "climbed 8
// places" is arithmetically true in three situations that mean completely
// different things — the agent earned it, a neighbour moved and displaced it, or
// the scoring model itself changed. rank_history used to record only the delta,
// which made all three indistinguishable and let passive movement be presented
// as achievement. These tests pin down that every row says WHY.
//
// Everything drives the real scoring pipeline (createAgent -> addAttestation ->
// recalcAgent), so what is asserted is what production writes.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const { getDb } = require('../db');
const agentService = require('../services/agentService');
const attestationService = require('../services/attestationService');
const trustScore = require('../services/trustScore');
const app = require('../../server');

let server;
let base;

function get(path) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) })
      );
    });
    r.on('error', reject);
    r.end();
  });
}

// Wallets must be plausible EVM addresses that do NOT match the demo exclusion
// (which filters 0x00000000-prefixed addresses), otherwise the agent has no
// public rank at all and no history is ever written for it.
async function makeAgent(handle, seed) {
  const hex = crypto.createHash('sha256').update(`kairune-cause-${seed}`).digest('hex');
  const a = await agentService.createAgent({
    handle,
    wallet: '0x' + hex.slice(0, 40),
    operator: 'Fixture Labs',
  });
  return a.id;
}

// Distinct issuer per attestation, so the per-issuer volume cap doesn't flatten
// the boost and the corroboration ceiling actually lifts.
let issuerSeq = 0;
async function addVerified(agentId, n) {
  for (let i = 0; i < n; i++) {
    await attestationService.addAttestation(agentId, {
      kind: 'clean_payment',
      verification_status: 'verified',
      issuer_id: `ca-iss-${issuerSeq++}`,
      created_at: new Date().toISOString(),
    });
  }
  await agentService.recalcAgent(agentId);
}

let a1, a2, a3, a4, riser;

// Feed snapshots taken while the board is pristine — one climb, four agents
// displaced once each. Later tests add agents (and one deliberately edits a
// score with raw SQL, which bypasses the movement log by design), so those
// reorder the field further. Asserting the clean case against a snapshot keeps
// the feed assertions about the feed rather than about fixture ordering.
let cleanActivityFeed;
let cleanShiftFeed;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  a1 = await makeAgent('ca-alpha', 1);
  a2 = await makeAgent('ca-bravo', 2);
  a3 = await makeAgent('ca-charlie', 3);
  a4 = await makeAgent('ca-delta', 4);
  riser = await makeAgent('ca-riser', 5);

  // A well-separated field: alpha strongest, riser last.
  await addVerified(a1, 10);
  await addVerified(a2, 8);
  await addVerified(a3, 6);
  await addVerified(a4, 4);
  await addVerified(riser, 1);

  // The event under test: riser climbs from last to first, displacing all four.
  await addVerified(riser, 20);

  cleanActivityFeed = await agentService.getTopMovers({
    direction: 'all',
    windowHours: 24,
    limit: 50,
  });
  cleanShiftFeed = await agentService.getTopMovers({
    direction: 'all',
    cause: 'neighbor_shift',
    windowHours: 24,
    limit: 50,
  });
});

after(() => server && server.close());

test('an agent that earns its climb is tagged cause=activity', async () => {
  const hist = await agentService.getRankHistory(riser, { limit: 20 });
  assert.ok(hist.moves.length >= 1, 'the climb was recorded');
  for (const m of hist.moves) {
    assert.equal(m.cause, 'activity', 'own-score movement is activity');
    assert.equal(m.direction, 'up');
    // Its score genuinely changed — that is what makes it activity, not a shift.
    assert.notEqual(m.previous_score, m.score);
  }
});

test('agents displaced by someone else are recorded, tagged neighbor_shift', async () => {
  // This is the defect: before cause existed, these agents' ranks changed and
  // nothing at all was written for them.
  for (const id of [a1, a2, a3, a4]) {
    const hist = await agentService.getRankHistory(id, { limit: 20 });
    assert.ok(hist.moves.length >= 1, `${hist.handle} got a row for being displaced`);
    const m = hist.moves[0];
    assert.equal(m.cause, 'neighbor_shift', `${hist.handle} tagged as passive`);
    // Pushed down exactly one place by the single agent that passed them.
    assert.equal(m.direction, 'down');
    assert.equal(m.rank, m.previous_rank + 1);
    assert.equal(m.delta, -1);
    // Their own score did not move. That is the whole point of the distinction.
    assert.equal(m.previous_score, m.score, `${hist.handle} score unchanged`);
  }
});

test('every recorded move is stamped with the scoring model version', async () => {
  const hist = await agentService.getRankHistory(riser, { limit: 20 });
  for (const m of hist.moves) {
    assert.equal(
      m.model_version,
      trustScore.SCORING_MODEL_VERSION,
      'row attributable to a model version'
    );
  }
});

test('a scoring model change is tagged scoring_migration, not activity', async () => {
  // Simulate the model having moved underneath a stored score: mark the agent as
  // scored by an older version, with no new attestations. The next rescore is
  // then the ruler moving, not the runner.
  const mig = await makeAgent('ca-migrated', 6);
  await addVerified(mig, 7);

  const db = await getDb();
  // Rewind the stored model version AND nudge the stored score, so the rescore
  // both changes the score and moves the rank while the agent did nothing.
  await db.execute({
    sql: `UPDATE agents SET score_model_version = ?, score = ? WHERE id = ?`,
    args: [trustScore.SCORING_MODEL_VERSION - 1, 5, mig],
  });

  const before = await agentService.getRankHistory(mig, { limit: 50 });
  await agentService.recalcAgent(mig);
  const after = await agentService.getRankHistory(mig, { limit: 50 });

  assert.ok(after.moves.length > before.moves.length, 'the rescore moved its rank');
  assert.equal(after.moves[0].cause, 'scoring_migration', 'attributed to the model');
});

test('a fresh agent scoring for the first time is not called a migration', async () => {
  // score_model_version is NULL for an agent that has never been rescored.
  // Treating NULL as "old model" would mislabel ordinary first activity, so it
  // must not.
  const fresh = await makeAgent('ca-fresh', 7);
  await addVerified(fresh, 9);
  const hist = await agentService.getRankHistory(fresh, { limit: 20 });
  for (const m of hist.moves) {
    assert.notEqual(m.cause, 'scoring_migration', 'first scoring is not a migration');
  }
});

test('recalc stamps the current model version on the agent', async () => {
  const agent = await agentService.getAgent(riser);
  assert.equal(Number(agent.score_model_version), trustScore.SCORING_MODEL_VERSION);
});

test('movers defaults to activity, so passive movement cannot fake a climb', async () => {
  const out = cleanActivityFeed;
  assert.equal(out.cause, 'activity', 'default cause echoed');
  const handles = out.movers.map((m) => m.handle);
  assert.ok(handles.includes('ca-riser'), 'the real climber is listed');
  for (const h of ['ca-alpha', 'ca-bravo', 'ca-charlie', 'ca-delta']) {
    assert.ok(!handles.includes(h), `${h} is not presented as a mover`);
  }
});

test('movers can be asked for passive movement explicitly', async () => {
  const out = cleanShiftFeed;
  assert.equal(out.cause, 'neighbor_shift');
  const handles = out.movers.map((m) => m.handle);
  assert.ok(!handles.includes('ca-riser'), 'the earner is excluded here');
  assert.equal(handles.length, 4, 'exactly the four agents that were passed');
  for (const h of ['ca-alpha', 'ca-bravo', 'ca-charlie', 'ca-delta']) {
    assert.ok(handles.includes(h), `${h} listed as displaced`);
  }
  for (const m of out.movers) {
    assert.equal(m.direction, 'down');
    assert.equal(m.net_delta, -1, 'pushed down exactly one place');
  }
});

test('cause=all returns the raw ordering change', async () => {
  const out = await agentService.getTopMovers({
    direction: 'all',
    cause: 'all',
    windowHours: 24,
    limit: 50,
  });
  assert.equal(out.cause, 'all');
  const handles = out.movers.map((m) => m.handle);
  assert.ok(handles.includes('ca-riser'), 'earner present');
  assert.ok(handles.includes('ca-alpha'), 'displaced present');
});

test('an unknown cause falls back to activity rather than erroring', async () => {
  const out = await agentService.getTopMovers({ cause: 'nonsense; DROP TABLE agents' });
  assert.equal(out.cause, 'activity', 'unrecognised cause is not trusted');
  // The agents table is obviously still there.
  assert.ok(await agentService.getAgent(riser));
});

test('window-edge ranks are computed over the same cause subset as the delta', async () => {
  // from_rank/to_rank must describe the rows the delta was summed over,
  // otherwise the feed reports a span its own number cannot explain.
  for (const out of [cleanActivityFeed, cleanShiftFeed]) {
    for (const m of out.movers) {
      assert.equal(m.to_rank - m.from_rank, -m.net_delta, `${m.handle} span matches delta`);
    }
  }
});

test('GET /api/movers exposes and echoes ?cause', async () => {
  const res = await get('/api/movers?direction=all&cause=neighbor_shift&limit=50');
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.cause, 'neighbor_shift');
  assert.ok(body.movers.length >= 1);
  assert.ok(body.movers.every((m) => m.net_delta < 0));
});

test('GET /api/movers defaults to activity over HTTP too', async () => {
  const body = (await get('/api/movers?direction=all')).json();
  assert.equal(body.cause, 'activity');
  assert.ok(!body.movers.some((m) => m.handle === 'ca-alpha'));
});

test('GET rank history exposes cause and model_version', async () => {
  const body = (await get('/api/agents/ca-riser/rank/history')).json();
  assert.ok(body.moves.length >= 1);
  for (const m of body.moves) {
    assert.equal(m.cause, 'activity');
    assert.equal(m.model_version, trustScore.SCORING_MODEL_VERSION);
  }
});

test('SCORING_MODEL_VERSION is an exported positive integer', async () => {
  const v = trustScore.SCORING_MODEL_VERSION;
  assert.equal(typeof v, 'number');
  assert.ok(Number.isInteger(v) && v > 0, 'usable as an attribution stamp');
});

test('a huge reordering does not flood the log with passive rows', async () => {
  // A move big enough to displace more agents than the per-rescore cap is a bulk
  // reordering rather than a personal event for each agent involved. Without a
  // guard, one score update would write a row into dozens of agents' histories
  // and dominate the movement log.
  const db = await getDb();

  // Build a field far larger than the cap, all above the newcomer.
  const crowd = [];
  for (let i = 0; i < 40; i++) {
    const id = await makeAgent(`ca-crowd-${i}`, `crowd-${i}`);
    crowd.push(id);
    await addVerified(id, 3);
  }

  const sleeper = await makeAgent('ca-sleeper', 'sleeper');
  await addVerified(sleeper, 1); // lands at the bottom of the crowd

  const countShifts = async () =>
    Number(
      (
        await db.execute(
          `SELECT COUNT(*) c FROM rank_history WHERE cause = 'neighbor_shift'`
        )
      ).rows[0].c
    );

  const before = await countShifts();
  // One rescore that vaults it over the entire crowd in a single step.
  await addVerified(sleeper, 30);
  const after = await countShifts();

  const own = await agentService.getRankHistory(sleeper, { limit: 100 });
  assert.ok(own.moves.length >= 1, 'the mover itself is still recorded');
  assert.ok(
    after - before < 40,
    `bulk reorder wrote ${after - before} passive rows, expected the cap to bite`
  );
});
