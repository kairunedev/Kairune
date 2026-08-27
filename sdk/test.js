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

      // Spend receipts: an approved charge carries a signature, and its public
      // receipt verifies against the platform key.
      assert(
        'spend() result carries a receipt signature',
        typeof first.spend.receipt_signature === 'string' && first.spend.receipt_signature.length > 0
      );
      const receipt = await k.getReceipt(first.spend.id);
      assert('getReceipt() signed + verified', receipt.signed === true && receipt.verified === true);
      assert('getReceipt() algorithm is ed25519', receipt.algorithm === 'ed25519');
      assert('getReceipt() fields match the charge', receipt.fields.amount === 0.01 && receipt.fields.spend_id === first.spend.id);
      assert('getReceipt() includes the public key', typeof receipt.public_key === 'string' && receipt.public_key.includes('PUBLIC KEY'));
      assert('getReceipt() includes the canonical payload', typeof receipt.canonical === 'string');

      // The replay returns the SAME receipt (never re-signed).
      if (replay.approved) {
        assert(
          'spend() replay carries the original receipt',
          replay.spend.receipt_signature === first.spend.receipt_signature
        );
      }

      // Platform key endpoint: the current receipt-signing public key.
      const pk = await k.getPlatformKey();
      assert('getPlatformKey() is ed25519 for receipts', pk.algorithm === 'ed25519' && pk.purpose === 'receipt');
      assert('getPlatformKey() matches the receipt key', pk.public_key === receipt.public_key);

      // Unknown spend → 404.
      try {
        await k.getReceipt('no-such-spend');
        fail++; console.log(FAIL, 'getReceipt(invalid) should throw');
      } catch (e) {
        assert('getReceipt(invalid) throws 404', e instanceof KairuneError && e.status === 404);
      }
    }

    // velocity (burst) limit: a grant can add a max-spend-per-window cap on top
    // of the period ceiling. Build a fresh fixture with a small burst cap and a
    // large ceiling so only the velocity guard can trip.
    const vAgent = await k.registerAgent({
      handle: 'sdk-vel-' + Date.now(),
      wallet: '0x' + (Date.now().toString(16) + 'c'.repeat(40)).slice(-40),
    });
    for (let i = 0; i < 30; i++) await k.attest(vAgent.id, { kind: 'task_completed' });
    const vGrant = await k.grantPermission(vAgent.id, {
      category: 'compute',
      ceiling: 100000,
      velocity_limit: 30,
      velocity_window_s: 60,
    });
    assert('grantPermission() echoes velocity_limit', vGrant.permission.velocity_limit === 30);
    assert('grantPermission() echoes velocity_window_s', vGrant.permission.velocity_window_s === 60);
    const vpid = vGrant.permission.id;

    const vFirst = await k.spend(vpid, { amount: 20 });
    assert('spend() within burst cap approved', vFirst.approved === true);

    // 20 → 35 within 60s exceeds the 30 cap → blocked (SpendBlocked, not thrown).
    const vBurst = await k.spend(vpid, { amount: 15 });
    assert('spend() over burst cap is blocked', vBurst.approved === false);

    // preview agrees: same inputs would be blocked with velocity_exceeded.
    const vPreview = await k.previewSpend(vpid, { amount: 15 });
    assert('previewSpend() flags velocity_exceeded', vPreview.allowed === false && vPreview.reason === 'velocity_exceeded');
    assert('preview budget exposes velocity_limit', vPreview.budget.velocity_limit === 30);

    // --- SPEND REPORTING ---
    // The velocity fixture above landed exactly one approved charge of 20 on
    // vpid, so its totals are known and can be asserted exactly.
    const agentSpends = await k.getAgentSpends(vAgent.id);
    assert('getAgentSpends() returns array', Array.isArray(agentSpends));
    assert('getAgentSpends() merges the charge', agentSpends.length === 1 && agentSpends[0].amount === 20);
    assert('getAgentSpends() row carries the grant category', agentSpends[0].category === 'compute');

    const page = await k.getAgentSpendPage(vAgent.id, { limit: 1 });
    assert('getAgentSpendPage() echoes paging', page.paging.limit === 1 && page.paging.returned === 1);

    const scoped = await k.getAgentSpends(vAgent.id, { permission_id: vpid });
    assert('getAgentSpends() filters by permission_id', scoped.length === 1);

    const summary = await k.getSpendSummary(vAgent.id);
    assert('getSpendSummary() totals the agent', summary.total === 20 && summary.count === 1);
    assert('getSpendSummary() rolls up by permission', summary.by_permission.length === 1 && summary.by_permission[0].permission_id === vpid);
    assert('getSpendSummary() rolls up by category', summary.by_category.length === 1 && summary.by_category[0].category === 'compute');
    assert('getSpendSummary() names the agent', summary.handle === vAgent.handle);

    // A window that ends before the charge must report zero — proving the
    // filter is applied and not silently dropped.
    const empty = await k.getSpendSummary(vAgent.id, { since: '2020-01-01', until: '2020-02-01' });
    assert('getSpendSummary() honours the window', empty.total === 0 && empty.count === 0);

    // A malformed date is a 400, never a filter that quietly matches everything.
    try {
      await k.getSpendSummary(vAgent.id, { since: 'not-a-date' });
      fail++; console.log(FAIL, 'getSpendSummary(bad date) should throw');
    } catch (e) {
      assert('getSpendSummary(bad date) throws 400', e instanceof KairuneError && e.status === 400);
    }

    // The per-permission history keeps its old call shape (a bare page size)
    // while also accepting the new filter object.
    const legacy = await k.getSpends(vpid, 10);
    assert('getSpends(number) still works', Array.isArray(legacy) && legacy.length === 1);
    const filtered = await k.getSpends(vpid, { limit: 10, since: '2020-01-01', until: '2020-02-01' });
    assert('getSpends(query) applies filters', filtered.length === 0);
    const spendPage = await k.getSpendPage(vpid, { limit: 5 });
    assert('getSpendPage() echoes paging', spendPage.paging.limit === 5 && spendPage.paging.returned === 1);

    if (adminKey) {
      const ak = new Kairune({ adminKey, baseUrl: base });
      await ak.deleteAgent(agent.id).catch(() => {});
      await ak.deleteAgent(vAgent.id).catch(() => {});
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
