'use strict';

/**
 * SVG <text> → <path> flattener.
 *
 * WHY: On Vercel's serverless runtime, @resvg/resvg-js rasterises vector
 * SHAPES correctly but its text-shaping engine produces ZERO glyphs (verified:
 * an identical fonts+SVG render is 2058 bytes locally but a blank 226 bytes in
 * the Lambda). Rather than fight the native text engine, we convert every
 * <text>/<tspan> run into filled <path> geometry with opentype.js BEFORE
 * handing the SVG to resvg. resvg then only has to draw paths — which works.
 *
 * The browser-facing .svg routes keep their real <text> (crisper, accessible);
 * only the PNG pipeline flattens.
 */

const opentype = require('opentype.js');

// --- Font resolution -------------------------------------------------------
// Buffers arrive in the fixed order defined by scripts/gen-font-data.js:
//   [0] DejaVuSans        (sans, normal)
//   [1] DejaVuSans-Bold   (sans, bold)
//   [2] DejaVuSansMono    (mono, normal)
//   [3] DejaVuSansMono-Bold (mono, bold)
let PARSED = null;

function parseFonts(fontBuffers) {
  if (PARSED) return PARSED;
  const toAB = (buf) =>
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const parse = (buf) => {
    if (!buf) return null;
    try {
      return opentype.parse(toAB(buf));
    } catch (_) {
      return null;
    }
  };
  PARSED = {
    sans: parse(fontBuffers[0]),
    sansBold: parse(fontBuffers[1]),
    mono: parse(fontBuffers[2]),
    monoBold: parse(fontBuffers[3]),
  };
  return PARSED;
}

function pickFont(fonts, fontFamily, fontWeight) {
  const fam = String(fontFamily || '').toLowerCase();
  const isMono = fam.includes('mono') || fam.includes('consol') || fam.includes('menlo');
  const w = String(fontWeight || '');
  const isBold = w === 'bold' || (parseInt(w, 10) || 0) >= 600;
  if (isMono) return (isBold && fonts.monoBold) || fonts.mono || fonts.sans;
  return (isBold && fonts.sansBold) || fonts.sans || fonts.mono;
}

// --- Tiny attribute + entity helpers --------------------------------------
function getAttr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? m[1] : null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// Measure a run's advance width (font units scaled to px), including spacing.
function runWidth(font, text, fontSize, letterSpacing) {
  if (!font) return 0;
  const scale = fontSize / font.unitsPerEm;
  let w = 0;
  for (const ch of text) {
    const g = font.charToGlyph(ch);
    w += (g.advanceWidth || 0) * scale + letterSpacing;
  }
  return w;
}

// Emit path data for a run starting at pen (x baseline y), advancing pen.x.
function runPath(font, text, pen, fontSize, letterSpacing) {
  if (!font) return '';
  const scale = fontSize / font.unitsPerEm;
  let d = '';
  for (const ch of text) {
    const g = font.charToGlyph(ch);
    const p = g.getPath(pen.x, pen.y, fontSize);
    d += p.toPathData(2);
    pen.x += (g.advanceWidth || 0) * scale + letterSpacing;
  }
  return d;
}

/**
 * Replace every <text> element in `svg` with equivalent filled <path>s.
 * Supports: x, y, font-family, font-size, font-weight, fill, fill-opacity,
 * text-anchor (start|middle|end), letter-spacing, and nested <tspan> runs
 * that flow inline (optionally overriding font-size / fill).
 *
 * @param {string} svg
 * @param {Buffer[]} fontBuffers ordered DejaVu buffers (see above)
 * @returns {string} svg with <text> flattened to <path>
 */
function flattenTextToPaths(svg, fontBuffers) {
  if (!Array.isArray(fontBuffers) || !fontBuffers.length) return svg;
  const fonts = parseFonts(fontBuffers);
  if (!fonts.sans && !fonts.mono) return svg; // nothing usable

  return svg.replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi, (whole, attrs, inner) => {
    try {
      const openTag = '<text' + attrs + '>';
      const baseX = parseFloat(getAttr(openTag, 'x')) || 0;
      const baseY = parseFloat(getAttr(openTag, 'y')) || 0;
      const baseSize = parseFloat(getAttr(openTag, 'font-size')) || 16;
      const baseFamily = getAttr(openTag, 'font-family') || '';
      const baseWeight = getAttr(openTag, 'font-weight') || '';
      const baseFill = getAttr(openTag, 'fill') || '#000';
      const baseFillOpacity = getAttr(openTag, 'fill-opacity');
      const baseSpacing = parseFloat(getAttr(openTag, 'letter-spacing')) || 0;
      const anchor = (getAttr(openTag, 'text-anchor') || 'start').toLowerCase();
      const textTransform = getAttr(openTag, 'transform');

      // Split inner into runs: plain text (base style) + <tspan> overrides.
      const runs = [];
      const tspanRe = /<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/gi;
      let last = 0;
      let m;
      while ((m = tspanRe.exec(inner)) !== null) {
        if (m.index > last) {
          const t = inner.slice(last, m.index);
          if (t) runs.push({ text: decodeEntities(t) });
        }
        const tTag = '<tspan' + m[1] + '>';
        runs.push({
          text: decodeEntities(m[2]),
          size: parseFloat(getAttr(tTag, 'font-size')) || null,
          fill: getAttr(tTag, 'fill'),
          weight: getAttr(tTag, 'font-weight'),
          family: getAttr(tTag, 'font-family'),
        });
        last = tspanRe.lastIndex;
      }
      if (last < inner.length) {
        const t = inner.slice(last);
        if (t) runs.push({ text: decodeEntities(t) });
      }
      if (!runs.length) return '';

      // Resolve per-run style + font.
      const resolved = runs.map((r) => {
        const size = r.size || baseSize;
        const family = r.family || baseFamily;
        const weight = r.weight || baseWeight;
        const fill = r.fill || baseFill;
        return {
          text: r.text,
          size,
          fill,
          font: pickFont(fonts, family, weight),
          spacing: baseSpacing,
        };
      });

      // Anchor offset from total advance width.
      let total = 0;
      for (const r of resolved) total += runWidth(r.font, r.text, r.size, r.spacing);
      let startX = baseX;
      if (anchor === 'middle') startX = baseX - total / 2;
      else if (anchor === 'end') startX = baseX - total;

      // Lay out each run, one <path> per fill so colours are preserved.
      const pen = { x: startX, y: baseY };
      let out = '';
      for (const r of resolved) {
        const d = runPath(r.font, r.text, pen, r.size, r.spacing);
        if (!d) continue;
        const foAttr =
          baseFillOpacity != null ? ` fill-opacity="${baseFillOpacity}"` : '';
        out += `<path d="${d}" fill="${r.fill}"${foAttr}/>`;
      }
      if (textTransform) out = `<g transform="${textTransform}">${out}</g>`;
      return out;
    } catch (_) {
      return whole; // never break the SVG; fall back to original <text>
    }
  });
}

module.exports = { flattenTextToPaths };
