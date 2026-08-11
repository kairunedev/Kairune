/**
 * @kairune/sdk — Official SDK for the Kairune trust & spend layer.
 *
 * Zero dependencies. Uses native fetch (Node 18+, browsers, Deno, Bun).
 *
 * @example
 * ```ts
 * import { Kairune } from '@kairune/sdk'
 *
 * const k = new Kairune({ adminKey: 'your-admin-key' })
 *
 * // Check trust score
 * const agent = await k.getAgent('voyager-07')
 * console.log(agent.score, agent.tier)
 *
 * // Check whether a spend would go through — without charging (dry-run)
 * const check = await k.previewSpend(permissionId, { amount: 30 })
 * if (!check.allowed) console.log('would be blocked:', check.reason)
 *
 * // Authorize a spend (enforces ceiling)
 * const result = await k.spend(permissionId, { amount: 30 })
 * if (result.approved) console.log('approved, remaining:', result.budget.remaining)
 * else console.log('blocked:', result.error)
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KairuneOptions {
  /** Base URL of the Kairune API. Default: https://kairune.online */
  baseUrl?: string
  /** Admin key for write operations (spend, grant, attest, webhooks). */
  adminKey?: string
  /** Custom fetch implementation (optional, defaults to global fetch). */
  fetch?: typeof fetch
}

export interface Agent {
  id: string
  handle: string
  wallet: string
  operator: string | null
  status: 'active' | 'suspended'
  score: number
  tier: number
  created_at: string
  updated_at: string
  breakdown?: Record<string, number>
}

/**
 * Payee scope for a permission — WHO the budget may pay.
 *
 * - `open`      naming a payee is optional (legacy; the trust gate only runs
 *               when a `counterparty` is supplied)
 * - `required`  every spend must name a payee, so the trust gate always runs
 * - `allowlist` every spend must name a payee pinned to the permission
 *
 * `allowlist` implies `required`. Neither replaces the trust gate: an
 * allowlisted payee that starts failing its trust check is still refused.
 */
export type CounterpartyPolicy = 'open' | 'required' | 'allowlist'

/** One payee pinned to a permission's allowlist. */
export interface PermissionPayee {
  id: string
  permission_id: string
  /** Resolved payee agent, or `null` for a valid-but-unregistered wallet. */
  agent_id: string | null
  /** The reference as stored (handle, agent id, or lowercased wallet). */
  reference: string
  /** Optional operator note, e.g. "primary GPU vendor". */
  label?: string | null
  /** Current handle of the resolved payee, when it is registered. */
  handle?: string | null
  /** Whether the reference resolved to a registered Kairune agent. */
  registered?: boolean
  created_at: string
}

export interface Permission {
  id: string
  agent_id: string
  category: string
  ceiling: number
  period: 'day' | 'week' | 'month'
  status: 'active' | 'revoked'
  /** Optional burst cap: max spend within `velocity_window_s`. `null` = no limit. */
  velocity_limit?: number | null
  /** Rolling window (seconds) for the velocity limit. `null` when no limit is set. */
  velocity_window_s?: number | null
  /** Payee scope. Defaults to `open` for grants made before the feature existed. */
  counterparty_policy?: CounterpartyPolicy
  /** Allowlisted payees, returned when a grant seeds or updates them. */
  payees?: PermissionPayee[]
  /** ISO8601 deadline after which the grant stops authorizing. `null` = never expires. */
  expires_at?: string | null
  /** Seconds left before the deadline (`0` once passed), or `null` when there is none. */
  expires_in_s?: number | null
  /** True when the deadline has passed. The row stays `active` — expiry is not revocation. */
  expired?: boolean
  granted_by: string | null
  created_at: string
}

export interface Budget {
  permission_id: string
  agent_id: string
  category: string
  period: string
  status: string
  ceiling: number
  used: number
  remaining: number
  /** Burst cap (max spend within `velocity_window_s`), or `null` when none is set. */
  velocity_limit?: number | null
  /** Rolling window (seconds) for the velocity limit, or `null` when none is set. */
  velocity_window_s?: number | null
  /** Payee scope enforced on every spend against this permission. */
  counterparty_policy?: CounterpartyPolicy
  /** ISO8601 deadline after which the grant stops authorizing. `null` = never expires. */
  expires_at?: string | null
  /** Seconds left before the deadline (`0` once passed), or `null` when there is none. */
  expires_in_s?: number | null
  /** True when the deadline has passed, so every further spend is refused. */
  expired?: boolean
}

export interface Spend {
  id: string
  permission_id: string
  agent_id: string
  amount: number
  note: string | null
  idempotency_key?: string | null
  created_at: string
}

export interface SpendResult {
  approved: true
  spend: Spend
  budget: Budget
  /** True when this result is a replay of an earlier spend with the same idempotency key (no new charge was applied). */
  idempotent_replay?: boolean
}

export interface SpendBlocked {
  approved: false
  error: string
  /**
   * Structured rejection detail. Shape depends on why the spend was blocked:
   * a ceiling block carries `remaining`/`used`/`period`, a velocity (burst)
   * block carries `velocity_limit`/`velocity_window_s`/`velocity_remaining`.
   */
  details?: {
    requested: number
    // ceiling block
    ceiling?: number
    used?: number
    remaining?: number
    period?: string
    // velocity block
    velocity_limit?: number
    velocity_window_s?: number
    velocity_used?: number
    velocity_remaining?: number
    // counterparty block
    counterparty?: string | null
    verdict?: 'decline' | 'review' | 'proceed'
    reasons?: string[]
    registered?: boolean
    // payee-scope block (counterparty_required / counterparty_not_allowed)
    counterparty_policy?: CounterpartyPolicy
    reason?: SpendPreviewReason
    // expiry block (permission_expired)
    expires_at?: string | null
  }
}

/** Why a previewed spend would be blocked. `null` when it would be allowed. */
export type SpendPreviewReason =
  | 'ceiling_exceeded'
  | 'velocity_exceeded'
  | 'permission_revoked'
  | 'agent_suspended'
  | 'agent_not_found'
  | 'counterparty_declined'
  /** The permission's policy requires a payee, and none was named. */
  | 'counterparty_required'
  /** The named payee is not on this permission's allowlist. */
  | 'counterparty_not_allowed'
  /** The grant's deadline has passed. Extend it with `setExpiry` to resume. */
  | 'permission_expired'

export interface SpendPreview {
  /** Whether a real charge with these inputs would be authorized right now. */
  allowed: boolean
  /** Machine-readable rejection reason, or `null` when allowed. */
  reason: SpendPreviewReason | null
  /** The amount that was previewed. */
  requested: number
  /** Current budget for the permission (unchanged — preview never charges). */
  budget: Budget
  /** True when the idempotency key already charged, so a real call would replay. */
  idempotent_replay?: boolean
  /** The original spend, present only on an idempotent replay. */
  spend?: Spend
}

export interface Attestation {
  id: string
  agent_id: string
  kind: string
  weight: number
  amount: number
  note: string | null
  created_at: string
  verified?: boolean
}

export interface FeedEvent {
  event: 'spend.approved' | 'spend.blocked' | 'spend.threshold'
  agent_handle: string
  amount: number
  ceiling: number
  period: string
  reason: string | null
  created_at: string
}

export interface Webhook {
  id: string
  url: string
  events: string
  status: string
  created_at: string
}

export interface Stats {
  total_agents: number
  active_agents: number
  total_attestations: number
  active_permissions: number
  total_spend: number
  avg_score: number
  tier_distribution: Array<{ tier: number; c: number }>
}

export interface Meta {
  attestation_kinds: string[]
  kind_weights: Record<string, number>
  tiers: Array<{ tier: number; label: string; threshold: number }>
  periods: string[]
  max_score: number
}

/**
 * Trust profile for a Robinhood Chain wallet, returned by `lookupWallet`.
 * `registered: false` means the wallet is a valid address but not in the
 * registry — a useful "unknown" answer for a spend gateway.
 */
export interface WalletProfile {
  registered: boolean
  wallet: string
  chain: string
  chain_id: number
  // Present only when registered === true:
  agent_id?: string
  handle?: string
  status?: 'active' | 'suspended'
  score?: number
  tier?: number
  tier_label?: string
  max_score?: number
  suggested_daily_ceiling?: number
  /** active AND tier >= 1 — the go/no-go signal a gateway should key on. */
  trusted?: boolean
  updated_at?: string
  // Present only when registered === false:
  message?: string
}

export type CounterpartyCheckStatus = 'pass' | 'warn' | 'fail'
export type CounterpartyVerdict = 'proceed' | 'review' | 'decline'

/** One named check that fed into the counterparty verdict. */
export interface CounterpartyCheck {
  id: string
  label: string
  status: CounterpartyCheckStatus
  detail: string
}

/**
 * The result of a pre-flight counterparty check — the go/no-go an agent gets
 * before paying another agent. `verdict` is the headline; `checks` explains it.
 * An unregistered counterparty resolves to `registered: false` + a `decline`
 * verdict rather than throwing.
 */
export interface CounterpartyReport {
  registered: boolean
  /** proceed = safe · review = caution / human-in-the-loop · decline = do not pay. */
  verdict: CounterpartyVerdict
  /** The amount that was assessed, or null when none was supplied. */
  requested_amount: number | null
  /** 0..100 independence of the counterparty's verified trust (anti-farming). */
  trust_independence: number
  /** Recommended max exposure (USD) for a single transaction with this agent. */
  suggested_max_amount: number
  /** Whether requested_amount fits the recommendation; null when no amount given. */
  within_suggested_ceiling: boolean | null
  /** Codes of every check that did not pass, worst-first. */
  reasons: string[]
  /** Every check that ran, in evaluation order. */
  checks: CounterpartyCheck[]
  /** Present only when registered === true. */
  counterparty?: {
    agent_id: string
    handle: string
    wallet: string | null
    status: 'active' | 'suspended'
    score: number
    tier: number
    tier_label: string
    max_score: number
  }
  /** Raw signals behind the verdict; null when unregistered. */
  signals?: {
    tier: number
    trust_independence: number
    distinct_issuers: number
    verified_count: number
    unverified_count: number
    recent_severe_negatives: number
    recent_disputes: number
    negative_lookback_days: number
  } | null
  /** Present only when registered === false. */
  wallet?: string | null
}

/**
 * One candidate inside a counterparty comparison — the same assessment
 * `checkCounterparty` returns, flattened and given a `rank`.
 */
export interface CounterpartyCandidate {
  /** The reference as supplied by the caller (id, handle, or wallet). */
  ref: string
  /** 1-based position in the ranking; 1 is the best pick. */
  rank: number
  handle: string | null
  registered: boolean
  verdict: CounterpartyVerdict
  score: number
  tier: number
  tier_label: string | null
  trust_independence: number
  suggested_max_amount: number | null
  within_suggested_ceiling: boolean | null
  reasons: string[]
  checks: CounterpartyCheck[]
  signals: Record<string, number> | Record<string, never>
}

/**
 * The result of comparing several counterparties — "which of these do I pay?".
 *
 * `ranked` is ordered best-first by verdict, then fewest recent severe
 * negatives, then fewest disputes, then score, then trust independence, then
 * handle (so the order is deterministic across callers). Severity outranks
 * score because scores saturate: a slate can all sit at the ceiling while
 * differing wildly in recent harm.
 * `recommended` is the best candidate that actually clears; it is `null` when
 * none reach `proceed`, rather than naming a least-bad option.
 */
export interface CounterpartyComparison {
  /** The amount assessed against every candidate, or null when none was given. */
  requested_amount: number | null
  /** How many candidates produced a verdict (excludes `unresolved`). */
  candidate_count: number
  /** Best candidate with verdict `proceed`, or null when none qualifies. */
  recommended: CounterpartyCandidate | null
  /** All assessed candidates, best-first. */
  ranked: CounterpartyCandidate[]
  /** References that could not be resolved to an agent (e.g. a typo'd handle). */
  unresolved: string[]
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class KairuneError extends Error {
  status: number
  body: unknown

  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.name = 'KairuneError'
    this.status = status
    this.body = body
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class Kairune {
  private baseUrl: string
  private adminKey: string
  private _fetch: typeof fetch

  constructor(opts: KairuneOptions = {}) {
    this.baseUrl = (opts.baseUrl || 'https://kairune.online').replace(/\/$/, '')
    this.adminKey = opts.adminKey || ''
    this._fetch = opts.fetch || globalThis.fetch
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private headers(write = false): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (write && this.adminKey) h['x-admin-key'] = this.adminKey
    return h
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const isWrite = method !== 'GET'
    const res = await this._fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: { ...this.headers(isWrite), ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    })

    const data = await res.json().catch(() => null)

    if (!res.ok) {
      throw new KairuneError(
        (data as any)?.error || `HTTP ${res.status}`,
        res.status,
        data
      )
    }
    return data as T
  }

  // -------------------------------------------------------------------------
  // Read — no admin key needed
  // -------------------------------------------------------------------------

  /** Get global statistics. */
  async stats(): Promise<Stats> {
    return this.request('GET', '/stats')
  }

  /** Get metadata (kinds, tiers, weights). */
  async meta(): Promise<Meta> {
    return this.request('GET', '/meta')
  }

  /** Get the public spend activity feed. */
  async feed(limit = 20): Promise<FeedEvent[]> {
    const res = await this.request<{ events: FeedEvent[] }>('GET', `/feed?limit=${limit}`)
    return res.events
  }

  /** List agents (leaderboard). */
  async listAgents(opts?: { limit?: number; offset?: number; status?: string }): Promise<Agent[]> {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.offset) params.set('offset', String(opts.offset))
    if (opts?.status) params.set('status', opts.status)
    const q = params.toString()
    const res = await this.request<{ agents: Agent[] }>('GET', `/agents${q ? '?' + q : ''}`)
    return res.agents
  }

  /** Get a single agent by ID or handle. */
  async getAgent(idOrHandle: string): Promise<Agent> {
    const res = await this.request<{ agent: Agent }>('GET', `/agents/${encodeURIComponent(idOrHandle)}`)
    return res.agent
  }

  /**
   * Look up the live trust profile for a Robinhood Chain wallet address.
   *
   * Built for payment rails / spend gateways that only know the wallet (not
   * the internal id or handle) and need a fast go/no-go signal before
   * approving a charge. An unregistered-but-valid wallet resolves to
   * `{ registered: false, trusted: undefined }` rather than throwing, so the
   * caller can treat "unknown" as "not trusted" without special-casing 404s.
   * An invalid (non-EVM) address still throws a KairuneError(400).
   */
  async lookupWallet(wallet: string): Promise<WalletProfile> {
    try {
      return await this.request<WalletProfile>('GET', `/wallets/${encodeURIComponent(wallet)}`)
    } catch (e) {
      // 404 carries a structured { registered: false, ... } body — return it
      // as data instead of an error, since "not registered" is a valid answer.
      if (e instanceof KairuneError && e.status === 404 && e.body && typeof e.body === 'object') {
        return e.body as WalletProfile
      }
      throw e
    }
  }

  /**
   * Pre-flight trust check before paying another agent.
   *
   * The one call for agent-to-agent commerce: name a counterparty (by id,
   * handle, or `0x…` wallet) and optionally how much you mean to spend, and get
   * a single `proceed` / `review` / `decline` verdict plus the checks behind it
   * (status, tier, recent negatives, trust independence, exposure vs ceiling).
   *
   * A valid-but-unregistered wallet resolves to `{ registered: false, verdict:
   * 'decline' }` instead of throwing, so "unknown counterparty" is a normal
   * answer you can branch on. An unresolvable non-wallet reference throws
   * KairuneError(404).
   */
  async checkCounterparty(
    counterparty: string,
    opts: { amount?: number } = {}
  ): Promise<CounterpartyReport> {
    const body: { counterparty: string; amount?: number } = { counterparty }
    if (opts.amount != null) body.amount = opts.amount
    return this.request<CounterpartyReport>('POST', '/counterparty/check', body)
  }

  /**
   * Compare competing counterparties and pick one.
   *
   * `checkCounterparty` answers "is this one safe?". When you hold several bids
   * for the same job, the real question is "which of these do I pay?" — this
   * runs the identical assessment on every candidate in a single round-trip and
   * returns them ranked by one documented rule (verdict, then fewest recent
   * severe negatives, then fewest disputes, then score, then trust
   * independence, then handle), so two callers comparing the same agents always
   * agree on the winner.
   *
   * Read `recommended` for the answer. It is `null` when no candidate reaches
   * `proceed` — deliberately not "the least-bad one" — so treat null as "reject
   * this whole slate" and inspect `ranked` only if you want to override that
   * knowingly.
   *
   * Requires 2..10 candidates. A typo'd handle lands in `unresolved` instead of
   * failing the batch; a valid-but-unregistered `0x…` wallet is still ranked
   * (as a `decline`). Throws KairuneError(404) only when nothing resolves.
   */
  async compareCounterparties(
    counterparties: string[],
    opts: { amount?: number } = {}
  ): Promise<CounterpartyComparison> {
    const body: { counterparties: string[]; amount?: number } = { counterparties }
    if (opts.amount != null) body.amount = opts.amount
    return this.request<CounterpartyComparison>('POST', '/counterparty/compare', body)
  }

  /** Get attestation history for an agent. */
  async getAttestations(agentId: string): Promise<Attestation[]> {
    const res = await this.request<{ attestations: Attestation[] }>('GET', `/agents/${agentId}/attestations`)
    return res.attestations
  }

  /** Get permissions for an agent. */
  async getPermissions(agentId: string): Promise<Permission[]> {
    const res = await this.request<{ permissions: Permission[] }>('GET', `/agents/${agentId}/permissions`)
    return res.permissions
  }

  /** Get remaining budget for a permission. */
  async getBudget(permissionId: string): Promise<Budget> {
    const res = await this.request<{ budget: Budget }>('GET', `/permissions/${permissionId}/budget`)
    return res.budget
  }

  /** Get spend history for a permission. */
  async getSpends(permissionId: string, limit = 50): Promise<Spend[]> {
    const res = await this.request<{ spends: Spend[] }>('GET', `/permissions/${permissionId}/spends?limit=${limit}`)
    return res.spends
  }

  // -------------------------------------------------------------------------
  // Write — requires admin key
  // -------------------------------------------------------------------------

  /** Register a new agent. */
  async registerAgent(input: { handle: string; wallet: string; operator?: string }): Promise<Agent> {
    const res = await this.request<{ agent: Agent }>('POST', '/agents', input)
    return res.agent
  }

  /** Add an attestation (triggers rescore). */
  async attest(agentId: string, input: { kind: string; weight?: number; amount?: number; note?: string }): Promise<Attestation> {
    const res = await this.request<{ attestation: Attestation }>('POST', `/agents/${agentId}/attestations`, input)
    return res.attestation
  }

  /**
   * Grant a spending permission to an agent.
   *
   * Pass `velocity_limit` to add a burst cap on top of the period ceiling: at
   * most that amount may be spent within `velocity_window_s` seconds (default
   * 60). A spend that trips it is denied and fires a `spend.velocity` webhook,
   * catching a runaway or compromised agent before it drains the whole budget.
   *
   * Pass `counterparty_policy` to scope WHO the budget may pay. `required`
   * makes naming a payee mandatory (so the trust gate can never be skipped by
   * omitting it); `allowlist` additionally restricts spends to the `payees` you
   * pin here — "this budget may only ever pay these vendors". An `allowlist`
   * grant requires a non-empty `payees` array.
   *
   * Pass `expires_in_s` (or an absolute `expires_at`) to make the grant
   * time-bound: once the deadline passes it stops authorizing on its own, so a
   * budget delegated for one job does not stay live because nobody remembered
   * to revoke it. Omit both for a grant that never expires.
   */
  async grantPermission(
    agentId: string,
    input: {
      category: string
      ceiling: number
      period?: string
      velocity_limit?: number
      velocity_window_s?: number
      counterparty_policy?: CounterpartyPolicy
      /** Payee references (id / handle / wallet). Required for `allowlist`. */
      payees?: string[]
      /** Lifetime in seconds from now (max 365 days). Mutually exclusive with `expires_at`. */
      expires_in_s?: number
      /** Absolute ISO8601 deadline. Mutually exclusive with `expires_in_s`. */
      expires_at?: string
    }
  ): Promise<{ permission: Permission; capped: boolean }> {
    return this.request('POST', `/agents/${agentId}/permissions`, input)
  }

  /** Revoke a permission. */
  async revokePermission(permissionId: string): Promise<{ revoked: boolean }> {
    return this.request('POST', `/permissions/${permissionId}/revoke`)
  }

  /** List the payees allowlisted on a permission, plus its current policy. */
  async listPayees(
    permissionId: string
  ): Promise<{ counterparty_policy: CounterpartyPolicy; payees: PermissionPayee[] }> {
    return this.request('GET', `/permissions/${permissionId}/payees`)
  }

  /**
   * Pin a payee to a permission's allowlist.
   *
   * The reference is resolved to a Kairune agent when possible, so an entry
   * added by handle still matches a spend that names the same payee by wallet.
   * A valid-but-unregistered wallet is accepted — the allowlist declares scope,
   * not trust, so it is still refused by the trust gate until it registers.
   */
  async addPayee(
    permissionId: string,
    counterparty: string,
    input: { label?: string } = {}
  ): Promise<{ payee: PermissionPayee }> {
    return this.request('POST', `/permissions/${permissionId}/payees`, {
      counterparty,
      ...input,
    })
  }

  /** Remove a payee from a permission's allowlist (by row id or reference). */
  async removePayee(
    permissionId: string,
    reference: string
  ): Promise<{ removed: PermissionPayee }> {
    return this.request(
      'DELETE',
      `/permissions/${permissionId}/payees/${encodeURIComponent(reference)}`
    )
  }

  /**
   * Change a permission's payee scope in place.
   *
   * Lets you TIGHTEN an existing grant (e.g. `open` → `allowlist`) without
   * revoking and re-granting, so the permission id and its spend history
   * survive. Switching to `allowlist` requires at least one payee — supply them
   * via `payees` if the allowlist is still empty.
   */
  async setCounterpartyPolicy(
    permissionId: string,
    counterparty_policy: CounterpartyPolicy,
    input: { payees?: string[] } = {}
  ): Promise<{ permission: Permission }> {
    return this.request('POST', `/permissions/${permissionId}/counterparty-policy`, {
      counterparty_policy,
      ...input,
    })
  }

  /**
   * Set, extend, or clear a permission's expiry deadline.
   *
   * Extending keeps the permission id and its spend history, so a renewed grant
   * does not reset the period's used budget. Call with no arguments to remove
   * the deadline entirely (back to never expires).
   *
   * An already-expired grant can be revived this way — the response carries
   * `revived: true`. A revoked permission cannot: revocation is final by
   * design, and re-granting is the explicit path back.
   */
  async setExpiry(
    permissionId: string,
    input: {
      /** Lifetime in seconds from now (max 365 days). Mutually exclusive with `expires_at`. */
      expires_in_s?: number
      /** Absolute ISO8601 deadline. Mutually exclusive with `expires_in_s`. */
      expires_at?: string
    } = {}
  ): Promise<{ permission: Permission & { revived?: boolean } }> {
    return this.request('POST', `/permissions/${permissionId}/expiry`, input)
  }

  /**
   * Authorize a spend against a permission. Enforces the ceiling — and the
   * burst (velocity) limit when the permission has one.
   * Returns `{ approved: true, spend, budget }` or `{ approved: false, error, details }`.
   * A blocked spend (ceiling or velocity) resolves as `approved: false`; only
   * an unexpected error throws.
   *
   * Pass `idempotencyKey` to make the charge safe to retry: a retry that reuses
   * the same key returns the original spend without charging the budget again
   * (the result carries `idempotent_replay: true`). Strongly recommended for
   * any agent that retries on network failures.
   *
   * Pass `counterparty` (the payee's id, handle, or wallet) to gate the charge
   * on Kairune's trust check: a payment to a payee whose verdict is `decline`
   * (unregistered, suspended, or recently charged-back) is refused before any
   * budget is touched, resolving as `approved: false` with `verdict: 'decline'`.
   *
   * When the permission's `counterparty_policy` is `required` or `allowlist`,
   * `counterparty` is mandatory: omitting it is refused with
   * `counterparty_required`, and naming a payee outside an allowlist is refused
   * with `counterparty_not_allowed` — both before any budget is touched.
   */
  async spend(
    permissionId: string,
    input: { amount: number; note?: string; idempotencyKey?: string; counterparty?: string }
  ): Promise<SpendResult | SpendBlocked> {
    const { idempotencyKey, ...body } = input
    const headers = idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined
    try {
      const res = await this.request<{ spend: Spend; budget: Budget; idempotent_replay?: boolean }>(
        'POST',
        `/permissions/${permissionId}/spends`,
        body,
        headers
      )
      return { approved: true, ...res }
    } catch (e) {
      // A blocked spend is a normal outcome, not an exception: 409 = ceiling
      // exceeded / revoked / suspended, 429 = velocity (burst) limit tripped.
      if (e instanceof KairuneError && (e.status === 409 || e.status === 429)) {
        return {
          approved: false,
          error: e.message,
          details: (e.body as any)?.details,
        }
      }
      throw e
    }
  }

  /**
   * Preview a spend WITHOUT charging — a go / no-go dry-run.
   *
   * Runs the exact same checks as {@link spend} (budget headroom, permission
   * status, agent status, idempotent replay) but writes nothing and consumes
   * no budget. Use it to decide before committing a charge.
   *
   * Always resolves with `{ allowed, reason, budget }`; `reason` is a
   * machine-readable string when blocked (e.g. `'ceiling_exceeded'`) and
   * `null` when allowed. A malformed amount or idempotency key still throws.
   *
   * Note: preview is a point-in-time read, not a reservation — the budget can
   * change between preview and charge. Pair it with an `idempotencyKey` on the
   * real {@link spend} call to charge exactly once.
   */
  async previewSpend(
    permissionId: string,
    input: { amount: number; idempotencyKey?: string; counterparty?: string }
  ): Promise<SpendPreview> {
    const { idempotencyKey, ...body } = input
    const headers = idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined
    return this.request<SpendPreview>(
      'POST',
      `/permissions/${permissionId}/spends/preview`,
      body,
      headers
    )
  }

  /** Suspend or activate an agent. */
  async setAgentStatus(agentId: string, status: 'active' | 'suspended'): Promise<Agent> {
    const res = await this.request<{ agent: Agent }>('PATCH', `/agents/${agentId}/status`, { status })
    return res.agent
  }

  /** Delete an agent (admin key required). */
  async deleteAgent(agentId: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/agents/${agentId}`)
  }

  /** Register a webhook for spend events. */
  async createWebhook(input: { url: string; events?: string; secret?: string }): Promise<{ webhook: Webhook; secret: string }> {
    return this.request('POST', '/webhooks', input)
  }

  /** List registered webhooks. */
  async listWebhooks(): Promise<Webhook[]> {
    const res = await this.request<{ webhooks: Webhook[] }>('GET', '/webhooks')
    return res.webhooks
  }

  /** Delete a webhook. */
  async deleteWebhook(webhookId: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/webhooks/${webhookId}`)
  }
}

export default Kairune
