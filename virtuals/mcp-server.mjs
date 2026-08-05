#!/usr/bin/env node
/**
 * Kairune MCP — exposes the same capabilities as Virtuals ACP offerings
 * so any MCP-compatible client can call kairune.online directly (no ACP escrow).
 *
 * Tools mirror Jobs Offered:
 *   lookup_trust_score, register_agent_on_kairune, record_attestation, full_trust_report
 * Resources mirror Resources Offered:
 *   kairune_stats, kairune_meta
 */
import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const require = createRequire(import.meta.url);
const { fulfill, kairune } = require('./kairuneClient.cjs');

const BASE = process.env.KAIRUNE_API_BASE || 'https://kairune.online/api';
const SITE = 'https://kairune.online';

const TOOLS = [
  {
    name: 'lookup_trust_score',
    description:
      'Fetch a live Kairune trust score, tier, and suggested daily spend ceiling for any registered agent.',
    inputSchema: {
      type: 'object',
      properties: {
        handle_or_id: {
          type: 'string',
          description: 'Kairune agent handle (e.g. voyager-07) or UUID',
        },
      },
      required: ['handle_or_id'],
    },
    offeringId: 'lookup-trust-score',
  },
  {
    name: 'register_agent_on_kairune',
    description:
      'Register a new agent on the Kairune trust registry and receive baseline score + share card URL.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        wallet: { type: 'string' },
        operator: { type: 'string' },
      },
      required: ['handle', 'wallet'],
    },
    offeringId: 'register-agent',
  },
  {
    name: 'record_attestation',
    description: 'Record behavior on a Kairune agent and get the updated trust score.',
    inputSchema: {
      type: 'object',
      properties: {
        handle_or_id: { type: 'string' },
        kind: {
          type: 'string',
          enum: [
            'task_completed',
            'clean_payment',
            'peer_vouch',
            'dispute',
            'chargeback',
            'anomaly_flag',
          ],
        },
        note: { type: 'string' },
      },
      required: ['handle_or_id', 'kind'],
    },
    offeringId: 'record-attestation',
  },
  {
    name: 'full_trust_report',
    description:
      'Full Kairune report: score breakdown, recent attestations, active permissions, share URL.',
    inputSchema: {
      type: 'object',
      properties: {
        handle_or_id: { type: 'string' },
      },
      required: ['handle_or_id'],
    },
    offeringId: 'full-trust-report',
  },
  {
    name: 'counterparty_check',
    description:
      'Pre-flight go/no-go BEFORE paying or trading with another agent. Call this right before signing a swap, transfer, or payment to another party. Returns a single verdict — proceed / review / decline — plus every check behind it (registration, account status, recent chargebacks/anomalies over a 90-day decay-aware window, tier, trust-source independence, and exposure vs a recommended per-tx ceiling). Deterministic and read-only. Map it onto an approval gate as proceed=sign, review=ask a human, decline=block. A high trust score alone is not a go: a PRIME agent can still return decline.',
    inputSchema: {
      type: 'object',
      properties: {
        counterparty: {
          type: 'string',
          description:
            'The agent on the other side of the transaction: an EVM/Robinhood Chain wallet (0x…), a Kairune handle, or an id.',
        },
        amount: {
          type: 'number',
          description:
            'Optional amount (USD) you intend to pay. When supplied, enables the exposure check against the recommended per-tx ceiling.',
        },
      },
      required: ['counterparty'],
    },
    offeringId: 'counterparty-check',
  },
  {
    name: 'counterparty_compare',
    description:
      'Choose between competing counterparties in ONE call. Use this when you hold several bids/offers for the same job and must decide who to pay, instead of calling counterparty_check once per candidate. Runs the identical assessment on every candidate and returns them ranked best-first by verdict, then trust score, then trust-source independence. Read "recommended" for the answer: it is the best candidate that actually clears (verdict=proceed), or null when NONE of them clear — null means reject the whole slate and re-bid, not "pick the least-bad one". Accepts 2-10 candidates as wallets (0x…), handles, or ids; a typo\'d handle is returned in "unresolved" rather than failing the batch. Deterministic and read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        counterparties: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 10,
          description:
            'The candidates to compare: EVM/Robinhood Chain wallets (0x…), Kairune handles, or ids. 2 to 10 entries.',
        },
        amount: {
          type: 'number',
          description:
            'Optional amount (USD) you intend to pay the winner. When supplied, each candidate is also checked for exposure against its recommended per-tx ceiling, so a candidate can be demoted for being too small to take the job safely.',
        },
      },
      required: ['counterparties'],
    },
    offeringId: 'counterparty-compare',
  },
];

const RESOURCES = [
  {
    uri: 'kairune://stats',
    name: 'kairune_stats',
    description: 'Live registry counters (agents, attestations, avg score)',
    mimeType: 'application/json',
    path: '/stats',
  },
  {
    uri: 'kairune://meta',
    name: 'kairune_meta',
    description: 'Attestation kinds, weights, and tier thresholds',
    mimeType: 'application/json',
    path: '/meta',
  },
];

const server = new Server(
  { name: 'kairune', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
      isError: true,
    };
  }
  try {
    const result = await fulfill(tool.offeringId, req.params.arguments || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: String(err.message || err) }],
      isError: true,
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({
    uri,
    name,
    description,
    mimeType,
  })),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const res = RESOURCES.find((r) => r.uri === req.params.uri);
  if (!res) throw new Error(`Unknown resource: ${req.params.uri}`);
  const data = await kairune(res.path);
  return {
    contents: [
      {
        uri: res.uri,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only — stdout is MCP protocol
console.error(`Kairune MCP ready → ${BASE} | site ${SITE}`);
