"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  Kairune: () => Kairune,
  KairuneError: () => KairuneError,
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var KairuneError = class extends Error {
  status;
  body;
  constructor(message, status, body) {
    super(message);
    this.name = "KairuneError";
    this.status = status;
    this.body = body;
  }
};
function spendQueryString(q = {}, extra = {}) {
  const params = new URLSearchParams();
  const set = (k, v) => {
    if (v !== void 0 && v !== null && v !== "") params.set(k, String(v));
  };
  set("limit", q.limit);
  set("offset", q.offset);
  set("since", q.since);
  set("until", q.until);
  set("payee", q.payee);
  set("idempotency_key", q.idempotency_key);
  for (const [k, v] of Object.entries(extra)) set(k, v);
  const s = params.toString();
  return s ? `?${s}` : "";
}
var Kairune = class _Kairune {
  baseUrl;
  adminKey;
  issuerKey;
  signOwnerMessage;
  _fetch;
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || "https://kairune.online").replace(/\/$/, "");
    this.adminKey = opts.adminKey || "";
    this.issuerKey = opts.issuerKey || "";
    this.signOwnerMessage = opts.signOwnerMessage;
    this._fetch = opts.fetch || globalThis.fetch;
  }
  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------
  headers(write = false) {
    const h = { "content-type": "application/json" };
    if (write && this.adminKey) h["x-admin-key"] = this.adminKey;
    return h;
  }
  issuerHeaders() {
    const h = {};
    if (this.issuerKey) h["x-issuer-key"] = this.issuerKey;
    return h;
  }
  async request(method, path, body, extraHeaders) {
    const isWrite = method !== "GET";
    const res = await this._fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: { ...this.headers(isWrite), ...extraHeaders },
      body: body ? JSON.stringify(body) : void 0
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new KairuneError(
        data?.error || `HTTP ${res.status}`,
        res.status,
        data
      );
    }
    return data;
  }
  // -------------------------------------------------------------------------
  // Read — no admin key needed
  // -------------------------------------------------------------------------
  /** Get global statistics. */
  async stats() {
    return this.request("GET", "/stats");
  }
  /** Get metadata (kinds, tiers, weights). */
  async meta() {
    return this.request("GET", "/meta");
  }
  /** Get the public spend activity feed. */
  async feed(limit = 20) {
    const res = await this.request("GET", `/feed?limit=${limit}`);
    return res.events;
  }
  /** List agents (leaderboard). */
  async listAgents(opts) {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    if (opts?.status) params.set("status", opts.status);
    const q = params.toString();
    const res = await this.request("GET", `/agents${q ? "?" + q : ""}`);
    return res.agents;
  }
  /** Get a single agent by ID or handle. */
  async getAgent(idOrHandle) {
    const res = await this.request("GET", `/agents/${encodeURIComponent(idOrHandle)}`);
    return res.agent;
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
  async lookupWallet(wallet) {
    try {
      return await this.request("GET", `/wallets/${encodeURIComponent(wallet)}`);
    } catch (e) {
      if (e instanceof KairuneError && e.status === 404 && e.body && typeof e.body === "object") {
        return e.body;
      }
      throw e;
    }
  }
  /**
   * Request a challenge for an agent to prove control of its wallet.
   *
   * Registering an agent only ever recorded a *claimed* address — the format
   * was validated, control never was. These three methods close that gap using
   * EIP-191 `personal_sign`, which every EVM wallet already implements, so no
   * private key is ever sent to Kairune.
   *
   * The challenge is always issued for the wallet on record, not one you pass
   * in, so nobody can mint challenges for addresses they don't already claim.
   * Requesting a new challenge invalidates any previous outstanding one.
   *
   * ```ts
   * const ch = await kairune.requestWalletChallenge(agentId)
   * const signature = await wallet.signMessage(ch.message)  // ethers / viem / EIP-1193
   * await kairune.submitWalletProof(agentId, ch.nonce, signature)
   * ```
   */
  async requestWalletChallenge(agentId) {
    return this.request(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/wallet-proof/challenge`
    );
  }
  /**
   * Submit a signed challenge to prove wallet control.
   *
   * The nonce is single-use and is consumed on *any* attempt, successful or
   * not — so a failed submission needs a fresh challenge. Throws
   * KairuneError(401) if the recovered signer is not the claimed wallet.
   */
  async submitWalletProof(agentId, nonce, signature) {
    return this.request(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/wallet-proof`,
      { nonce, signature }
    );
  }
  /**
   * Current wallet proof state for an agent.
   *
   * Proof is a property of the (agent, wallet) pair, so an agent that proved
   * one address and later changed it reads as unproven again.
   */
  async getWalletProof(agentId) {
    return this.request(
      "GET",
      `/agents/${encodeURIComponent(agentId)}/wallet-proof`
    );
  }
  // -------------------------------------------------------------------------
  // Owner lock — opt-in protection over an agent's spending authority
  // -------------------------------------------------------------------------
  /**
   * Is this agent owner-locked?
   *
   * A tiny wrapper around `getAgent` — the lock state lives on the agent row
   * itself. No extra endpoint is needed and no credentials are required.
   */
  async getOwnerLock(agentId) {
    const a = await this.getAgent(agentId);
    return {
      agent_id: a.id,
      handle: a.handle,
      locked: Boolean(a.owner_locked),
      owner_locked_at: a.owner_locked_at ?? null,
      wallet: a.wallet
    };
  }
  /**
   * Bind an agent to its wallet so only the wallet holder can change its
   * spending authority.
   *
   * Requires `signOwnerMessage` on the client — locking is self-authenticating
   * and proves you hold the address now, not that you held an admin key at
   * some point. After this, an anonymous caller can still read the agent and
   * preview a spend, but cannot grant it a budget, charge one, or revoke it.
   */
  async lockAgent(agentId) {
    const proof = await this.proveOwnership(agentId);
    return this.request(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/lock`,
      proof
    );
  }
  /**
   * Remove an agent's owner lock, returning it to the open default.
   *
   * Takes the same fresh proof as locking — an unauthenticated unlock would
   * make the lock decorative.
   */
  async unlockAgent(agentId) {
    const proof = await this.proveOwnership(agentId);
    return this.request(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/unlock`,
      proof
    );
  }
  /**
   * Mint + sign one proof for an agent (`nonce:signature`).
   *
   * Useful when you want to hold the proof yourself — e.g. to sign once in a
   * trusted process and pass the `X-Owner-Proof` string to an untrusted spend
   * loop. A proof is single-use and is consumed whether the call it authorizes
   * succeeds or fails.
   */
  async ownerProof(agentId) {
    if (!this.signOwnerMessage) {
      throw new Error(
        "Kairune: this call needs a wallet proof. Pass `signOwnerMessage` to the constructor (a personal_sign over the challenge message)."
      );
    }
    const ch = await this.requestWalletChallenge(agentId);
    const sig = await this.signOwnerMessage(ch.message, ch);
    if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig.trim())) {
      throw new Error(
        "Kairune: signOwnerMessage must return a 0x-prefixed 65-byte hex signature (r + s + v), got " + String(typeof sig)
      );
    }
    return { nonce: ch.nonce, signature: sig.trim(), header: `${ch.nonce}:${sig.trim()}`, challenge: ch };
  }
  /**
   * @internal Mint a proof while capturing the exact challenge that was signed.
   */
  async proveOwnership(agentId) {
    const r = await this.ownerProof(agentId);
    return { nonce: r.nonce, signature: r.signature };
  }
  /**
   * @internal True for the 401 Kairune returns when an agent is owner-locked and
   * the call carried no fresh proof. The guard runs before any state change, so
   * catching this and retrying cannot double-apply the mutation.
   */
  static isOwnerLockError(e) {
    return e instanceof KairuneError && e.status === 401 && /owner|proof|locked/i.test(e.message || "");
  }
  /**
   * @internal Run a mutation, transparently satisfying an owner lock if the
   * agent turns out to be locked and a signer is configured.
   *
   * Unlocked agents — the default — hit the happy path with zero extra calls:
   * `run()` succeeds directly and no challenge is ever minted. Only on a 401
   * owner-lock rejection does the SDK mint a proof and retry once. When no
   * signer is configured the 401 is re-thrown so the caller learns the real
   * requirement rather than seeing a silent fall-open.
   *
   * @param agentId the (possibly locked) agent whose authority is being changed
   * @param run issues the request; receives the `X-Owner-Proof` header value
   *        (empty string on the first, unproofed attempt)
   */
  async withOwnerProof(agentId, run) {
    try {
      return await run("");
    } catch (e) {
      if (!_Kairune.isOwnerLockError(e) || !this.signOwnerMessage) throw e;
      const { header } = await this.ownerProof(agentId);
      return run(header);
    }
  }
  /**
   * @internal Same as withOwnerProof, for permission-scoped routes. The server
   * derives the agent from the permission, so the SDK does the same only on the
   * retry path: a budget read resolves `agent_id`, then one fresh proof replays
   * the call. The first attempt carried no side effect (the owner guard runs
   * before any state change), so the replay cannot double-apply it.
   */
  async withOwnerProofForPermission(permissionId, run) {
    try {
      return await run("");
    } catch (e) {
      if (!_Kairune.isOwnerLockError(e) || !this.signOwnerMessage) throw e;
      const budget = await this.getBudget(permissionId);
      const { header } = await this.ownerProof(budget.agent_id);
      return run(header);
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
  async checkCounterparty(counterparty, opts = {}) {
    const body = { counterparty };
    if (opts.amount != null) body.amount = opts.amount;
    return this.request("POST", "/counterparty/check", body);
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
  async compareCounterparties(counterparties, opts = {}) {
    const body = { counterparties };
    if (opts.amount != null) body.amount = opts.amount;
    return this.request("POST", "/counterparty/compare", body);
  }
  /** Get attestation history for an agent. */
  async getAttestations(agentId) {
    const res = await this.request("GET", `/agents/${agentId}/attestations`);
    return res.attestations;
  }
  /** Get permissions for an agent. */
  async getPermissions(agentId) {
    const res = await this.request("GET", `/agents/${agentId}/permissions`);
    return res.permissions;
  }
  /** Get remaining budget for a permission. */
  async getBudget(permissionId) {
    const res = await this.request("GET", `/permissions/${permissionId}/budget`);
    return res.budget;
  }
  /**
   * Get spend history for one permission.
   *
   * Pass a number for a simple page size, or a {@link SpendQuery} to page and
   * filter: `since`/`until` bound the window (`until` is exclusive so
   * consecutive windows tile without double-counting), `payee` answers "have I
   * paid this vendor before?", and `idempotency_key` answers "did that retry
   * actually land?".
   */
  async getSpends(permissionId, opts = 50) {
    const res = await this.getSpendPage(permissionId, opts);
    return res.spends;
  }
  /** Like {@link getSpends}, but also returns the paging echo so you can tell when a page is the last one. */
  async getSpendPage(permissionId, opts = 50) {
    const q = spendQueryString(typeof opts === "number" ? { limit: opts } : opts);
    return this.request("GET", `/permissions/${permissionId}/spends${q}`);
  }
  /**
   * Get spend history merged across every permission an agent holds.
   *
   * The per-permission history answers "what did this grant pay for"; this
   * answers "what did this agent pay for" — which an operator running several
   * grants on one agent cannot otherwise get in a single call. Each row also
   * carries the granting permission's `category` and `period`.
   *
   * Requires an admin key: a grant's charge history is operator data, unlike
   * the anonymised public {@link feed}.
   */
  async getAgentSpends(agentId, opts = {}) {
    const res = await this.getAgentSpendPage(agentId, opts);
    return res.spends;
  }
  /** Like {@link getAgentSpends}, but also returns the paging echo. */
  async getAgentSpendPage(agentId, opts = {}) {
    const q = spendQueryString(opts, { permission_id: opts.permission_id });
    return this.request("GET", `/agents/${agentId}/spends${q}`, void 0, this.headers(true));
  }
  /**
   * Aggregated spending for an agent: a total plus rollups by permission,
   * category, and payee over an optional `[since, until)` window.
   *
   * This is the "how much did this agent spend this month, and on whom"
   * report. Totals cover the requested window, not each permission's rolling
   * ceiling window — use {@link getBudget} for remaining headroom.
   *
   * Requires an admin key.
   */
  async getSpendSummary(agentId, opts = {}) {
    const q = spendQueryString(opts, {
      top_payees: opts.top_payees == null ? void 0 : String(opts.top_payees)
    });
    const res = await this.request(
      "GET",
      `/agents/${agentId}/spend-summary${q}`,
      void 0,
      this.headers(true)
    );
    return res.summary;
  }
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
  async getReceipt(spendId) {
    const res = await this.request("GET", `/spends/${spendId}/receipt`);
    return res.receipt;
  }
  /**
   * Get the platform's current receipt-signing public key.
   *
   * Pin this out-of-band (docs, pinned post, DNS TXT) so receipt verification
   * never has to fetch the key from the same server whose receipts it checks.
   * `ephemeral: true` means the deployment has not configured a production
   * key (RECEIPT_PRIVATE_KEY) — signatures still verify, but the key is not a
   * long-lived commitment.
   */
  async getPlatformKey() {
    return this.request("GET", "/platform-key");
  }
  // -------------------------------------------------------------------------
  // Write — requires admin key
  // -------------------------------------------------------------------------
  /** Register a new agent. */
  async registerAgent(input) {
    const res = await this.request("POST", "/agents", input);
    return res.agent;
  }
  async attest(agentId, input) {
    const r = await this.withOwnerProof(
      agentId,
      (ph) => this.request("POST", `/agents/${agentId}/attestations`, input, ph ? { "X-Owner-Proof": ph } : void 0)
    );
    return r.attestation;
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
  async grantPermission(agentId, input) {
    return this.withOwnerProof(
      agentId,
      (ph) => this.request("POST", `/agents/${agentId}/permissions`, input, ph ? { "X-Owner-Proof": ph } : void 0)
    );
  }
  /** Revoke a permission. */
  async revokePermission(permissionId) {
    return this.withOwnerProofForPermission(
      permissionId,
      (ph) => this.request("POST", `/permissions/${permissionId}/revoke`, {}, ph ? { "X-Owner-Proof": ph } : void 0)
    );
  }
  /** List the payees allowlisted on a permission, plus its current policy. */
  async listPayees(permissionId) {
    return this.request("GET", `/permissions/${permissionId}/payees`);
  }
  /**
   * Pin a payee to a permission's allowlist.
   *
   * The reference is resolved to a Kairune agent when possible, so an entry
   * added by handle still matches a spend that names the same payee by wallet.
   * A valid-but-unregistered wallet is accepted — the allowlist declares scope,
   * not trust, so it is still refused by the trust gate until it registers.
   */
  async addPayee(permissionId, counterparty, input = {}) {
    return this.withOwnerProofForPermission(
      permissionId,
      (ph) => this.request("POST", `/permissions/${permissionId}/payees`, { counterparty, ...input }, ph ? { "X-Owner-Proof": ph } : void 0)
    );
  }
  /** Remove a payee from a permission's allowlist (by row id or reference). */
  async removePayee(permissionId, reference) {
    return this.withOwnerProofForPermission(
      permissionId,
      (ph) => this.request(
        "DELETE",
        `/permissions/${permissionId}/payees/${encodeURIComponent(reference)}`,
        void 0,
        ph ? { "X-Owner-Proof": ph } : void 0
      )
    );
  }
  /**
   * Change a permission's payee scope in place.
   *
   * Lets you TIGHTEN an existing grant (e.g. `open` → `allowlist`) without
   * revoking and re-granting, so the permission id and its spend history
   * survive. Switching to `allowlist` requires at least one payee — supply them
   * via `payees` if the allowlist is still empty.
   */
  async setCounterpartyPolicy(permissionId, counterparty_policy, input = {}) {
    return this.withOwnerProofForPermission(
      permissionId,
      (ph) => this.request("POST", `/permissions/${permissionId}/counterparty-policy`, { counterparty_policy, ...input }, ph ? { "X-Owner-Proof": ph } : void 0)
    );
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
  async setExpiry(permissionId, input = {}) {
    return this.withOwnerProofForPermission(
      permissionId,
      (ph) => this.request("POST", `/permissions/${permissionId}/expiry`, input, ph ? { "X-Owner-Proof": ph } : void 0)
    );
  }
  // ---------------------------------------------------------------------------
  // Issuer requests (marketplace handshake)
  // ---------------------------------------------------------------------------
  /** Create a verification request from an agent to an issuer. */
  async createIssuerRequest(input) {
    return this.request("POST", "/issuer-requests", input);
  }
  /** Fetch a single issuer request by id. */
  async getIssuerRequest(requestId) {
    return this.request("GET", `/issuer-requests/${encodeURIComponent(requestId)}`);
  }
  /** List requests an agent has created. */
  async getAgentRequests(agentId) {
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/requests`);
  }
  /** List requests an issuer has received. Issuer key required. */
  async getIssuerRequests(issuerId) {
    return this.request("GET", `/issuers/${encodeURIComponent(issuerId)}/requests`, void 0, this.issuerHeaders());
  }
  /** Accept or reject a request. Issuer key required — must match the addressed issuer. */
  async respondToRequest(requestId, decision, opts = {}) {
    return this.request("POST", `/issuer-requests/${encodeURIComponent(requestId)}/respond`, {
      decision,
      ...opts
    }, this.issuerHeaders());
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
  async spend(permissionId, input) {
    const { idempotencyKey, ...body } = input;
    const idemHeader = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : void 0;
    const call = (ph) => this.request(
      "POST",
      `/permissions/${permissionId}/spends`,
      body,
      { ...idemHeader ?? {}, ...ph ? { "X-Owner-Proof": ph } : {} }
    );
    try {
      const res = await this.withOwnerProofForPermission(permissionId, call);
      return { approved: true, ...res };
    } catch (e) {
      if (e instanceof KairuneError && (e.status === 409 || e.status === 429)) {
        return {
          approved: false,
          error: e.message,
          details: e.body?.details
        };
      }
      throw e;
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
  async previewSpend(permissionId, input) {
    const { idempotencyKey, ...body } = input;
    const headers = idempotencyKey ? { "idempotency-key": idempotencyKey } : void 0;
    return this.request(
      "POST",
      `/permissions/${permissionId}/spends/preview`,
      body,
      headers
    );
  }
  /** Suspend or activate an agent. */
  async setAgentStatus(agentId, status) {
    const res = await this.request("PATCH", `/agents/${agentId}/status`, { status });
    return res.agent;
  }
  /** Delete an agent (admin key required). */
  async deleteAgent(agentId) {
    return this.request("DELETE", `/agents/${agentId}`);
  }
  /** Register a webhook for spend events. */
  async createWebhook(input) {
    return this.request("POST", "/webhooks", input);
  }
  /** List registered webhooks. */
  async listWebhooks() {
    const res = await this.request("GET", "/webhooks");
    return res.webhooks;
  }
  /** Delete a webhook. */
  async deleteWebhook(webhookId) {
    return this.request("DELETE", `/webhooks/${webhookId}`);
  }
};
var index_default = Kairune;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Kairune,
  KairuneError
});
