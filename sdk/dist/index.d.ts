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
interface KairuneOptions {
    /** Base URL of the Kairune API. Default: https://kairune.online */
    baseUrl?: string;
    /** Admin key for write operations (spend, grant, attest, webhooks). */
    adminKey?: string;
    /** Custom fetch implementation (optional, defaults to global fetch). */
    fetch?: typeof fetch;
}
interface Agent {
    id: string;
    handle: string;
    wallet: string;
    operator: string | null;
    status: 'active' | 'suspended';
    score: number;
    tier: number;
    created_at: string;
    updated_at: string;
    breakdown?: Record<string, number>;
}
interface Permission {
    id: string;
    agent_id: string;
    category: string;
    ceiling: number;
    period: 'day' | 'week' | 'month';
    status: 'active' | 'revoked';
    granted_by: string | null;
    created_at: string;
}
interface Budget {
    permission_id: string;
    agent_id: string;
    category: string;
    period: string;
    status: string;
    ceiling: number;
    used: number;
    remaining: number;
}
interface Spend {
    id: string;
    permission_id: string;
    agent_id: string;
    amount: number;
    note: string | null;
    idempotency_key?: string | null;
    created_at: string;
}
interface SpendResult {
    approved: true;
    spend: Spend;
    budget: Budget;
    /** True when this result is a replay of an earlier spend with the same idempotency key (no new charge was applied). */
    idempotent_replay?: boolean;
}
interface SpendBlocked {
    approved: false;
    error: string;
    details?: {
        requested: number;
        ceiling: number;
        used: number;
        remaining: number;
        period: string;
    };
}
/** Why a previewed spend would be blocked. `null` when it would be allowed. */
type SpendPreviewReason = 'ceiling_exceeded' | 'permission_revoked' | 'agent_suspended' | 'agent_not_found';
interface SpendPreview {
    /** Whether a real charge with these inputs would be authorized right now. */
    allowed: boolean;
    /** Machine-readable rejection reason, or `null` when allowed. */
    reason: SpendPreviewReason | null;
    /** The amount that was previewed. */
    requested: number;
    /** Current budget for the permission (unchanged — preview never charges). */
    budget: Budget;
    /** True when the idempotency key already charged, so a real call would replay. */
    idempotent_replay?: boolean;
    /** The original spend, present only on an idempotent replay. */
    spend?: Spend;
}
interface Attestation {
    id: string;
    agent_id: string;
    kind: string;
    weight: number;
    amount: number;
    note: string | null;
    created_at: string;
    verified?: boolean;
}
interface FeedEvent {
    event: 'spend.approved' | 'spend.blocked';
    agent_handle: string;
    amount: number;
    ceiling: number;
    period: string;
    reason: string | null;
    created_at: string;
}
interface Webhook {
    id: string;
    url: string;
    events: string;
    status: string;
    created_at: string;
}
interface Stats {
    total_agents: number;
    active_agents: number;
    total_attestations: number;
    active_permissions: number;
    total_spend: number;
    avg_score: number;
    tier_distribution: Array<{
        tier: number;
        c: number;
    }>;
}
interface Meta {
    attestation_kinds: string[];
    kind_weights: Record<string, number>;
    tiers: Array<{
        tier: number;
        label: string;
        threshold: number;
    }>;
    periods: string[];
    max_score: number;
}
/**
 * Trust profile for a Robinhood Chain wallet, returned by `lookupWallet`.
 * `registered: false` means the wallet is a valid address but not in the
 * registry — a useful "unknown" answer for a spend gateway.
 */
interface WalletProfile {
    registered: boolean;
    wallet: string;
    chain: string;
    chain_id: number;
    agent_id?: string;
    handle?: string;
    status?: 'active' | 'suspended';
    score?: number;
    tier?: number;
    tier_label?: string;
    max_score?: number;
    suggested_daily_ceiling?: number;
    /** active AND tier >= 1 — the go/no-go signal a gateway should key on. */
    trusted?: boolean;
    updated_at?: string;
    message?: string;
}
declare class KairuneError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body?: unknown);
}
declare class Kairune {
    private baseUrl;
    private adminKey;
    private _fetch;
    constructor(opts?: KairuneOptions);
    private headers;
    private request;
    /** Get global statistics. */
    stats(): Promise<Stats>;
    /** Get metadata (kinds, tiers, weights). */
    meta(): Promise<Meta>;
    /** Get the public spend activity feed. */
    feed(limit?: number): Promise<FeedEvent[]>;
    /** List agents (leaderboard). */
    listAgents(opts?: {
        limit?: number;
        offset?: number;
        status?: string;
    }): Promise<Agent[]>;
    /** Get a single agent by ID or handle. */
    getAgent(idOrHandle: string): Promise<Agent>;
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
    lookupWallet(wallet: string): Promise<WalletProfile>;
    /** Get attestation history for an agent. */
    getAttestations(agentId: string): Promise<Attestation[]>;
    /** Get permissions for an agent. */
    getPermissions(agentId: string): Promise<Permission[]>;
    /** Get remaining budget for a permission. */
    getBudget(permissionId: string): Promise<Budget>;
    /** Get spend history for a permission. */
    getSpends(permissionId: string, limit?: number): Promise<Spend[]>;
    /** Register a new agent. */
    registerAgent(input: {
        handle: string;
        wallet: string;
        operator?: string;
    }): Promise<Agent>;
    /** Add an attestation (triggers rescore). */
    attest(agentId: string, input: {
        kind: string;
        weight?: number;
        amount?: number;
        note?: string;
    }): Promise<Attestation>;
    /** Grant a spending permission to an agent. */
    grantPermission(agentId: string, input: {
        category: string;
        ceiling: number;
        period?: string;
    }): Promise<{
        permission: Permission;
        capped: boolean;
    }>;
    /** Revoke a permission. */
    revokePermission(permissionId: string): Promise<{
        revoked: boolean;
    }>;
    /**
     * Authorize a spend against a permission. Enforces the ceiling.
     * Returns `{ approved: true, spend, budget }` or `{ approved: false, error, details }`.
     *
     * Pass `idempotencyKey` to make the charge safe to retry: a retry that reuses
     * the same key returns the original spend without charging the budget again
     * (the result carries `idempotent_replay: true`). Strongly recommended for
     * any agent that retries on network failures.
     */
    spend(permissionId: string, input: {
        amount: number;
        note?: string;
        idempotencyKey?: string;
    }): Promise<SpendResult | SpendBlocked>;
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
    previewSpend(permissionId: string, input: {
        amount: number;
        idempotencyKey?: string;
    }): Promise<SpendPreview>;
    /** Suspend or activate an agent. */
    setAgentStatus(agentId: string, status: 'active' | 'suspended'): Promise<Agent>;
    /** Delete an agent (admin key required). */
    deleteAgent(agentId: string): Promise<{
        deleted: boolean;
    }>;
    /** Register a webhook for spend events. */
    createWebhook(input: {
        url: string;
        events?: string;
        secret?: string;
    }): Promise<{
        webhook: Webhook;
        secret: string;
    }>;
    /** List registered webhooks. */
    listWebhooks(): Promise<Webhook[]>;
    /** Delete a webhook. */
    deleteWebhook(webhookId: string): Promise<{
        deleted: boolean;
    }>;
}

export { type Agent, type Attestation, type Budget, type FeedEvent, Kairune, KairuneError, type KairuneOptions, type Meta, type Permission, type Spend, type SpendBlocked, type SpendPreview, type SpendPreviewReason, type SpendResult, type Stats, type WalletProfile, type Webhook, Kairune as default };
