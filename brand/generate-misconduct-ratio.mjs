// Kairune — "Misconduct is a ratio, not a receipt" card (1600×900, 16:9).
// One chargeback costs more than a wall of clean payments can buy back, and a
// 5% chargeback rate lands the same score no matter the volume. Every number is
// measured from the real computeScore (scripts/probe-asymmetry.mjs), not styled.
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

// Left panel: one chargeback on a 100-clean-payment record.
// Measured: 979/PRIME -> 845/TRUSTED, and 640 clean payments to climb back.
function beforeAfter(x, y, w) {
  const h = 300;
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${C.panel}"
      stroke="${C.line}" stroke-width="1" filter="url(#soft)"/>
    <text x="${x + 32}" y="${y + 44}" font-family="${MONO}" font-size="19"
      letter-spacing="2" fill="${C.text3}">100 CLEAN PAYMENTS · THEN ONE CHARGEBACK</text>

    <text x="${x + 32}" y="${y + 150}" font-family="${MONO}" font-size="88"
      font-weight="700" fill="${C.green}">979</text>
    <text x="${x + 32}" y="${y + 190}" font-family="${MONO}" font-size="22"
      fill="${C.text2}">PRIME</text>

    <text x="${x + 252}" y="${y + 132}" font-family="${MONO}" font-size="46"
      fill="${C.text3}">→</text>

    <text x="${x + 330}" y="${y + 150}" font-family="${MONO}" font-size="88"
      font-weight="700" fill="${C.red}">845</text>
    <text x="${x + 330}" y="${y + 190}" font-family="${MONO}" font-size="22"
      fill="${C.text2}">TRUSTED</text>

    <text x="${x + 32}" y="${y + 246}" font-family="${MONO}" font-size="21"
      fill="${C.red}">−134 in one event.</text>
    <text x="${x + 32}" y="${y + 278}" font-family="${MONO}" font-size="21"
      fill="${C.text2}">640 clean payments to climb back.</text>
  `;
}

// One severity bar: dispute / chargeback / anomaly, drop from 979.
function severityRow(x, y, w, label, weight, drop, col) {
  const barMax = w - 470;
  const barW = Math.round((drop / 170) * barMax);
  return `
    <text x="${x}" y="${y + 22}" font-family="${MONO}" font-size="21"
      fill="${C.text2}">${label}</text>
    <text x="${x + 200}" y="${y + 22}" font-family="${MONO}" font-size="18"
      fill="${C.text3}">w=${weight}</text>
    <rect x="${x + 290}" y="${y + 4}" width="${barMax}" height="22" rx="6"
      fill="${C.ink}" stroke="${C.line}" stroke-width="1"/>
    <rect x="${x + 290}" y="${y + 4}" width="${barW}" height="22" rx="6"
      fill="${col}" fill-opacity="0.85"/>
    <text x="${x + w}" y="${y + 22}" text-anchor="end" font-family="${MONO}"
      font-size="21" font-weight="700" fill="${col}">−${drop}</text>
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
      letter-spacing="3" fill="${C.signal}">// MISCONDUCT IS A RATIO</text>
  </g>
  <text x="${pad}" y="194" font-family="${SANS}" font-size="56" font-weight="800"
    fill="${C.text}">one chargeback beats <tspan fill="${C.signal}">a wall of receipts.</tspan></text>

  <!-- left: before/after on 100 clean payments -->
  ${beforeAfter(pad, 244, 700)}

  <!-- right: severity is preserved -->
  <rect x="${pad + 740}" y="244" width="${W - pad * 2 - 740}" height="300" rx="16"
    fill="${C.panel}" stroke="${C.line}" stroke-width="1" filter="url(#soft)"/>
  <text x="${pad + 772}" y="288" font-family="${MONO}" font-size="19"
    letter-spacing="2" fill="${C.text3}">SEVERITY IS PRESERVED · DROP FROM 979</text>
  ${severityRow(pad + 772, 330, W - pad * 2 - 740 - 64, 'dispute', -40, 80, C.amber)}
  ${severityRow(pad + 772, 388, W - pad * 2 - 740 - 64, 'chargeback', -70, 134, C.red)}
  ${severityRow(pad + 772, 446, W - pad * 2 - 740 - 64, 'anomaly', -90, 167, C.red)}
  <text x="${pad + 772}" y="516" font-family="${MONO}" font-size="18"
    fill="${C.text2}">worse conduct → sharper fall.</text>

  <!-- bottom: volume can't drown it -->
  <text x="${pad}" y="612" font-family="${SANS}" font-size="30" font-weight="700"
    fill="${C.text}">a 5% chargeback rate lands the <tspan fill="${C.signal}">same score</tspan>, at any volume.</text>

  ${[['200 clean', '10 bad'], ['1,000 clean', '50 bad'], ['3,000 clean', '150 bad']]
    .map(([a, b], i) => {
      const x = pad + i * 470;
      return `
        <rect x="${x}" y="646" width="436" height="96" rx="14" fill="${C.panel2}"
          stroke="${C.line}" stroke-width="1"/>
        <text x="${x + 28}" y="686" font-family="${MONO}" font-size="20"
          fill="${C.text2}">${a} · ${b}</text>
        <text x="${x + 28}" y="724" font-family="${MONO}" font-size="30"
          font-weight="700" fill="${C.amber}">498 <tspan font-size="18" font-weight="400" fill="${C.text3}">EMERGING</tspan></text>
        <text x="${x + 436 - 28}" y="724" text-anchor="end" font-family="${MONO}"
          font-size="16" fill="${C.text3}">misconduct-ratio</text>
      `;
    }).join('')}

  <!-- footer -->
  <line x1="${pad}" y1="800" x2="${W - pad}" y2="800" stroke="${C.line}" stroke-width="1"/>
  <text x="${pad}" y="852" font-family="${MONO}" font-size="26" font-weight="700"
    fill="${C.text}">KAIRUNE</text>
  <text x="${pad + 150}" y="852" font-family="${MONO}" font-size="21"
    fill="${C.signal}">the trust layer for agents that spend</text>
  <text x="${W - pad}" y="852" text-anchor="end" font-family="${MONO}"
    font-size="20" fill="${C.text2}">bound_by: "misconduct-ratio"</text>
</svg>`;

// Arithmetic layout validation — nothing may cross its container.
const rW = W - pad * 2 - 740 - 64;
const checks = [
  ['header tag', pad + 26 + monoW('// MISCONDUCT IS A RATIO', 21), W - pad],
  ['left tag', pad + 32 + monoW('100 CLEAN PAYMENTS · THEN ONE CHARGEBACK', 19), pad + 700 - 32],
  ['left note', pad + 32 + monoW('640 clean payments to climb back.', 21), pad + 700 - 32],
  ['right tag', pad + 772 + monoW('SEVERITY IS PRESERVED · DROP FROM 979', 19),
    pad + 740 + (W - pad * 2 - 740) - 32],
  ['severity label vs bar', pad + 772 + 290, pad + 772 + rW],
  // SANS bold at 56/30px is wider than mono; approximate glyph advance at ~0.60em
  // of the font size and check the headline strings against the right margin.
  ['top headline', pad + 'one chargeback beats a wall of receipts.'.length * 0.60 * 56, W - pad],
  ['bottom headline', pad + 'a 5% chargeback rate lands the same score, at any volume.'.length * 0.55 * 30, W - pad],
  ['card 3 right edge', pad + 2 * 470 + 436, W - pad],
  ['card label', pad + 28 + monoW('3,000 clean · 150 bad', 20), pad + 436 - 28],
  ['footer tagline', pad + 150 + monoW('the trust layer for agents that spend', 21),
    W - pad - monoW('bound_by: "misconduct-ratio"', 20) - 24],
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
writeFileSync(new URL('./kairune-misconduct-ratio.png', import.meta.url), png);
console.log('wrote brand/kairune-misconduct-ratio.png (' + Math.round(png.length / 1024) + ' KB)');
