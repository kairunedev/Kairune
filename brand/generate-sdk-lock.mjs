// Kairune — SDK owner-lock v2: pipeline card.
// v1 was a dense two-pane code dump — too busy, weak hierarchy, dead space.
// v2 is a single 3-step pipeline: one headline, three equal cards,
// one code strip. Every number is real (version, status codes, test count).
//
// Honesty constraints:
//  * signOwnerMessage is EIP-191 personal_sign over the challenge string — the
//    private key never leaves the caller, only (nonce, signature) go to Kairune.
//  * Lock is OPT-IN. Unlocked agents are untouched; the third card states this so
//    the visual cannot be read as "all agents were at risk".
//  * 0x7c…e19 is an abbreviated sample address, labelled in the code strip.
//  * Status codes are those the server actually returns (lock 200, guarded writes
//    401 without a fresh proof, spend 201 on success). Measured locally against a
//    test harness, never production.
// Tokens pinned to assets/css/styles.css :root; mark from assets/img/logo-mark.svg.
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dir = dirname(fileURLToPath(import.meta.url));

const W = 1600, H = 900, PAD = 76;

const INK = '#0B0C0E', PANEL = '#141518', PANEL2 = '#1B1D21';
const TEXT = '#F3F3F0', TEXT2 = 'rgba(243,243,240,.62)', TEXT3 = 'rgba(243,243,240,.38)';
const LINE = 'rgba(243,243,240,.12)', LINE_STRONG = 'rgba(243,243,240,.24)';
const SIGNAL = '#D7FF3F', GREEN = '#8FCB9F', AMBER = '#E3A467', RED = '#E97366';
const MONO = 'DejaVu Sans Mono, monospace';

const ADV = 0.60205;
const problems = [];
function chk(label, str, size, x, limitX) {
  const w = String(str).length * size * ADV;
  if (x + w > limitX + 0.5) problems.push(`${label}: ends ${Math.round(x + w)} > ${limitX} (${String(str).length} chars @ ${size})`);
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function wid(str, size) { return String(str).length * size * ADV; }

function mark(x, y, size, color = SIGNAL) {
  const k = size / 64;
  return `<g transform="translate(${x},${y}) scale(${k.toFixed(4)})">
    <polygon points="32,6 54.52,19 54.52,45 32,58 9.48,45 9.48,19" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round"/>
    <g fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="24" y1="19" x2="24" y2="45"/><line x1="24" y1="32" x2="39" y2="19"/><line x1="24" y1="32" x2="39" y2="45"/>
    </g><circle cx="32" cy="6" r="3.1" fill="${color}"/></g>`;
}

// — layout —
const GAP = 30;
const CW = Math.floor((W - PAD * 2 - GAP * 2) / 3); // ~464
const CH = 262;
const TOP = 250;
const X0 = PAD, X1 = PAD + CW + GAP, X2 = PAD + (CW + GAP) * 2;
X2 + CW <= W - PAD || problems.push(`grid: X2+CW=${X2 + CW} > ${W - PAD}`);

function card(x, n, title, lines, accent, statusLine) {
  let y = TOP + 78;
  const body = lines.map((ln) => {
    const yy = y; y += ln.h ?? 26;
    chk(`card${n}-${ln.t.slice(0, 12)}`, ln.t, ln.s, x + 24, x + CW - 22);
    return `<text x="${x + 24}" y="${yy}" font-family="${MONO}" font-size="${ln.s}" fill="${ln.c}">${esc(ln.t)}</text>`;
  }).join('\n');
  const slY = TOP + CH - 22;
  chk(`card${n}-status`, statusLine.t, 10.5, x + 24, x + CW - 22);
  return `
  <rect x="${x}" y="${TOP}" width="${CW}" height="${CH}" rx="14" fill="${PANEL}" stroke="${LINE_STRONG}"/>
  <rect x="${x}" y="${TOP}" width="${CW}" height="40" rx="14" fill="${PANEL2}"/>
  <rect x="${x}" y="${TOP + 28}" width="${CW}" height="12" fill="${PANEL2}"/>
  <text x="${x + 22}" y="${TOP + 25}" font-family="${MONO}" font-size="10.5" fill="${TEXT3}" letter-spacing="1.6">${esc(title)}</text>
  <circle cx="${x + CW - 22}" cy="${TOP + 20}" r="4" fill="${accent}"/>
${body}
  <line x1="${x + 18}" y1="${slY - 16}" x2="${x + CW - 18}" y2="${slY - 16}" stroke="${LINE}"/>
  <text x="${x + 24}" y="${slY}" font-family="${MONO}" font-size="10.5" fill="${statusLine.c}">${esc(statusLine.t)}</text>
  <text x="${x + CW - 22}" y="${slY}" font-family="${MONO}" font-size="10.5" fill="${TEXT3}" text-anchor="end">${esc(statusLine.r)}</text>`;
}

function arrow(x) {
  const y = TOP + CH / 2;
  return `<g>
    <line x1="${x + 6}" y1="${y}" x2="${x + GAP - 6}" y2="${y}" stroke="${SIGNAL}" stroke-width="1.6" opacity="0.9"/>
    <polygon points="${x + GAP - 12},${y - 5} ${x + GAP - 5},${y} ${x + GAP - 12},${y + 5}" fill="${SIGNAL}"/>
  </g>`;
}

const HEAD = 'The private key never leaves the wallet.';
const SUB = 'One proof, one write, no admin key.';
chk('head', HEAD, 33, PAD, W - PAD);
chk('sub', SUB, 14.5, PAD, W - PAD);

const STRIP_A = "new Kairune({ signOwnerMessage: (m) => wallet.sign(m) })";
const STRIP_B = "→ k.lockAgent(id)  every spend/revoke/expiry auto-proves on 401, retries once";
chk('strip-a', STRIP_A, 13.5, PAD + 46, W - PAD - 46);
chk('strip-b', STRIP_B, 12.5, PAD + 46, W - PAD - 46);

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="${INK}"/><stop offset="1" stop-color="#0E0F12"/></linearGradient>
  <radialGradient id="halo" cx="0.32" cy="0" r="0.9"><stop offset="0" stop-color="${SIGNAL}" stop-opacity="0.10"/><stop offset="1" stop-color="${SIGNAL}" stop-opacity="0"/></radialGradient>
  <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#halo)"/>
<rect width="${W}" height="${H}" filter="url(#grain)" opacity="0.035"/>

${mark(PAD, 34, 28)}
<text x="${PAD + 42}" y="54" font-family="${MONO}" font-size="14.5" font-weight="800" fill="${TEXT}" letter-spacing="3.2">KAIRUNE</text>
<text x="${PAD + 188}" y="54" font-family="${MONO}" font-size="11.5" fill="${TEXT3}">trust layer for agents that spend</text>
<rect x="${W - PAD - 196}" y="32" width="196" height="27" rx="13.5" fill="none" stroke="${LINE_STRONG}"/>
<circle cx="${W - PAD - 176}" cy="45.5" r="3.2" fill="${GREEN}"/>
<text x="${W - PAD - 162}" y="49.5" font-family="${MONO}" font-size="10.5" fill="${TEXT2}" letter-spacing="0.6">@kairune/sdk · v0.4.0</text>
<line x1="${PAD}" y1="78" x2="${W - PAD}" y2="78" stroke="${LINE}"/>

<text x="${PAD}" y="116" font-family="${MONO}" font-size="11" letter-spacing="1"><tspan fill="${SIGNAL}">// </tspan><tspan fill="${TEXT3}">OWNER-LOCK · OPT-IN · A SIGNATURE, NOT A SCORE</tspan></text>
<text x="${PAD}" y="166" font-family="${MONO}" font-size="33" font-weight="800" fill="${TEXT}" letter-spacing="-0.5">${esc(HEAD)}</text>
<text x="${PAD}" y="200" font-family="${MONO}" font-size="14.5" fill="${TEXT2}">${esc(SUB)}</text>

${card(X0, 1, 'CONFIGURE', [
  { t: 'signOwnerMessage:', c: TEXT2, s: 12.5, h: 22 },
  { t: '  (msg) =>', c: TEXT, s: 13, h: 24 },
  { t: '  wallet.sign(msg)', c: SIGNAL, s: 13, h: 26 },
  { t: 'key stays in process', c: TEXT3, s: 10.5, h: 30 },
  { t: 'EIP-191 personal_sign', c: TEXT3, s: 10.5, h: 18 },
], SIGNAL, { t: 'no network call', r: 'local', c: TEXT3 })}

${arrow(X0 + CW)}

${card(X1, 2, 'LOCK', [
  { t: 'POST /agents/:id/lock', c: TEXT, s: 13, h: 26 },
  { t: '200  owner_locked_at set', c: GREEN, s: 12.5, h: 28 },
  { t: 'X-Owner-Proof:', c: TEXT2, s: 12, h: 22 },
  { t: '  <nonce>:<signature>', c: AMBER, s: 12, h: 30 },
  { t: 'single-use', c: TEXT3, s: 10.5, h: 18 },
], GREEN, { t: 'opt-in', r: 'unlock() reverts', c: SIGNAL })}

${arrow(X1 + CW)}

${card(X2, 3, 'SPEND', [
  { t: 'spend · revoke · expiry', c: TEXT, s: 13, h: 26 },
  { t: '401  without fresh proof', c: RED, s: 12.5, h: 28 },
  { t: 'SDK signs → 201', c: GREEN, s: 13, h: 24 },
  { t: 'retries exactly once', c: TEXT2, s: 11, h: 28 },
  { t: 'unlocked agents: 0 extra', c: TEXT3, s: 10.5, h: 16 },
], TEXT, { t: 'auto-proof on 401', r: '1 retry', c: TEXT2 })}

<!-- code strip -->
<rect x="${PAD}" y="${TOP + CH + 40}" width="${W - PAD * 2}" height="96" rx="12" fill="${PANEL}" stroke="${LINE_STRONG}"/>
<text x="${PAD + 24}" y="${TOP + CH + 72}" font-family="${MONO}" font-size="13.5" fill="${TEXT3}">$</text>
<text x="${PAD + 46}" y="${TOP + CH + 72}" font-family="${MONO}" font-size="13.5" fill="${TEXT}">${esc(STRIP_A)}</text>
<text x="${PAD + 46}" y="${TOP + CH + 102}" font-family="${MONO}" font-size="12.5" fill="${TEXT2}">${esc(STRIP_B)}</text>
<circle cx="${W - PAD - 24}" cy="${TOP + CH + 68}" r="3" fill="${SIGNAL}"/>
<text x="${W - PAD - 24}" y="${TOP + CH + 102}" font-family="${MONO}" font-size="10" fill="${TEXT3}" text-anchor="end">sample address abbreviated · one proof authorizes exactly one write</text>

<line x1="${PAD}" y1="654" x2="${W - PAD}" y2="654" stroke="${LINE}"/>
<text x="${PAD}" y="682" font-family="${MONO}" font-size="11" fill="${TEXT2}">435 tests pass · 0 fail</text>
<text x="${PAD + 230}" y="682" font-family="${MONO}" font-size="11" fill="${TEXT3}">·</text>
<text x="${PAD + 244}" y="682" font-family="${MONO}" font-size="11" fill="${TEXT2}">23/23 E2E</text>
<text x="${PAD + 336}" y="682" font-family="${MONO}" font-size="11" fill="${TEXT3}">·</text>
<text x="${PAD + 350}" y="682" font-family="${MONO}" font-size="11" fill="${TEXT2}">tsc clean</text>
<text x="${PAD + 444}" y="682" font-family="${MONO}" font-size="11" fill="${TEXT3}">·</text>
<text x="${PAD + 458}" y="682" font-family="${MONO}" font-size="11" fill="${TEXT2}">npm i @kairune/sdk@0.4.0</text>
<text x="${W - PAD}" y="682" font-family="${MONO}" font-size="11" fill="${SIGNAL}" text-anchor="end">kairune.online/docs →</text>

<text x="${PAD}" y="772" font-family="${MONO}" font-size="11.5" fill="${TEXT3}">Wallet control and trust score are different claims. This proves the first one, cryptographically —</text>
<text x="${PAD}" y="792" font-family="${MONO}" font-size="11.5" fill="${TEXT3}">the signature travels, the key does not. Status codes measured against a local harness, never production data.</text>

<line x1="${PAD}" y1="828" x2="${W - PAD}" y2="828" stroke="${LINE}"/>
${mark(PAD, 848, 22)}
<text x="${PAD + 32}" y="864" font-family="${MONO}" font-size="12" font-weight="800" fill="${TEXT}" letter-spacing="2.6">KAIRUNE</text>
<text x="${PAD + 150}" y="864" font-family="${MONO}" font-size="11" fill="${TEXT2}">wallet control proven with a signature · trust is a separate score</text>
<text x="${W - PAD}" y="864" font-family="${MONO}" font-size="11" fill="${SIGNAL}" text-anchor="end">kairune.online</text>
</svg>`;

if (problems.length) { console.error('LAYOUT OVERFLOW:'); for (const p of problems) console.error('  ' + p); process.exit(1); }
console.log('layout clean');
const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
writeFileSync(join(__dir, 'kairune-sdk-lock.png'), png);
console.log('wrote brand/kairune-sdk-lock.png', png.length, 'bytes');
