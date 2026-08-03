/**
 * Counterparty check — the go/no-go a trading runtime runs BEFORE it pays or
 * trades with another agent.
 *
 * This is the pattern a fail-closed safety gate (think an autonomous trading
 * runtime like VEX) wires in right before it signs. The runtime already
 * enforces its OWN limits — max loss, daily ceiling, capital left. What it
 * can't see on its own is the OTHER side: is this counterparty registered,
 * trusted, and free of recent chargebacks/anomalies? One call answers that and
 * returns a single verdict — proceed / review / decline — plus every check
 * that produced it, so the gate can log exactly why it stopped.
 *
 * Nothing here needs an admin key — the check is a public read. The runtime
 * makes the sign/park decision locally from the returned report.
 *
 * Run:
 *   KAIRUNE_URL=http://localhost:3000 \
 *   COUNTERPARTY=0xtheir_wallet_or_handle AMOUNT=250 \
 *     npx tsx examples/06-counterparty-check.ts
 */

import { Kairune, KairuneError, CounterpartyReport } from '@kairune/sdk'

const k = new Kairune({
  baseUrl: process.env.KAIRUNE_URL || 'https://kairune.online',
})

type GateAction = 'sign' | 'park' | 'block'

/**
 * Map a counterparty report onto a fail-closed gate action.
 *
 *   proceed → sign   (safe up to suggested_max_amount)
 *   review  → park   (needs a human tap / smaller amount)
 *   decline → block  (do not pay)
 *
 * Fails closed: anything unexpected parks rather than signs.
 */
function gateAction(report: CounterpartyReport): GateAction {
  switch (report.verdict) {
    case 'proceed':
      return 'sign'
    case 'review':
      return 'park'
    case 'decline':
      return 'block'
    default:
      return 'park'
  }
}

/**
 * Fetch a counterparty report, mapping a 404 (unknown non-wallet handle) into a
 * synthetic decline so the gate never has to catch KairuneError itself. A
 * valid-but-unregistered wallet already comes back as a first-class decline
 * from the API, so this only covers the "handle doesn't resolve" case.
 */
async function assess(
  counterparty: string,
  amount: number
): Promise<CounterpartyReport> {
  try {
    return await k.checkCounterparty(counterparty, { amount })
  } catch (e) {
    if (e instanceof KairuneError && e.status === 404) {
      return {
        registered: false,
        verdict: 'decline',
        requested_amount: amount,
        trust_independence: 0,
        suggested_max_amount: 0,
        within_suggested_ceiling: false,
        reasons: ['not_resolvable'],
        checks: [
          {
            id: 'registration',
            label: 'Registered on Kairune',
            status: 'fail',
            detail: 'counterparty could not be resolved',
          },
        ],
      }
    }
    throw e
  }
}

// A stand-in for the swap/transfer the runtime wants to sign.
async function signAndSettle(counterparty: string, amount: number): Promise<string> {
  return `signed transfer of $${amount} to ${counterparty}`
}

function printChecks(report: CounterpartyReport): void {
  const glyph = { pass: '✓', warn: '⚠', fail: '✗' } as const
  for (const c of report.checks) {
    console.log(`  ${glyph[c.status]} ${c.label} — ${c.detail}`)
  }
}

async function main() {
  const counterparty = process.env.COUNTERPARTY
  if (!counterparty) {
    console.error('set COUNTERPARTY=<0x… wallet or handle> (grab one from GET /api/agents)')
    process.exit(1)
  }
  const amount = Number(process.env.AMOUNT || '250')

  const report = await assess(counterparty, amount)

  console.log(`counterparty : ${counterparty}`)
  if (report.counterparty) {
    console.log(
      `profile      : ${report.counterparty.tier_label} ` +
        `(score ${report.counterparty.score}/${report.counterparty.max_score}, ` +
        `status ${report.counterparty.status})`
    )
  }
  console.log(`verdict      : ${report.verdict.toUpperCase()}`)
  console.log(`recommended  : max $${report.suggested_max_amount} per tx`)
  console.log(`reasons      : ${report.reasons.length ? report.reasons.join(', ') : '(none)'}`)
  console.log('checks       :')
  printChecks(report)

  const action = gateAction(report)
  console.log(`\ngate action  : ${action.toUpperCase()}`)

  if (action !== 'sign') {
    console.log(
      action === 'block'
        ? '→ blocked: not paying this counterparty.'
        : '→ parked: needs review / smaller amount before signing.'
    )
    return
  }

  const result = await signAndSettle(counterparty, amount)
  console.log(`→ ${result}`)
}

main().catch((err) => {
  console.error('fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
