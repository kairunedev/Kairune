/**
 * Spend preview — decide before you charge.
 *
 * Sometimes an agent wants to know whether a charge *would* be approved before
 * it commits to the work — e.g. batching several paid steps and only starting
 * if the whole batch fits the budget, or picking a cheaper path when the
 * expensive one wouldn't clear. `previewSpend` runs the exact same checks as a
 * real spend (budget headroom, permission + agent status, idempotent replay)
 * but writes nothing and consumes no budget.
 *
 * Important: preview is a point-in-time read, NOT a reservation. Between the
 * preview and the real charge the budget can change, so the actual charge is
 * still the source of truth. Pair the real `spend()` with an idempotencyKey to
 * charge exactly once.
 *
 * Run:
 *   KAIRUNE_URL=http://localhost:3000 KAIRUNE_ADMIN_KEY=dev-key \
 *   KAIRUNE_PERMISSION_ID=<permission-id> \
 *     npx tsx examples/04-spend-preview.ts
 */

import { Kairune } from '@kairune/sdk'
import { randomUUID } from 'node:crypto'

const k = new Kairune({
  baseUrl: process.env.KAIRUNE_URL || 'https://kairune.online',
  adminKey: process.env.KAIRUNE_ADMIN_KEY,
})

// A stand-in for a paid tool call the agent wants to make.
async function callPaidModel(prompt: string): Promise<string> {
  return `completion for: ${prompt.slice(0, 24)}...`
}

async function main() {
  const permissionId = process.env.KAIRUNE_PERMISSION_ID
  if (!permissionId) {
    console.error('set KAIRUNE_PERMISSION_ID (run 01-quickstart.ts first to mint one)')
    process.exit(1)
  }

  const cost = Number(process.env.COST || 5)

  // 1) Dry-run: would a charge of `cost` clear right now? No budget is touched.
  const check = await k.previewSpend(permissionId, { amount: cost })

  console.log(
    `preview $${cost}: allowed=${check.allowed}` +
      (check.reason ? ` reason=${check.reason}` : '') +
      ` (remaining=$${check.budget.remaining}/${check.budget.period})`
  )

  if (!check.allowed) {
    // No charge happened. Branch on the machine-readable reason.
    switch (check.reason) {
      case 'ceiling_exceeded':
        console.log('→ skipping the expensive path; budget is exhausted for this window')
        break
      case 'permission_revoked':
        console.log('→ permission was revoked; ask the operator to re-grant')
        break
      case 'agent_suspended':
        console.log('→ agent is suspended; nothing will be authorized')
        break
      default:
        console.log('→ blocked; not charging')
    }
    return
  }

  // 2) Preview said yes. Commit the real charge with an idempotency key so a
  //    retry after a network blip never double-charges.
  const key = randomUUID()
  const result = await k.spend(permissionId, {
    amount: cost,
    note: 'preview-then-commit',
    idempotencyKey: key,
  })

  if (result.approved) {
    const out = await callPaidModel('do the paid work')
    console.log(`charged $${cost} → ${out} (remaining=$${result.budget.remaining})`)
  } else {
    // Rare: the budget changed between preview and charge (that's why the real
    // call is authoritative, not the preview).
    console.log(`charge blocked at commit time: ${result.error}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
