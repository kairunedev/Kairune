'use strict';

/**
 * Demo seed data for Kairune (async / libSQL).
 * Creates several agents with different attestation histories so the
 * dashboard is populated with realistic data right away.
 *
 * Run: node src/db/seed.js  (optional: --reset to clear existing data)
 * Works for local (file) and Turso remote (reads the env automatically).
 */

const crypto = require('crypto');
const { getDb, closeDb } = require('./index');
const agentService = require('../services/agentService');
const permissionService = require('../services/permissionService');
const { KIND_WEIGHTS } = require('../services/trustScore');

// Subtract days from now → ISO string (simulates history).
function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

const SEED_AGENTS = [
  {
    handle: 'voyager-07',
    wallet: '0x71a2c4e83b90ff01a2b3c4d5e6f70819a2b39f0c',
    operator: 'Helios Labs',
    events: [
      ...Array(60).fill('task_completed'),
      ...Array(40).fill('clean_payment'),
      ...Array(12).fill('peer_vouch'),
    ],
  },
  {
    handle: 'scout-14',
    wallet: '0x4c1e77ab22cd33ef44a05b16c27d38e49f5a22ab',
    operator: 'Northwind',
    events: [
      ...Array(30).fill('task_completed'),
      ...Array(18).fill('clean_payment'),
      ...Array(5).fill('peer_vouch'),
      'dispute',
    ],
  },
  {
    handle: 'relay-02',
    wallet: '0x9b3055e1a7c8d9e0f1a2b3c4d5e6f7089b3077e1',
    operator: 'Meshworks',
    events: [
      ...Array(14).fill('task_completed'),
      ...Array(8).fill('clean_payment'),
      'peer_vouch',
    ],
  },
  {
    handle: 'nomad-31',
    wallet: '0xa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
    operator: 'Driftless',
    events: [
      ...Array(6).fill('task_completed'),
      ...Array(3).fill('clean_payment'),
      'chargeback',
      'anomaly_flag',
    ],
  },
  {
    handle: 'pilot-09',
    wallet: '0xf0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3',
    operator: 'Skybridge',
    events: [...Array(3).fill('task_completed')],
  },
];

async function reset(db) {
  await db.execute('DELETE FROM permissions');
  await db.execute('DELETE FROM attestations');
  await db.execute('DELETE FROM agents');
  console.log('[seed] existing data cleared');
}

async function seed() {
  const db = await getDb();
  const doReset = process.argv.includes('--reset');

  // Safety: this seeds SYNTHETIC demo agents. It must never silently run
  // against production (or a Turso remote), or it will pollute real data.
  // Callers that genuinely want demo data in prod must pass --allow-prod.
  const isProd =
    process.env.NODE_ENV === 'production' || !!process.env.TURSO_DATABASE_URL;
  const allowProd =
    process.argv.includes('--allow-prod') || process.env.SEED_ALLOW_PROD === '1';
  if (isProd && !allowProd) {
    console.log(
      '[seed] refusing to seed demo data in production. ' +
        'Pass --allow-prod (or SEED_ALLOW_PROD=1) only if you really mean it.'
    );
    return;
  }

  const existing = (await db.execute('SELECT COUNT(*) c FROM agents')).rows[0].c;
  if (existing > 0 && !doReset) {
    console.log(
      `[seed] ${existing} agent(s) already exist — skipping (use --reset to overwrite)`
    );
    return;
  }
  if (doReset) await reset(db);

  for (const spec of SEED_AGENTS) {
    const agent = await agentService.createAgent({
      handle: spec.handle,
      wallet: spec.wallet,
      operator: spec.operator,
    });

    // Spread events across roughly the last 120 days with historical timestamps.
    for (let i = 0; i < spec.events.length; i++) {
      const kind = spec.events[i];
      const spread = Math.floor((i / spec.events.length) * 120);
      await db.execute({
        sql: `INSERT INTO attestations (id, agent_id, kind, weight, amount, note, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          crypto.randomUUID(), agent.id, kind, KIND_WEIGHTS[kind], 0, null,
          daysAgo(120 - spread),
        ],
      });
    }

    const scored = await agentService.recalcAgent(agent.id);
    console.log(
      `[seed] ${scored.handle.padEnd(12)} score=${String(scored.score).padStart(
        4
      )} tier=${scored.tier} (${scored.label})`
    );

    if (scored.tier >= 2) {
      try {
        await permissionService.grantPermission(agent.id, {
          category: 'compute',
          ceiling: 500,
          period: 'day',
          granted_by: 'seed',
        });
      } catch (_) {
        /* ignore if the tier is too low */
      }
    }
  }
  console.log('[seed] done.');
}

if (require.main === module) {
  seed()
    .catch((err) => {
      console.error('[seed] error:', err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}

module.exports = { seed };
