# @kairune/sdk

Official SDK for the [Kairune](https://kairune.online) trust & spend layer for AI agents.

Zero dependencies. Uses native `fetch` (Node 18+, browsers, Deno, Bun).

## Install

```bash
npm install @kairune/sdk
```

## Quick start

```ts
import { Kairune } from '@kairune/sdk'

const k = new Kairune({ adminKey: 'your-admin-key' })

// Check an agent's trust score
const agent = await k.getAgent('voyager-07')
console.log(agent.score, agent.tier) // 381, 1

// Authorize a spend (enforces ceiling)
const result = await k.spend(permissionId, { amount: 30 })
if (result.approved) {
  console.log('✓ approved, remaining:', result.budget.remaining)
} else {
  console.log('✕ blocked:', result.error)
}
```

## Read-only (no admin key needed)

```ts
const k = new Kairune() // defaults to https://kairune.online

await k.stats()           // global stats
await k.meta()            // tiers, weights, kinds
await k.feed(10)          // live spend decisions
await k.listAgents()      // leaderboard
await k.getAgent(id)      // single agent + score
await k.getBudget(pid)    // remaining budget
```

## Write operations (admin key required)

```ts
const k = new Kairune({ adminKey: process.env.KAIRUNE_ADMIN_KEY })

// Register agent
await k.registerAgent({ handle: 'my-agent', wallet: '0x...' })

// Build trust
await k.attest(agentId, { kind: 'task_completed', amount: 50 })

// Grant permission ($100/day for compute)
const { permission } = await k.grantPermission(agentId, {
  category: 'compute',
  ceiling: 100,
  period: 'day'
})

// Spend against it
await k.spend(permission.id, { amount: 30, note: 'gpu-hours' })

// Safe retries: pass an idempotencyKey so a retried charge is applied only
// once. A replay returns the original spend with `idempotent_replay: true`
// and the budget is never charged twice.
const r = await k.spend(permission.id, { amount: 30, idempotencyKey: 'order-42' })
if (r.approved && r.idempotent_replay) {
  // this was a retry — no new charge happened
}

// Webhooks
await k.createWebhook({ url: 'https://your-backend.com/kairune' })
```

## Custom base URL

```ts
const k = new Kairune({ baseUrl: 'http://localhost:3000' })
```

## Error handling

```ts
import { KairuneError } from '@kairune/sdk'

try {
  await k.spend(pid, { amount: 9999 })
} catch (e) {
  if (e instanceof KairuneError && e.status === 409) {
    console.log('blocked:', e.body)
  }
}
```

## Links

- Product: https://kairune.online
- Console: https://kairune.online/app
- Docs: https://kairune.online/docs
- GitHub: https://github.com/kairunedev/Kairune
- npm: https://www.npmjs.com/package/@kairune/sdk
