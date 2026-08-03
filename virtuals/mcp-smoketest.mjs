#!/usr/bin/env node
/**
 * Smoke test the Kairune MCP server over stdio: list tools, then call
 * counterparty_check against the live API. Exits non-zero on failure.
 *
 *   node virtuals/mcp-smoketest.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, 'mcp-server.mjs')],
  env: { ...process.env, KAIRUNE_API_BASE: process.env.KAIRUNE_API_BASE || 'https://kairune.online/api' },
});

const client = new Client({ name: 'kairune-smoketest', version: '1.0.0' }, { capabilities: {} });

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
console.log('tools:', names.join(', '));

if (!names.includes('counterparty_check')) fail('counterparty_check not listed');

const res = await client.callTool({
  name: 'counterparty_check',
  arguments: { counterparty: process.env.SMOKE_COUNTERPARTY || 'kkkkkkk', amount: 100 },
});

if (res.isError) fail('counterparty_check returned an error: ' + JSON.stringify(res.content));

const report = JSON.parse(res.content[0].text);
console.log('verdict     :', report.verdict);
console.log('registered  :', report.registered);
console.log('reasons     :', JSON.stringify(report.reasons));
console.log('checks      :', Array.isArray(report.checks) ? report.checks.length + ' returned' : 'MISSING');
console.log('suggested   : $' + report.suggested_max_amount);

if (!report.verdict || !['proceed', 'review', 'decline'].includes(report.verdict)) {
  fail('unexpected verdict: ' + report.verdict);
}
if (!Array.isArray(report.checks) || report.checks.length === 0) fail('no checks returned');

console.log('\nOK: MCP counterparty_check tool is live and well-formed.');
await client.close();
process.exit(0);
