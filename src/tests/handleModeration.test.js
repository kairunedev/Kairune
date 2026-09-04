'use strict';

// Tests for assertValidHandle's profanity gate.
//
// A handle is a public identifier: it renders on the leaderboard, in share
// cards, and in any counterparty check another agent runs. A slur got
// registered and sat on the public registry, so the gate is checked at
// registration time rather than moderated away afterwards.

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');

const { assertValidHandle, containsProfanity } = require('../middleware/moderation');

/** Assert that a handle is refused with a 400. Returns the thrown error. */
function assertRefused(handle) {
  let err = null;
  try {
    assertValidHandle(handle);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `handle ${JSON.stringify(handle)} should have been refused`);
  assert.strictEqual(err.status, 400, 'refusal must carry status 400');
  return err;
}

test('slurs are refused outright', () => {
  // The exact handle that reached production, plus other unambiguous slurs.
  for (const handle of ['nigger', 'faggot', 'chink', 'kike', 'tranny', 'retard']) {
    const err = assertRefused(handle);
    assert.match(err.message, /prohibited language/i);
  }
});

test('slurs are refused as substrings, not just exact matches', () => {
  // An exact-match deny-list is trivially bypassed by padding.
  for (const handle of ['xniggerx', 'my-faggot-bot', 'agent-chink-01', 'theshitbot']) {
    assertRefused(handle);
  }
});

test('leet-speak and separator evasion is folded before matching', () => {
  for (const handle of ['n1gg3r', 'f4gg0t', 'n_i-g-g-e-r', 'sh1t-bot', 'f-u-c-k']) {
    assertRefused(handle);
  }
});

test('short ambiguous words are refused only as whole tokens', () => {
  // Bare, or delimited by a separator or a digit run.
  for (const handle of ['cock-bot', 'dick_01', 'agent-ass-99', 'nazi-coin', 'a-cunt-bot']) {
    assertRefused(handle);
  }
});

test('legitimate handles are still accepted (no Scunthorpe problem)', () => {
  // A naive substring list refuses real names. These must all pass.
  const ok = [
    'skybridge', 'helios-labs', 'meshworks', 'northwind', 'driftless',
    'voyager-07', 'relay-02', 'scout-14', 'nomad-31', 'analyst_9',
    'assembly-bot', 'classic-agent', 'shipping-co',
    'cockpit-ai', 'dickinson', 'scunthorpe', 'penistone', 'analytics',
    'class-act', 'massive-ai', 'assembly', 'bitcoin-bot', 'titanic',
  ];
  for (const handle of ok) {
    assert.strictEqual(
      assertValidHandle(handle),
      handle,
      `handle ${handle} should be accepted`
    );
  }
});

test('containsProfanity is exported and case-insensitive', () => {
  assert.strictEqual(containsProfanity('NIGGER'), true);
  assert.strictEqual(containsProfanity('Skybridge'), false);
  assert.strictEqual(containsProfanity(''), false);
});

test('the existing handle rules still hold', () => {
  assertRefused('ab');                   // too short
  assertRefused('a'.repeat(33));         // too long
  assertRefused('12345');                // all digits
  assertRefused('-leading-dash');        // must start alphanumeric
  assertRefused('has space');            // invalid character
  assertRefused('admin');                // reserved
  assertRefused('demo-thing');           // reserved prefix
  assertRefused('try-thing');            // gated prefix (not allowed by default)
});
