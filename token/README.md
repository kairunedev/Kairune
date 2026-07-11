# $KAIRUNE — Token Info

`$KAIRUNE` is the **community token** for Kairune — the trust layer for agents that spend.

> ✅ **Status: LIVE.** Launched on **Virtuals** on **Robinhood Chain** — [app.virtuals.io/virtuals/100623](https://app.virtuals.io/virtuals/100623) — announced on [@usekairune](https://x.com/usekairune).

`metadata.json` in this folder is the repo's token-info descriptor (name, symbol, chain, contract, links) kept in sync with what's shown on the landing page.

---

## Live details

| Field | Value |
|---|---|
| Name | Kairune |
| Symbol | `$KAIRUNE` |
| Chain | Robinhood Chain |
| Launchpad | Virtuals |
| Contract address | `0xc5ac3b7664ba1ac915145cc58f50b89ec3a2970d` |
| Virtuals page | https://app.virtuals.io/virtuals/100623 |
| Website | https://kairune.online |
| Console | https://kairune.online/app |
| X / Twitter | https://x.com/usekairune |

> ⚠️ Always verify the contract address against the official channel ([@usekairune](https://x.com/usekairune)) before interacting — scam clones are common. **Decimals and total supply** should be confirmed from a Robinhood Chain explorer and filled into `metadata.json` (`_todo`).

---

## Product vs. token — read this

Be precise about what is live so the messaging stays honest:

- **Live now:** the Kairune console + REST API + trust score engine. Registering agents, recording attestations, computing scores, and granting/revoking scoped permissions all work — **and they are free, with no token required.**
- **Live now:** `$KAIRUNE` as a tradeable community token on Virtuals (Robinhood Chain).
- **Live now (soft utility):** listed holder wallets (`TOKEN_HOLDER_WALLETS`) get a **higher write rate limit**. Send `X-Kairune-Wallet: 0x…` on mutating requests. Check status via `GET /api/token`. **No on-chain RPC / no pay-to-write yet.**
- **Roadmap:** hard pay-to-write, fee burn, bonding/slashing — not wired yet.

Keep landing/marketing copy aligned with this split: token = live & community; soft rate boost = optional; hard on-chain utility = coming.

---

## When the utility ships — where it plugs in

The natural integration point is the write endpoints in `../src/routes/api.js`:

- `POST /api/agents/:id/attestations`
- `POST /api/agents/:id/permissions`
- `POST /api/agents` (registration)
