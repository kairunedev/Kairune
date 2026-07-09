# $KAIRUNE — Token Info

`$KAIRUNE` is the **community token** for Kairune — the trust layer for agents that spend.

> ✅ **Status: LIVE.** Launched on **Robinhood Chain** via **Noxa** and announced on [@usekairune](https://x.com/usekairune).

`metadata.json` in this folder is the repo's token-info descriptor (name, symbol, chain, contract, links) kept in sync with what's shown on the landing page.

---

## Live details

| Field | Value |
|---|---|
| Name | Kairune |
| Symbol | `$KAIRUNE` |
| Chain | Robinhood Chain |
| Launchpad | Noxa |
| Contract address | `0xc20f293b166eebdc88815a51c19e7b817134ed1f` |
| Website | https://kairune.online |
| X / Twitter | https://x.com/usekairune |

> ⚠️ Always verify the contract address against the official channel ([@usekairune](https://x.com/usekairune)) before interacting — scam clones are common. **Decimals and total supply** should be confirmed from the Robinhood Chain block explorer and filled into `metadata.json` (`_todo`).

---

## Product vs. token — read this

Be precise about what is live so the messaging stays honest:

- **Live now:** the Kairune console + REST API + trust score engine. Registering agents, recording attestations, computing scores, and granting/revoking scoped permissions all work — **and they are free, with no token required.**
- **Live now:** `$KAIRUNE` as a tradeable community token on Robinhood Chain.
- **Roadmap (not yet built):** on-chain token *utility*. The code in `../server.js` and `../src/**` has **no token integration** — nothing checks a balance, charges a fee, or burns anything today.

The intended utility model (for when it ships):
- **Free to read, pay to write** — reading trust scores stays free; writing to the trust graph (attestations, vouches, grants) would require `$KAIRUNE`.
- **Fee burn** — a portion of every write fee burned, tying scarcity to real usage.
- **Bonding + slashing** — stake against false flags; lose the stake on proven abuse.

Keep landing/marketing copy aligned with this split: token = live & community; on-chain utility = coming. Avoid promising utility as if it already exists.

---

## When the utility ships — where it plugs in

The natural integration point is the write endpoints in `../src/routes/api.js`:

- `POST /api/agents/:id/attestations`
- `POST /api/agents/:id/permissions`
- `POST /api/agents` (registration)

Each would require a signed, paid transaction (fee in `$KAIRUNE`) before the write is accepted, with a portion routed to burn and the rest to treasury. Design this in a dedicated `TOKENOMICS.md` before writing code.
