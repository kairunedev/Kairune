/**
 * Kairune ACP Provider — listens for Virtuals jobs and fulfills them via kairune.online API.
 *
 * Prerequisites (from app.virtuals.io agent page):
 *   - Role: Provider
 *   - Offerings created (see offerings.json / SETUP.md)
 *   - Smart contract wallet + signer private key
 *
 * Env (see .env.example):
 *   ACP_WALLET_ADDRESS
 *   ACP_WALLET_ID
 *   ACP_SIGNER_PRIVATE_KEY
 *   ACP_BUILDER_CODE          (optional, bc-...)
 *   KAIRUNE_API_BASE          (default https://kairune.online/api)
 */

import {
  AcpAgent,
  PrivyAlchemyEvmProviderAdapter,
  AssetToken,
  robinhood,
} from '@virtuals-protocol/acp-node-v2';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { detectOffering, fulfill } = require('./kairuneClient.cjs');
const offerings = require('./offerings.json');

const PRICE_BY_ID = Object.fromEntries(
  offerings.offerings.map((o) => [o.id, o.price_usdc])
);

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function parseRequirement(content) {
  if (content == null) return {};
  if (typeof content === 'object') return content;
  try {
    return JSON.parse(content);
  } catch {
    return { raw: String(content) };
  }
}

async function main() {
  // Kairune agent is on Virtuals / Robinhood Chain — not Base.
  const seller = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: env('ACP_WALLET_ADDRESS'),
      walletId: env('ACP_WALLET_ID'),
      signerPrivateKey: env('ACP_SIGNER_PRIVATE_KEY'),
      chains: [robinhood],
      builderCode: process.env.ACP_BUILDER_CODE || undefined,
    }),
  });

  // jobId -> { offeringId, requirement, price }
  const jobs = new Map();

  seller.on('entry', async (session, entry) => {
    try {
      if (
        entry.kind === 'message' &&
        entry.contentType === 'requirement' &&
        session.status === 'open'
      ) {
        const requirement = parseRequirement(entry.content);
        const offeringName = session.job?.description || '';
        const offeringId = detectOffering(offeringName) || 'lookup-trust-score';
        const price = PRICE_BY_ID[offeringId] ?? 0.1;
        jobs.set(session.jobId, { offeringId, requirement, price });
        console.log(`[job ${session.jobId}] open "${offeringName}" → ${offeringId}`, requirement);
        await session.setBudget(AssetToken.usdc(price, session.chainId));
        return;
      }

      if (entry.kind === 'system') {
        const type = entry.event?.type;
        if (type === 'job.funded') {
          const meta = jobs.get(session.jobId);
          if (!meta) {
            console.warn(`[job ${session.jobId}] funded but no cached requirement`);
            await session.submit(
              JSON.stringify({ error: 'missing requirement cache — resubmit job' })
            );
            return;
          }
          console.log(`[job ${session.jobId}] funded — fulfilling ${meta.offeringId}`);
          const result = await fulfill(meta.offeringId, meta.requirement);
          await session.submit(JSON.stringify(result));
          console.log(`[job ${session.jobId}] submitted`, result);
        }
        if (type === 'job.completed') {
          console.log(`[job ${session.jobId}] completed`);
          jobs.delete(session.jobId);
        }
        if (type === 'job.rejected' || type === 'job.expired') {
          console.log(`[job ${session.jobId}] ${type}`);
          jobs.delete(session.jobId);
        }
      }
    } catch (err) {
      console.error(`[job ${session.jobId}] error:`, err.message || err);
      try {
        if (session.status === 'funded') {
          await session.submit(JSON.stringify({ error: String(err.message || err) }));
        }
      } catch (_) {
        /* ignore */
      }
    }
  });

  await seller.start(() => {
    console.log('Kairune ACP provider listening for jobs…');
    console.log('Offerings:', offerings.offerings.map((o) => o.name).join(' | '));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
