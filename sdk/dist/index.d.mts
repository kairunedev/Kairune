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
type CounterpartyPolicy = 'open' | 'required' | 'allowlist';
/** One payee pinned to a permission's allowlist. */
interface PermissionPayee {
    id: string;
    permission_id: string;
    /** Resolved payee agent, or `null` for a valid-but-unregistered wallet. */
    agent_id: string | null;
    /** The reference as stored (handle, agent id, or lowercased wallet). */
    reference: string;
    /** Optional operator note, e.g. "primary GPU vendor". */
    label?: string | null;
    /** Current handle of the resolved payee, when it is registered. */
    handle?: string | null;
    /** Whether the reference resolved to a registered Kairune agent. */
    registered?: boolean;
    created_at: string;
}
interface Permission {
    id: string;
    agent_id: string;
    category: string;
    ceiling: number;
    period: 'day' | 'week' | 'month';
    status: 'active' | 'revoked';
    /** Optional burst cap: max spend within `velocity_window_s`. `null` = no limit. */
    velocity_limit?: number | null;
    /** Rolling window (seconds) for the velocity limit. `null` when no limit is set. */
    velocity_window_s?: number | null;
    /** Payee scope. Defaults to `open` for grants made before the feature existed. */
    counterparty_policy?: CounterpartyPolicy;
    /** Allowlisted payees, returned when a grant seeds or updates them. */
    payees?: PermissionPayee[];
    /** ISO8601 deadline after which the grant stops authorizing. `null` = never expires. */
    expires_at?: string | null;
    /** Seconds left before the deadline (`0` once passed), or `null` when there is none. */
    expires_in_s?: number | null;
    /** True when the deadline has passed. The row stays `active` — expiry is not revocation. */
    expired?: boolean;
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
    /** Burst cap (max spend within `velocity_window_s`), or `null` when none is set. */
    velocity_limit?: number | null;
    /** Rolling window (seconds) for the velocity limit, or `null` when none is set. */
    velocity_window_s?: number | null;
    /** Payee scope enforced on every spend against this permission. */
    counterparty_policy?: CounterpartyPolicy;
    /** ISO8601 deadline after which the grant stops authorizing. `null` = never expires. */
    expires_at?: string | null;
    /** Seconds left before the deadline (`0` once passed), or `null` when there is none. */
    expires_in_s?: number | null;
    /** True when the deadline has passed, so every further spend is refused. */
    expired?: boolean;
}
interface Spend {
    id: string;
    permission_id: string;
    agent_id: string;
    amount: number;
    note: string | null;
    /** The payee named on the charge (part of the signed receipt), or null. */
    payee?: string | null;
    idempotency_key?: string | null;
    /** Platform Ed25519 signature over the exact charge — the spend's receipt. */
    receipt_signature?: string | null;
    /** The platform_keys row that signed the receipt (for key rotation). */
    receipt_key_id?: string | null;
    created_at: string;
}
/**
 * A publicly verifiable receipt for one approved spend.
 *
 * Kairune signs the exact charge fields (who paid, who was paid, how much,
 * when) with the platform Ed25519 key at authorization time. This object
 * carries everything an independent verifier needs — the fields, the
 * canonical payload, the signature, and the public key — plus the result of
 * verifying the stored signature. A spend recorded before receipts existed
 * has `signed: false`.
 */
interface SpendReceipt {
    spend_id: string;
    /** False when the spend predates receipts (or signing failed) — no signature exists. */
    signed: boolean;
    /** True when the stored signature verifies against the stored fields right now. */
    verified: boolean;
    /** The exact signed fields. */
    fields: {
        agent_id: string;
        amount: number;
        created_at: string;
        note: string | null;
        payee: string | null;
        permission_id: string;
        spend_id: string;
    };
    /** The canonical (byte-stable) payload that was signed, or null when unsigned. */
    canonical: string | null;
    /** Base64 Ed25519 signature, or null when unsigned. */
    signature: string | null;
    algorithm: 'ed25519';
    /** SPKI PEM public key to verify with (pinned to the key that signed). */
    public_key: string | null;
    /** The platform_keys row that signed, or null. */
    key_id: string | null;
    /** True when the signing key was generated in-process (dev/test), not configured. */
    ephemeral_key: boolean;
}
/** The platform's current receipt-signing public key. */
interface PlatformKey {
    algorithm: 'ed25519';
    purpose: 'receipt';
    /** SPKI PEM public key — pin this out-of-band to verify receipts independently. */
    public_key: string;
    /** True when the key was generated in-process (dev/test), not configured. */
    ephemeral: boolean;
    receipt_endpoint: string;
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
    /**
     * Structured rejection detail. Shape depends on why the spend was blocked:
     * a ceiling block carries `remaining`/`used`/`period`, a velocity (burst)
     * block carries `velocity_limit`/`velocity_window_s`/`velocity_remaining`.
     */
    details?: {
        requested: number;
        ceiling?: number;
        used?: number;
        remaining?: number;
        period?: string;
        velocity_limit?: number;
        velocity_window_s?: number;
        velocity_used?: number;
        velocity_remaining?: number;
        counterparty?: string | null;
        verdict?: 'decline' | 'review' | 'proceed';
        reasons?: string[];
        registered?: boolean;
        counterparty_policy?: CounterpartyPolicy;
        reason?: SpendPreviewReason;
        expires_at?: string | null;
    };
}
/** Why a previewed spend would be blocked. `null` when it would be allowed. */
type SpendPreviewReason = 'ceiling_exceeded' | 'velocity_exceeded' | 'permission_revoked' | 'agent_suspended' | 'agent_not_found' | 'counterparty_declined'
/** The permission's policy requires a payee, and none was named. */
 | 'counterparty_required'
/** The named payee is not on this permission's allowlist. */
 | 'counterparty_not_allowed'
/** The grant's deadline has passed. Extend it with `setExpiry` to resume. */
 | 'permission_expired';
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
    event: 'spend.approved' | 'spend.blocked' | 'spend.threshold';
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
type CounterpartyCheckStatus = 'pass' | 'warn' | 'fail';
type CounterpartyVerdict = 'proceed' | 'review' | 'decline';
/** One named check that fed into the counterparty verdict. */
interface CounterpartyCheck {
    id: string;
    label: string;
    status: CounterpartyCheckStatus;
    detail: string;
}
/**
 * The result of a pre-flight counterparty check — the go/no-go an agent gets
 * before paying another agent. `verdict` is the headline; `checks` explains it.
 * An unregistered counterparty resolves to `registered: false` + a `decline`
 * verdict rather than throwing.
 */
interface CounterpartyReport {
    registered: boolean;
    /** proceed = safe · review = caution / human-in-the-loop · decline = do not pay. */
    verdict: CounterpartyVerdict;
    /** The amount that was assessed, or null when none was supplied. */
    requested_amount: number | null;
    /** 0..100 independence of the counterparty's verified trust (anti-farming). */
    trust_independence: number;
    /** Recommended max exposure (USD) for a single transaction with this agent. */
    suggested_max_amount: number;
    /** Whether requested_amount fits the recommendation; null when no amount given. */
    within_suggested_ceiling: boolean | null;
    /** Codes of every check that did not pass, worst-first. */
    reasons: string[];
    /** Every check that ran, in evaluation order. */
    checks: CounterpartyCheck[];
    /** Present only when registered === true. */
    counterparty?: {
        agent_id: string;
        handle: string;
        wallet: string | null;
        status: 'active' | 'suspended';
        score: number;
        tier: number;
        tier_label: string;
        max_score: number;
    };
    /** Raw signals behind the verdict; null when unregistered. */
    signals?: {
        tier: number;
        trust_independence: number;
        distinct_issuers: number;
        verified_count: number;
        unverified_count: number;
        recent_severe_negatives: number;
        recent_disputes: number;
        negative_lookback_days: number;
    } | null;
    /** Present only when registered === false. */
    wallet?: string | null;
}
/**
 * One candidate inside a counterparty comparison — the same assessment
 * `checkCounterparty` returns, flattened and given a `rank`.
 */
interface CounterpartyCandidate {
    /** The reference as supplied by the caller (id, handle, or wallet). */
    ref: string;
    /** 1-based position in the ranking; 1 is the best pick. */
    rank: number;
    handle: string | null;
    registered: boolean;
    verdict: CounterpartyVerdict;
    score: number;
    tier: number;
    tier_label: string | null;
    trust_independence: number;
    suggested_max_amount: number | null;
    within_suggested_ceiling: boolean | null;
    reasons: string[];
    checks: CounterpartyCheck[];
    signals: Record<string, number> | Record<string, never>;
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
interface CounterpartyComparison {
    /** The amount assessed against every candidate, or null when none was given. */
    requested_amount: number | null;
    /** How many candidates produced a verdict (excludes `unresolved`). */
    candidate_count: number;
    /** Best candidate with verdict `proceed`, or null when none qualifies. */
    recommended: CounterpartyCandidate | null;
    /** All assessed candidates, best-first. */
    ranked: CounterpartyCandidate[];
    /** References that could not be resolved to an agent (e.g. a typo'd handle). */
    unresolved: string[];
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
    checkCounterparty(counterparty: string, opts?: {
        amount?: number;
    }): Promise<CounterpartyReport>;
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
    compareCounterparties(counterparties: string[], opts?: {
        amount?: number;
    }): Promise<CounterpartyComparison>;
    /** Get attestation history for an agent. */
    getAttestations(agentId: string): Promise<Attestation[]>;
    /** Get permissions for an agent. */
    getPermissions(agentId: string): Promise<Permission[]>;
    /** Get remaining budget for a permission. */
    getBudget(permissionId: string): Promise<Budget>;
    /** Get spend history for a permission. */
    getSpends(permissionId: string, limit?: number): Promise<Spend[]>;
    /**
     * Get the public, independently-verifiable receipt for one approved spend.
     *
     * Every spend Kairune authorizes is signed with the platform Ed25519 key at
     * charge time. The receipt carries the signed fields, the canonical payload,
     * the signature, and the public key — so a payee or third party can prove a
     * charge happened (who paid whom, how much, when) without trusting any
     * database. `receipt.verified` is the result of checking the stored
     * signature against the stored fields right now.
     */
    getReceipt(spendId: string): Promise<SpendReceipt>;
    /**
     * Get the platform's current receipt-signing public key.
     *
     * Pin this out-of-band (docs, pinned post, DNS TXT) so receipt verification
     * never has to fetch the key from the same server whose receipts it checks.
     * `ephemeral: true` means the deployment has not configured a production
     * key (RECEIPT_PRIVATE_KEY) — signatures still verify, but the key is not a
     * long-lived commitment.
     */
    getPlatformKey(): Promise<PlatformKey>;
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
    grantPermission(agentId: string, input: {
        category: string;
        ceiling: number;
        period?: string;
        velocity_limit?: number;
        velocity_window_s?: number;
        counterparty_policy?: CounterpartyPolicy;
        /** Payee references (id / handle / wallet). Required for `allowlist`. */
        payees?: string[];
        /** Lifetime in seconds from now (max 365 days). Mutually exclusive with `expires_at`. */
        expires_in_s?: number;
        /** Absolute ISO8601 deadline. Mutually exclusive with `expires_in_s`. */
        expires_at?: string;
    }): Promise<{
        permission: Permission;
        capped: boolean;
    }>;
    /** Revoke a permission. */
    revokePermission(permissionId: string): Promise<{
        revoked: boolean;
    }>;
    /** List the payees allowlisted on a permission, plus its current policy. */
    listPayees(permissionId: string): Promise<{
        counterparty_policy: CounterpartyPolicy;
        payees: PermissionPayee[];
    }>;
    /**
     * Pin a payee to a permission's allowlist.
     *
     * The reference is resolved to a Kairune agent when possible, so an entry
     * added by handle still matches a spend that names the same payee by wallet.
     * A valid-but-unregistered wallet is accepted — the allowlist declares scope,
     * not trust, so it is still refused by the trust gate until it registers.
     */
    addPayee(permissionId: string, counterparty: string, input?: {
        label?: string;
    }): Promise<{
        payee: PermissionPayee;
    }>;
    /** Remove a payee from a permission's allowlist (by row id or reference). */
    removePayee(permissionId: string, reference: string): Promise<{
        removed: PermissionPayee;
    }>;
    /**
     * Change a permission's payee scope in place.
     *
     * Lets you TIGHTEN an existing grant (e.g. `open` → `allowlist`) without
     * revoking and re-granting, so the permission id and its spend history
     * survive. Switching to `allowlist` requires at least one payee — supply them
     * via `payees` if the allowlist is still empty.
     */
    setCounterpartyPolicy(permissionId: string, counterparty_policy: CounterpartyPolicy, input?: {
        payees?: string[];
    }): Promise<{
        permission: Permission;
    }>;
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
    setExpiry(permissionId: string, input?: {
        /** Lifetime in seconds from now (max 365 days). Mutually exclusive with `expires_at`. */
        expires_in_s?: number;
        /** Absolute ISO8601 deadline. Mutually exclusive with `expires_in_s`. */
        expires_at?: string;
    }): Promise<{
        permission: Permission & {
            revived?: boolean;
        };
    }>;
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
    spend(permissionId: string, input: {
        amount: number;
        note?: string;
        idempotencyKey?: string;
        counterparty?: string;
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
        counterparty?: string;
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

export { type Agent, type Attestation, type Budget, type CounterpartyCandidate, type CounterpartyCheck, type CounterpartyCheckStatus, type CounterpartyComparison, type CounterpartyPolicy, type CounterpartyReport, type CounterpartyVerdict, type FeedEvent, Kairune, KairuneError, type KairuneOptions, type Meta, type Permission, type PermissionPayee, type PlatformKey, type Spend, type SpendBlocked, type SpendPreview, type SpendPreviewReason, type SpendReceipt, type SpendResult, type Stats, type WalletProfile, type Webhook, Kairune as default };
