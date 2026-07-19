'use strict';

// Tests for the embeddable trust badge: SVG renderer + HTTP route.
// In-memory DB so the route can resolve (or 404) an agent.

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { renderBadgeSvg } = require('../services/shareCard');
const app = require('../../server');

let server;
let base;

function get(path) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: data })
      );
    });
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ---- renderer unit tests -------------------------------------------------

test('renderBadgeSvg produces valid SVG with score and tier label', () => {
  const svg = renderBadgeSvg({ handle: 'voyager-07', score: 379, tier: 1, label: 'EMERGING' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /379 · EMERGING/);
  assert.match(svg, /kairune trust/);
  // Has a width/height so it embeds at a sensible size.
  assert.match(svg, /height="20"/);
  assert.match(svg, /width="\d+"/);
});

test('renderBadgeSvg clamps out-of-range tiers and defaults label', () => {
  const svg = renderBadgeSvg({ score: 999, tier: 99 });
  // Tier clamps to 4 (PRIME uses the signal colour) and label defaults to UNRATED.
  assert.match(svg, /999 · UNRATED/);
  assert.match(svg, /#D7FF3F/); // signal colour for clamped-high tier
});

test('renderBadgeSvg escapes and uppercases the label', () => {
  const svg = renderBadgeSvg({ score: 0, tier: 0, label: 'trusted' });
  assert.match(svg, /0 · TRUSTED/);
});

// ---- route integration tests --------------------------------------------

test('GET /a/:handle/badge.svg returns an SVG for an unknown agent (UNRATED)', async () => {
  const res = await get('/a/does-not-exist/badge.svg');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/svg\+xml/);
  assert.match(res.body, /kairune trust/);
  assert.match(res.body, /0 · UNRATED/);
  // Badges are hotlinked cross-origin from READMEs, so CORS must be open.
  assert.equal(res.headers['access-control-allow-origin'], '*');
});
