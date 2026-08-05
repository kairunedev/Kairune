// src/index.ts
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
var Kairune = class {
  baseUrl;
  adminKey;
  _fetch;
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || "https://kairune.online").replace(/\/$/, "");
    this.adminKey = opts.adminKey || "";
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
   * returns them ranked by one documented rule (verdict, then score, then trust
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
  /** Get spend history for a permission. */
  async getSpends(permissionId, limit = 50) {
    const res = await this.request("GET", `/permissions/${permissionId}/spends?limit=${limit}`);
    return res.spends;
  }
  // -------------------------------------------------------------------------
  // Write — requires admin key
  // -------------------------------------------------------------------------
  /** Register a new agent. */
  async registerAgent(input) {
    const res = await this.request("POST", "/agents", input);
    return res.agent;
  }
  /** Add an attestation (triggers rescore). */
  async attest(agentId, input) {
    const res = await this.request("POST", `/agents/${agentId}/attestations`, input);
    return res.attestation;
  }
  /**
   * Grant a spending permission to an agent.
   *
   * Pass `velocity_limit` to add a burst cap on top of the period ceiling: at
   * most that amount may be spent within `velocity_window_s` seconds (default
   * 60). A spend that trips it is denied and fires a `spend.velocity` webhook,
   * catching a runaway or compromised agent before it drains the whole budget.
   */
  async grantPermission(agentId, input) {
    return this.request("POST", `/agents/${agentId}/permissions`, input);
  }
  /** Revoke a permission. */
  async revokePermission(permissionId) {
    return this.request("POST", `/permissions/${permissionId}/revoke`);
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
   */
  async spend(permissionId, input) {
    const { idempotencyKey, ...body } = input;
    const headers = idempotencyKey ? { "idempotency-key": idempotencyKey } : void 0;
    try {
      const res = await this.request(
        "POST",
        `/permissions/${permissionId}/spends`,
        body,
        headers
      );
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
export {
  Kairune,
  KairuneError,
  index_default as default
};
