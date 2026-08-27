# Kairune

**Spending limits your AI agents actually earn.** — a working prototype: landing page + **live console dashboard** + **REST API** with a real trust score engine on top of SQLite.

No longer a mockup — you can register an agent, record its behavior (attestation), watch its spending ceiling recalculate in real time, then grant or revoke spending permission based on tier.

> Note: agent trust/reputation is a crowded, fast-moving category with several teams exploring similar ideas. Kairune's specific focus is **spend authorization** — turning behavior into a concrete, revocable spending ceiling — not general-purpose reputation.

---

## Architecture

```
├── index.html / app / a / docs   # product UI
├── assets/                      # CSS, JS, logos in use
├── api/ + server.js + src/      # API + trust engine
├── token/metadata.json          # $KAIRUNE metadata
├── virtuals/                    # ACP provider (local)
├── package.json + vercel.json
└── .env.example
```

## How the trust score works

Every agent has a history of **attestations** (behavior events). The engine computes a score of `0..1000`:

- **Baseline** 120 for a new agent (neutral).
- **Positive events** — `task_completed` (+6), `clean_payment` (+8), `peer_vouch` (+14).
- **Negative events** — `dispute` (−40), `chargeback` (−70), `anomaly_flag` (−90). Penalties are amplified 1.15× (asymmetric: trust is hard to build, easy to lose).
- **Volume bonus** — the more clean activity, the more trusted (logarithmic, anti-spam).
- **Recency decay** — events decay to half their weight every 90 days.

The score maps to a **tier**: 0 UNRATED → 1 EMERGING → 2 ESTABLISHED → 3 TRUSTED → 4 PRIME. The tier determines the maximum spending **ceiling** that can be granted.

## Verifiable attestations

Attestations can be **cryptographically signed** so the data behind a score is provably authentic — not just whatever an anonymous caller posted.

- An **issuer** is a registered party (Admin registers it, gets a one-time API key).
- Issuers register **Ed25519 public keys** and sign each attestation over a canonical payload.
- The server **verifies** every signed submission and marks it `verified` or `unverified`.
- The trust engine weights **verified** attestations at `1.0` and **unverified** ones at `UNVERIFIED_WEIGHT_FACTOR` (default `0.25`) — so unsigned data still counts, but less.
- The existing unsigned flow keeps working unchanged (recorded as `unverified`), so no integration breaks.

Signing uses Node's built-in `crypto` (no extra dependency). Revoked keys cause their attestations to be treated as `unverified`.

**Replay protection:** signed submissions must include an `issued_at` timestamp within a freshness window (`REPLAY_MAX_AGE_SECONDS`, default 300s, plus `REPLAY_FUTURE_SKEW_SECONDS` clock skew), and each signature may be used only once — a reused signature is rejected with `409`.

---

## Spend receipts

Every approved spend is **signed with the platform Ed25519 key at charge time** — who paid, who was paid, how much, when. The signature is stored with the spend, and a public endpoint returns the full receipt: the signed fields, the canonical payload, the signature, and the public key.

- `GET /api/spends/:sid/receipt` — public, no auth. Includes `verified`, computed on the spot.
- `GET /api/platform-key` — the current receipt-signing public key (pin it out-of-band).
- Anyone can prove a charge happened **without trusting any database**: verify the signature against the pinned key.
- Spends recorded before receipts existed report `signed: false` — never an error.
- Idempotent replays return the **same** receipt (never re-signed). Key rotation is supported: each spend pins the `receipt_key_id` that signed it.
- Signing is best-effort at charge time — a key misconfiguration never blocks a legitimate spend.

Configure a production key with `RECEIPT_PRIVATE_KEY` (PEM or 32-byte base64/base64url seed). Unset → an ephemeral in-memory key (dev/test), flagged `ephemeral: true` in the receipt and `/api/platform-key`.

SDK:

```ts
const receipt = await k.getReceipt(spendId)   // { signed, verified, fields, canonical, signature, public_key, ... }
const key = await k.getPlatformKey()          // { algorithm, purpose, public_key, ephemeral }
```

---

## Running locally

Requires **Node.js >= 18**.

```bash
# 1. Install dependencies
npm ci

# 2. Copy the environment template
cp .env.example .env

# 3. Seed the database with demo data (optional but recommended)
npm run seed

# 4. Run
npm start
```

- Landing page → http://localhost:3040
- **Live console** → http://localhost:3040/app
- Health check → http://localhost:3040/health

Reset & re-seed demo data any time:

```bash
npm run seed:reset
```

For development mode:

```bash
npm run dev
```

---

## Environment variables

| Variable   | Default       | Description                        |
| ---------- | ------------- | ---------------------------------- |
| `PORT`     | `3040`        | HTTP port the server listens on    |
| `HOST`     | `0.0.0.0`     | Bind address                       |
| `NODE_ENV` | `development` | `development` \| `production`      |
| `RECEIPT_PRIVATE_KEY` | —  | Ed25519 key for spend receipts (PEM or 32-byte base64 seed). Unset → ephemeral dev key |

> `.env` is git-ignored. Never commit secrets.

---

## Endpoints

### Pages
| Method | Path       | Description                                   |
| ------ | ---------- | --------------------------------------------- |
| GET    | `/`          | Landing page                                  |
| GET    | `/app`       | Live console dashboard                         |
| GET    | `/docs`      | API docs                                       |
| GET    | `/a/:handle` | Public trust card                              |
| GET    | `/health`    | Health-check JSON (`{ status, uptime, ... }`) |

### REST API (`/api`)
| Method | Path                              | Description                          |
| ------ | --------------------------------- | ------------------------------------ |
| GET    | `/api/meta`                       | Metadata (kinds, tiers, weights)     |
| GET    | `/api/stats`                      | Global statistics                    |
| GET    | `/api/agents`                     | List agents (leaderboard)            |
| POST   | `/api/agents`                     | Register a new agent                 |
| GET    | `/api/agents/:id`                 | Agent detail + score breakdown       |
| PATCH  | `/api/agents/:id/status`          | Suspend / activate an agent          |
| DELETE | `/api/agents/:id`                 | Delete an agent                      |
| GET    | `/api/agents/:id/attestations`    | Attestation history                  |
| POST   | `/api/agents/:id/attestations`    | Add attestation (triggers rescore)   |
| GET    | `/api/agents/:id/permissions`     | List permissions                     |
| POST   | `/api/agents/:id/permissions`     | Grant permission (self-serve; refused below tier 1) |
| POST   | `/api/permissions/:pid/revoke`    | Revoke permission (instant)          |
| GET    | `/api/permissions/:pid/spends`    | Spend history (filterable)           |
| GET    | `/api/agents/:id/spends`          | Spend history across every permission |
| GET    | `/api/agents/:id/spend-summary`   | Spend totals by permission / category / payee |
| GET    | `/api/spends/:sid/receipt`        | Public signed receipt for a spend    |
| GET    | `/api/platform-key`               | Current receipt-signing public key   |

Both spend-history endpoints accept `since`, `until`, `payee` and `idempotency_key`
filters plus `limit`/`offset`. `until` is exclusive so consecutive windows tile
without double-counting, and an unparseable date is a `400` rather than a filter
that silently matches everything. Summary totals cover the requested window, not
each grant's rolling ceiling window — use `/api/permissions/:pid/budget` for
remaining headroom.

### Authorisation model

Granting a budget, spending against it, scoping payees, setting expiry and
revoking are **self-serve** — no platform key. The trust tier is the access
control: an agent below EMERGING (score 250) is refused a permission with
`409 tier_too_low`, because there is no behavioural basis to extend it credit
yet. An agent earns its budget rather than being handed one.

The admin key covers platform-operator surface only: issuer registration,
webhook management, agent status/delete, and the cross-permission spend
reports. It is fail-closed — if `ADMIN_KEY` is unset in production those
routes return `503` rather than opening up.

### Wallet proof (`/api`)
| Method | Path                              | Description                          |
| ------ | --------------------------------- | ------------------------------------ |
| POST   | `/api/agents/:id/wallet-proof/challenge` | Issue a signing challenge (600s TTL) |
| POST   | `/api/agents/:id/wallet-proof`    | Submit an EIP-191 `personal_sign` signature |
| GET    | `/api/agents/:id/wallet-proof`    | Proof status (public read)            |

An agent proves it controls the wallet it claims by signing a server-issued
challenge with `personal_sign` (chain `4663`, domain `kairune.online`). The
private key never leaves the wallet. This proves **wallet control only** — it
is not a claim about the trust score, which is earned from attestations.

### Issuers — verifiable attestations (`/api`)
| Method | Path                              | Auth            | Description                          |
| ------ | --------------------------------- | --------------- | ------------------------------------ |
| POST   | `/api/issuers`                    | Admin           | Register an issuer (returns API key once) |
| GET    | `/api/issuers`                    | Admin           | List issuers (no secrets)            |
| POST   | `/api/issuers/:id/keys`           | `X-Issuer-Key`  | Register an Ed25519 public key       |
| DELETE | `/api/issuers/:id/keys/:kid`      | `X-Issuer-Key`  | Revoke a key                         |

A signed attestation adds `issuer_id`, `issuer_key_id`, `signature` (base64), and `issued_at` to the `POST /api/agents/:id/attestations` body, plus the `X-Issuer-Key` header.

Examples:

```bash
# Register an agent
curl -X POST localhost:3040/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"handle":"voyager-08","wallet":"0xabc...","operator":"Helios"}'

# Record behavior → score recalculated automatically
curl -X POST localhost:3040/api/agents/<id>/attestations \
  -H 'Content-Type: application/json' \
  -d '{"kind":"clean_payment"}'

# Grant a spending permission
curl -X POST localhost:3040/api/agents/<id>/permissions \
  -H 'Content-Type: application/json' \
  -d '{"category":"compute","ceiling":100,"period":"day"}'
```

## Testing

```bash
npm test
```

Runs unit tests (trust score engine) + integration tests (REST API, using an in-memory DB) via `node:test` — no extra test dependencies.

---

## Deploy (Vercel + Turso)

```bash
vercel env add TURSO_DATABASE_URL
vercel env add TURSO_AUTH_TOKEN
vercel --prod
```

Static assets on CDN; `/api/*` + `/health` as serverless. Live: [kairune.online](https://kairune.online).

ACP provider bot (Virtuals jobs): see `virtuals/SETUP.md` — run locally, not on Vercel.

---

## Server features

- Gzip, security headers, static caching
- Health-check + graceful shutdown
- Rate limiting on writes; soft `$KAIRUNE` holder boost via `TOKEN_HOLDER_WALLETS`
- Optional `ADMIN_KEY` for DELETE moderation

---

## Note

Kairune is a **working prototype** — the console, REST API, and trust score engine are live and free to use, with no token required. `$KAIRUNE` is a **live community token** on [Virtuals](https://app.virtuals.io/virtuals/100623) (**Robinhood Chain**); its on-chain utility is on the roadmap and **not yet wired into the product**. This is not financial advice or an investment offering — verify the contract address on the official channel ([@usekairune](https://x.com/usekairune)) and do your own research before interacting with any token or granting agent permissions.
