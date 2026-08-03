/**
 * Register the Counterparty Check offering on the Virtuals ACP registry.
 *
 * The registry exposes PUT /agents/offerings, which REPLACES the whole offerings
 * array. So this script always sends existing offerings + the new one, never just
 * the new one. Existing entries are read live from the registry at run time.
 *
 * Usage:
 *   node --env-file=.env register-offering.mjs            # dry run, prints payload
 *   node --env-file=.env register-offering.mjs --apply    # actually writes
 *
 * Auth: PUT /agents/offerings is a USER-scoped route. An agent token (from
 * /auth/agent, which the SDK signs with the Privy wallet) authenticates fine
 * but is rejected here with 401 — verified by control test: GET /jobs returns
 * 200 with the same token. So a user token is required.
 *
 * Easiest path — log in once, then run this:
 *   node login.mjs                                    # email OTP, caches token
 *   node --env-file=.env register-offering.mjs --apply
 *
 * The token is read automatically from .virtuals-session.json. Overrides, if
 * you'd rather pass one in:
 *   ACP_USER_TOKEN   — a Virtuals API token (7-day life), used directly
 *   PRIVY_TOKEN      — a Privy JWT (~1h), exchanged via /wallet/auth/privy
 *
 * Env: ACP_WALLET_ADDRESS, ACP_WALLET_ID, ACP_SIGNER_PRIVATE_KEY
 */
import { PrivyAlchemyEvmProviderAdapter, robinhood } from '@virtuals-protocol/acp-node-v2';
import { buildAgentAuthTypedData } from '@virtuals-protocol/acp-node-v2/dist/core/agentAuth.js';
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { readSession, sessionIsFresh, exchangePrivyToken } from './login.mjs';

const require = createRequire(import.meta.url);
const localOfferings = require('./offerings.json');

const SERVER = process.env.ACP_SERVER_URL || 'https://api.acp.virtuals.io';
const API2 = process.env.VIRTUALS_API2_BASE || 'https://api2.virtuals.io';
const APPLY = process.argv.includes('--apply');
const TARGET_ID = 'counterparty-check';
const REGISTRY_NAME = 'counterparty_check';

const env = (n) => {
  const v = process.env[n];
  if (!v) {
    console.error(`Missing env ${n}`);
    process.exit(1);
  }
  return v;
};

const wallet = env('ACP_WALLET_ADDRESS');

/** Strip server-managed fields so we send back only what the API owns. */
const toPayload = (o) => ({
  name: o.name,
  description: o.description,
  deliverable: o.deliverable,
  requirements: o.requirements,
  slaMinutes: o.slaMinutes,
  priceType: o.priceType,
  priceValue: o.priceValue,
  requiredFunds: o.requiredFunds ?? false,
  isHidden: o.isHidden ?? false,
  ...(o.isPrivate === undefined ? {} : { isPrivate: o.isPrivate }),
  subscriptions: o.subscriptions ?? [],
});

// ---------------------------------------------------------------------------
// 1. Read current registry state
// ---------------------------------------------------------------------------
const agentRes = await fetch(`${SERVER}/agents/wallet/${wallet}`);
if (!agentRes.ok) {
  console.error(`Could not read agent: ${agentRes.status} ${agentRes.statusText}`);
  process.exit(1);
}
const agent = (await agentRes.json()).data;
const existing = agent.offerings ?? [];

console.log(`agent          : ${agent.name} (${agent.id})`);
console.log(`existing       : ${existing.length} offerings -> ${existing.map((o) => o.name).join(', ')}`);

writeFileSync('offerings-backup.json', JSON.stringify(existing, null, 2));
console.log('backup         : virtuals/offerings-backup.json');

if (existing.some((o) => o.name === REGISTRY_NAME)) {
  console.log(`\nAlready registered as "${REGISTRY_NAME}". Nothing to do.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Build the new offering from offerings.json (single source of truth)
// ---------------------------------------------------------------------------
const src = localOfferings.offerings.find((o) => o.id === TARGET_ID);
if (!src) {
  console.error(`${TARGET_ID} not found in offerings.json`);
  process.exit(1);
}

const newOffering = {
  name: REGISTRY_NAME,
  description: src.description,
  deliverable: src.ui_paste?.deliverable_text ?? 'JSON: verdict, checks[], share_url',
  requirements: src.requirements,
  slaMinutes: src.sla_minutes,
  priceType: src.price_type ?? 'fixed',
  priceValue: src.price_usdc,
  requiredFunds: false,
  isHidden: false,
  subscriptions: [],
};

const payload = { offerings: [...existing.map(toPayload), newOffering] };

console.log(`\nwill submit    : ${payload.offerings.length} offerings`);
payload.offerings.forEach((o) => {
  const mark = o.name === REGISTRY_NAME ? '  <== NEW' : '';
  console.log(`   - ${o.name.padEnd(28)} $${String(o.priceValue).padEnd(5)} SLA ${o.slaMinutes}m${mark}`);
});

if (!APPLY) {
  console.log('\n--- DRY RUN. Payload for the new offering: ---');
  console.log(JSON.stringify(newOffering, null, 2));
  console.log('\nRe-run with --apply to write.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. Authenticate, then PUT
// ---------------------------------------------------------------------------

/** Sign in as the agent via the Privy remote signer (works, but user-scoped routes reject it). */
async function agentToken() {
  const provider = await PrivyAlchemyEvmProviderAdapter.create({
    walletAddress: wallet,
    walletId: env('ACP_WALLET_ID'),
    signerPrivateKey: env('ACP_SIGNER_PRIVATE_KEY'),
    chains: [robinhood],
  });
  const chainIds = await provider.getSupportedChainIds();
  const chainId = Number(chainIds[0]);
  const issuedAt = Date.now();
  const signature = await provider.signTypedData(
    chainId,
    buildAgentAuthTypedData({ wallet, chainId, issuedAt }),
  );
  const res = await fetch(`${SERVER}/auth/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: wallet, signature, issuedAt, chainId }),
  });
  if (!res.ok) {
    throw new Error(`agent auth failed: ${res.status} ${res.statusText} ${(await res.text()).slice(0, 200)}`);
  }
  return { token: (await res.json()).data.token, chainId };
}

let token;
let authKind;

try {
  const cached = readSession();
  if (process.env.ACP_USER_TOKEN) {
    token = process.env.ACP_USER_TOKEN;
    authKind = 'user token (ACP_USER_TOKEN)';
  } else if (process.env.PRIVY_TOKEN) {
    token = await exchangePrivyToken(process.env.PRIVY_TOKEN);
    authKind = 'user token (exchanged from PRIVY_TOKEN)';
  } else if (cached && sessionIsFresh(cached)) {
    token = cached.accessToken;
    authKind = `user token (cached session${cached.identity ? `, ${cached.identity}` : ''})`;
  } else {
    if (cached) console.warn('note           : cached session expired — run `node login.mjs` to refresh');
    const a = await agentToken();
    token = a.token;
    authKind = `agent token (chainId ${a.chainId}) — expected to be rejected by this route`;
  }
} catch (err) {
  console.error(`\nauth failed    : ${err.message}`);
  if (/Invalid access token|exchange/.test(err.message)) {
    console.error(
      [
        '',
        'A Privy JWT only lives ~1h. Easiest fix — log in from the terminal:',
        '',
        '  node login.mjs',
        '',
        'Nothing was changed. Backup is intact at virtuals/offerings-backup.json',
      ].join('\n'),
    );
  }
  process.exit(1);
}

console.log(`\nauth           : OK via ${authKind}`);

const putRes = await fetch(`${SERVER}/agents/offerings`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

const putBody = await putRes.text();
console.log(`PUT /agents/offerings : ${putRes.status} ${putRes.statusText}`);
if (!putRes.ok) {
  console.error(putBody.slice(0, 600));
  console.error('\nNothing was changed. Backup is intact at virtuals/offerings-backup.json');
  if (putRes.status === 401) {
    console.error(
      [
        '',
        'This route needs a USER token; an agent token is not enough.',
        'Log in once from the terminal, then re-run:',
        '',
        '  node login.mjs',
        '  node --env-file=.env register-offering.mjs --apply',
        '',
        'The token is cached in .virtuals-session.json (chmod 600, gitignored).',
      ].join('\n'),
    );
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Verify against the live registry
// ---------------------------------------------------------------------------
const verifyRes = await fetch(`${SERVER}/agents/wallet/${wallet}`);
const after = (await verifyRes.json()).data.offerings ?? [];
console.log(`\nregistry now   : ${after.length} offerings`);
after.forEach((o) => console.log(`   - ${o.name.padEnd(28)} $${String(o.priceValue).padEnd(5)} hidden:${o.isHidden}`));

const ok = after.some((o) => o.name === REGISTRY_NAME);
console.log(ok ? '\nOK: Counterparty Check is live on ACP.' : '\nFAILED: new offering not present.');
process.exit(ok ? 0 : 1);
