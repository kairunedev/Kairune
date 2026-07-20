/**
 * Spend guard — the pattern an agent actually integrates in production.
 *
 * Before any paid action (an LLM call, an API purchase, a transfer) the agent
 * asks Kairune to authorize it. If Kairune approves, the action runs. If the
 * budget is exhausted, the action never fires. Enforcement lives outside the
 * agent's own logic, so a buggy or jailbroken loop still can't overspend.
 *
 * Run:
 *   KAIRUNE_URL=http://localhost:3000 KAIRUNE_ADMIN_KEY=dev-key \
 *   KAIRUNE_PERMISSION_ID=<permission-id> \
 *     npx tsx examples/02-spend-guard.ts
 */

import { Kairune } from '@kairune/sdk'

const k = new Kairune({
  baseUrl: process.env.KAIRUNE_URL || 'https://kairune.online',
  adminKey: process.env.KAIRUNE_ADMIN_KEY,
})

/**
 * Run `action` only if Kairune authorizes a spend of `cost` against
 * `permissionId`. Throws BudgetExceeded when the spend is blocked, so the
 * paid action is never invoked.
 */
class BudgetExceeded extends Error {
  constructor(public reason: string) {
    super(reason)
    this.name = 'BudgetExceeded'
  }
}

async function guardedSpend<T>(
  permissionId: string,
  cost: number,
  note: string,
  action: () => Promise<T>
): Promise<T> {
  const decision = await k.spend(permissionId, { amount: cost, note })
  if (!decision.approved) {
    throw new BudgetExceeded(decision.error)
  }
  try {
    return await action()
  } catch (err) {
    // The action failed after the spend was recorded. In a real system you'd
    // reconcile here (refund/credit). We surface it so the caller can decide.
    console.warn(`action failed after spend was authorized: ${(err as Error).message}`)
    throw err
  }
}

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

  // The agent loops, wanting to make a paid call each iteration. Kairune stops
  // it the moment the budget runs dry — no bookkeeping in the agent itself.
  for (let i = 1; i <= 100; i++) {
    try {
      const out = await guardedSpend(permissionId, 1, `loop-${i}`, () =>
        callPaidModel(`iteration ${i}`)
      )
      console.log(`#${i} ran → ${out}`)
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        console.log(`#${i} stopped by budget guard → ${err.reason}`)
        break
      }
      throw err
    }
  }

  const budget = await k.getBudget(permissionId)
  console.log(`final: used=$${budget.used} of $${budget.ceiling}/${budget.period}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
