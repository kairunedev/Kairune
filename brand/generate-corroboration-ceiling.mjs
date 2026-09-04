// Kairune — Corroboration Ceiling card (1600×900, 16:9 X-ready).
// Shows the bug that was live: a perfect score bought with self-posted rows,
// and the rule that now bounds it. Same design language as the other cards.
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

// DejaVu Sans Mono is monospaced at 0.60205 em, so every mono width below is
// exact arithmetic rather than a guess from the rendered PNG.
const ADV = 0.60205;
const monoW = (s, fs) => s.length * ADV * fs;

// One "before / after" column: what the score was, and what bounds it now.
function scoreCard(x, y, w, opts) {
  const { tag, score, label, sub, col, note, dim } = opts;
  const h = 268;
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${C.panel}"
      stroke="${dim ? C.line : col}" stroke-width="${dim ? 1 : 2}" filter="url(#soft)"/>
    <text x="${x + 32}" y="${y + 46}" font-family="${MONO}" font-size="19"
      letter-spacing="2" fill="${C.text3}">${tag}</text>
    <text x="${x + 32}" y="${y + 148}" font-family="${MONO}" font-size="96"
      font-weight="700" fill="${col}">${score}</text>
    <text x="${x + 32}" y="${y + 194}" font-family="${MONO}" font-size="26"
      font-weight="700" fill="${col}">${label}</text>
    <text x="${x + 32}" y="${y + 232}" font-family="${MONO}" font-size="19"
      fill="${C.text2}">${sub}</text>
    <text x="${x + w - 32}" y="${y + 46}" text-anchor="end" font-family="${MONO}"
      font-size="19" fill="${dim ? C.text3 : col}">${note}</text>
  `;
}

// The ceiling ladder: how much corroboration each tier of trust costs.
function ladderRow(x, y, w, issuers, ceiling, unlocked) {
  const col = ceiling >= 1000 ? C.signal : ceiling >= 800 ? C.green : C.amber;
  const barMax = w - 430;
  const barW = Math.round((ceiling / 1000) * barMax);
  const lbl = issuers === 0 ? 'no issuers' : issuers + ' issuer' + (issuers === 1 ? '' : 's');
  return `
    <text x="${x}" y="${y + 22}" font-family="${MONO}" font-size="21"
      fill="${C.text2}">${lbl}</text>
    <rect x="${x + 210}" y="${y + 4}" width="${barMax}" height="22" rx="6"
      fill="${C.ink}" stroke="${C.line}" stroke-width="1"/>
    <rect x="${x + 210}" y="${y + 4}" width="${barW}" height="22" rx="6" fill="${col}" fill-opacity="0.85"/>
    <text x="${x + 210 + barMax + 24}" y="${y + 22}" font-family="${MONO}"
      font-size="21" font-weight="700" fill="${col}">${ceiling}</text>
    <text x="${x + w - 4}" y="${y + 22}" text-anchor="end" font-family="${MONO}"
      font-size="19" fill="${unlocked ? C.signal : C.text3}">${unlocked}</text>
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
      letter-spacing="3" fill="${C.signal}">// CORROBORATION CEILING</text>
  </g>
  <text x="${pad}" y="194" font-family="${SANS}" font-size="56" font-weight="800"
    fill="${C.text}">vouching for yourself <tspan fill="${C.signal}">is not a track record.</tspan></text>

  <!-- the two states, side by side -->
  ${scoreCard(pad, 244, 636, {
    tag: 'WAS LIVE — 2216 SELF-POSTED ROWS',
    score: '1000',
    label: 'PRIME',
    sub: '0 verified · 0 distinct issuers',
    col: C.red,
    note: 'UNCORROBORATED',
    dim: false,
  })}
  ${scoreCard(pad + 676, 244, 636, {
    tag: 'SAME HISTORY, BOUNDED',
    score: '600',
    label: 'ESTABLISHED',
    sub: 'earned 1000 · ceiling 600',
    col: C.amber,
    note: 'CEILING APPLIED',
    dim: true,
  })}

  <!-- the ladder -->
  <text x="${pad}" y="586" font-family="${SANS}" font-size="30" font-weight="700"
    fill="${C.text}">the top tiers are bought with <tspan fill="${C.signal}">independent issuers</tspan>, not volume.</text>

  ${ladderRow(pad, 618, W - pad * 2, 0, 600, '')}
  ${ladderRow(pad, 660, W - pad * 2, 1, 700, '')}
  ${ladderRow(pad, 702, W - pad * 2, 2, 800, 'TRUSTED')}
  ${ladderRow(pad, 744, W - pad * 2, 4, 1000, 'PRIME')}

  <!-- footer -->
  <line x1="${pad}" y1="800" x2="${W - pad}" y2="800" stroke="${C.line}" stroke-width="1"/>
  <text x="${pad}" y="852" font-family="${MONO}" font-size="26" font-weight="700"
    fill="${C.text}">KAIRUNE</text>
  <text x="${pad + 150}" y="852" font-family="${MONO}" font-size="21"
    fill="${C.signal}">the trust layer for agents that spend</text>
  <text x="${W - pad}" y="852" text-anchor="end" font-family="${MONO}"
    font-size="20" fill="${C.text2}">GET /api/agents/:id/trust-sources</text>
</svg>`;

// Arithmetic layout validation — no text may cross its container.
const checks = [
  ['headline tag', monoW('// CORROBORATION CEILING', 21) + 26 + pad, W - pad],
  ['left card tag', monoW('WAS LIVE — 2216 SELF-POSTED ROWS', 19) + pad + 32, pad + 636 - 32],
  ['left card note', monoW('UNCORROBORATED', 19), 636 - 64 - monoW('WAS LIVE — 2216 SELF-POSTED ROWS', 19)],
  ['right card sub', monoW('earned 1000 · ceiling 600', 19) + pad + 676 + 32, pad + 676 + 636 - 32],
  ['footer tagline', monoW('the trust layer for agents that spend', 21) + pad + 150,
    W - pad - monoW('GET /api/agents/:id/trust-sources', 20) - 24],
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
writeFileSync(new URL('./kairune-corroboration-ceiling.png', import.meta.url), png);
console.log('wrote brand/kairune-corroboration-ceiling.png (' + Math.round(png.length / 1024) + ' KB)');
