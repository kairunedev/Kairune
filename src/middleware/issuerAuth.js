'use strict';

/**
 * Issuer authentication middleware.
 *
 * Resolves an issuer from the X-Issuer-Key header and attaches it as
 * req.issuer. Responds 401 when the key is absent or invalid.
 */

const issuerService = require('../services/issuerService');

async function requireIssuer(req, res, next) {
  try {
    const apiKey = req.get('x-issuer-key') || '';
    const issuer = apiKey ? await issuerService.getIssuerByApiKey(apiKey) : null;
    if (!issuer) {
      return res.status(401).json({ error: 'Valid issuer API key required' });
    }
    req.issuer = issuer;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireIssuer };
