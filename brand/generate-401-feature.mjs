// Kairune — "the 401 is the feature" poster.
//
// Concept distinct from every other card in this folder: no editor pane, no
// three-panel pipeline, no BEFORE/NOW table. One enormous typographic 401 as
// the hero, a vertical rule, and a right-hand column that explains why a
// refusal is the product. Poster, not dashboard.
//
// Honesty constraints:
//  * The 401 only happens on a LOCKED agent. Opt-in is stated twice — in the
//    right column and in the base strip — so this cannot read as "Kairune
//    started blocking everyone".
//  * Reads and the spend dry-run stay open when locked; said explicitly,
//    because a payment rail needs a go/no-go without holding the owner wallet.
//  * Wallet control is the only cryptographically proven claim. The footer
//    says the trust score is behavioural, not signed.
//  * 0x7c…e19 is an abbreviated sample address, labelled as sample.
//  * Status codes are what the server returns; measured against a local test
//    harness, never against production data.
//
// Tokens pinned to assets/css/styles.css :root; mark from assets/img/logo-mark.svg.
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dir = dirname(fileURLToPath(import.meta.url));

const W = 1600, H = 900, PAD = 80;

const INK = '#0B0C0E', PANEL = '#141518', PANEL2 = '#1B1D21';
const TEXT = '#F3F3F0', TEXT2 = 'rgba(243,243,240,.62)', TEXT3 = 'rgba(243,243,240,.38)';
const LINE = 'rgba(243,243,240,.12)', LINE_STRONG = 'rgba(243,243,240,.24)';
const SIGNAL = '#D7FF3F', GREEN = '#8FCB9F', RED = '#E97366';
const MONO = 'DejaVu Sans Mono, monospace';

const ADV = 0.60205;
const problems = [];
function chk(label, str, size, x, limitX) {
  const w = String(str).length * size * ADV;
  if (x + w > limitX + 0.5) problems.push(`${label}: ends ${Math.round(x + w)} > ${limitX} (${String(str).length}ch @ ${size})`);
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function mark(x, y, size, color = SIGNAL) {
  const k = size / 64;
  return `<g transform="translate(${x},${y}) scale(${k.toFixed(4)})">
    <polygon points="32,6 54.52,19 54.52,45 32,58 9.48,45 9.48,19" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round"/>
    <g fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="24" y1="19" x2="24" y2="45"/><line x1="24" y1="32" x2="39" y2="19"/><line x1="24" y1="32" x2="39" y2="45"/>
    </g><circle cx="32" cy="6" r="3.1" fill="${color}"/></g>`;
}

// — geometry: hero left, divider, column right —
const DIV = 726;              // vertical rule x
const RX = DIV + 62;          // right column x
const RLIM = W - PAD;         // right column limit

// right column rows: [text, size, color, gapAfter]
const ROWS = [
  ['WHAT A LOCKED AGENT REFUSES', 11, TEXT3, 30],
  ['spend · revoke · set expiry', 18, TEXT, 26],
  ['add payee · counterparty policy', 18, TEXT, 42],
  ['— unless the caller signs a fresh,', 13, TEXT2, 22],
  ['single-use proof for that one write.', 13, TEXT2, 46],
  ['WHAT STAYS OPEN', 11, TEXT3, 30],
  ['every public read', 16, GREEN, 24],
  ['the spend dry-run', 16, GREEN, 24],
  ['so a payment rail still gets a go/no-go', 12.5, TEXT2, 22],
  ['without ever holding the owner wallet.', 12.5, TEXT2, 0],
];
ROWS.forEach(([t, s], i) => chk(`row${i}`, t, s, RX, RLIM));

let ry = 214;
const rightCol = ROWS.map(([t, s, c, gap]) => {
  const y = ry; ry += gap;
  const ls = s === 11 ? ' letter-spacing="1.8"' : '';
  const w = s >= 16 && s <= 18 ? ' font-weight="700"' : '';
  return `<text x="${RX}" y="${y}" font-family="${MONO}" font-size="${s}" fill="${c}"${ls}${w}>${esc(t)}</text>`;
}).join('\n');

const HEAD = 'The refusal is the feature.';
chk('head', HEAD, 30, PAD, DIV - 40);

const BASE = 'Opt-in. An agent that never locks behaves exactly as before — zero extra calls, zero extra latency.';
chk('base', BASE, 12.5, PAD + 24, W - PAD - 24);

const SDK1 = "k = new Kairune({ signOwnerMessage })";
const SDK2 = 'await k.lockAgent(id)';
chk('sdk1', SDK1, 13.5, PAD + 26, DIV - 40);
chk('sdk2', SDK2, 13.5, PAD + 26, DIV - 40);

const F1 = 'Wallet control is proven with a signature (EIP-191). The trust score is not — it is earned from behaviour.';
const F2 = 'Sample address abbreviated. Status codes measured against a local test harness, never production data.';
chk('f1', F1, 11.5, PAD, W - PAD);
chk('f2', F2, 11.5, PAD, W - PAD);

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.75" y2="1"><stop offset="0" stop-color="${INK}"/><stop offset="1" stop-color="#101215"/></linearGradient>
  <radialGradient id="halo" cx="0.2" cy="0.42" r="0.7"><stop offset="0" stop-color="${RED}" stop-opacity="0.12"/><stop offset="1" stop-color="${RED}" stop-opacity="0"/></radialGradient>
  <linearGradient id="num" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.96"/><stop offset="1" stop-color="${RED}" stop-opacity="0.78"/></linearGradient>
  <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#halo)"/>
<rect width="${W}" height="${H}" filter="url(#grain)" opacity="0.035"/>

${mark(PAD, 34, 27)}
<text x="${PAD + 40}" y="53" font-family="${MONO}" font-size="14" font-weight="800" fill="${TEXT}" letter-spacing="3.2">KAIRUNE</text>
<text x="${PAD + 182}" y="53" font-family="${MONO}" font-size="11.5" fill="${TEXT3}">owner-lock</text>
<text x="${W - PAD}" y="53" font-family="${MONO}" font-size="11" fill="${TEXT2}" text-anchor="end" letter-spacing="0.6">@kairune/sdk · v0.4.0 · on npm</text>
<line x1="${PAD}" y1="76" x2="${W - PAD}" y2="76" stroke="${LINE}"/>

<!-- hero -->
<text x="${PAD}" y="126" font-family="${MONO}" font-size="30" font-weight="800" fill="${TEXT}" letter-spacing="-0.4">${esc(HEAD)}</text>
<text x="${PAD - 6}" y="466" font-family="${MONO}" font-size="290" font-weight="800" fill="url(#num)" letter-spacing="-14">401</text>
<text x="${PAD + 4}" y="516" font-family="${MONO}" font-size="12" fill="${RED}" letter-spacing="3.4">X-OWNER-PROOF REQUIRED</text>
<line x1="${PAD}" y1="540" x2="${PAD + 322}" y2="540" stroke="${RED}" stroke-width="2" opacity="0.85"/>

<!-- sdk block under hero -->
<rect x="${PAD}" y="572" width="${DIV - 40 - PAD}" height="104" rx="12" fill="${PANEL}" stroke="${LINE_STRONG}"/>
<text x="${PAD + 26}" y="600" font-family="${MONO}" font-size="10.5" fill="${TEXT3}" letter-spacing="1.8">TWO LINES TO TURN IT ON</text>
<text x="${PAD + 26}" y="628" font-family="${MONO}" font-size="13.5" fill="${TEXT}">${esc(SDK1)}</text>
<text x="${PAD + 26}" y="654" font-family="${MONO}" font-size="13.5" fill="${SIGNAL}">${esc(SDK2)}</text>

<!-- divider -->
<line x1="${DIV}" y1="110" x2="${DIV}" y2="690" stroke="${LINE}"/>
<circle cx="${DIV}" cy="214" r="3" fill="${SIGNAL}"/>

<!-- right column -->
${rightCol}

<!-- base strip -->
<rect x="${PAD}" y="712" width="${W - PAD * 2}" height="48" rx="10" fill="${PANEL2}" stroke="${LINE_STRONG}"/>
<circle cx="${PAD + 24}" cy="736" r="3.4" fill="${SIGNAL}"/>
<text x="${PAD + 42}" y="741" font-family="${MONO}" font-size="12.5" fill="${TEXT2}">${esc(BASE)}</text>

<!-- footer -->
<text x="${PAD}" y="800" font-family="${MONO}" font-size="11.5" fill="${TEXT3}">${esc(F1)}</text>
<text x="${PAD}" y="820" font-family="${MONO}" font-size="11.5" fill="${TEXT3}">${esc(F2)}</text>
<line x1="${PAD}" y1="842" x2="${W - PAD}" y2="842" stroke="${LINE}"/>
<text x="${PAD}" y="868" font-family="${MONO}" font-size="11.5" fill="${TEXT2}">435 tests · 0 failing</text>
<text x="${W - PAD}" y="868" font-family="${MONO}" font-size="12" fill="${SIGNAL}" text-anchor="end">kairune.online</text>
</svg>`;

if (problems.length) { console.error('LAYOUT OVERFLOW:'); for (const p of problems) console.error('  ' + p); process.exit(1); }
console.log('layout clean');
const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
writeFileSync(join(__dir, 'kairune-401-feature.png'), png);
console.log('wrote brand/kairune-401-feature.png', png.length, 'bytes');
