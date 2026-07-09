'use strict';

/**
 * Kairune static site server.
 * Serves the landing page (index.html + assets) with gzip compression,
 * long-lived caching for hashed assets, a health-check endpoint, and a
 * graceful shutdown handler for clean PM2 / container restarts.
 */

const path = require('path');
const express = require('express');
const compression = require('compression');
const apiRouter = require('./src/routes/api');

// Configuration comes from the environment (no secret values are hard-coded).
const PORT = parseInt(process.env.PORT, 10) || 3040;
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const PUBLIC_DIR = __dirname;

const app = express();

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
  res.status(200).json({
    status: 'ok',
    service: 'kairune',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
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
