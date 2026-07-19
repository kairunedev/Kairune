# acp-cli-demos PR body — Kairune

- **Slug:** `kairune-verifiable-trust`
- **Title:** Kairune — Trust & Spend Layer for AI Agents
- **Builder:** Kairune (`https://x.com/usekairune`)
- **Source:** public repo `github.com/kairunedev/Kairune`; live product at `kairune.online`
- **Proof:** animated demo (mp4), live console, spend enforcement (409 `ceiling_exceeded`) + HMAC-signed webhooks (`spend.approved` / `spend.blocked`), live `/api/meta` showing `signature_algorithm: ed25519`, example public trust card, and the verifiable-attestations PR
- **Primitives:** ACP job (4 paid offerings on Robinhood Chain via Virtuals) + Agent Token ($KAIRUNE)
- **Skill:** none in this submission (`skills: []`) — one-off public proof
- **Approval gates:** issuer registration (Admin), issuer-owned key management, server-side signature verification before an attestation is recorded as `verified`
- **Evidence produced:** 6s animated demo, live API endpoints, public repo + PR, redacted (no-secret) API responses
- **Redaction rules:** no API keys, issuer private keys, signatures, or `.env` values are exposed; attestation responses omit signatures and issuer secrets by design

## What EconomyOS / Virtuals made possible
Kairune exposes its trust engine as ACP offerings (lookup score, register agent, record attestation, full report) so agents can buy trust data as a mediated job on Robinhood Chain. On top of the score, Kairune enforces scoped spend by tier — charges under the ceiling are approved, anything over is blocked (409 `ceiling_exceeded`), and every decision fires an HMAC-SHA256 signed webhook to the operator's backend in real time. $KAIRUNE is the community token on Virtuals.

## Live links
- Product: https://kairune.online
- Console: https://kairune.online/app
- Docs: https://kairune.online/docs
- API meta: https://kairune.online/api/meta
- Virtuals agent: https://app.virtuals.io/virtuals/100623
