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
    created_at: string;
}
interface SpendResult {
    approved: true;
    spend: Spend;
    budget: Budget;
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
     */
    spend(permissionId: string, input: {
        amount: number;
        note?: string;
    }): Promise<SpendResult | SpendBlocked>;
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

export { type Agent, type Attestation, type Budget, type FeedEvent, Kairune, KairuneError, type KairuneOptions, type Meta, type Permission, type Spend, type SpendBlocked, type SpendResult, type Stats, type Webhook, Kairune as default };
