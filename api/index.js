'use strict';

/**
 * Vercel serverless entrypoint.
 * Exports the Express app from server.js. Static files (landing, /app, /assets)
 * are served directly by the Vercel CDN via rewrites in vercel.json; this
 * function only handles /api/* and /health.
 */

module.exports = require('../server');
