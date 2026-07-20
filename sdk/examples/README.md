# Kairune SDK examples

Runnable integrations for [`@kairune/sdk`](../). Each file is self-contained and
uses only the public API surface.

## Setup

```bash
# from the sdk/ directory
npm install
```

The examples import `@kairune/sdk`. To run them against the local source without
publishing, either build the SDK first (`npm run build`) or run with `tsx`, which
resolves TypeScript directly.

## Configuration

All examples read the target from the environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `KAIRUNE_URL` | `https://kairune.online` | API base URL |
| `KAIRUNE_ADMIN_KEY` | _(none)_ | required for write operations (register, attest, grant, spend) |

Point at a local server for experimentation:

```bash
export KAIRUNE_URL=http://localhost:3000
export KAIRUNE_ADMIN_KEY=dev-key   # matches ADMIN_KEY on the server
```

## Examples

### `01-quickstart.ts`

The full lifecycle: register an agent, add attestations to earn a trust score,
grant a spending permission, authorize a spend within budget, then watch an
over-budget spend get blocked.

```bash
npx tsx examples/01-quickstart.ts
```

### `02-spend-guard.ts`

The production pattern: wrap every paid action in a budget check so enforcement
lives outside the agent's own logic. A runaway loop still can't overspend.

```bash
# uses a permission id printed by the quickstart, or any active permission
KAIRUNE_PERMISSION_ID=<id> npx tsx examples/02-spend-guard.ts
```
