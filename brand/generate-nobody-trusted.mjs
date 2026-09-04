// Kairune — "Nobody is TRUSTED yet" card (1600×900, 16:9 X-ready).
// The corroboration ceiling applied to our own live leaderboard. Every number
// below is read from production, including the empty tiers. Same design
// language as the other cards.
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

// DejaVu Sans Mono advances 0.60205 em per glyph, so mono widths below are
// exact arithmetic rather than eyeballed off the rendered PNG.
const ADV = 0.60205;
const monoW = (s, fs) => s.length * ADV * fs;

// Live leaderboard, GET /api/agents on 2026-09-04.
const BOARD = [
  { handle: 'voyager-07', score: 600, tier: 2 },
  { handle: 'scout-14', score: 600, tier: 2 },
  { handle: 'relay-02', score: 600, tier: 2 },
  { handle: 'pilot-09', score: 600, tier: 2 },
  { handle: '4eewer', score: 120, tier: 0 },
  { handle: 'gmmtcu4bco', score: 120, tier: 0 },
  { handle: 'nomad-31', score: 106, tier: 0 },
];
// TIER_LABELS / TIER_THRESHOLDS from src/services/trustScore.js, occupancy from
// GET /api/stats tier_distribution: [{tier:0,c:3},{tier:2,c:4}].
const TIERS = [
  { label: 'UNRATED', floor: 0, count: 3 },
  { label: 'EMERGING', floor: 250, count: 0 },
  { label: 'ESTABLISHED', floor: 500, count: 4 },
  { label: 'TRUSTED', floor: 750, count: 0 },
  { label: 'PRIME', floor: 900, count: 0 },
];

const tierColour = (t) => (t >= 4 ? C.signal : t >= 3 ? C.green : t >= 2 ? C.amber : C.text3);

// Geometry — left board panel, right tier-occupancy panel.
const LX = pad, LW = 836;
const RX = pad + LW + 40, RW = 532;
const PY = 244, PH = 520;
const BAR_X = LX + 234, BAR_MAX = 340;
const CEILING_X = BAR_X + Math.round((600 / 1000) * BAR_MAX);

// One leaderboard row: rank, handle, score bar, score, tier label.
function boardRow(y, i, a) {
  const col = tierColour(a.tier);
  const barW = Math.round((a.score / 1000) * BAR_MAX);
  return `
    <text x="${LX + 28}" y="${y + 22}" font-family="${MONO}" font-size="19"
      fill="${C.text3}">${i + 1}</text>
    <text x="${LX + 62}" y="${y + 22}" font-family="${MONO}" font-size="22"
      fill="${C.text}">${a.handle}</text>
    <rect x="${BAR_X}" y="${y + 4}" width="${BAR_MAX}" height="22" rx="6"
      fill="${C.ink}" stroke="${C.line}" stroke-width="1"/>
    <rect x="${BAR_X}" y="${y + 4}" width="${barW}" height="22" rx="6"
      fill="${col}" fill-opacity="0.85"/>
    <text x="${BAR_X + BAR_MAX + 70}" y="${y + 22}" text-anchor="end"
      font-family="${MONO}" font-size="24" font-weight="700" fill="${col}">${a.score}</text>
    <text x="${LX + LW - 28}" y="${y + 22}" text-anchor="end" font-family="${MONO}"
      font-size="17" letter-spacing="1" fill="${C.text3}">${TIERS[a.tier].label}</text>
  `;
}

// One tier slot: label, threshold, and how many agents actually sit in it.
function tierRow(y, t) {
  const empty = t.count === 0;
  const col = empty ? C.text3 : C.amber;
  const occ = empty ? 'empty' : t.count + (t.count === 1 ? ' agent' : ' agents');
  return `
    <rect x="${RX + 28}" y="${y - 20}" width="${RW - 56}" height="52" rx="10"
      fill="${empty ? 'none' : C.ink}" stroke="${empty ? C.line : C.amber}"
      stroke-width="1" stroke-opacity="${empty ? 0.6 : 1}"
      stroke-dasharray="${empty ? '4 5' : 'none'}"/>
    <text x="${RX + 48}" y="${y + 12}" font-family="${MONO}" font-size="21"
      font-weight="${empty ? 400 : 700}" fill="${col}">${t.label}</text>
    <text x="${RX + RW - 48}" y="${y + 12}" text-anchor="end" font-family="${MONO}"
      font-size="19" fill="${empty ? C.text3 : C.text}">${occ}</text>
  `;
}

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
      letter-spacing="3" fill="${C.signal}">// LIVE LEADERBOARD, AFTER THE RULE</text>
  </g>
  <text x="${pad}" y="194" font-family="${SANS}" font-size="56" font-weight="800"
    fill="${C.text}">nobody here <tspan fill="${C.signal}">is TRUSTED yet.</tspan></text>

  <!-- left: the live board -->
  <rect x="${LX}" y="${PY}" width="${LW}" height="${PH}" rx="16" fill="${C.panel}"
    stroke="${C.line}" stroke-width="1" filter="url(#soft)"/>
  <text x="${LX + 28}" y="${PY + 44}" font-family="${MONO}" font-size="19"
    letter-spacing="2" fill="${C.text3}">7 AGENTS · 9,067 ATTESTATIONS · 0 VERIFIED</text>

  <!-- the ceiling, drawn through the bars it binds -->
  <line x1="${CEILING_X}" y1="${PY + 66}" x2="${CEILING_X}" y2="${PY + PH - 20}"
    stroke="${C.signal}" stroke-width="1.5" stroke-dasharray="5 6" stroke-opacity="0.7"/>
  <text x="${CEILING_X + 10}" y="${PY + 78}" font-family="${MONO}" font-size="17"
    fill="${C.signal}">ceiling 600</text>

  ${BOARD.map((a, i) => boardRow(PY + 110 + i * 56, i, a)).join('')}

  <!-- right: which tiers are actually occupied -->
  <rect x="${RX}" y="${PY}" width="${RW}" height="${PH}" rx="16" fill="${C.panel}"
    stroke="${C.line}" stroke-width="1" filter="url(#soft)"/>
  <text x="${RX + 28}" y="${PY + 44}" font-family="${MONO}" font-size="19"
    letter-spacing="2" fill="${C.text3}">TIER OCCUPANCY</text>

  ${TIERS.map((t, i) => tierRow(PY + 108 + i * 68, t)).join('')}

  <text x="${RX + 28}" y="${PY + 486}" font-family="${MONO}" font-size="18"
    fill="${C.amber}">the top two need verified issuers.</text>

  <!-- footer -->
  <line x1="${pad}" y1="800" x2="${W - pad}" y2="800" stroke="${C.line}" stroke-width="1"/>
  <text x="${pad}" y="852" font-family="${MONO}" font-size="26" font-weight="700"
    fill="${C.text}">KAIRUNE</text>
  <text x="${pad + 150}" y="852" font-family="${MONO}" font-size="21"
    fill="${C.signal}">the trust layer for agents that spend</text>
  <text x="${W - pad}" y="852" text-anchor="end" font-family="${MONO}"
    font-size="20" fill="${C.text2}">GET /api/agents</text>
</svg>`;

// Arithmetic layout validation — nothing may cross its container.
const longestHandle = BOARD.reduce((m, a) => (a.handle.length > m.length ? a.handle : m), '');
const boardTag = '7 AGENTS · 9,067 ATTESTATIONS · 0 VERIFIED';
const checks = [
  ['header tag', pad + 26 + monoW('// LIVE LEADERBOARD, AFTER THE RULE', 21), W - pad],
  ['board tag', LX + 28 + monoW(boardTag, 19), LX + LW - 28],
  ['handle vs bar', LX + 62 + monoW(longestHandle, 22), BAR_X - 12],
  ['score vs tier label', BAR_X + BAR_MAX + 70,
    LX + LW - 28 - monoW('ESTABLISHED', 17) - 16],
  ['ceiling label', CEILING_X + 10 + monoW('ceiling 600', 17), BAR_X + BAR_MAX],
  ['last board row', PY + 110 + (BOARD.length - 1) * 56 + 26, PY + PH - 12],
  ['tier label vs count', RX + 48 + monoW('ESTABLISHED', 21),
    RX + RW - 48 - monoW('4 agents', 19) - 16],
  ['last tier row', PY + 108 + (TIERS.length - 1) * 68 + 32, PY + 486 - 24],
  ['tier note', RX + 28 + monoW('the top two need verified issuers.', 18), RX + RW - 28],
  ['footer tagline', pad + 150 + monoW('the trust layer for agents that spend', 21),
    W - pad - monoW('GET /api/agents', 20) - 24],
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
writeFileSync(new URL('./kairune-nobody-trusted.png', import.meta.url), png);
console.log('wrote brand/kairune-nobody-trusted.png (' + Math.round(png.length / 1024) + ' KB)');
