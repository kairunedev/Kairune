/**
 * Velocity guard — cap how fast an agent can spend, not just how much.
 *
 * A period ceiling ($/day) stops long-run overspend, but a compromised or
 * runaway agent can still drain a whole day's budget in seconds. A velocity
 * limit adds a burst cap: at most `velocity_limit` may be spent within any
 * rolling `velocity_window_s` window. A spend that trips it is denied with a
 * 429 and fires a `spend.velocity` webhook, so operators can react to a burst
 * (possible compromise) differently from a normal budget denial.
 *
 * Run:
 *   KAIRUNE_URL=http://localhost:3000 KAIRUNE_ADMIN_KEY=dev-key \
 *   KAIRUNE_AGENT_ID=<agent-id> \
 *     npx tsx examples/05-velocity-guard.ts
 */

import { Kairune } from '@kairune/sdk'

const k = new Kairune({
  baseUrl: process.env.KAIRUNE_URL || 'https://kairune.online',
  adminKey: process.env.KAIRUNE_ADMIN_KEY,
})

async function main() {
  const agentId = process.env.KAIRUNE_AGENT_ID
  if (!agentId) {
    console.error('set KAIRUNE_AGENT_ID (a trusted agent that can hold a permission)')
    process.exit(1)
  }

  // Grant a generous daily ceiling but a tight burst cap: at most 30 per 60s.
  const { permission } = await k.grantPermission(agentId, {
    category: 'compute',
    ceiling: 100_000, // per day — plenty of headroom
    period: 'day',
    velocity_limit: 30, // ...but no more than 30
    velocity_window_s: 60, // ...within any 60-second window
  })
  console.log(
    `granted ${permission.id}: ceiling ${permission.ceiling}/day, ` +
      `burst cap ${permission.velocity_limit}/${permission.velocity_window_s}s`
  )

  // A misbehaving loop tries to fire rapid charges. The ceiling would allow it,
  // but the velocity guard cuts it off the moment the 60s window fills up.
  let spent = 0
  for (let i = 1; i <= 10; i++) {
    const decision = await k.spend(permission.id, { amount: 10, note: `burst-${i}` })
    if (decision.approved) {
      spent += 10
      console.log(`#${i} approved → ${spent} spent in this window`)
    } else {
      // decision.details carries the burst headroom so you can back off.
      const d = decision.details as
        | { velocity_remaining?: number; velocity_window_s?: number }
        | undefined
      console.log(
        `#${i} BLOCKED by velocity guard → ${decision.error}` +
          (d?.velocity_remaining !== undefined
            ? ` (only ${d.velocity_remaining} left in the window)`
            : '')
      )
      break
    }
  }

  // A preview gives the same go / no-go without charging — useful to decide
  // whether to wait for the window to roll over before retrying.
  const preview = await k.previewSpend(permission.id, { amount: 10 })
  console.log(
    preview.allowed
      ? 'preview: a 10 charge would go through now'
      : `preview: a 10 charge would be blocked (${preview.reason})`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
