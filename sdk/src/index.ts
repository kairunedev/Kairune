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

export interface Permission {
  id: string
  agent_id: string
  category: string
  ceiling: number
  period: 'day' | 'week' | 'month'
  status: 'active' | 'revoked'
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
  details?: {
    requested: number
    ceiling: number
    used: number
    remaining: number
    period: string
  }
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
  event: 'spend.approved' | 'spend.blocked'
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

  /** Grant a spending permission to an agent. */
  async grantPermission(agentId: string, input: { category: string; ceiling: number; period?: string }): Promise<{ permission: Permission; capped: boolean }> {
    return this.request('POST', `/agents/${agentId}/permissions`, input)
  }

  /** Revoke a permission. */
  async revokePermission(permissionId: string): Promise<{ revoked: boolean }> {
    return this.request('POST', `/permissions/${permissionId}/revoke`)
  }

  /**
   * Authorize a spend against a permission. Enforces the ceiling.
   * Returns `{ approved: true, spend, budget }` or `{ approved: false, error, details }`.
   *
   * Pass `idempotencyKey` to make the charge safe to retry: a retry that reuses
   * the same key returns the original spend without charging the budget again
   * (the result carries `idempotent_replay: true`). Strongly recommended for
   * any agent that retries on network failures.
   */
  async spend(
    permissionId: string,
    input: { amount: number; note?: string; idempotencyKey?: string }
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
      if (e instanceof KairuneError && e.status === 409) {
        return {
          approved: false,
          error: e.message,
          details: (e.body as any)?.details,
        }
      }
      throw e
    }
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
