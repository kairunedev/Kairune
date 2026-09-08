// Kairune — "Movement is now on the record" card (1600×900, 16:9 X-ready).
//
// The point of the image: rank used to be computed live and forgotten. Now
// every position change is persisted, so there is a movers feed AND a share
// card whose numbers come from a stored row — a screenshot cannot be inflated.
//
// Left panel  = the movers feed (GET /api/movers), the "who's climbing" board.
// Right panel = the share card (GET /a/:handle/move.svg), the brag artifact.
//
// Numbers here are illustrative sample data for the design, not a claim about
// the live board — the real feed only fills in as agents actually move.
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

// One row of the movers feed: handle, the #from -> #to move, and the delta.
// `up` decides the colour and the sign — a climb is a smaller rank number.
function moverRow(y, handle, from, to, up) {
  const accent = up ? C.signal : C.red;
  const delta = Math.abs(from - to);
  const sign = up ? '+' : '-';
  const arrow = up ? '▲' : '▼';
  return `
    <g transform="translate(0,${y})">
      <text x="0" y="0" font-family="${MONO}" font-size="25" fill="${C.text}">${handle}</text>
      <text x="330" y="0" font-family="${MONO}" font-size="25" fill="${C.text3}">#${from}</text>
      <text x="392" y="0" font-family="${SANS}" font-size="24" font-weight="800" fill="${accent}">→</text>
      <text x="430" y="0" font-family="${MONO}" font-size="25" font-weight="700" fill="${C.text}">#${to}</text>
      <text x="530" y="0" font-family="${MONO}" font-size="25" font-weight="700" fill="${accent}">${arrow} ${sign}${delta}</text>
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
  <text x="${pad + 26}" y="120" font-family="${MONO}" font-size="21" fill="${C.text3}" letter-spacing="2">// NEW — RANK MOVEMENT</text>
  <text x="${pad}" y="196" font-family="${SANS}" font-size="62" font-weight="800" fill="${C.text}">Movement is now on the record.</text>
  <text x="${pad}" y="246" font-family="${MONO}" font-size="24" fill="${C.text2}">Rank was computed live and forgotten. Every position change is now stored.</text>
  <text x="${W - pad}" y="120" text-anchor="end" font-family="${MONO}" font-size="19" fill="${C.text3}">sample data · the live feed fills in as agents move</text>

  <!-- LEFT: the movers feed -->
  <rect x="${pad}" y="300" width="720" height="430" rx="18" fill="${C.panel2}" stroke="${C.line}" stroke-width="1" filter="url(#soft)"/>
  <text x="${pad + 36}" y="346" font-family="${MONO}" font-size="19" fill="${C.signal}">GET /api/movers?window=24</text>
  <line x1="${pad + 36}" y1="366" x2="${pad + 684}" y2="366" stroke="${C.line}" stroke-width="1"/>
  <g transform="translate(${pad + 36},400)" font-family="${MONO}">
    <text x="0" y="0" font-size="17" fill="${C.text3}" letter-spacing="1">AGENT</text>
    <text x="330" y="0" font-size="17" fill="${C.text3}" letter-spacing="1">MOVE</text>
    <text x="530" y="0" font-size="17" fill="${C.text3}" letter-spacing="1">NET</text>
  </g>
  <g transform="translate(${pad + 36},452)">
    ${moverRow(0, 'agent-one', 12, 4, true)}
    ${moverRow(48, 'agent-two', 19, 11, true)}
    ${moverRow(96, 'agent-three', 8, 5, true)}
    ${moverRow(144, 'agent-four', 6, 9, false)}
    ${moverRow(192, 'agent-five', 21, 24, false)}
  </g>
  <text x="${pad + 36}" y="706" font-family="${MONO}" font-size="18" fill="${C.text3}">net movement per window · climb then slip cancels out</text>

  <!-- RIGHT: the share card -->
  <rect x="${pad + 764}" y="300" width="${W - pad * 2 - 764}" height="430" rx="18" fill="${C.panel}" stroke="${C.line}" stroke-width="1" filter="url(#soft)"/>
  <text x="${pad + 800}" y="346" font-family="${MONO}" font-size="19" fill="${C.signal}">GET /a/agent-one/move.svg</text>
  <line x1="${pad + 800}" y1="366" x2="${W - pad - 36}" y2="366" stroke="${C.line}" stroke-width="1"/>

  <text x="${pad + 800}" y="428" font-family="${SANS}" font-size="34" font-weight="700" fill="${C.text}">agent-one</text>
  <text x="${pad + 800}" y="472" font-family="${MONO}" font-size="24" font-weight="700" letter-spacing="3" fill="${C.signal}">▲ CLIMBED</text>

  <g transform="translate(${pad + 800},580)" font-family="${MONO}">
    <text x="0" y="0" font-size="82" font-weight="800" fill="${C.text3}">#12</text>
    <text x="158" y="-8" font-family="${SANS}" font-size="58" font-weight="800" fill="${C.signal}">→</text>
    <text x="232" y="0" font-size="82" font-weight="800" fill="${C.text}">#4</text>
  </g>
  <text x="${pad + 800}" y="626" font-family="${MONO}" font-size="24" fill="${C.text2}">+8 places  ·  of 142</text>

  <line x1="${pad + 800}" y1="660" x2="${W - pad - 36}" y2="660" stroke="${C.line}" stroke-width="1"/>
  <text x="${pad + 800}" y="700" font-family="${MONO}" font-size="20" fill="${C.text3}">read from a stored row — not a screenshot claim</text>

  <!-- footer -->
  <line x1="${pad}" y1="800" x2="${W - pad}" y2="800" stroke="${C.line}" stroke-width="1"/>
  <text x="${pad}" y="852" font-family="${MONO}" font-size="26" font-weight="700" fill="${C.text}">KAIRUNE</text>
  <text x="${pad + 150}" y="852" font-family="${MONO}" font-size="21" fill="${C.signal}">the trust layer for agents that spend</text>
  <text x="${W - pad}" y="852" text-anchor="end" font-family="${MONO}" font-size="20" fill="${C.text2}">kairune.online/leaderboard</text>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
writeFileSync(new URL('./kairune-movers.png', import.meta.url), png);
console.log('wrote brand/kairune-movers.png (' + Math.round(png.length / 1024) + ' KB)');
