// Kairune — "Same +8. Three different reasons." card (1600×900, 16:9 X-ready).
//
// The point of the image: a rank is a position in a shared ordering, so the same
// delta can mean completely different things. An agent can climb because it
// earned it, because a neighbour moved and displaced it, or because someone
// edited a weight in the scoring function. A movement log that stores only the
// delta presents all three identically — and the flattering reading wins.
//
// Left panel  = three rows with the SAME +8, separated by cause.
// Right panel = what the feed does with that: activity is the default, passive
//               movement is recorded but not sold as achievement.
//
// Handles and numbers are illustrative sample data for the design, not a claim
// about the live board.
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

// One attributed move: the same delta every time, with the cause spelled out.
// The colour carries the meaning — signal for earned, amber for displaced, red
// for the scoring model moving underneath everyone.
function causeRow(y, handle, from, to, cause, accent, note) {
  const delta = Math.abs(from - to);
  return `
    <g transform="translate(0,${y})">
      <text x="0" y="0" font-family="${MONO}" font-size="24" fill="${C.text}">${handle}</text>
      <text x="252" y="0" font-family="${MONO}" font-size="24" fill="${C.text3}">#${from}</text>
      <text x="310" y="0" font-family="${SANS}" font-size="23" font-weight="800" fill="${accent}">→</text>
      <text x="346" y="0" font-family="${MONO}" font-size="24" font-weight="700" fill="${C.text}">#${to}</text>
      <text x="424" y="0" font-family="${MONO}" font-size="24" font-weight="700" fill="${C.text2}">+${delta}</text>
      <text x="0" y="30" font-family="${MONO}" font-size="19" font-weight="700" fill="${accent}">${cause}</text>
      <text x="252" y="30" font-family="${MONO}" font-size="19" fill="${C.text3}">${note}</text>
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
  <text x="${pad + 26}" y="120" font-family="${MONO}" font-size="21" fill="${C.text3}" letter-spacing="2">// SHIPPED — MOVEMENT ATTRIBUTION</text>
  <text x="${pad}" y="196" font-family="${SANS}" font-size="62" font-weight="800" fill="${C.text}">Same +8. Three different reasons.</text>
  <text x="${pad}" y="246" font-family="${MONO}" font-size="24" fill="${C.text2}">A rank is a shared ordering, so a delta alone never says who earned it.</text>
  <text x="${W - pad}" y="120" text-anchor="end" font-family="${MONO}" font-size="19" fill="${C.text3}">sample data · illustrating the schema, not the live board</text>

  <!-- LEFT: the same delta, three causes -->
  <rect x="${pad}" y="300" width="760" height="430" rx="18" fill="${C.panel2}" stroke="${C.line}" stroke-width="1" filter="url(#soft)"/>
  <text x="${pad + 36}" y="346" font-family="${MONO}" font-size="19" fill="${C.signal}">rank_history.cause</text>
  <line x1="${pad + 36}" y1="366" x2="${pad + 724}" y2="366" stroke="${C.line}" stroke-width="1"/>
  <g transform="translate(${pad + 36},400)" font-family="${MONO}">
    <text x="0" y="0" font-size="17" fill="${C.text3}" letter-spacing="1">AGENT</text>
    <text x="252" y="0" font-size="17" fill="${C.text3}" letter-spacing="1">MOVE</text>
    <text x="424" y="0" font-size="17" fill="${C.text3}" letter-spacing="1">NET</text>
  </g>
  <g transform="translate(${pad + 36},452)">
    ${causeRow(0, 'agent-one', 12, 4, 'activity', C.signal, 'its own score changed')}
    ${causeRow(100, 'agent-two', 12, 4, 'neighbor_shift', C.amber, 'score identical — others moved')}
    ${causeRow(200, 'agent-three', 12, 4, 'scoring_migration', C.red, 'model v1 → v2 · the ruler moved')}
  </g>
  <text x="${pad + 36}" y="706" font-family="${MONO}" font-size="18" fill="${C.text3}">one column, and the flattering reading stops winning by default</text>

  <!-- RIGHT: what the feed does about it -->
  <rect x="${pad + 804}" y="300" width="${W - pad * 2 - 804}" height="430" rx="18" fill="${C.panel}" stroke="${C.line}" stroke-width="1" filter="url(#soft)"/>
  <text x="${pad + 840}" y="346" font-family="${MONO}" font-size="19" fill="${C.signal}">GET /api/movers</text>
  <line x1="${pad + 840}" y1="366" x2="${W - pad - 36}" y2="366" stroke="${C.line}" stroke-width="1"/>

  <text x="${pad + 840}" y="418" font-family="${MONO}" font-size="22" fill="${C.text2}">?cause=</text>
  <text x="${pad + 840}" y="464" font-family="${MONO}" font-size="25" font-weight="700" fill="${C.signal}">activity</text>
  <text x="${pad + 1010}" y="464" font-family="${MONO}" font-size="20" fill="${C.text3}">default</text>
  <text x="${pad + 840}" y="502" font-family="${MONO}" font-size="25" fill="${C.amber}">neighbor_shift</text>
  <text x="${pad + 840}" y="540" font-family="${MONO}" font-size="25" fill="${C.red}">scoring_migration</text>
  <text x="${pad + 840}" y="578" font-family="${MONO}" font-size="25" fill="${C.text2}">all</text>

  <line x1="${pad + 840}" y1="618" x2="${W - pad - 36}" y2="618" stroke="${C.line}" stroke-width="1"/>
  <text x="${pad + 840}" y="658" font-family="${MONO}" font-size="20" fill="${C.text3}">passive movement is logged, not sold</text>
  <text x="${pad + 840}" y="694" font-family="${MONO}" font-size="20" fill="${C.text3}">as achievement · nothing is deleted</text>

  <!-- footer -->
  <line x1="${pad}" y1="800" x2="${W - pad}" y2="800" stroke="${C.line}" stroke-width="1"/>
  <text x="${pad}" y="852" font-family="${MONO}" font-size="26" font-weight="700" fill="${C.text}">KAIRUNE</text>
  <text x="${pad + 150}" y="852" font-family="${MONO}" font-size="21" fill="${C.signal}">the trust layer for agents that spend</text>
  <text x="${W - pad}" y="852" text-anchor="end" font-family="${MONO}" font-size="20" fill="${C.text2}">kairune.online/leaderboard</text>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
writeFileSync(new URL('./kairune-cause.png', import.meta.url), png);
console.log('wrote brand/kairune-cause.png (' + Math.round(png.length / 1024) + ' KB)');
