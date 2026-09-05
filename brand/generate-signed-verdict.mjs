// Kairune — "the go/no-go is signed" card (1600×900, 16:9).
// The counterparty verdict — the signal a buyer agent actually bets money on —
// is now returned signed, and verifiable by anyone through the public stateless
// endpoint. Every byte on this card is copied from a real production response
// (POST https://kairune.online/api/counterparty/check {sign:true}, 2026-09-05),
// including the signature and the key id. Nothing here is styled or invented.
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';

const C = {
  ink: '#0B0C0E', panel: '#121317', panel2: '#0F1013', line: '#23252A',
  text: '#F3F3F0', text2: '#A7ABB0', text3: '#6C7075',
  signal: '#D7FF3F', green: '#8FCB9F', amber: '#E3A467', red: '#E97366',
};
const MONO = 'DejaVu Sans Mono, monospace';
const SANS = 'DejaVu Sans, sans-serif';
const W = 1600, H = 900;
const pad = 96;

const ADV = 0.60205;
const monoW = (s, fs) => s.length * ADV * fs;

// Verbatim from production. The canonical string is the exact byte sequence the
// signature covers — fixed key order, so a verifier rebuilds it independently.
const CANONICAL =
  '{"counterparty_handle":"pilot-09","counterparty_wallet":"0xf0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3",' +
  '"issued_at":"2026-09-05T15:51:24.835Z","registered":true,"requested_amount":250,"score":600,' +
  '"suggested_max_amount":150,"tier":2,"verdict":"review"}';
const SIGNATURE = 'n/9atG5IT+LN4YdxU6jzyFTK+erMuII4R/kM0iDZTJp+qzzuRhwQK12Xymc1IiI62f90yDB8HKVME2TCdco+Dg==';
const KEY_ID = '4886580f-3dc4-4fe9-901a-c6cc2f31734d';

// Split the canonical bytes into fixed-width lines. Breaking mid-token is fine
// and honest: this is a byte string, not pretty-printed JSON.
const WRAP = 124;
const canonLines = [];
for (let i = 0; i < CANONICAL.length; i += WRAP) canonLines.push(CANONICAL.slice(i, i + WRAP));

// One verification outcome card. Three of these are the whole argument: the
// genuine verdict passes, it passes without the caller knowing modes exist, and
// the moment a signed field moves it stops passing.
function outcome(x, y, w, tag, result, col, sub) {
  const h = 196;
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${C.panel}"
      stroke="${C.line}" stroke-width="1" filter="url(#soft)"/>
    <text x="${x + 30}" y="${y + 42}" font-family="${MONO}" font-size="18"
      letter-spacing="2" fill="${C.text3}">${tag}</text>
    <text x="${x + 30}" y="${y + 118}" font-family="${MONO}" font-size="52"
      font-weight="700" fill="${col}">${result}</text>
    <text x="${x + 30}" y="${y + 162}" font-family="${MONO}" font-size="18"
      fill="${C.text2}">${sub}</text>
  `;
}

const CARD_W = 445, CARD_GAP = 36, ZA_W = W - pad * 2;

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.ink}"/><stop offset="1" stop-color="${C.panel2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.0" r="0.9">
      <stop offset="0" stop-color="${C.signal}" stop-opacity="0.09"/>
      <stop offset="1" stop-color="${C.signal}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="dots" width="34" height="34" patternUnits="userSpaceOnUse">
      <circle cx="1.5" cy="1.5" r="1.5" fill="#FFFFFF" fill-opacity="0.03"/>
    </pattern>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#dots)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- header -->
  <g>
    <circle cx="${pad + 6}" cy="108" r="6" fill="${C.signal}"/>
    <text x="${pad + 26}" y="116" font-family="${MONO}" font-size="21"
      letter-spacing="3" fill="${C.signal}">// THE VERDICT IS SIGNED</text>
  </g>
  <text x="${pad}" y="194" font-family="${SANS}" font-size="56" font-weight="800"
    fill="${C.text}">we sign the go/no-go. <tspan fill="${C.signal}">anyone can check.</tspan></text>

  <!-- the artifact: exact signed bytes -->
  <rect x="${pad}" y="242" width="${ZA_W}" height="272" rx="16" fill="${C.panel}"
    stroke="${C.line}" stroke-width="1" filter="url(#soft)"/>
  <text x="${pad + 32}" y="286" font-family="${MONO}" font-size="19"
    letter-spacing="2" fill="${C.text3}">SIGNED CANONICAL BYTES · ED25519 · KEY ${KEY_ID.slice(0, 8)}</text>

  ${canonLines.map((l, i) => `
    <text x="${pad + 32}" y="${332 + i * 30}" font-family="${MONO}" font-size="16"
      fill="${C.text}">${l}</text>`).join('')}

  <text x="${pad + 32}" y="${332 + canonLines.length * 30 + 22}" font-family="${MONO}"
    font-size="16" fill="${C.text3}">signature  <tspan fill="${C.signal}">${SIGNATURE}</tspan></text>
  <text x="${pad + 32}" y="${332 + canonLines.length * 30 + 56}" font-family="${MONO}"
    font-size="17" fill="${C.text2}">the prose explaining the verdict is deliberately NOT signed. the decision is.</text>

  <!-- what a third party gets when it checks -->
  ${outcome(pad, 548, CARD_W, 'THE GENUINE VERDICT', 'VERIFIED', C.green, 'mode: "verdict"')}
  ${outcome(pad + (CARD_W + CARD_GAP), 548, CARD_W, 'NO MODE FLAG SENT', 'VERIFIED', C.green, 'shape auto-detected')}
  ${outcome(pad + 2 * (CARD_W + CARD_GAP), 548, CARD_W, 'ONE FIELD MOVED', 'REJECTED', C.red, 'verdict → "proceed"')}

  <text x="${pad}" y="782" font-family="${MONO}" font-size="19" fill="${C.text2}">an ACP escrow keeper, the seller, an arbiter — <tspan fill="${C.text}">no SDK, no trust in us.</tspan></text>

  <!-- footer -->
  <line x1="${pad}" y1="806" x2="${W - pad}" y2="806" stroke="${C.line}" stroke-width="1"/>
  <text x="${pad}" y="856" font-family="${MONO}" font-size="26" font-weight="700"
    fill="${C.text}">KAIRUNE</text>
  <text x="${pad + 150}" y="856" font-family="${MONO}" font-size="21"
    fill="${C.signal}">the trust layer for agents that spend</text>
  <text x="${W - pad}" y="856" text-anchor="end" font-family="${MONO}"
    font-size="20" fill="${C.text2}">POST /api/verify {mode:"verdict"}</text>
</svg>`;

// Arithmetic layout validation — nothing may cross its container.
const sigLine = 'signature  ' + SIGNATURE;
const caption = 'the prose explaining the verdict is deliberately NOT signed. the decision is.';
const foot = 'an ACP escrow keeper, the seller, an arbiter — no SDK, no trust in us.';
const checks = [
  ['header tag', pad + 26 + monoW('// THE VERDICT IS SIGNED', 21), W - pad],
  // SANS bold at 56px runs wider than mono; approximate ~0.60em per glyph.
  ['headline', pad + 'we sign the go/no-go. anyone can check.'.length * 0.60 * 56, W - pad],
  ['panel tag', pad + 32 + monoW(`SIGNED CANONICAL BYTES · ED25519 · KEY ${KEY_ID.slice(0, 8)}`, 19), pad + ZA_W - 32],
  ['canonical line', pad + 32 + monoW(canonLines[0], 16), pad + ZA_W - 32],
  ['signature line', pad + 32 + monoW(sigLine, 16), pad + ZA_W - 32],
  ['panel caption', pad + 32 + monoW(caption, 17), pad + ZA_W - 32],
  ['canonical fits panel height', 332 + canonLines.length * 30 + 56, 242 + 272 - 8],
  ['card 3 right edge', pad + 2 * (CARD_W + CARD_GAP) + CARD_W, W - pad],
  ['card tag', 30 + monoW('THE GENUINE VERDICT', 18), CARD_W - 30],
  ['card sub', 30 + monoW('verdict → "proceed"', 18), CARD_W - 30],
  ['cards clear the footer line', 548 + 196, 782 - 20],
  ['footer note', pad + monoW(foot, 19), W - pad],
  ['footer tagline', pad + 150 + monoW('the trust layer for agents that spend', 21),
    W - pad - monoW('POST /api/verify {mode:"verdict"}', 20) - 24],
];
let bad = 0;
for (const [name, got, limit] of checks) {
  const ok = got <= limit;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${Math.round(got)} <= ${Math.round(limit)}`);
}
if (bad > 0) {
  console.error(`\n${bad} layout check(s) failed — fix before shipping.`);
  process.exit(1);
}

const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
writeFileSync(new URL('./kairune-signed-verdict.png', import.meta.url), png);
console.log('wrote brand/kairune-signed-verdict.png (' + Math.round(png.length / 1024) + ' KB)');
