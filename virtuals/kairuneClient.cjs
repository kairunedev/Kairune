'use strict';

/**
 * Kairune ACP helpers — call the live Kairune REST API to fulfill Virtuals jobs.
 */

const BASE = process.env.KAIRUNE_API_BASE || 'https://kairune.online/api';

async function kairune(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Kairune HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function shareUrl(handle) {
  return `https://kairune.online/a/${encodeURIComponent(handle)}`;
}

function normalizeOfferingName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Map Virtuals offering name → handler.
 */
function detectOffering(name) {
  const raw = String(name || '').toLowerCase().trim();
  if (raw === 'lookup_trust_score' || raw === 'lookuptrustscore') return 'lookup-trust-score';
  if (raw === 'register_agent_on_kairune' || raw === 'register_agent') return 'register-agent';
  if (raw === 'record_attestation') return 'record-attestation';
  if (raw === 'full_trust_report') return 'full-trust-report';

  const n = normalizeOfferingName(name);
  if (n.includes('lookup') || n.includes('trust score')) return 'lookup-trust-score';
  if (n.includes('register')) return 'register-agent';
  if (n.includes('attestation') || n.includes('record')) return 'record-attestation';
  if (n.includes('report') || n.includes('full trust')) return 'full-trust-report';
  return null;
}

async function fulfill(offeringId, req) {
  switch (offeringId) {
    case 'lookup-trust-score': {
      const id = req.handle_or_id;
      if (!id) throw new Error('handle_or_id required');
      const data = await kairune('/agents/' + encodeURIComponent(id));
      const a = data.agent;
      return {
        handle: a.handle,
        score: a.score,
        tier: a.tier,
        label: a.label,
        suggested_daily_ceiling: a.suggested_daily_ceiling,
        share_url: shareUrl(a.handle),
      };
    }
    case 'register-agent': {
      const data = await kairune('/agents', {
        method: 'POST',
        body: JSON.stringify({
          handle: req.handle,
          wallet: req.wallet,
          operator: req.operator || 'virtuals-acp',
        }),
      });
      const a = data.agent;
      return {
        id: a.id,
        handle: a.handle,
        score: a.score,
        share_url: shareUrl(a.handle),
      };
    }
    case 'record-attestation': {
      const id = req.handle_or_id;
      if (!id || !req.kind) throw new Error('handle_or_id and kind required');
      const data = await kairune(
        '/agents/' + encodeURIComponent(id) + '/attestations',
        {
          method: 'POST',
          body: JSON.stringify({ kind: req.kind, note: req.note }),
        }
      );
      const a = data.agent;
      return {
        handle: a.handle,
        kind: req.kind,
        score: a.score,
        label: a.label,
        share_url: shareUrl(a.handle),
      };
    }
    case 'full-trust-report': {
      const id = req.handle_or_id;
      if (!id) throw new Error('handle_or_id required');
      const data = await kairune('/agents/' + encodeURIComponent(id));
      return {
        agent: data.agent,
        attestations: data.attestations,
        permissions: data.permissions,
        share_url: shareUrl(data.agent.handle),
      };
    }
    default:
      throw new Error('Unknown offering: ' + offeringId);
  }
}

module.exports = {
  kairune,
  shareUrl,
  detectOffering,
  fulfill,
};
