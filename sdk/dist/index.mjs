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
  async request(method, path, body) {
    const isWrite = method !== "GET";
    const res = await this._fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: this.headers(isWrite),
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
  /** Grant a spending permission to an agent. */
  async grantPermission(agentId, input) {
    return this.request("POST", `/agents/${agentId}/permissions`, input);
  }
  /** Revoke a permission. */
  async revokePermission(permissionId) {
    return this.request("POST", `/permissions/${permissionId}/revoke`);
  }
  /**
   * Authorize a spend against a permission. Enforces the ceiling.
   * Returns `{ approved: true, spend, budget }` or `{ approved: false, error, details }`.
   */
  async spend(permissionId, input) {
    try {
      const res = await this.request(
        "POST",
        `/permissions/${permissionId}/spends`,
        input
      );
      return { approved: true, ...res };
    } catch (e) {
      if (e instanceof KairuneError && e.status === 409) {
        return {
          approved: false,
          error: e.message,
          details: e.body?.details
        };
      }
      throw e;
    }
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
