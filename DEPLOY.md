# Deploy Kairune to Vercel + Turso

Kairune needs a database. Vercel is **serverless** (it can't keep a persistent SQLite file), so the database moves to **Turso** (SQLite in the cloud, free). The code auto-detects: if the Turso env is present → use Turso; otherwise → use a local file.

Total time: ~10 minutes. You run every step yourself (all files are already prepared).

---

## Step 1 — Create a Turso database (free)

1. Install the Turso CLI:

   ```bash
   # macOS / Linux
   curl -sSfL https://get.tur.so/install.sh | bash

   # Windows (WSL recommended) — run the command above inside WSL
   ```

2. Sign up + log in (with GitHub):

   ```bash
   turso auth signup
   ```

3. Create the database:

   ```bash
   turso db create kairune
   ```

4. Get the **database URL**:

   ```bash
   turso db show kairune --url
   # example output: libsql://kairune-yourname.turso.io
   ```

5. Create an **auth token**:

   ```bash
   turso db tokens create kairune
   # example output: eyJhbGciOi... (long string)
   ```

Save both values (URL + token) for step 3.

---

## Step 2 — Load schema + seed data into Turso (optional but recommended)

From the project folder, set the env then run the seed. This creates the tables + 5 demo agents in the cloud database.

```bash
export TURSO_DATABASE_URL="libsql://kairune-yourname.turso.io"
export TURSO_AUTH_TOKEN="eyJhbGciOi..."

npm run seed
```

You'll see:

```
[seed] voyager-07   score= 830 tier=3 (TRUSTED)
[seed] scout-14     score= 447 tier=1 (EMERGING)
...
```

> The table schema is also created automatically the first time the app connects, so this seed is purely for populating sample data. Skip it if you want to start empty.

---

## Step 3 — Deploy to Vercel

### Option A — via CLI (fastest)

1. Install & log in:

   ```bash
   npm i -g vercel
   vercel login
   ```

2. From the project folder:

   ```bash
   vercel
   ```

   Answer the setup prompts (accept the defaults). This creates a preview deployment.

3. Add the environment variables:

   ```bash
   vercel env add TURSO_DATABASE_URL
   # paste: libsql://kairune-yourname.turso.io  → choose Production (+ Preview/Development if you want)

   vercel env add TURSO_AUTH_TOKEN
   # paste token → choose Production
   ```

4. Deploy to production:

   ```bash
   vercel --prod
   ```

### Option B — via GitHub + the Vercel dashboard

1. Push the project to a GitHub repo.
2. On [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
3. **Root Directory**: choose the folder that contains `vercel.json` (i.e. `kairune-project`).
4. Before deploying, open **Settings → Environment Variables** and add:
   - `TURSO_DATABASE_URL` = `libsql://kairune-yourname.turso.io`
   - `TURSO_AUTH_TOKEN` = the token from step 1
5. Click **Deploy**.

---

## Result

After deploying, you get a URL like `https://kairune.vercel.app`:

| URL | Content |
| --- | --- |
| `/` | Landing page |
| `/app` | Live console dashboard (data from Turso) |
| `/health` | Health check |
| `/api/agents` | REST API (leaderboard) |

All console features — register agents, record attestations, grant/revoke permissions — work fully and **data persists** in Turso.

---

## Architecture on Vercel

```
Browser
  ├── /  /app  /assets/*        → Vercel CDN (static, fast)
  └── /api/*  /health           → serverless function (api/index.js → Express)
                                     │
                                     └── Turso (libSQL over HTTP) ← persistent data
```

- Static files are served by the CDN (see `rewrites` in `vercel.json`).
- Only `/api/*` and `/health` call the function (efficient, fast).
- The DB layer automatically uses `@libsql/client/web` (pure-JS HTTP) on serverless — no native binary that would break the build.

---

## Troubleshooting

- **Empty console / "fetch failed" error** → check that `TURSO_DATABASE_URL` & `TURSO_AUTH_TOKEN` are set in Vercel (Production), then redeploy.
- **401 from Turso** → wrong/expired token. Recreate it: `turso db tokens create kairune`.
- **Want to reset data** → `npm run seed:reset` (with the Turso env set), or `turso db shell kairune` then `DELETE FROM agents;`.
- **Local still using a file** → don't set the Turso env when running `npm start` locally; the app automatically uses `data/kairune.db`.
