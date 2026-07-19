'use strict';

/**
 * Dynamic share card (OG image) generator — Kairune.
 *
 * Renders a 1200×630 SVG "trust card" for an agent so that links shared to
 * X / Telegram / Discord / Slack unfurl into a rich, branded preview instead
 * of a bare logo. Pure string templating — no headless browser, no canvas,
 * no extra dependency (consistent with the rest of the project).
 */

// Brand palette (mirrors assets/css/styles.css :root).
const COLORS = Object.freeze({
  ink: '#0B0C0E',
  panel: '#141518',
  line: 'rgba(243,243,240,.12)',
  lineStrong: 'rgba(243,243,240,.24)',
  text: '#F3F3F0',
  text2: 'rgba(243,243,240,.62)',
  text3: 'rgba(243,243,240,.38)',
  signal: '#D7FF3F',
  signalInk: '#10130A',
  green: '#8FCB9F',
  amber: '#E3A467',
  red: '#E97366',
});

// Accent colour per tier (0..4), matching the .tier-N pills in share.css.
const TIER_ACCENT = Object.freeze([
  COLORS.text3, // 0 UNRATED
  COLORS.amber, // 1 EMERGING
  COLORS.green, // 2 ESTABLISHED
  COLORS.signal, // 3 TRUSTED
  COLORS.signal, // 4 PRIME
]);

// NOTE: 'DejaVu Sans Mono' / 'DejaVu Sans' are appended so the server-side
// PNG rasteriser (resvg) — which only has our bundled DejaVu TTFs loaded —
// can resolve a concrete font. Browsers still use the nicer system fonts
// listed first; the DejaVu entries are an invisible fallback for them.
const MONO =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace";
const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'DejaVu Sans', sans-serif";

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shortWallet(wallet) {
  const w = String(wallet || '');
  if (w.length <= 14) return w;
  return w.slice(0, 8) + '…' + w.slice(-6);
}

/**
 * Build the 1200×630 SVG string for an agent's trust card.
 * @param {object} agent { handle, wallet, score, tier, label, suggested_daily_ceiling }
 * @param {{attestations?:number}} [opts]
 * @returns {string} SVG markup
 */
function renderCardSvg(agent, opts = {}) {
  const W = 1200;
  const H = 630;
  const score = Number(agent.score) || 0;
  const tier = Math.max(0, Math.min(4, Number(agent.tier) || 0));
  const label = agent.label || 'UNRATED';
  const accent = TIER_ACCENT[tier];
  const ceiling = agent.suggested_daily_ceiling || 0;
  const atts = Number(opts.attestations) || 0;
  const handle = escapeXml(agent.handle || 'unknown');
  const wallet = escapeXml(shortWallet(agent.wallet));

  // Score arc — a 0..1000 progress ring in the top-right.
  const pct = Math.max(0, Math.min(1, score / 1000));
  const cx = 1010;
  const cy = 200;
  const r = 104;
  const circ = 2 * Math.PI * r;
  const dash = (pct * circ).toFixed(1);
  const gap = (circ - pct * circ).toFixed(1);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Kairune trust card for ${handle}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B0C0E"/>
      <stop offset="1" stop-color="#141518"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.82" cy="0.28" r="0.6">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.14"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="0" y="0" width="${W}" height="6" fill="${accent}"/>

  <!-- logo mark + wordmark -->
  <g transform="translate(80,74)">
    <polygon points="24,0 45.6,12.5 45.6,37.5 24,50 2.4,37.5 2.4,12.5" fill="${COLORS.signal}"/>
    <g fill="none" stroke="${COLORS.signalInk}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="14" x2="18" y2="36"/>
      <line x1="18" y1="25" x2="30" y2="14"/>
      <line x1="18" y1="25" x2="30" y2="36"/>
    </g>
    <text x="66" y="34" font-family="${SANS}" font-size="34" font-weight="600" fill="${COLORS.text}">Kairune</text>
  </g>
  <text x="80" y="150" font-family="${MONO}" font-size="20" fill="${COLORS.text3}" letter-spacing="2">// KAIRUNE TRUST MARK</text>

  <!-- agent handle -->
  <text x="80" y="250" font-family="${SANS}" font-size="72" font-weight="700" fill="${COLORS.text}">${handle}</text>
  <text x="82" y="298" font-family="${MONO}" font-size="24" fill="${COLORS.text3}">${wallet}</text>

  <!-- tier pill -->
  <g transform="translate(80,340)">
    <rect x="0" y="0" width="${72 + label.length * 17}" height="46" rx="10" fill="${accent}" fill-opacity="0.14" stroke="${accent}" stroke-opacity="0.5"/>
    <circle cx="26" cy="23" r="7" fill="${accent}"/>
    <text x="46" y="31" font-family="${MONO}" font-size="24" font-weight="600" fill="${accent}">${escapeXml(label)}</text>
  </g>

  <!-- stat strip -->
  <g transform="translate(80,430)" font-family="${MONO}">
    <g>
      <text x="0" y="0" font-size="18" fill="${COLORS.text3}" letter-spacing="1">SUGGESTED CEILING</text>
      <text x="0" y="52" font-size="46" font-weight="700" fill="${COLORS.text}">$${ceiling}<tspan font-size="22" fill="${COLORS.text3}">/day</tspan></text>
    </g>
    <g transform="translate(360,0)">
      <text x="0" y="0" font-size="18" fill="${COLORS.text3}" letter-spacing="1">ATTESTATIONS</text>
      <text x="0" y="52" font-size="46" font-weight="700" fill="${COLORS.text}">${atts}</text>
    </g>
  </g>

  <!-- score ring -->
  <g transform="translate(0,0)">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${COLORS.lineStrong}" stroke-width="16"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${accent}" stroke-width="16"
      stroke-linecap="round" stroke-dasharray="${dash} ${gap}"
      transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-family="${MONO}" font-size="72" font-weight="700" fill="${COLORS.text}">${score}</text>
    <text x="${cx}" y="${cy + 34}" text-anchor="middle" font-family="${MONO}" font-size="22" fill="${COLORS.text3}">/ 1000</text>
  </g>

  <!-- footer -->
  <line x1="80" y1="556" x2="${W - 80}" y2="556" stroke="${COLORS.line}"/>
  <text x="80" y="596" font-family="${MONO}" font-size="22" fill="${COLORS.text2}">the trust layer for agents that spend</text>
  <text x="${W - 80}" y="596" text-anchor="end" font-family="${MONO}" font-size="22" fill="${accent}">kairune.online</text>
</svg>`;
}

// Short tier label for compact rows.
const TIER_SHORT = Object.freeze([
  'UNRATED',
  'EMERGING',
  'ESTABLISHED',
  'TRUSTED',
  'PRIME',
]);

/**
 * Build a 1200×630 SVG leaderboard card (top agents by trust score).
 * @param {Array<object>} agents rows with { handle, score, tier }
 * @param {{title?:string}} [opts]
 * @returns {string} SVG markup
 */
function renderLeaderboardSvg(agents, opts = {}) {
  const W = 1200;
  const H = 630;
  const rows = (agents || []).slice(0, 5);
  const title = escapeXml(opts.title || 'Most trusted agents');

  const rowY = (i) => 232 + i * 74;
  const medal = ['#F4C752', '#C7CAD1', '#CE8B54']; // gold / silver / bronze

  const rowsSvg = rows
    .map((a, i) => {
      const tier = Math.max(0, Math.min(4, Number(a.tier) || 0));
      const accent = TIER_ACCENT[tier];
      const label = TIER_SHORT[tier];
      const rankColor = medal[i] || COLORS.text3;
      const handle = escapeXml(a.handle || 'unknown');
      const score = Number(a.score) || 0;
      const y = rowY(i);
      return `
    <g transform="translate(80,${y})">
      <rect x="0" y="-34" width="1040" height="60" rx="12" fill="${COLORS.panel}" stroke="${COLORS.line}"/>
      <text x="26" y="6" font-family="${MONO}" font-size="30" font-weight="700" fill="${rankColor}">${i + 1}</text>
      <text x="80" y="6" font-family="${SANS}" font-size="30" font-weight="600" fill="${COLORS.text}">${handle}</text>
      <circle cx="720" cy="-4" r="6" fill="${accent}"/>
      <text x="738" y="6" font-family="${MONO}" font-size="20" fill="${accent}">${label}</text>
      <text x="1014" y="6" text-anchor="end" font-family="${MONO}" font-size="32" font-weight="700" fill="${COLORS.text}">${score}</text>
    </g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Kairune leaderboard">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B0C0E"/>
      <stop offset="1" stop-color="#141518"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.1" r="0.7">
      <stop offset="0" stop-color="${COLORS.signal}" stop-opacity="0.12"/>
      <stop offset="1" stop-color="${COLORS.signal}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="0" y="0" width="${W}" height="6" fill="${COLORS.signal}"/>

  <g transform="translate(80,74)">
    <polygon points="20,0 38,10.4 38,31.2 20,41.6 2,31.2 2,10.4" fill="${COLORS.signal}"/>
    <g fill="none" stroke="${COLORS.signalInk}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round">
      <line x1="15" y1="11.6" x2="15" y2="30"/>
      <line x1="15" y1="20.8" x2="25" y2="11.6"/>
      <line x1="15" y1="20.8" x2="25" y2="30"/>
    </g>
    <text x="56" y="30" font-family="${SANS}" font-size="30" font-weight="600" fill="${COLORS.text}">Kairune</text>
  </g>

  <text x="80" y="170" font-family="${SANS}" font-size="56" font-weight="700" fill="${COLORS.text}">${title}</text>
  <text x="82" y="205" font-family="${MONO}" font-size="20" fill="${COLORS.text3}">// ranked by verifiable trust score</text>
  ${rowsSvg}

  <line x1="80" y1="588" x2="${W - 80}" y2="588" stroke="${COLORS.line}"/>
  <text x="80" y="618" font-family="${MONO}" font-size="20" fill="${COLORS.text2}">the trust layer for agents that spend</text>
  <text x="${W - 80}" y="618" text-anchor="end" font-family="${MONO}" font-size="20" fill="${COLORS.signal}">kairune.online/leaderboard</text>
</svg>`;
}

// Solid colour per tier for the compact badge (needs opaque fills, not the
// translucent text3 used elsewhere for UNRATED).
const BADGE_TIER_COLOR = Object.freeze([
  '#6B7076', // 0 UNRATED  (muted grey)
  '#E3A467', // 1 EMERGING (amber)
  '#8FCB9F', // 2 ESTABLISHED (green)
  '#D7FF3F', // 3 TRUSTED (signal)
  '#D7FF3F', // 4 PRIME (signal)
]);

// Rough per-character advance for DejaVu Sans at 11px (used to size the
// badge halves before text is flattened to paths). Slightly generous so
// glyphs never touch the edges.
function badgeTextWidth(str, size) {
  let w = 0;
  for (const ch of String(str)) {
    if (/[iIl.,:;'|!]/.test(ch)) w += 0.32;
    else if (/[fjtr ]/.test(ch)) w += 0.42;
    else if (/[A-Z0-9]/.test(ch)) w += 0.68;
    else if (/[mwMW]/.test(ch)) w += 0.9;
    else w += 0.58;
  }
  return Math.ceil(w * size);
}

/**
 * Render a compact, embeddable "trust badge" (shields.io style) for an agent.
 * Left half = label (dark), right half = "score · TIER" in the tier colour.
 * Designed to be dropped into a README / docs / site:
 *   [![Kairune](https://kairune.online/a/<handle>/badge.svg)](https://kairune.online/a/<handle>)
 *
 * @param {object} agent { handle, score, tier, label }
 * @returns {string} SVG markup (height 20, dynamic width)
 */
function renderBadgeSvg(agent) {
  const score = Number(agent.score) || 0;
  const tier = Math.max(0, Math.min(4, Number(agent.tier) || 0));
  const label = String(agent.label || 'UNRATED').toUpperCase();
  const color = BADGE_TIER_COLOR[tier];
  // Dark ink reads well on every tier colour (amber/green/signal are all light).
  const valueInk = '#10130A';

  const H = 20;
  const fs = 11;
  const padX = 8;
  const logoW = 16; // reserved space for the hexagon mark on the left

  const leftText = 'kairune trust';
  const valueText = `${score} · ${label}`;

  const leftTextW = badgeTextWidth(leftText, fs);
  const valueTextW = badgeTextWidth(valueText, fs);
  const leftW = logoW + leftTextW + padX * 2;
  const rightW = valueTextW + padX * 2;
  const W = leftW + rightW;

  const leftTextMidX = logoW + padX + leftTextW / 2;
  const rightTextMidX = leftW + padX + valueTextW / 2;
  const textY = 14;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Kairune trust: ${escapeXml(String(score))} ${escapeXml(label)}">
  <defs>
    <linearGradient id="bsheen" x2="0" y2="100%">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity=".08"/>
      <stop offset="1" stop-color="#000000" stop-opacity=".18"/>
    </linearGradient>
    <clipPath id="bround"><rect width="${W}" height="${H}" rx="4"/></clipPath>
  </defs>
  <g clip-path="url(#bround)">
    <rect width="${leftW}" height="${H}" fill="#141518"/>
    <rect x="${leftW}" width="${rightW}" height="${H}" fill="${color}"/>
    <rect width="${W}" height="${H}" fill="url(#bsheen)"/>
  </g>
  <g transform="translate(6,5)">
    <polygon points="5,0 9.5,2.6 9.5,7.8 5,10.4 0.5,7.8 0.5,2.6" fill="${COLORS.signal}"/>
  </g>
  <text x="${leftTextMidX}" y="${textY}" text-anchor="middle" font-family="${SANS}" font-size="${fs}" font-weight="600" fill="${COLORS.text}">${escapeXml(leftText)}</text>
  <text x="${rightTextMidX}" y="${textY}" text-anchor="middle" font-family="${SANS}" font-size="${fs}" font-weight="700" fill="${valueInk}">${escapeXml(valueText)}</text>
</svg>`;
}

module.exports = {
  renderCardSvg,
  renderLeaderboardSvg,
  renderBadgeSvg,
  COLORS,
  TIER_ACCENT,
};
