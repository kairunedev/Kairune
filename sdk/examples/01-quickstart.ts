/**
 * Quickstart — the full lifecycle an integrating team runs once.
 *
 *   register agent → add attestations → check trust score
 *   → grant a spend permission → authorize spends → hit the ceiling
 *
 * Run:
 *   KAIRUNE_URL=http://localhost:3000 KAIRUNE_ADMIN_KEY=dev-key \
 *     npx tsx examples/01-quickstart.ts
 *
 * Against production:
 *   KAIRUNE_URL=https://kairune.online KAIRUNE_ADMIN_KEY=... \
 *     npx tsx examples/01-quickstart.ts
 */

import { Kairune, KairuneError } from '@kairune/sdk'

const k = new Kairune({
  baseUrl: process.env.KAIRUNE_URL || 'https://kairune.online',
  adminKey: process.env.KAIRUNE_ADMIN_KEY,
})

async function main() {
  // A unique handle so the example is re-runnable.
  const handle = `voyager-${Date.now().toString(36)}`
  const wallet = `0x${Date.now().toString(16).padStart(40, '0')}`

  // 1. Register the agent.
  const agent = await k.registerAgent({ handle, wallet, operator: 'quickstart' })
  console.log(`registered ${agent.handle}  score=${agent.score}  tier=${agent.tier}`)

  // 2. Earn trust. Attestations reweight the score. A fresh agent starts below
  //    the threshold (250 = tier 1) needed to receive any spend permission.
  //
  //    Note: attestations submitted without an issuer signature count at 25%
  //    weight (anti-gaming). In production, issuers sign attestations via
  //    POST /api/issuers/:id/keys + a signed payload, which count at full
  //    weight — so far fewer are needed. Here we submit a batch of unsigned
  //    ones to cross the threshold in a self-contained script.
  const kinds = ['task_completed', 'clean_payment', 'peer_vouch'] as const
  for (let i = 0; i < 21; i++) {
    await k.attest(agent.id, { kind: kinds[i % kinds.length], note: `history #${i + 1}` })
  }

  // 3. Re-read the score after attestations settle.
  const scored = await k.getAgent(agent.id)
  console.log(`after attestations  score=${scored.score}  tier=${scored.tier}`)
  if (scored.tier < 1) {
    console.error('agent did not reach tier 1 — cannot receive a permission')
    process.exit(1)
  }

  // 4. Grant a spending permission. `capped` is true when the requested
  //    ceiling was reduced to what the agent's tier allows.
  const { permission, capped } = await k.grantPermission(agent.id, {
    category: 'compute',
    ceiling: 5,
    period: 'day',
  })
  console.log(
    `granted ${permission.category} $${permission.ceiling}/${permission.period}` +
      (capped ? '  (capped to tier limit)' : '')
  )

  // 5. Authorize a spend within budget.
  const first = await k.spend(permission.id, { amount: 1, note: 'openai call' })
  if (first.approved) {
    console.log(`spend $1 approved  remaining=$${first.budget.remaining}`)
  }

  // 6. Try to overspend — this is the whole point of the layer.
  const over = await k.spend(permission.id, { amount: 74, note: 'runaway loop' })
  if (!over.approved) {
    console.log(`spend $74 BLOCKED — ${over.error}`)
  } else {
    console.error('expected the $74 spend to be blocked')
    process.exitCode = 1
  }

  // 7. Confirm the ledger reflects exactly one approved spend.
  const budget = await k.getBudget(permission.id)
  const spends = await k.getSpends(permission.id)
  console.log(
    `ledger: used=$${budget.used} remaining=$${budget.remaining} entries=${spends.length}`
  )
}

main().catch((err) => {
  if (err instanceof KairuneError) {
    console.error(`Kairune API error ${err.status}: ${err.message}`)
    if (err.status === 401) {
      console.error('→ set KAIRUNE_ADMIN_KEY for write operations')
    }
  } else {
    console.error(err)
  }
  process.exit(1)
})
