# Kairune MCP — counterparty check for approval-gated agents

Kairune ships an MCP server so any MCP-compatible runtime can call
`kairune.online` directly — no ACP escrow, no SDK, no code changes to your
agent. This is the drop-in for **approval-gated** runtimes (e.g. VEX): the agent
proposes a fund-moving action, and one tool call tells the gate whether the
**counterparty** is safe before a human ever sees the prompt.

## Why this fits an approval-gated agent

An approval gate already answers *"does the operator allow this spend?"* It
does **not** answer *"is the party on the other side trustworthy?"* — that's a
signal the runtime can't derive locally. `counterparty_check` fills exactly that
gap and maps 1:1 onto the gate:

| verdict | gate action |
| --- | --- |
| `proceed` | sign / auto-approve up to `suggested_max_amount` |
| `review` | surface to the human for an explicit tap |
| `decline` | block — do not sign |

It fails closed: an unknown or unregistered counterparty returns `decline`,
never a silent pass. Read-only, deterministic, nothing persisted — same posture
as a local-first runtime.

## Run the server

```bash
# from virtuals/
node mcp-server.mjs      # stdio transport; stdout is MCP protocol, logs go to stderr
```

Environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `KAIRUNE_API_BASE` | `https://kairune.online/api` | Kairune API base |

## Register it with an MCP client

Point your runtime's MCP config at the server. Generic example:

```json
{
  "mcpServers": {
    "kairune": {
      "command": "node",
      "args": ["/absolute/path/to/virtuals/mcp-server.mjs"],
      "env": { "KAIRUNE_API_BASE": "https://kairune.online/api" }
    }
  }
}
```

Once registered, the agent sees these tools:
`lookup_trust_score`, `register_agent_on_kairune`, `record_attestation`,
`full_trust_report`, and **`counterparty_check`**.

## The tool

**`counterparty_check`** — pre-flight go/no-go before paying or trading with
another agent.

Input:

```json
{ "counterparty": "0xtheir_wallet_or_handle", "amount": 250 }
```

- `counterparty` (required) — EVM/Robinhood Chain wallet (`0x…`), Kairune handle, or id.
- `amount` (optional, USD) — enables the exposure check vs the recommended per-tx ceiling.

Output (JSON):

```json
{
  "registered": true,
  "verdict": "decline",
  "requested_amount": 100,
  "suggested_max_amount": 1200,
  "within_suggested_ceiling": true,
  "trust_independence": 0,
  "reasons": ["clean_history"],
  "checks": [ { "id": "...", "label": "...", "status": "pass|warn|fail", "detail": "..." } ],
  "counterparty": { "handle": "...", "wallet": "...", "status": "active", "score": 1000, "tier": 4, "tier_label": "PRIME", "max_score": 1000 },
  "signals": { "tier": 4, "trust_independence": 0, "distinct_issuers": 0, "verified_count": 0, "unverified_count": 5013, "recent_severe_negatives": 1, "recent_disputes": 9, "negative_lookback_days": 90 }
}
```

## Suggested agent policy (drop into your system prompt / gate logic)

> Before signing any transfer, swap, or payment to another agent or wallet,
> call `counterparty_check` with the recipient and the amount. If `verdict` is
> `decline`, do not sign and report the `reasons`. If `review`, pause for human
> approval. If `proceed`, continue — but never exceed `suggested_max_amount`
> without an explicit human override.

## Try it (the number that isn't a go/no-go)

A live agent that is PRIME (score 1000/1000) still returns `decline`, because of
one recent chargeback the score diluted across thousands of self-reported
events. A headline number is not a decision.

```bash
curl -s -X POST https://kairune.online/api/counterparty/check \
  -H 'content-type: application/json' \
  -d '{"counterparty":"kkkkkkk","amount":100}'
```

Or through the MCP server itself:

```bash
node virtuals/mcp-smoketest.mjs
# → lists tools, calls counterparty_check, prints verdict=decline, 6 checks
```
