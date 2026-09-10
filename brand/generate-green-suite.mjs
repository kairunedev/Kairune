// Kairune — "526 tests green. Three bugs were live." card (1600×900, 16:9 X-ready).
//
// The point of the image: a passing suite is evidence about the tests, not about
// production. Three real bugs shipped and stayed live behind a fully green run,
// and each one survived for a STRUCTURALLY DIFFERENT reason:
//
//   1. the test called the render helper directly and never the route
//   2. the wrong answer was a plausible one ($0 is a real ceiling at tier 0)
//   3. the test imported the build artifact, so a stale build passed itself
//
// None of the three is a missing assertion. Each is a test aimed one layer away
// from where the bug could live. That is the actual claim being made here.
//
// Every number on this card is measured, not illustrative:
//   - card.svg 500 introduced fc0b073 (2026-08-27), fixed 6011b8d (2026-09-10)
//   - sdk sign flag dropped d078268 (2026-09-05), fixed 940f69f (2026-09-10)
//   - suite went 509 -> 526 tests, 0 failures throughout
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

const LEFT_X = pad;
const LEFT_W = 860;
const IN_X = LEFT_X + 36;
const IN_W = LEFT_W - 72;

const RIGHT_X = pad + 896;
const RIGHT_W = W - pad - RIGHT_X;

// One shipped bug: the surface it broke, how long it was live, the symptom, and
// the reason a green suite could not see it. The last line is the load-bearing
// one — without it this is just a bug list.
function bugRow(y, surface, badge, symptom, blindspot, accent) {
  return `
    <g transform="translate(0,${y})">
      <text x="0" y="0" font-family="${MONO}" font-size="22" fill="${C.text}">${surface}</text>
      <text x="${IN_W}" y="0" text-anchor="end" font-family="${MONO}" font-size="18" font-weight="700" fill="${accent}">${badge}</text>
      <text x="0" y="32" font-family="${MONO}" font-size="20" fill="${accent}">${symptom}</text>
      <text x="0" y="58" font-family="${MONO}" font-size="18" fill="${C.text3}">${blindspot}</text>
    </g>
  `;
}

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.ink}"/><stop offset="1" stop-color="${C.panel2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.0" r="0.9">
      <stop offset="0" stop-color="${C.signal}" stop-opacity="0.10"/>
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
  <rect x="0" y="0" width="${W}" height="6" fill="${C.signal}"/>

  <!-- header -->
  <circle cx="${pad + 6}" cy="112" r="6" fill="${C.signal}"/>
  <text x="${pad + 26}" y="120" font-family="${MONO}" font-size="21" fill="${C.text3}" letter-spacing="2">// POSTMORTEM — WHAT A GREEN SUITE DID NOT SEE</text>
  <text x="${pad}" y="196" font-family="${SANS}" font-size="62" font-weight="800" fill="${C.text}">526 tests green. Three bugs were live.</text>
  <text x="${pad}" y="246" font-family="${MONO}" font-size="24" fill="${C.text2}">Not one missing assertion. Three tests aimed one layer away from the bug.</text>
  <text x="${W - pad}" y="120" text-anchor="end" font-family="${MONO}" font-size="19" fill="${C.text3}">measured from git history · not illustrative</text>

  <!-- LEFT: the three bugs, and why each was invisible -->
  <rect x="${LEFT_X}" y="300" width="${LEFT_W}" height="460" rx="18" fill="${C.panel2}" stroke="${C.line}" stroke-width="1" filter="url(#soft)"/>
  <text x="${IN_X}" y="346" font-family="${MONO}" font-size="19" fill="${C.signal}">shipped, live, and passing CI</text>
  <line x1="${IN_X}" y1="366" x2="${IN_X + IN_W}" y2="366" stroke="${C.line}" stroke-width="1"/>
  <g transform="translate(${IN_X},412)">
    ${bugRow(0, 'GET /a/:handle/card.svg', '500 · 14 DAYS', 'ReferenceError: atts is not defined', 'the test called renderCardSvg(), never the route', C.red)}
    ${bugRow(124, 'GET /a/:handle/card.png', 'og:image · WRONG NUMBER', 'published $0/day to every social unfurl', '$0 is a real ceiling at tier 0 — a plausible wrong answer', C.amber)}
    ${bugRow(248, 'sdk checkCounterparty({sign:true})', 'SILENT · 5 DAYS', 'the sign flag never reached the API', 'the test imported dist/, so a stale build passed itself', C.signal)}
  </g>

  <!-- RIGHT: the structural gap, not the individual fixes -->
  <rect x="${RIGHT_X}" y="300" width="${RIGHT_W}" height="460" rx="18" fill="${C.panel}" stroke="${C.line}" stroke-width="1" filter="url(#soft)"/>
  <text x="${RIGHT_X + 36}" y="346" font-family="${MONO}" font-size="19" fill="${C.signal}">what actually closed them</text>
  <line x1="${RIGHT_X + 36}" y1="366" x2="${W - pad - 36}" y2="366" stroke="${C.line}" stroke-width="1"/>

  <text x="${RIGHT_X + 36}" y="412" font-family="${MONO}" font-size="21" fill="${C.text}">route-level tests</text>
  <text x="${RIGHT_X + 36}" y="438" font-family="${MONO}" font-size="18" fill="${C.text3}">call the handler, not the helper</text>

  <text x="${RIGHT_X + 36}" y="492" font-family="${MONO}" font-size="21" fill="${C.text}">build-artifact tests</text>
  <text x="${RIGHT_X + 36}" y="518" font-family="${MONO}" font-size="18" fill="${C.text3}">a committed dist is untrusted input</text>

  <text x="${RIGHT_X + 36}" y="572" font-family="${MONO}" font-size="21" fill="${C.text}">a route sweeper</text>
  <text x="${RIGHT_X + 36}" y="598" font-family="${MONO}" font-size="18" fill="${C.text3}">GET every registered route, every run</text>

  <line x1="${RIGHT_X + 36}" y1="640" x2="${W - pad - 36}" y2="640" stroke="${C.line}" stroke-width="1"/>
  <text x="${RIGHT_X + 36}" y="684" font-family="${MONO}" font-size="19" fill="${C.text3}">every guard verified negatively:</text>
  <text x="${RIGHT_X + 36}" y="712" font-family="${MONO}" font-size="19" fill="${C.text3}">reintroduce the bug, watch it fail</text>

  <!-- footer -->
  <line x1="${pad}" y1="800" x2="${W - pad}" y2="800" stroke="${C.line}" stroke-width="1"/>
  <text x="${pad}" y="852" font-family="${MONO}" font-size="26" font-weight="700" fill="${C.text}">KAIRUNE</text>
  <text x="${pad + 150}" y="852" font-family="${MONO}" font-size="21" fill="${C.signal}">the trust layer for agents that spend</text>
  <text x="${W - pad}" y="852" text-anchor="end" font-family="${MONO}" font-size="20" fill="${C.text2}">kairune.online</text>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
writeFileSync(new URL('./kairune-green-suite.png', import.meta.url), png);
console.log('wrote brand/kairune-green-suite.png (' + Math.round(png.length / 1024) + ' KB)');
