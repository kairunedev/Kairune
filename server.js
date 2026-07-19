'use strict';

/**
 * Kairune static site server.
 * Serves the landing page (index.html + assets) with gzip compression,
 * long-lived caching for hashed assets, a health-check endpoint, and a
 * graceful shutdown handler for clean PM2 / container restarts.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const compression = require('compression');
const { Resvg } = require('@resvg/resvg-js');
const apiRouter = require('./src/routes/api');
const agentService = require('./src/services/agentService');
const attestationService = require('./src/services/attestationService');
const trustScore = require('./src/services/trustScore');
const { renderCardSvg, renderLeaderboardSvg, renderBadgeSvg } = require('./src/services/shareCard');
const { flattenTextToPaths } = require('./src/services/svgText');

// Configuration comes from the environment (no secret values are hard-coded).
const PORT = parseInt(process.env.PORT, 10) || 3040;
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const PUBLIC_DIR = __dirname;

const app = express();

// Load bundled fonts once at startup. Vercel serverless has NO system fonts,
// so we must ship our own TTFs and hand resvg the raw buffers — otherwise
// text renders blank (transparent) in the generated PNG.
//
// The fonts are embedded as base64 in src/services/fontData.js because Vercel's
// serverless bundler does NOT reliably trace fs.readFileSync() on binary assets
// (the assets/fonts/*.ttf were shipped to the CDN but not into the lambda FS,
// leaving FONT_BUFFERS empty → blank text). A required JS module is always
// bundled. We fall back to reading the TTFs from disk if the module is missing.
let FONT_BUFFERS = [];
try {
  FONT_BUFFERS = require('./src/services/fontData');
} catch (_) {
  const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
  FONT_BUFFERS = [
    'DejaVuSans.ttf',
    'DejaVuSans-Bold.ttf',
    'DejaVuSansMono.ttf',
    'DejaVuSansMono-Bold.ttf',
  ]
    .map((f) => {
      try {
        return fs.readFileSync(path.join(FONT_DIR, f));
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function svgToPng(svg) {
  // resvg's text-shaping engine renders ZERO glyphs on Vercel's serverless
  // runtime (verified: identical fonts+SVG = 2058 bytes locally, blank 226
  // bytes in the Lambda). Its SHAPE rendering works fine, so we pre-flatten
  // every <text> run into vector <path>s with opentype.js and let resvg draw
  // only paths. This is exactly what Vercel's own OG image lib does.
  let prepared = svg;
  try {
    prepared = flattenTextToPaths(svg, FONT_BUFFERS);
  } catch (_) {
    prepared = svg; // fall back to text rendering if flattening fails
  }
  return new Resvg(prepared, {
    fitTo: { mode: 'width', value: 1200 },
    background: '#0B0C0E',
    font: {
      loadSystemFonts: false,
      fontBuffers: FONT_BUFFERS,
      defaultFontFamily: 'DejaVu Sans',
    },
  }).render().asPng();
}

// Behind a reverse proxy (nginx / load balancer) → trust X-Forwarded-* headers.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Gzip compression for every compressible response.
app.use(compression());

// Parse JSON body for the REST API (size-limited → protects against large payloads).
app.use(express.json({ limit: '100kb' }));

// Basic security headers (no extra dependency).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=()'
  );
  next();
});

// Health-check for PM2 / deploy script / uptime monitor.
app.get('/health', (req, res) => {
  // Font render self-test: rasterize a tiny black-on-white text SVG and count
  // how many pixels are non-white. If fonts render, we get many dark pixels;
  // if they don't (blank text), the canvas stays white → count ~0.
  let renderTest = null;
  try {
    const testSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60">' +
      '<rect width="200" height="60" fill="#ffffff"/>' +
      '<text x="10" y="40" font-size="32" font-family="DejaVu Sans" fill="#000000">RENDER</text>' +
      '</svg>';
    const png = new Resvg(testSvg, {
      font: {
        loadSystemFonts: false,
        fontBuffers: FONT_BUFFERS,
        defaultFontFamily: 'DejaVu Sans',
      },
    })
      .render()
      .asPng();
    // Also try WITHOUT explicit fontBuffers to compare (loadSystemFonts true).
    const pngSys = new Resvg(testSvg, {
      font: { loadSystemFonts: true, defaultFontFamily: 'sans-serif' },
    })
      .render()
      .asPng();
    renderTest = {
      resvgVersion: require('@resvg/resvg-js/package.json').version,
      bufferPngBytes: png.length,
      systemPngBytes: pngSys.length,
    };
  } catch (err) {
    renderTest = { error: String(err && err.message) };
  }

  res.status(200).json({
    status: 'ok',
    service: 'kairune',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    fonts: {
      count: FONT_BUFFERS.length,
      bytes: FONT_BUFFERS.reduce((a, b) => a + b.length, 0),
      firstBytes: FONT_BUFFERS[0]
        ? FONT_BUFFERS[0].slice(0, 4).toString('hex')
        : null,
    },
    renderTest,
  });
});

// REST API — trust marks, agents, attestations, permissions.
app.use('/api', apiRouter);

// Static assets: long cache for /assets, no cache for HTML.
app.use(
  '/assets',
  express.static(path.join(PUBLIC_DIR, 'assets'), {
    maxAge: '30d',
    immutable: false,
    fallthrough: true,
  })
);

// Console dashboard (SPA at /app).
app.use(
  '/app',
  express.static(path.join(PUBLIC_DIR, 'app'), {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// API docs at /docs (must be explicit so Vercel file-tracing includes the folder).
app.use(
  '/docs',
  express.static(path.join(PUBLIC_DIR, 'docs'), {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// Dynamic OG/share image for the leaderboard — 1200×630 SVG.
app.get('/leaderboard/card.svg', async (req, res, next) => {
  try {
    const agents = await agentService.listAgents({ limit: 5 });
    const withLabels = (agents || []).map((a) => ({
      ...a,
      label: trustScore.TIER_LABELS[a.tier] || 'UNRATED',
    }));
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.type('image/svg+xml').send(renderLeaderboardSvg(withLabels));
  } catch (err) {
    next(err);
  }
});

// PNG version for X/Twitter and other crawlers that do not render SVG OG images.
app.get('/leaderboard/card.png', async (req, res, next) => {
  try {
    const agents = await agentService.listAgents({ limit: 5 });
    const withLabels = (agents || []).map((a) => ({
      ...a,
      label: trustScore.TIER_LABELS[a.tier] || 'UNRATED',
    }));
    const png = svgToPng(renderLeaderboardSvg(withLabels));
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.type('image/png').send(png);
  } catch (err) {
    next(err);
  }
});

// Public leaderboard page (SSR meta for rich unfurls).
app.get('/leaderboard', async (req, res, next) => {
  try {
    let html = fs.readFileSync(path.join(PUBLIC_DIR, 'leaderboard', 'index.html'), 'utf8');
    const title = 'Most trusted AI agents — Kairune leaderboard';
    const desc = 'A live ranking of autonomous agents by verifiable trust score. The trust layer for agents that spend.';
    const cardImg = 'https://kairune.online/leaderboard/card.png';
    html = html.replace('<!--OG_META-->', [
      `<meta property="og:title" content="${escapeHtml(title)}" />`,
      `<meta property="og:description" content="${escapeHtml(desc)}" />`,
      `<meta property="og:url" content="https://kairune.online/leaderboard" />`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:image" content="${cardImg}" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:image:type" content="image/png" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(desc)}" />`,
      `<meta name="twitter:image" content="${cardImg}" />`,
      `<meta name="description" content="${escapeHtml(desc)}" />`,
    ].join('\n'));
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

// Dynamic OG/share image for an agent — 1200×630 SVG (rich social unfurls).
app.get('/a/:handle/card.svg', async (req, res, next) => {
  try {
    const handle = String(req.params.handle).trim().toLowerCase();
    const base = await agentService.getAgent(handle);
    if (!base) {
      res.setHeader('Cache-Control', 'no-cache');
      return res.status(404).type('image/svg+xml').send(
        renderCardSvg(
          { handle: handle || 'unknown', wallet: '', score: 0, tier: 0, label: 'NOT FOUND', suggested_daily_ceiling: 0 },
          { attestations: 0 }
        )
      );
    }
    const agent = await agentService.recalcAgent(base.id);
    const atts = await attestationService.listAttestations(base.id, { limit: 200 });
    const label = agent.label || trustScore.TIER_LABELS[agent.tier] || 'UNRATED';
    const svg = renderCardSvg(
      { ...agent, label },
      { attestations: (atts || []).length }
    );
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    next(err);
  }
});

// PNG version for X/Twitter and other crawlers that do not render SVG OG images.
app.get('/a/:handle/card.png', async (req, res, next) => {
  try {
    const handle = String(req.params.handle).trim().toLowerCase();
    const base = await agentService.getAgent(handle);
    if (!base) {
      const svg = renderCardSvg(
        { handle: handle || 'unknown', wallet: '', score: 0, tier: 0, label: 'NOT FOUND', suggested_daily_ceiling: 0 },
        { attestations: 0 }
      );
      res.setHeader('Cache-Control', 'no-cache');
      return res.type('image/png').send(svgToPng(svg));
    }
    const agent = await agentService.recalcAgent(base.id);
    const atts = await attestationService.listAttestations(base.id, { limit: 200 });
    const label = agent.label || trustScore.TIER_LABELS[agent.tier] || 'UNRATED';
    const svg = renderCardSvg(
      { ...agent, label },
      { attestations: (atts || []).length }
    );
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.type('image/png').send(svgToPng(svg));
  } catch (err) {
    next(err);
  }
});

// Compact, embeddable trust badge (shields.io style) — for READMEs / docs / sites.
// Usage: [![Kairune](https://kairune.online/a/<handle>/badge.svg)](https://kairune.online/a/<handle>)
app.get('/a/:handle/badge.svg', async (req, res, next) => {
  try {
    const handle = String(req.params.handle).trim().toLowerCase();
    const base = await agentService.getAgent(handle);
    let svg;
    if (!base) {
      svg = renderBadgeSvg({ handle, score: 0, tier: 0, label: 'UNRATED' });
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      const agent = await agentService.recalcAgent(base.id);
      const label = agent.label || trustScore.TIER_LABELS[agent.tier] || 'UNRATED';
      svg = renderBadgeSvg({ ...agent, label });
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    next(err);
  }
});

// Public agent trust cards at /a/:handle (SSR meta for X/OG unfurls)
app.get('/a/:handle', async (req, res, next) => {
  if (req.params.handle.includes('.')) return next();
  try {
    let html = fs.readFileSync(path.join(PUBLIC_DIR, 'a', 'index.html'), 'utf8');
    const handle = String(req.params.handle).trim().toLowerCase();
    const base = await agentService.getAgent(handle);
    let title = 'Kairune — agent trust card';
    let desc = 'Verifiable trust score for AI agents that spend.';
    if (base) {
      const agent = await agentService.recalcAgent(base.id);
      const atts = await attestationService.listAttestations(base.id, { limit: 50 });
      const label = agent.label || trustScore.TIER_LABELS[agent.tier] || 'UNRATED';
      title = `${agent.handle} · score ${agent.score} (${label}) — Kairune`;
      desc = `Trust mark for ${agent.handle}: score ${agent.score}/1000, tier ${label}, suggested ceiling $${agent.suggested_daily_ceiling || 0}/day.`;
      const cardImg = `https://kairune.online/a/${encodeURIComponent(agent.handle)}/card.png`;
      html = html
        .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
        .replace(
          '<!--OG_META-->',
          [
            `<meta property="og:title" content="${escapeHtml(title)}" />`,
            `<meta property="og:description" content="${escapeHtml(desc)}" />`,
            `<meta property="og:url" content="https://kairune.online/a/${encodeURIComponent(agent.handle)}" />`,
            `<meta property="og:type" content="website" />`,
            `<meta property="og:image" content="${escapeHtml(cardImg)}" />`,
            `<meta property="og:image:width" content="1200" />`,
            `<meta property="og:image:height" content="630" />`,
            `<meta property="og:image:type" content="image/png" />`,
            `<meta name="twitter:card" content="summary_large_image" />`,
            `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
            `<meta name="twitter:description" content="${escapeHtml(desc)}" />`,
            `<meta name="twitter:image" content="${escapeHtml(cardImg)}" />`,
            `<meta name="description" content="${escapeHtml(desc)}" />`,
          ].join('\n')
        );
      // seed client so card paints without flash
      html = html.replace(
        '<!--BOOT_JSON-->',
        `<script>window.__KAIRUNE_SHARE__=${JSON.stringify({
          agent,
          attestations: atts,
        }).replace(/</g, '\\u003c')};</script>`
      );
    } else {
      html = html.replace('<!--OG_META-->', '');
      html = html.replace('<!--BOOT_JSON-->', '');
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});
app.use(
  '/a',
  express.static(path.join(PUBLIC_DIR, 'a'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// Leaderboard static assets (CSS). The HTML + card.svg are handled above.
app.use(
  '/leaderboard',
  express.static(path.join(PUBLIC_DIR, 'leaderboard'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// SPA-style fallback: serve index.html for non-file requests.
// The /api path must not hit the HTML fallback → keeps API 404s as JSON.
app.get('*', (req, res, next) => {
  if (req.method !== 'GET' || path.extname(req.path)) return next();
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next(err);
  });
});

// 404 handler.
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).type('text/plain').send('404 — Not Found');
});

// Centralized error handler.
app.use((err, req, res, next) => {
  // eslint-disable-line no-unused-vars
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error(
      '[kairune] request error:',
      err && err.stack ? err.stack : err
    );
  }
  if (req.path.startsWith('/api')) {
    return res.status(status).json({
      error: err.message || 'Internal Server Error',
    });
  }
  res
    .status(status)
    .type('text/plain')
    .send(`${status} — ${err.message || 'Internal Server Error'}`);
});

// Only start the listener when run directly (not when required by a test).
if (require.main === module) {
  async function maybeSeedDev() {
    if (NODE_ENV === 'production' || process.env.TURSO_DATABASE_URL) return;
    try {
      const { getDb } = require('./src/db');
      const { seed } = require('./src/db/seed');
      const db = await getDb();
      const row = (await db.execute('SELECT COUNT(*) AS c FROM agents')).rows[0];
      if (Number(row.c) === 0) {
        console.log('[kairune] empty local DB — running demo seed…');
        await seed();
      }
    } catch (err) {
      console.warn('[kairune] dev seed skipped:', err.message);
    }
  }

  maybeSeedDev().then(() => {
  const server = app.listen(PORT, HOST, () => {
    console.log(
      `[kairune] listening on http://${HOST}:${PORT} (env: ${NODE_ENV})`
    );
  });

  // Graceful shutdown so PM2 / Docker can restart cleanly.
  const shutdown = (signal) => {
    console.log(`[kairune] ${signal} received, shutting down...`);
    server.close(() => {
      console.log('[kairune] closed remaining connections. Bye.');
      process.exit(0);
    });
    // Force-exit if connections hang for more than 10 seconds.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  ['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(sig)));

  process.on('unhandledRejection', (reason) => {
    console.error('[kairune] unhandledRejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[kairune] uncaughtException:', err);
    shutdown('uncaughtException');
  });
  });
}

module.exports = app;
