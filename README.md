# Kairune

**The trust layer for agents that spend.** — a working prototype: landing page + **live console dashboard** + **REST API** with a real trust score engine on top of SQLite.

No longer a mockup — you can register an agent, record its behavior (attestation), watch the trust score recalculate in real time, then grant or revoke spending permission based on tier.

---

## Architecture

```
kairune-project/
├── index.html              # Landing page (marketing)
├── app/                    # 🖥️ Live console dashboard (SPA)
│   ├── index.html
│   ├── console.css
│   └── console.js          # Consumes the REST API, renders leaderboard + detail
├── assets/
│   ├── css/styles.css      # Design system (dark theme, responsive)
│   ├── js/main.js          # Landing animations (graph canvas, ticker, marquee)
│   └── img/                # Logos (SVG + PNG)
├── server.js               # Express: static + REST API + /health + graceful shutdown
├── src/
│   ├── db/
│   │   ├── schema.sql      # SQLite schema (agents, attestations, permissions)
│   │   ├── index.js        # DB connection (singleton)
│   │   └── seed.js         # Demo data
│   ├── services/
│   │   ├── trustScore.js   # 🧠 Trust score engine (score + tier + decay)
│   │   ├── agentService.js
│   │   ├── attestationService.js
│   │   └── permissionService.js
│   ├── routes/api.js       # All REST endpoints
│   └── tests/              # Unit + integration tests (node:test)
├── data/                   # SQLite runtime (gitignored, volume in Docker)
├── package.json            # Dependencies + scripts
├── .env.example            # Environment variables template
├── ecosystem.config.cjs    # PM2 configuration
├── deploy.ps1              # Deploy script to VPS (Windows/PowerShell)
├── Dockerfile              # Multi-stage build, non-root, healthcheck, volume
├── docker-compose.yml      # One-command run + volume persist
└── .dockerignore
```

## How the trust score works

Every agent has a history of **attestations** (behavior events). The engine computes a score of `0..1000`:

- **Baseline** 120 for a new agent (neutral).
- **Positive events** — `task_completed` (+6), `clean_payment` (+8), `peer_vouch` (+14).
- **Negative events** — `dispute` (−40), `chargeback` (−70), `anomaly_flag` (−90). Penalties are amplified 1.15× (asymmetric: trust is hard to build, easy to lose).
- **Volume bonus** — the more clean activity, the more trusted (logarithmic, anti-spam).
- **Recency decay** — events decay to half their weight every 90 days.

The score maps to a **tier**: 0 UNRATED → 1 EMERGING → 2 ESTABLISHED → 3 TRUSTED → 4 PRIME. The tier determines the maximum spending **ceiling** that can be granted.

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

> `.env` is git-ignored. Never commit secrets.

---

## Endpoints

### Pages
| Method | Path       | Description                                   |
| ------ | ---------- | --------------------------------------------- |
| GET    | `/`        | Landing page                                  |
| GET    | `/app`     | Live console dashboard                         |
| GET    | `/health`  | Health-check JSON (`{ status, uptime, ... }`) |

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
| POST   | `/api/agents/:id/permissions`     | Grant permission (capped by tier)    |
| POST   | `/api/permissions/:pid/revoke`    | Revoke permission (instant)          |

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

## Docker

```bash
# Build + run via compose (use "docker compose" or "docker-compose" depending on version)
docker-compose up -d --build

# Check status + health
docker-compose ps

# Logs
docker-compose logs -f kairune

# Stop
docker-compose down
```

Or manually:

```bash
docker build -t kairune:latest .
docker run -d -p 3040:3040 --name kairune kairune:latest
```

---

## Deploy to Vercel (serverless + Turso)

Vercel is serverless, so the database moves to **Turso** (SQLite cloud, free). The code auto-detects the Turso env.

Full steps are in **[DEPLOY.md](./DEPLOY.md)**. In short:

```bash
# 1. Create the Turso DB
turso db create kairune
turso db show kairune --url          # → TURSO_DATABASE_URL
turso db tokens create kairune       # → TURSO_AUTH_TOKEN

# 2. (optional) seed data to the cloud
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run seed

# 3. Deploy
vercel
vercel env add TURSO_DATABASE_URL    # paste URL
vercel env add TURSO_AUTH_TOKEN      # paste token
vercel --prod
```

Static assets (landing, `/app`, assets) are served by the CDN; `/api/*` + `/health` run as a serverless function.

## Deploy to a VPS (PM2)

`ecosystem.config.cjs` and `deploy.ps1` are already provided.

```bash
# On the server (manual):
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save

# Restart after an update:
pm2 restart kairune

# Check health:
curl http://127.0.0.1:3040/health
```

From a local Windows machine, `deploy.ps1` packages, uploads via `scp`, installs, and restarts PM2 on the VPS automatically.

---

## Server features

- ✅ Gzip compression (`compression`)
- ✅ Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`)
- ✅ Caching: static assets 30 days, HTML `no-cache`
- ✅ Health-check endpoint for PM2 / Docker / uptime monitors
- ✅ Graceful shutdown (SIGTERM / SIGINT)
- ✅ 404 & 500 handlers
- ✅ `trust proxy` for running behind nginx / a load balancer
- ✅ Rate limiting on mutating endpoints (POST/PATCH/DELETE), per client IP — reads stay free. Tune via `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`.

---

## Note

Kairune is a **working prototype** — the console, REST API, and trust score engine are live and free to use, with no token required. `$KAIRUNE` is a **live community token** on [Virtuals](https://app.virtuals.io/virtuals/100623) (**Robinhood Chain**); its on-chain utility is on the roadmap and **not yet wired into the product**. This is not financial advice or an investment offering — verify the contract address on the official channel ([@usekairune](https://x.com/usekairune)) and do your own research before interacting with any token or granting agent permissions.
