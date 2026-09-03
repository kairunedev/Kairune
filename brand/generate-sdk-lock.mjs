// Kairune — "the code is the copy" card: SDK owner-lock, shown as a real
// editor you could paste. Different from every prior card: no BEFORE/NOW row
// table, no two-panel context viewer. One code pane + one execution pane — the
// shape a developer actually reads.
//
// Honesty constraints:
//   * `signOwnerMessage` is an EIP-191 personal_sign over the challenge string.
//     The private key never leaves the caller; only the signature and its nonce
//     go to Kairune.
//   * Owner lock is OPT-IN. Unlocked agents are unaffected — the last terminal
//     row says this out loud so nobody reads the card as "all wallets were at
//     risk".
//   * `0x7c…e19` is an abbreviated sample address, not a real one — labelled as
//     such in the gutter comment.
//   * Status codes are the ones the server returns (POST /agents/:id/lock 200,
//     guarded writes 401 without a valid fresh proof). No production mutating
//     request was made to render this.
//
// Tokens pinned to assets/css/styles.css :root; mark from assets/img/logo-mark.svg.
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));

const W = 1600, H = 1000, PAD = 76;

const INK = '#0B0C0E', PANEL = '#141518', PANEL2 = '#1B1D21';
const TEXT = '#F3F3F0', TEXT2 = 'rgba(243,243,240,.62)', TEXT3 = 'rgba(243,243,240,.38)';
const LINE = 'rgba(243,243,240,.12)', LINE_STRONG = 'rgba(243,243,240,.24)';
const SIGNAL = '#D7FF3F', GREEN = '#8FCB9F', AMBER = '#E3A467', RED = '#E97366';
const MONO = 'DejaVu Sans Mono, monospace';

const ADV = 0.60205, CODE = 18, LH = 30;
const problems = [];
function span(label, parts, size, x0, limitX) {
  const s = parts.map((p) => p[0]).join('');
  const w = s.length * size * ADV;
  if (x0 + w > limitX) problems.push(`${label}: ends at ${Math.round(x0 + w)} > ${limitX} (${s.length} chars @ ${size})`);
  return s;
}
function text(label, str, size, x, limitX) {
  const w = str.length * size * ADV;
  if (x + w > limitX) problems.push(`${label}: ends at ${Math.round(x + w)} > ${limitX} (${str.length} chars @ ${size})`);
  return str;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function mark(x, y, size, color = SIGNAL) {
  const k = size / 64;
  return `<g transform="translate(${x},${y}) scale(${k.toFixed(4)})">
    <polygon points="32,6 54.52,19 54.52,45 32,58 9.48,45 9.48,19" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round"/>
    <g fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="24" y1="19" x2="24" y2="45"/>
      <line x1="24" y1="32" x2="39" y2="19"/><line x1="24" y1="32" x2="39" y2="45"/>
    </g><circle cx="32" cy="6" r="3.1" fill="${color}"/></g>`;
}

// --- CODE ---
const CODE_LINES = [
  [
    [['const ', SIGNAL], ['k', TEXT], [' = ', TEXT3], ['new ', SIGNAL], ['Kairune', GREEN], ['({', TEXT]],
  ],
  [
    [['  ', TEXT], ['signOwnerMessage', TEXT], [': ', TEXT3], ['(', TEXT], ['msg', AMBER], [') => ', TEXT3], ['wallet', GREEN], ['.sign(', TEXT], ['msg', AMBER], ['),', TEXT]],
  ],
  [
    [['  ', TEXT], ['wallet', TEXT], [': ', TEXT3], ["'0x7c…e19'", TEXT2], [',', TEXT], ['   // the address, never the key', TEXT3]],
  ],
  [
    [['})', TEXT]],
  ],
  [ [['', TEXT]] ],
  [
    [['const ', SIGNAL], ['a', TEXT], [' = ', TEXT3], ['await ', SIGNAL], ['k.registerAgent', GREEN], ['({', TEXT]],
  ],
  [
    [['  ', TEXT], ['handle', TEXT], [': ', TEXT3], ["'scout-14'", TEXT2], [',', TEXT], ['  ', TEXT3], ['// claimed. control untested, until now.', TEXT3]],
  ],
  [
    [['  ', TEXT], ['wallet', TEXT], [': ', TEXT3], ["'0x7c…e19'", TEXT2], [',', TEXT]],
  ],
  [
    [['})', TEXT]],
  ],
  [ [['', TEXT]] ],
  [
    [['// bind this agent\'s spend authority to its wallet', TEXT3]],
  ],
  [
    [['await ', SIGNAL], ['k.lockAgent', GREEN], ['(a.id)', TEXT], ['            ', TEXT3], ['// proof minted + signed for you', TEXT3]],
  ],
].map((l) => l[0]);

const TERM = [
  { l: 'POST /agents/scout-14/lock', v: '200', c: SIGNAL, d: 'owner_locked_at set', dc: TEXT2 },
  { l: 'spend / revoke / expiry — no proof', v: '401', c: RED, d: 'X-Owner-Proof required', dc: TEXT },
  { l: 'spend / revoke / expiry — signed now', v: '201', c: GREEN, d: 'single-use, consumed pass or fail', dc: TEXT2 },
  { l: 'UNLOCKED agents (default state)', v: 'ok', c: TEXT3, d: 'unchanged · 0 extra calls', dc: TEXT2 },
];

const GX = 56;
const CODE_X = GX + 62, CODE_LIMIT = W - PAD - 40;
function codePane() {
  const top = 200;
  const paneH = CODE_LINES.length * LH + 76;
  let y = top + 62;
  const lines = CODE_LINES.map((parts, i) => {
    const raw = parts.map((p) => p[0]).join('');
    span(`code[${i}]`, parts, CODE, CODE_X, CODE_LIMIT);
    const num = `<text x="${GX}" y="${y}" font-family="${MONO}" font-size="14" fill="${TEXT3}" text-anchor="end">${i + 1}</text>`;
    let xx = CODE_X;
    const seg = parts.map((p) => { const t = `<text x="${xx.toFixed(1)}" y="${y}" font-family="${MONO}" font-size="${CODE}" fill="${p[1]}" xml:space="preserve">${esc(p[0])}</text>`; xx += p[0].length * CODE * ADV; return t; }).join('');
    y += LH;
    return `${num}${seg}\n`;
  }).join('');
  return `
  <rect x="${GX}" y="${top}" width="${W - GX - PAD}" height="${paneH}" rx="12" fill="${PANEL}" stroke="${LINE_STRONG}"/>
  <rect x="${GX}" y="${top}" width="${W - GX - PAD}" height="42" rx="12" fill="${PANEL2}"/>
  <rect x="${GX}" y="${top + 30}" width="${W - GX - PAD}" height="12" fill="${PANEL2}"/>
  <line x1="${CODE_X - 14}" y1="${top}" x2="${CODE_X - 14}" y2="${top + paneH}" stroke="${LINE}"/>
  <circle cx="${GX + 30}" cy="${top + 21}" r="5.5" fill="${RED}"/>
  <circle cx="${GX + 48}" cy="${top + 21}" r="5.5" fill="${AMBER}"/>
  <circle cx="${GX + 66}" cy="${top + 21}" r="5.5" fill="${GREEN}"/>
  <text x="${GX + 94}" y="${top + 26}" font-family="${MONO}" font-size="13.5" fill="${TEXT2}">kairune-lock.ts</text>
  <text x="${W - GX - PAD - 22}" y="${top + 26}" font-family="${MONO}" font-size="12" fill="${TEXT3}" text-anchor="end">@kairune/sdk · v0.4.0</text>
${lines}`;
}

function termPane() {
  const top = 598;
  const paneH = TERM.length * LH + 48;
  let y = top + 44;
  const rows = TERM.map((r, i) => {
    text(`term[${i}].l`, r.l, 13.5, CODE_X + 8, W - PAD - 420);
    text(`term[${i}].d`, r.d, 12, W - PAD - 380, W - PAD - 24);
    const yy = y;
    y += LH;
    return `  <text x="${CODE_X + 4}" y="${yy}" font-family="${MONO}" font-size="12" fill="${TEXT3}">$</text>
  <text x="${CODE_X + 22}" y="${yy}" font-family="${MONO}" font-size="13.5" fill="${TEXT2}">${esc(r.l)}</text>
  <text x="${CODE_X + 22 + (r.l.length + 4) * 13.5 * ADV}" y="${yy}" font-family="${MONO}" font-size="13.5" fill="${r.c}">${esc(r.v)}</text>
  <text x="${W - PAD - 24}" y="${yy}" font-family="${MONO}" font-size="11.5" fill="${r.dc}" text-anchor="end">${esc(r.d)}</text>`;
  }).join('\n');
  return `
  <rect x="${GX}" y="${top}" width="${W - GX - PAD}" height="${paneH}" rx="10" fill="${PANEL}" stroke="${LINE_STRONG}"/>
  <text x="${CODE_X - 14}" y="${top + 22}" font-family="${MONO}" font-size="11.5" fill="${TEXT3}">$ node kairune-lock.ts</text>
${rows}`;
}

const HEAD1 = 'The private key stays with the wallet.';
const HEAD2 = 'Everything else is one proof away.';
text('head1', HEAD1, 36, PAD, W - PAD);
text('head2', HEAD2, 36, PAD, W - PAD);

const RULE = 'opt-in · unlocked agents stay open by default · one proof authorizes exactly one write';
text('rule', RULE, 13, PAD + 26, W - PAD - 26);

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.7" y2="1"><stop offset="0" stop-color="${INK}"/><stop offset="1" stop-color="#0E0F12"/></linearGradient>
  <radialGradient id="halo" cx="0.5" cy="0" r="0.8"><stop offset="0" stop-color="${SIGNAL}" stop-opacity="0.09"/><stop offset="1" stop-color="${SIGNAL}" stop-opacity="0"/></radialGradient>
  <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#halo)"/>
<rect width="${W}" height="${H}" filter="url(#grain)" opacity="0.035"/>

${mark(PAD, 42, 30)}
<text x="${PAD + 44}" y="64" font-family="${MONO}" font-size="15" font-weight="800" fill="${TEXT}" letter-spacing="3.4">KAIRUNE</text>
<text x="${PAD + 196}" y="64" font-family="${MONO}" font-size="12.5" fill="${TEXT3}">// trust layer for agents that spend</text>
<rect x="${W - PAD - 218}" y="42" width="218" height="30" rx="15" fill="none" stroke="${LINE_STRONG}"/>
<circle cx="${W - PAD - 194}" cy="57" r="3.4" fill="${GREEN}"/>
<text x="${W - PAD - 178}" y="62" font-family="${MONO}" font-size="12" fill="${TEXT2}" letter-spacing="0.8">435 TESTS · 0 FAILING</text>
<line x1="${PAD}" y1="100" x2="${W - PAD}" y2="100" stroke="${LINE}"/>

<text x="${PAD}" y="140" font-family="${MONO}" font-size="12.5"><tspan fill="${SIGNAL}">// </tspan><tspan fill="${TEXT3}">opt-in spend-authority lock · no admin key</tspan></text>
<text x="${PAD}" y="176" font-family="${MONO}" font-size="22" font-weight="800" fill="${TEXT}" letter-spacing="-0.3">${esc(HEAD1)}</text>
<pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="${LINE}"/></pattern>
<rect x="0" y="0" width="0" height="0" fill="none"/>
${codePane()}
${termPane()}

<rect x="${GX}" y="782" width="${W - GX - PAD}" height="46" rx="10" fill="${PANEL2}" stroke="${LINE_STRONG}"/>
<text x="${PAD + 26}" y="810" font-family="${MONO}" font-size="13" fill="${SIGNAL}">${esc(RULE)}</text>

<line x1="${PAD}" y1="882" x2="${W - PAD}" y2="882" stroke="${LINE}"/>
${mark(PAD, 902, 24)}
<text x="${PAD + 36}" y="920" font-family="${MONO}" font-size="13.5" font-weight="800" fill="${TEXT}" letter-spacing="3">KAIRUNE</text>
<text x="${PAD + 168}" y="920" font-family="${MONO}" font-size="12" fill="${TEXT2}">wallet control proven with EIP-191 · not trust — trust is a score, this is a signature</text>
<text x="${W - PAD}" y="920" font-family="${MONO}" font-size="13" fill="${SIGNAL}" text-anchor="end">kairune.online/docs</text>

<text x="${PAD}" y="980" font-family="${MONO}" font-size="11.5" fill="${TEXT3}">sample address abbreviated · real API shape · status codes measured locally against a test harness, never production data</text>
</svg>`;

if (problems.length) { console.error('LAYOUT OVERFLOW:'); for (const p of problems) console.error('  ' + p); process.exit(1); }
console.log('layout clean');
const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
writeFileSync(join(__dir, 'kairune-sdk-lock.png'), png);
console.log('wrote brand/kairune-sdk-lock.png', png.length, 'bytes');
