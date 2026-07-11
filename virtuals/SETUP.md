# Kairune on Virtuals — build the agent

Your agent page ([virtuals/100623](https://app.virtuals.io/virtuals/100623)) is live but **Agent Info still shows 0 jobs** because Offerings are empty and no provider bot is listening.

This folder fixes both:

1. **Offerings copy** — paste into Virtuals UI (Offerings tab)
2. **ACP provider bot** — fulfills paid jobs by calling `https://kairune.online/api`

---

## A. Virtuals UI (do this first)

Open your agent → **Agent Info** → **Offerings** → create **4 offerings**.

Use values from [`offerings.json`](./offerings.json) (`ui_paste` block), or paste below.

### 1) Lookup Trust Score
| Field | Value |
|--------|--------|
| Name | Lookup Trust Score |
| Description | Fetch a live Kairune trust score, tier, and suggested daily spend ceiling for any registered agent. |
| Price | **0.10 USDC** (raise later) |
| SLA | 5 minutes |
| Requirements | `{"type":"object","properties":{"handle_or_id":{"type":"string"}},"required":["handle_or_id"]}` |
| Deliverable | JSON trust card: handle, score, tier, label, suggested_daily_ceiling, share_url |

### 2) Register Agent on Kairune
| Field | Value |
|--------|--------|
| Name | Register Agent on Kairune |
| Description | Register a new agent on the Kairune trust registry and receive baseline score + share card URL. |
| Price | **0.25 USDC** |
| SLA | 10 minutes |
| Requirements | `{"type":"object","properties":{"handle":{"type":"string"},"wallet":{"type":"string"},"operator":{"type":"string"}},"required":["handle","wallet"]}` |
| Deliverable | JSON: id, handle, score, share_url |

### 3) Record Attestation
| Field | Value |
|--------|--------|
| Name | Record Attestation |
| Description | Record behavior on a Kairune agent and get the updated trust score. |
| Price | **0.15 USDC** |
| SLA | 5 minutes |
| Requirements | `{"type":"object","properties":{"handle_or_id":{"type":"string"},"kind":{"type":"string","enum":["task_completed","clean_payment","peer_vouch","dispute","chargeback","anomaly_flag"]},"note":{"type":"string"}},"required":["handle_or_id","kind"]}` |
| Deliverable | JSON: handle, kind, score, label, share_url |

### 4) Full Trust Report
| Field | Value |
|--------|--------|
| Name | Full Trust Report |
| Description | Full Kairune report: score breakdown, recent attestations, active permissions, share URL. |
| Price | **0.20 USDC** |
| SLA | 5 minutes |
| Requirements | `{"type":"object","properties":{"handle_or_id":{"type":"string"}},"required":["handle_or_id"]}` |
| Deliverable | JSON: agent, attestations[], permissions[], share_url |

### Resources (optional, read-only)
- `https://kairune.online/api/stats`
- `https://kairune.online/api/meta`

### Agent profile tips
- Role: **Provider** (seller)
- Description: use the `agent.description` from `offerings.json`
- Link website: `https://kairune.online`
- X auth: `@usekairune`
- Create / fund **smart contract wallet** + **Add Signer** (needed for the bot)

---

## B. Run the ACP provider bot

```bash
cd virtuals
cp .env.example .env
# fill ACP_WALLET_ADDRESS, ACP_WALLET_ID, ACP_SIGNER_PRIVATE_KEY from Virtuals Signers tab

npm install
npm run provider
```

When a buyer opens a job:
1. Bot reads requirement JSON  
2. Sets budget (USDC from offering price)  
3. On `job.funded` → calls Kairune API → `session.submit(JSON result)`

Keep this process running (PM2 / systemd / Railway). Vercel serverless cannot listen to ACP events long-lived.

---

## C. Test end-to-end

1. Offerings visible on agent page  
2. Bot logs `Listening for jobs…`  
3. From another ACP client / test buyer: create job **Lookup Trust Score** with  
   `{"handle_or_id":"voyager-07"}`  
4. Job Log should show activity; Metrics leave 0 after first completed job  

---

## D. Cursor MCP (optional)

**Kairune MCP** (local) — same tools as Jobs Offered, hits `kairune.online` directly (no escrow):

```bash
npm run mcp
```

Chain: **Robinhood Chain** via Virtuals ACP (`robinhood` in `provider.mjs`).

---

## Files

| File | Purpose |
|------|---------|
| `offerings.json` | Source of truth for offerings + UI paste |
| `import-jobs.json` | Virtuals UI Import (jobs only, snake_case) |
| `import-resources.json` | Virtuals UI Import (resources only) |
| `kairuneClient.cjs` | Maps job → Kairune REST API |
| `provider.mjs` | ACP seller listener (Robinhood Chain) |
| `mcp-server.mjs` | Cursor MCP tools mirroring ACP offerings |
| `.env.example` | Secrets template |
| `package.json` | Local deps for the bot |

---

## Notes

- Prices are **test-low** on purpose — raise after first successful jobs.
- Product itself stays free at `kairune.online/app`; ACP fee is for mediated agent-commerce jobs.
- Never commit `virtuals/.env` (signer key / wallet id).
