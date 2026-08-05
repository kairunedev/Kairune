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
  if (raw === 'counterparty_check' || raw === 'counterpartycheck') return 'counterparty-check';
  if (raw === 'counterparty_compare' || raw === 'counterpartycompare') return 'counterparty-compare';

  const n = normalizeOfferingName(name);
  // Compare is checked before the single check so that a phrase containing both
  // "counterparty" and "compare" routes to the batch handler, not the single one.
  if (
    n.includes('compare') ||
    n.includes('choose') ||
    n.includes('pick') ||
    n.includes('rank counterpart') ||
    n.includes('which provider') ||
    n.includes('which agent') ||
    n.includes('best bid') ||
    n.includes('shortlist')
  ) {
    return 'counterparty-compare';
  }
  if (n.includes('counterparty') || n.includes('pre flight') || n.includes('go no go')) return 'counterparty-check';
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
    case 'counterparty-check': {
      const counterparty = req.counterparty || req.handle_or_id || req.wallet;
      if (!counterparty) throw new Error('counterparty (wallet, handle, or id) required');
      const body = { counterparty };
      if (req.amount != null) body.amount = Number(req.amount);
      const data = await kairune('/counterparty/check', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return {
        registered: data.registered,
        verdict: data.verdict,
        requested_amount: data.requested_amount,
        suggested_max_amount: data.suggested_max_amount,
        within_suggested_ceiling: data.within_suggested_ceiling,
        trust_independence: data.trust_independence,
        reasons: data.reasons,
        checks: data.checks,
        counterparty: data.counterparty || null,
        signals: data.signals || null,
        share_url: data.counterparty ? shareUrl(data.counterparty.handle) : null,
      };
    }
    case 'counterparty-compare': {
      // Accept the several shapes an ACP job description might carry the slate
      // in, plus a comma/whitespace-separated string for plain-text jobs.
      let list = req.counterparties || req.candidates || req.agents || req.wallets;
      if (typeof list === 'string') {
        list = list.split(/[,\s]+/).filter(Boolean);
      }
      if (!Array.isArray(list) || list.length < 2) {
        throw new Error('counterparties must be an array of at least 2 wallets, handles, or ids');
      }
      const body = { counterparties: list };
      if (req.amount != null) body.amount = Number(req.amount);
      const data = await kairune('/counterparty/compare', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return {
        requested_amount: data.requested_amount,
        candidate_count: data.candidate_count,
        recommended: data.recommended,
        ranked: data.ranked,
        unresolved: data.unresolved,
        share_url: data.recommended?.handle ? shareUrl(data.recommended.handle) : null,
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
