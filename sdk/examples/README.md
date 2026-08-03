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

### `03-wallet-gate.ts`

The gateway pattern: check a wallet's trust **before** letting it spend, when
all you have is a Robinhood Chain address. One `lookupWallet` call answers is it
registered, is it trusted, what tier, and what daily ceiling — then the gateway
allows or denies locally. No admin key needed (it's a public read).

```bash
# grab a wallet from GET /api/agents
WALLET=0x71a2c4e83b90ff01a2b3c4d5e6f70819a2b39f0c npx tsx examples/03-wallet-gate.ts
```

### `04-spend-preview.ts`

The preview pattern: dry-run a charge with `previewSpend` to get a go/no-go
signal **before** committing. Runs the same checks as a real spend but writes
nothing and consumes no budget, so an agent can branch on the reason
(`ceiling_exceeded`, `permission_revoked`, `agent_suspended`) or pick a cheaper
path. Then commit the real charge with an idempotency key. Preview is a
point-in-time read, not a reservation — the real `spend` is always authoritative.

```bash
KAIRUNE_PERMISSION_ID=<id> COST=5 npx tsx examples/04-spend-preview.ts
```

### `05-velocity-guard.ts`

The burst-protection pattern: grant a permission with a `velocity_limit` on top
of the period ceiling, capping how fast an agent can spend (max spend per
`velocity_window_s`). A rapid over-limit spend is denied with a 429 and fires a
`spend.velocity` webhook, catching a runaway or compromised agent before it
drains the whole day's budget. The blocked result's `details` carries the
remaining burst headroom so a caller can back off and retry once the window
rolls over.

```bash
KAIRUNE_AGENT_ID=<id> npx tsx examples/05-velocity-guard.ts
```

### `06-counterparty-check.ts`

The pre-flight pattern for agent-to-agent commerce: run one `checkCounterparty`
**before** paying or trading with another agent to get a single verdict —
`proceed` / `review` / `decline` — plus every check that produced it. This is
what a fail-closed safety gate (e.g. an autonomous trading runtime) wires in
right before it signs: the runtime already enforces its own limits, this covers
the *other* side (registered? trusted? recent chargebacks/anomalies?). No admin
key needed — it's a public read, and the gate maps the verdict onto
sign / park / block locally.

```bash
# a live PRIME agent can still return decline — try it
COUNTERPARTY=0xtheir_wallet AMOUNT=250 npx tsx examples/06-counterparty-check.ts
```
