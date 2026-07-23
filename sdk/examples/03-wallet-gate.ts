/**
 * Wallet gate — check a wallet's trust BEFORE letting it spend.
 *
 * This is the pattern a payment rail, checkout, or spend gateway uses when all
 * it knows is a Robinhood Chain wallet address (not an internal id or handle).
 * One lookup answers: is this wallet registered, is it trusted, what tier is
 * it, and how much is it reasonable to let it spend per day?
 *
 * Nothing here needs an admin key — the lookup is a public read. The gateway
 * makes the allow/deny decision locally from the returned profile.
 *
 * Run:
 *   KAIRUNE_URL=http://localhost:3000 \
 *   WALLET=0x71a2c4e83b90ff01a2b3c4d5e6f70819a2b39f0c \
 *     npx tsx examples/03-wallet-gate.ts
 */

import { Kairune, KairuneError, WalletProfile } from '@kairune/sdk'

const k = new Kairune({
  baseUrl: process.env.KAIRUNE_URL || 'https://kairune.online',
})

/**
 * Fetch a wallet's profile, mapping an invalid-address 400 into a "not
 * trusted" profile so the caller never has to catch KairuneError itself.
 */
async function fetchProfile(wallet: string): Promise<WalletProfile> {
  try {
    return await k.lookupWallet(wallet)
  } catch (e) {
    if (e instanceof KairuneError && e.status === 400) {
      return {
        registered: false,
        wallet,
        chain: 'Robinhood Chain',
        chain_id: 4663,
        message: e.message,
      }
    }
    throw e
  }
}

/**
 * Pure allow/deny decision from a profile + requested amount. Returns null to
 * ALLOW, or a reason string to DENY — no side effects, easy to unit test.
 *
 * A real gateway would layer its own rolling-window accounting on top; here we
 * use the suggested ceiling as a single-shot sanity bound to keep it small.
 */
function denyReason(profile: WalletProfile, amount: number): string | null {
  if (!profile.registered) {
    return profile.message || 'wallet is not registered in the trust registry'
  }
  if (!profile.trusted) {
    return `wallet is not trusted (status=${profile.status}, tier=${profile.tier})`
  }
  const ceiling = profile.suggested_daily_ceiling ?? 0
  if (amount > ceiling) {
    return `amount $${amount} exceeds suggested daily ceiling $${ceiling} for tier ${profile.tier}`
  }
  return null
}

// A stand-in for whatever the wallet is paying for.
async function fulfilOrder(wallet: string, amount: number): Promise<string> {
  return `order fulfilled for ${wallet.slice(0, 10)}… ($${amount})`
}

async function main() {
  const wallet = process.env.WALLET
  if (!wallet) {
    console.error('set WALLET=<0x…> (grab one from GET /api/agents)')
    process.exit(1)
  }
  const amount = Number(process.env.AMOUNT || '25')

  const profile = await fetchProfile(wallet)
  console.log('profile:', JSON.stringify(profile, null, 2))

  const reason = denyReason(profile, amount)
  if (reason) {
    console.log(`DENY  → ${reason}`)
    return
  }

  const result = await fulfilOrder(wallet, amount)
  console.log(`ALLOW → ${result}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
