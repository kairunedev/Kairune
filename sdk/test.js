const { Kairune, KairuneError } = require('./dist/index.js');

const adminKey = process.env.ADMIN_KEY || '';
const PASS = '\u2705', FAIL = '\u274C';
let pass = 0, fail = 0;
let k; // read-only client, bound to the resolved target below

function assert(name, cond, detail) {
  if (cond) { pass++; console.log(PASS, name); }
  else { fail++; console.log(FAIL, name, detail || ''); }
}

// Resolve the test target.
//  - Default: boot an ephemeral in-process server on an in-memory DB, so the
//    suite is hermetic — no network, and it never writes to production.
//  - Set KAIRUNE_URL to run against an external target (e.g. a prod smoke test).
async function resolveTarget() {
  const external = process.env.KAIRUNE_URL;
  if (external) {
    const base = external.replace(/\/+$/, '');
    // Skip cleanly if the external target is unreachable (offline / down).
    try {
      await fetch(base + '/api/stats', { signal: AbortSignal.timeout(4000) });
    } catch {
      console.log('# \u23ed  Skipping SDK integration tests (target unreachable): ' + base);
      process.exit(0);
    }
    return { base, server: null };
  }
  // Ephemeral local server. Configure the DB BEFORE requiring the app so the
  // db module resolves to the in-memory database on first use.
  process.env.DB_PATH = ':memory:';
  process.env.NODE_ENV = 'test';
  const app = require('../server');
  const { seed } = require('../src/db/seed');
  await seed();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { base: 'http://127.0.0.1:' + server.address().port, server };
}

(async () => {
  const { base, server } = await resolveTarget();
  k = new Kairune({ baseUrl: base });

  console.log('============================');
  console.log('@kairune/sdk v0.1.0 — FULL TEST');
  console.log('target: ' + base);
  console.log('============================\n');

  // --- READ ENDPOINTS ---

  // stats()
  try {
    const s = await k.stats();
    assert('stats() returns data', typeof s.total_agents === 'number' && s.total_agents > 0);
    assert('stats() has avg_score', typeof s.avg_score === 'number');
    assert('stats() has tier_distribution', Array.isArray(s.tier_distribution));
  } catch (e) { fail++; console.log(FAIL, 'stats() threw:', e.message); }

  // meta()
  try {
    const m = await k.meta();
    assert('meta() has kinds', Array.isArray(m.attestation_kinds) && m.attestation_kinds.length > 0);
    assert('meta() has 5 tiers', Array.isArray(m.tiers) && m.tiers.length === 5);
    assert('meta() has kind_weights', typeof m.kind_weights === 'object');
  } catch (e) { fail++; console.log(FAIL, 'meta() threw:', e.message); }

  // feed()
  try {
    const f = await k.feed(5);
    assert('feed() returns array', Array.isArray(f));
  } catch (e) { fail++; console.log(FAIL, 'feed() threw:', e.message); }

  // listAgents()
  try {
    const agents = await k.listAgents({ limit: 5 });
    assert('listAgents() returns array', Array.isArray(agents) && agents.length > 0);
    assert('listAgents()[0] has handle+score', !!agents[0].handle && typeof agents[0].score === 'number');
  } catch (e) { fail++; console.log(FAIL, 'listAgents() threw:', e.message); }

  // getAgent() by ID
  let testAgentId;
  try {
    const agents = await k.listAgents({ limit: 1 });
    testAgentId = agents[0].id;
    const agent = await k.getAgent(testAgentId);
    assert('getAgent(id) returns correct agent', agent.id === testAgentId);
    assert('getAgent() has score+tier', typeof agent.score === 'number' && typeof agent.tier === 'number');
  } catch (e) { fail++; console.log(FAIL, 'getAgent() threw:', e.message); }

  // getAttestations()
  try {
    const atts = await k.getAttestations(testAgentId);
    assert('getAttestations() returns array', Array.isArray(atts));
    if (atts.length > 0) {
      assert('attestation has kind+created_at', !!atts[0].kind && !!atts[0].created_at);
    }
  } catch (e) { fail++; console.log(FAIL, 'getAttestations() threw:', e.message); }

  // getPermissions()
  let testPermId;
  try {
    const perms = await k.getPermissions(testAgentId);
    assert('getPermissions() returns array', Array.isArray(perms));
    if (perms.length > 0) {
      testPermId = perms[0].id;
      assert('permission has ceiling+period', typeof perms[0].ceiling === 'number' && !!perms[0].period);
    }
  } catch (e) { fail++; console.log(FAIL, 'getPermissions() threw:', e.message); }

  // getBudget()
  if (testPermId) {
    try {
      const budget = await k.getBudget(testPermId);
      assert('getBudget() has ceiling', typeof budget.ceiling === 'number');
      assert('getBudget() has remaining', typeof budget.remaining === 'number');
      assert('getBudget() remaining <= ceiling', budget.remaining <= budget.ceiling);
    } catch (e) { fail++; console.log(FAIL, 'getBudget() threw:', e.message); }

    // getSpends()
    try {
      const spends = await k.getSpends(testPermId);
      assert('getSpends() returns array', Array.isArray(spends));
    } catch (e) { fail++; console.log(FAIL, 'getSpends() threw:', e.message); }
  }

  // --- ERROR HANDLING ---

  // getAgent with invalid ID
  try {
    await k.getAgent('nonexistent-agent-xyz-999');
    fail++; console.log(FAIL, 'getAgent(invalid) should have thrown');
  } catch (e) {
    assert('getAgent(invalid) throws KairuneError', e instanceof KairuneError);
    assert('KairuneError.status is 404', e.status === 404, 'got ' + e.status);
    assert('KairuneError.message is string', typeof e.message === 'string');
  }

  // registerAgent is public (self-register)
  try {
    const handle = 'sdk-test-' + Date.now();
    // Wallet must be a valid Robinhood Chain (EVM) address: 0x + 40 hex chars.
    const wallet = '0x' + Date.now().toString(16).padStart(40, '0').slice(-40);
    const created = await k.registerAgent({ handle, wallet });
    assert('registerAgent() returns id', !!created.id);
    assert('registerAgent() returns handle', created.handle === handle);
    // cleanup: delete with admin-key enabled client if available
    if (adminKey) {
      const ak = new Kairune({ adminKey, baseUrl: base });
      await ak.deleteAgent(created.id).catch(() => {});
    }
  } catch (e) {
    fail++; console.log(FAIL, 'registerAgent() threw unexpectedly:', e.message);
  }

  // getBudget with invalid permission ID
  try {
    await k.getBudget('fake-permission-id-000');
    fail++; console.log(FAIL, 'getBudget(invalid) should throw');
  } catch (e) {
    assert('getBudget(invalid) throws 404', e instanceof KairuneError && e.status === 404);
  }

  // spend() idempotency: reusing a key must not double-charge the budget.
  // Builds its own fixture (agent → attestations → permission) so it does not
  // depend on seed data. Admin writes are bypassed in the test-mode server.
  try {
    const agent = await k.registerAgent({
      handle: 'sdk-idem-' + Date.now(),
      wallet: '0x' + (Date.now().toString(16) + 'b'.repeat(40)).slice(-40),
    });
    // Lift the agent to a tier that can hold a spending permission.
    for (let i = 0; i < 30; i++) await k.attest(agent.id, { kind: 'task_completed' });
    const grant = await k.grantPermission(agent.id, { category: 'compute', ceiling: 100 });
    const pid = grant.permission.id;

    const key = 'idem-key-' + Date.now();
    const first = await k.spend(pid, { amount: 0.01, idempotencyKey: key });
    assert('spend() first charge approved', first.approved === true);
    if (first.approved) {
      const usedAfterFirst = first.budget.used;
      const replay = await k.spend(pid, { amount: 0.01, idempotencyKey: key });
      assert('spend() idempotent replay approved', replay.approved === true);
      assert('spend() idempotent replay flagged', replay.approved && replay.idempotent_replay === true);
      assert(
        'spend() idempotent replay returns same spend id',
        replay.approved && replay.spend.id === first.spend.id
      );
      assert(
        'spend() idempotent replay does not double-charge',
        replay.approved && replay.budget.used === usedAfterFirst
      );

      // previewSpend(): dry-run must not touch the budget and must agree with
      // the real decision. Reuse the same permission/fixture from above.
      const usedBeforePreview = replay.approved ? replay.budget.used : first.budget.used;

      const okPreview = await k.previewSpend(pid, { amount: 0.01 });
      assert('previewSpend() allows a fitting charge', okPreview.allowed === true);
      assert('previewSpend() allowed reason is null', okPreview.reason === null);
      assert(
        'previewSpend() does not consume budget',
        okPreview.budget.used === usedBeforePreview
      );

      const overPreview = await k.previewSpend(pid, { amount: 1000 });
      assert('previewSpend() blocks over-budget', overPreview.allowed === false);
      assert(
        'previewSpend() over-budget reason is ceiling_exceeded',
        overPreview.reason === 'ceiling_exceeded'
      );

      // A known idempotency key previews as an allowed replay, not a new charge.
      const replayPreview = await k.previewSpend(pid, { amount: 0.01, idempotencyKey: key });
      assert(
        'previewSpend() reports idempotent replay for a known key',
        replayPreview.allowed === true && replayPreview.idempotent_replay === true
      );
    }
    if (adminKey) {
      const ak = new Kairune({ adminKey, baseUrl: base });
      await ak.deleteAgent(agent.id).catch(() => {});
    }
  } catch (e) {
    fail++; console.log(FAIL, 'spend() idempotency threw unexpectedly:', e.message);
  }

  // --- WRITE ENDPOINTS (with admin key) ---
  if (process.env.ADMIN_KEY) {
    const kw = new Kairune({ adminKey: process.env.ADMIN_KEY, baseUrl: base });
    console.log('\n--- WRITE TESTS ---');

    try {
      const agents = await kw.listAgents({ limit: 1 });
      const perms = await kw.getPermissions(agents[0].id);
      const activePerm = perms.find(p => p.status === 'active');
      if (activePerm) {
        const r = await kw.spend(activePerm.id, { amount: 0.01, note: 'sdk-test' });
        assert('spend() returns approved field', 'approved' in r);
        if (r.approved) {
          assert('spend().budget.remaining is number', typeof r.budget.remaining === 'number');
        } else {
          assert('spend() blocked has error string', typeof r.error === 'string');
        }
      } else {
        console.log('  (no active perms to test spend against)');
      }
    } catch (e) { fail++; console.log(FAIL, 'spend() threw unexpectedly:', e.message); }
  } else {
    console.log('\n\u23ED  Skipping write tests (no ADMIN_KEY env)');
  }

  // --- SUMMARY ---
  console.log('\n============================');
  console.log(`RESULTS: ${pass} passed, ${fail} failed`);
  console.log('============================');
  if (server) server.close();
  if (fail > 0) process.exit(1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
