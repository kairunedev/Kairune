'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { renderCardSvg } = require('../services/shareCard');

const sample = {
  handle: 'voyager-07',
  wallet: '0x71a2c4e83b90ff01a2b3c4d5e6f70819a2b39f0c',
  score: 830,
  tier: 3,
  label: 'TRUSTED',
  suggested_daily_ceiling: 500,
};

test('renders a 1200x630 svg', () => {
  const svg = renderCardSvg(sample, { attestations: 42 });
  assert.ok(svg.startsWith('<svg'), 'should be an SVG root');
  assert.ok(svg.includes('width="1200"'), 'width 1200');
  assert.ok(svg.includes('height="630"'), 'height 630');
  assert.ok(svg.trim().endsWith('</svg>'), 'closes svg tag');
});

test('includes the agent handle, score, tier label and stats', () => {
  const svg = renderCardSvg(sample, { attestations: 42 });
  assert.ok(svg.includes('voyager-07'), 'handle');
  assert.ok(svg.includes('>830<'), 'score');
  assert.ok(svg.includes('TRUSTED'), 'tier label');
  assert.ok(svg.includes('$500'), 'ceiling');
  assert.ok(svg.includes('>42<'), 'attestation count');
});

test('escapes XML-unsafe characters in the handle', () => {
  const svg = renderCardSvg(
    { ...sample, handle: 'evil<script>&"' },
    { attestations: 0 }
  );
  assert.ok(!svg.includes('<script>'), 'must not inject raw markup');
  assert.ok(svg.includes('&lt;script&gt;'), 'angle brackets escaped');
  assert.ok(svg.includes('&amp;'), 'ampersand escaped');
});

test('shortens a long wallet address', () => {
  const svg = renderCardSvg(sample, { attestations: 1 });
  assert.ok(svg.includes('0x71a2c4'), 'keeps the prefix');
  assert.ok(svg.includes('…'), 'uses an ellipsis');
  assert.ok(!svg.includes(sample.wallet), 'does not print the full wallet');
});

test('clamps out-of-range tier without throwing', () => {
  assert.doesNotThrow(() => renderCardSvg({ ...sample, tier: 99 }, {}));
  assert.doesNotThrow(() => renderCardSvg({ ...sample, tier: -3 }, {}));
});

test('handles missing optional fields gracefully', () => {
  const svg = renderCardSvg({ handle: 'bare', wallet: '', score: 0, tier: 0 }, {});
  assert.ok(svg.includes('bare'), 'handle rendered');
  assert.ok(svg.includes('UNRATED') || svg.includes('/ 1000'), 'renders defaults');
});
