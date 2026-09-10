'use strict';

// Route-level tests for the two share-card endpoints. Both were broken in
// production for two weeks with zero test failures.
//
// 1. `/a/:handle/card.svg` returned 500 on every request. `fc0b073` removed the
//    `recalcAgent` call from the image handlers and took the `const atts = ...`
//    line with it in the SVG branch, leaving `atts` referenced but never
//    declared — a ReferenceError on the happy path. The PNG branch kept its copy
//    of the line, so the two handlers diverged silently.
//
// 2. `/a/:handle/card.png` rendered "$0/day". `getAgent()` does not carry
//    `suggested_daily_ceiling` — it is derived from the score — and the PNG
//    handler never supplied it. card.png is what the OG tags point at, so that
//    zero is the number every social unfurl displayed.
//
// `shareCard.test.js` already covers `renderCardSvg` as a pure function, and it
// passed throughout both bugs: it calls the renderer directly with a fixture
// that already includes the ceiling, so it can neither see a handler that throws
// nor a handler that forgets an argument. These tests drive the HTTP routes.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const agentService = require('../services/agentService');
const attestationService = require('../services/attestationService');
const trustScore = require('../services/trustScore');
const { renderCardSvg } = require('../services/shareCard');
const app = require('../../server');

// Pull the ceiling back out of the rendered SVG: `>$50<tspan ...`.
const CEILING_RE = />\$(\d+)<tspan/;
const SERVER_JS = path.join(__dirname, '..', '..', 'server.js');

let server;
let base;
let handle;
let agent;

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get(base + urlPath, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            type: res.headers['content-type'] || '',
            buf,
            text: buf.toString('utf8'),
          });
        });
      })
      .on('error', reject);
  });
}

before(async () => {
  server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = 'http://127.0.0.1:' + server.address().port;

  // Own fixture rather than seed data: the card must show a non-zero ceiling for
  // the ceiling assertions to mean anything, and a sha256-derived wallet keeps
  // the agent clear of DEMO_EXCLUSION_SQL.
  const wallet =
    '0x' + crypto.createHash('sha256').update('kairune-sharecard-route').digest('hex').slice(0, 40);
  const created = await agentService.createAgent({
    handle: 'card-route-01',
    wallet,
    operator: 'Fixture Labs',
  });
  // Distinct issuers per attestation — the per-issuer volume cap otherwise keeps
  // the score down. 16 verified payments lands around 320, comfortably inside
  // tier 1; tier 0's ceiling is legitimately $0, which would make the ceiling
  // assertions below vacuous.
  for (let i = 0; i < 16; i++) {
    await attestationService.addAttestation(created.id, {
      kind: 'clean_payment',
      amount: 500,
      issuer_id: `card-iss-${i}`,
      verification_status: 'verified',
    });
  }
  await agentService.recalcAgent(created.id);
  agent = await agentService.getAgent(created.id);
  handle = agent.handle;

  assert.ok(
    trustScore.suggestedDailyCeiling(agent.score) > 0,
    'fixture must earn a non-zero ceiling or the ceiling assertions prove nothing'
  );
});

after(() => {
  if (server) server.close();
});

test('GET /a/:handle/card.svg renders instead of throwing', async () => {
  const res = await get(`/a/${handle}/card.svg`);
  assert.strictEqual(res.status, 200, 'card.svg must not 500 — it is the share image');
  assert.match(res.type, /image\/svg\+xml/);
  assert.match(res.text, /^<svg/);
});

test('GET /a/:handle/card.png returns a real 1200x630 PNG', async () => {
  const res = await get(`/a/${handle}/card.png`);
  assert.strictEqual(res.status, 200);
  assert.match(res.type, /image\/png/);
  assert.strictEqual(res.buf.slice(1, 4).toString(), 'PNG', 'not a PNG payload');
  assert.strictEqual(res.buf.readUInt32BE(16), 1200);
  assert.strictEqual(res.buf.readUInt32BE(20), 630);
});

test('the share card publishes the real suggested ceiling, not zero', async () => {
  const expected = trustScore.suggestedDailyCeiling(agent.score);
  const res = await get(`/a/${handle}/card.svg`);
  const rendered = (CEILING_RE.exec(res.text) || [])[1];
  assert.strictEqual(
    Number(rendered),
    expected,
    `card.svg published $${rendered}/day but score ${agent.score} implies $${expected}/day`
  );
});

test('omitting the ceiling silently renders $0, so handlers must pass it', () => {
  // The trap behind bug 2: a missing field is not a render error. Pinning this
  // makes the handler's obligation explicit rather than assumed.
  const label = trustScore.labelFor(agent.score) || 'UNRATED';
  const omitted = renderCardSvg({ ...agent, label }, { attestations: 0 });
  const supplied = renderCardSvg(
    { ...agent, label, suggested_daily_ceiling: trustScore.suggestedDailyCeiling(agent.score) },
    { attestations: 0 }
  );
  assert.strictEqual((CEILING_RE.exec(omitted) || [])[1], '0');
  assert.strictEqual(
    Number((CEILING_RE.exec(supplied) || [])[1]),
    trustScore.suggestedDailyCeiling(agent.score)
  );
});

test('card.svg does not match the zero-ceiling render', async () => {
  // Route-level regression for bug 2: if the handler stops passing the ceiling,
  // the response becomes identical to this.
  const label = trustScore.labelFor(agent.score) || 'UNRATED';
  const zeroed = renderCardSvg({ ...agent, label }, { attestations: 0 });
  const res = await get(`/a/${handle}/card.svg`);
  assert.notStrictEqual(res.text, zeroed, 'the ceiling is not reaching the renderer');
});


test('the card reports the agent attestation count', async () => {
  // `atts` existed to feed this stat. When its declaration was deleted the route
  // 500'd — meaning nothing was asserting the count was ever published.
  const atts = await attestationService.listAttestations(agent.id, { limit: 200 });
  const res = await get(`/a/${handle}/card.svg`);
  assert.match(res.text, new RegExp('>' + atts.length + '<'), 'attestation count missing');
});

test('an unknown handle 404s with a card rather than erroring', async () => {
  const res = await get('/a/definitely-not-a-real-agent-xyz/card.svg');
  assert.strictEqual(res.status, 404);
  assert.match(res.text, /NOT FOUND/);
});

test('every renderCardSvg call site supplies suggested_daily_ceiling', () => {
  // Static guard covering branches the runtime tests cannot reach: the 404
  // fallbacks, and card.png. Bug 2 was exactly one call site missing one field.
  //
  // This is the ONLY test that catches bug 2 in the PNG handler. card.png is a
  // raster, so the rendered number cannot be read back out of the response, and
  // server.js keeps its rasteriser (svgToPng) private — so the PNG cannot be
  // compared byte-for-byte against a locally rendered reference either. Verified
  // negatively: reintroducing bug 2 in the card.png handler fails this test and
  // this test alone. If this guard is ever loosened, bug 2 becomes invisible
  // again in exactly the place it mattered most (card.png is the og:image).
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const marker = 'renderCardSvg(';
  const sites = [];
  for (let i = src.indexOf(marker); i !== -1; i = src.indexOf(marker, i + 1)) {
    // Walk to the matching close paren so nested parens don't truncate the slice.
    let depth = 0;
    let j = i + marker.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    sites.push(src.slice(i, j + 1));
  }

  assert.ok(
    sites.length >= 4,
    `expected at least 4 renderCardSvg call sites, found ${sites.length}`
  );
  const missing = sites.filter((s) => !s.includes('suggested_daily_ceiling'));
  assert.deepStrictEqual(
    missing,
    [],
    'a renderCardSvg call omits suggested_daily_ceiling and would render $0/day'
  );
});

test('server.js declares the attestation list wherever it reads it', () => {
  // Bug 1 was a ReferenceError: `atts` used, never declared, inside one handler.
  // Each declaration is legitimately read twice (the length, plus the null
  // guard), so more reads than that means a block is borrowing a name it does
  // not own.
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const uses = (src.match(/\batts\b/g) || []).length;
  const declares = (src.match(/const atts\b/g) || []).length;
  assert.ok(declares > 0, 'no `const atts` declaration found — was the variable renamed?');
  assert.ok(
    uses <= declares * 3,
    `\`atts\` is read ${uses} times but declared only ${declares} times — a handler may reference it without declaring it`
  );
});
