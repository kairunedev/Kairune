# Design Document

## Overview

Verifiable attestations add a cryptographic trust anchor to Kairune's attestation pipeline. Today `POST /api/agents/:id/attestations` accepts any payload with no authentication, so the data that drives the trust score — and therefore spending permissions — can be fabricated freely. This feature introduces the concept of an **Issuer** (a registered party that submits attestations), lets issuers sign attestations with an Ed25519 key, verifies those signatures server-side, records each attestation's verification status, and teaches the trust score engine to weight verified attestations fully while discounting unverified ones.

The design is deliberately additive and backward compatible: the existing unauthenticated flow keeps working and is recorded as `unverified`. No new runtime dependency is introduced — signature verification uses Node's built-in `crypto` module (Ed25519), consistent with the project's "no extra dependency" style already used in `rateLimit.js` and `moderation.js`.

### Goals

- Let known issuers submit attestations whose authenticity and integrity are cryptographically verifiable.
- Discount unverified data in scoring without breaking existing integrations.
- Surface verification status transparently in API responses and the public trust card.
- Add no new npm dependency; reuse existing middleware, service, and DB patterns.

### Non-goals

- On-chain publication of attestations or scores (separate roadmap item).
- Replay-protection / issued-at freshness windows (flagged as an open question; not implemented in this iteration unless confirmed).
- Multiple signature algorithms — Ed25519 only for now.

## Requirements Traceability

| Requirement | Addressed by |
| --- | --- |
| R1 Issuer Registration | `issuerService.createIssuer`, `GET/POST /api/issuers`, Admin gate via `requireAdmin` |
| R2 Issuer Public Key Management | `issuerService` key ops, `POST/DELETE /api/issuers/:id/keys`, API-key auth middleware |
| R3 Signed Attestation Submission | `verification.verifyAttestation`, canonical payload, modified `POST /api/agents/:id/attestations` |
| R4 Backward-Compatible Unverified Submissions | Submission branch when no issuer fields present → `unverified`, existing validation preserved |
| R5 Verification-Weighted Trust Scoring | `trustScore.computeScore` factor logic, `UNVERIFIED_WEIGHT_FACTOR` config |
| R6 Surfacing Verification Status | Attestation serializer, trust-card counts, secret redaction |
| R7 Rate Limiting & Abuse Protection | Reuse `rateLimit` middleware; per-issuer keying; verification latency budget |

## Architecture

```
                        POST /api/agents/:id/attestations
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │  rateLimit (existing)    │  per API-key or IP
                        └─────────────────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
   signed?  ──── yes ──▶│  verification module     │──▶ verify Ed25519 sig
      │                 │  (canonical payload)     │    against issuer_key
      │ no              └─────────────────────────┘
      ▼                              │
 record as                          ▼
 'unverified'            record 'verified' | 'unverified'
      │                              │
      └──────────────┬───────────────┘
                     ▼
        attestationService.addAttestation
                     ▼
        agentService.recalcAgent  ──▶  trustScore.computeScore
                                        (verified=1.0, unverified=0.25)

  Admin ──▶ POST /api/issuers            (register issuer, one-time API key)
  Issuer ─▶ POST /api/issuers/:id/keys   (register public key,  API-key auth)
  Issuer ─▶ DELETE /api/issuers/:id/keys/:kid (revoke key, API-key auth)
```

### New / changed modules

| Module | Change |
| --- | --- |
| `src/db/schema.sql` | Add `issuers` and `issuer_keys` tables; add `verification_status`, `issuer_id`, `issuer_key_id` columns to `attestations` (idempotent). |
| `src/db/index.js` | No structural change. Add a small idempotent `ALTER TABLE ... ADD COLUMN` migration guard (see Data Models) since `CREATE TABLE IF NOT EXISTS` won't add columns to an existing table. |
| `src/services/issuerService.js` | **New.** Issuer + key CRUD, API-key generation/hashing, ownership checks. |
| `src/services/verification.js` | **New.** Canonical payload builder + Ed25519 verify; pure and unit-testable. |
| `src/middleware/issuerAuth.js` | **New.** Resolve issuer from `X-Issuer-Key`; attach `req.issuer`. |
| `src/services/attestationService.js` | Extend `addAttestation` to accept verification result; persist new columns. |
| `src/services/agentService.js` | `recalcAgent` selects `verification_status` and passes it to `computeScore`. |
| `src/services/trustScore.js` | `computeScore` applies `Verified_Weight_Factor`; breakdown returns verified/unverified/excluded counts. |
| `src/routes/api.js` | New issuer routes; modified attestation submission; `/api/meta` exposes new config. |

## Components and Interfaces

### verification.js (new, pure)

```js
// Canonical payload: deterministic, sorted-key JSON over a fixed field set.
// Fields: agent_id, kind, amount, note, issuer_id, issuer_key_id, issued_at
function canonicalPayload(fields) // -> string (stable JSON)

// Verify an Ed25519 signature (base64) over the canonical payload.
// publicKeyPem: SPKI PEM string stored on the issuer_key.
function verifySignature({ publicKeyPem, canonical, signatureB64 }) // -> boolean

// High-level: given submission fields + resolved issuer_key row, return
// { status: 'verified'|'unverified', reason }.
function evaluate({ fields, issuerKey }) // -> {status, reason}
```

Canonicalization uses `JSON.stringify` over an object built in a fixed key order (or `Object.keys().sort()`), with `amount` normalized to a number and `note` normalized to `null` when empty, so signing and verification produce identical bytes (R3.8 round-trip property). Verification uses `crypto.verify('ed25519' via null algorithm, Buffer.from(canonical), keyObject, signature)` with `crypto.createPublicKey(publicKeyPem)`.

### issuerService.js (new)

```js
createIssuer({ displayName })        // Admin path. -> { issuer, apiKey } (apiKey returned once)
listIssuers()                        // -> issuers[] without secrets
getIssuerByApiKey(apiKey)            // -> issuer | null   (constant-time hash compare)
addKey(issuerId, { publicKeyPem, algo }) // -> issuerKey (active)
revokeKey(issuerId, keyId)           // -> {status} ; 404 if missing, idempotent if already revoked
getActiveKey(issuerId, keyId)        // -> issuerKey | null
```

- **API key**: generated as `crypto.randomBytes(24).toString('base64url')` (≥ 32 chars, R1.1). Stored only as a SHA-256 hash (`api_key_hash`); the plaintext is returned once at registration and never again (R1.2, R1.3, R6.5).
- **Display name**: trimmed, validated 1–200 chars (R1.4).
- **Key size guard**: reject encoded public key > 4096 bytes or unparseable via `crypto.createPublicKey` (R2.3).
- **Ownership**: key ops verify the resolved `req.issuer.id` matches the `:id` path param, else 403 (R2.9).

### issuerAuth.js (new middleware)

Reads `X-Issuer-Key` header, calls `getIssuerByApiKey`. On miss/absent → 401 (R2.2). On success attaches `req.issuer`. Applied to issuer key-management routes and consulted (optionally) on attestation submission.

### Trust score changes (trustScore.js)

`computeScore(attestations, nowMs, opts)` — `opts.unverifiedFactor` defaults to `DEFAULT_UNVERIFIED_FACTOR = 0.25`, clamped/validated to `[0,1]`; invalid config falls back to 0.25 and is reported (R5.4).

Per attestation:
```
factor = att.verification_status === 'verified' ? 1.0
       : att.verification_status === 'unverified' ? unverifiedFactor
       : EXCLUDE            // any other status → excluded from score
effectiveWeight = base * factor * recencyFactor(...)
```
`base` is `att.weight ?? KIND_WEIGHTS[att.kind]` as today. Negative (penalty) weights keep the asymmetric ×1.15 treatment. The factor scales magnitude for both positive and negative events (an unverified chargeback also counts at 0.25) — noted as an intentional, documented policy.

`breakdown` gains `verifiedCount`, `unverifiedCount`, `excludedCount` (R5.7). Empty input returns the baseline score with all counts 0 (R5.8). Determinism is preserved: output is a pure function of (attestations, nowMs, opts) (R5.6).

### API surface

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/issuers` | Admin (`X-Admin-Key`) | Register issuer; returns `api_key` once (R1). |
| GET | `/api/issuers` | Admin | List issuers, no secrets (R1.5). |
| POST | `/api/issuers/:id/keys` | Issuer (`X-Issuer-Key`) | Register public key (R2.1–2.3). |
| DELETE | `/api/issuers/:id/keys/:kid` | Issuer | Revoke key; 404 missing, idempotent (R2.5–2.7). |
| POST | `/api/agents/:id/attestations` | Optional Issuer | Signed → verify; unsigned → unverified (R3, R4). |

Signed submission body adds: `issuer_id`, `issuer_key_id`, `signature` (base64), `issued_at` (ISO). Partial credential sets (some but not all of the three) → 400 (R3.4, R4.6). Signature mismatch → 400 (R3.5). Unknown issuer/key → 400 (R3.6). API key mismatch → 401 (R3.7). Verified against a `revoked` key → recorded `unverified` (R2.8, R3.3).

## Data Models

Added to `src/db/schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS issuers (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  api_key_hash  TEXT NOT NULL UNIQUE,          -- sha256 of the plaintext key
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','disabled')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issuer_keys (
  id            TEXT PRIMARY KEY,
  issuer_id     TEXT NOT NULL,
  public_key    TEXT NOT NULL,                 -- SPKI PEM (Ed25519)
  algo          TEXT NOT NULL DEFAULT 'ed25519',
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','revoked')),
  created_at    TEXT NOT NULL,
  revoked_at    TEXT,
  FOREIGN KEY (issuer_id) REFERENCES issuers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_issuer_keys_issuer ON issuer_keys(issuer_id);
```

New `attestations` columns. Because `CREATE TABLE IF NOT EXISTS` will not alter an existing table, `initSchema` gains an idempotent column-add guard that inspects `PRAGMA table_info(attestations)` and issues `ALTER TABLE attestations ADD COLUMN ...` only when the column is absent:

```sql
-- added when missing:
verification_status TEXT NOT NULL DEFAULT 'unverified'
                      CHECK (verification_status IN ('verified','unverified'));
issuer_id      TEXT;      -- nullable; set only for verified rows
issuer_key_id  TEXT;      -- nullable
```

Existing rows default to `unverified`, preserving current behavior. `SELECT` in `recalcAgent` changes to include `verification_status`.

## Error Handling

Reuse the existing pattern: throw `Error` with `.status`; `wrap()` forwards to the centralized error middleware in `server.js`, which emits `{ error }` JSON for `/api` paths. Status codes map directly to requirements:

| Condition | Status |
| --- | --- |
| Missing/invalid display name | 400 (R1.4) |
| Missing Admin credential | 401 (R1.5) |
| Missing/invalid issuer API key | 401 (R2.2, R3.7) |
| Malformed / oversized public key | 400 (R2.3) |
| Revoke non-existent key | 404 (R2.6) |
| Cross-issuer key op | 403 (R2.9) |
| Signature mismatch / unknown issuer or key / partial creds | 400 (R3.4–3.6, R4.6) |
| Rate limit exceeded | 429 + Retry-After (R7.4) |

On any rejection, no attestation is recorded and no rescore occurs (R3.4–3.7, R4.5).

## Testing Strategy

Extend the existing `node:test` suites (in-memory DB, `DB_PATH=:memory:`); no new test dependency.

Unit (`src/tests/`):
- `verification`: canonical payload determinism; round-trip sign→verify with a generated Ed25519 keypair (`crypto.generateKeyPairSync('ed25519')`); tamper detection (mutated field fails).
- `trustScore`: verified vs unverified weighting (0.25 default); configurable factor; invalid factor falls back to 0.25; breakdown counts; empty input → baseline; determinism.

Integration (`api.test.js`):
- Register issuer (Admin) → API key returned once; second read never exposes it.
- Register key; submit signed attestation → `verified`; verify score rises more than an equivalent unsigned submission.
- Unsigned submission still 201 → `unverified` (backward compat).
- Signature mismatch → 400; unknown issuer/key → 400; partial creds → 400; wrong API key → 401.
- Revoke key → subsequent submissions with it recorded `unverified`.
- Cross-issuer key op → 403.
- Attestation responses include `verification_status` and never expose signature/API key/private material.

## Correctness Properties

These are invariants the implementation must uphold; each is directly checkable by tests.

### Property 1: Signature round-trip
For any attestation fields and any Ed25519 keypair, a signature produced over `canonicalPayload(fields)` verifies successfully against the corresponding public key, and any single-field mutation causes verification to fail.

**Validates: Requirements 3.8, 3.5**

### Property 2: Canonical determinism
`canonicalPayload(fields)` produces byte-identical output for identical field values regardless of input key order.

**Validates: Requirements 3.8**

### Property 3: Status totality
Every recorded attestation has exactly one `verification_status` in {`verified`, `unverified`}; no row is persisted without one.

**Validates: Requirements 4.4**

### Property 4: Verified dominance
For identical attestation content, a `verified` attestation contributes at least as much magnitude to the score as an `unverified` one, given `unverifiedFactor` in [0,1].

**Validates: Requirements 5.1, 5.2, 5.3**

### Property 5: Scoring determinism
`computeScore(attestations, nowMs, opts)` is a pure function: identical inputs yield identical output, including breakdown counts.

**Validates: Requirements 5.6**

### Property 6: Count conservation
`verifiedCount + unverifiedCount + excludedCount` equals the number of input attestations.

**Validates: Requirements 5.7**

### Property 7: Config safety
An out-of-range or non-numeric `unverifiedFactor` never changes scoring math beyond falling back to the 0.25 default.

**Validates: Requirements 5.4**

### Property 8: No-write on rejection
Any submission that returns 4xx leaves the attestations table and the agent's score unchanged.

**Validates: Requirements 3.4, 3.5, 3.6, 3.7, 4.5, 4.6**

### Property 9: Secret non-exposure
No API response ever contains a plaintext API key (after registration), a raw signature, or private key material.

**Validates: Requirements 1.3, 6.5**

## Backward Compatibility

- Existing `POST /api/agents/:id/attestations` calls with no issuer fields are unchanged in shape and still return 201, now tagged `unverified`.
- Existing attestation rows migrate to `verification_status='unverified'` via column default; scores shift downward for agents built on unverified data — this is the intended effect and should be called out in the changelog/README, plus `/api/meta` will publish `unverified_weight_factor` so consumers can interpret the change.
- `computeScore` remains a pure function; the new `opts` argument is optional and defaults preserve deterministic behavior.

## Open Questions (from requirements, pending confirmation)

- Confirm default `Verified_Weight_Factor` = 0.25.
- Confirm Ed25519 as the sole supported algorithm.
- Confirm issuer key management is API-key authenticated (no additional Admin approval).
- Decide whether to enforce an `issued_at` freshness window (replay protection) and, if so, the acceptable clock skew — currently out of scope.
