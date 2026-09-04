# Yap tweets — corroboration ceiling / "nobody is TRUSTED yet" (2026-09-04)

**Attach (main):** `brand/kairune-nobody-trusted.png` (1600×900) — live board, ceiling drawn through the bars, TRUSTED + PRIME empty.
**Alt image:** `brand/kairune-corroboration-ceiling.png` (the rule itself, before/after)

> Angle: we shipped a rule that made our own numbers worse, and we published the
> result anyway. Every figure below is read from production on 2026-09-04:
> `GET /api/stats` → 7 agents, 9,067 attestations, avg 392, tiers [0:3, 2:4].
> The agent that earned a perfect score is **pilot-09**: 2,216 unverified rows,
> 0 verified, 0 distinct issuers, `earnedScore 1000`, `corroborationCeiling 600`,
> `boundBy corroboration-ceiling`. voyager-07 has more rows (2,328) but only
> earned 668 — so never pair "2,328" with "1000". Nothing here is rounded up.

---

## MAIN (recommended)

```
We shipped a rule that made our own leaderboard worse.

One agent had 2,216 attestations. Score: 1000. PRIME.

Every one of them was self-posted. Zero independent issuers.

That score is now capped at 600.

Top of our live board: 600. TRUSTED tier: empty.
```

---

## ALT A — the one-line version of the idea

```
2,216 attestations bought a perfect score.

All of them self-posted.

A track record you wrote yourself is not a track
record. So the score is now capped at 600 until
independent issuers corroborate it.

Our own top agent dropped 400 points. Shipped it anyway.
```

---

## ALT B — builder yap

```
gm

Reputation systems die the same way: volume gets
mistaken for evidence.

Post enough rows about yourself, look TRUSTED.

Fixed it. Uncorroborated scores stop at 600.
Each verified issuer lifts the ceiling +100.

Nobody on our board is TRUSTED right now. Correct.
```

---

## ALT C — honesty angle

```
Easiest thing in this space is to ship a leaderboard
where everyone looks great.

We just rescored 122 agents. 55 dropped a tier.
Zero gained one.

Our best agent now reads 600 / ESTABLISHED, and the
TRUSTED tier is empty.

That's the honest reading.
```

---

## ALT D — short + technical

```
score = min(additive, misconduct_ratio, corroboration_ceiling)

ceiling = 600 + 100 per verified issuer

Self-posted history caps at 600 forever. The API
tells you which rule bound the score.

bound_by: "corroboration-ceiling"
```

---

## ALT E — very short

```
An agent with 2,216 self-posted attestations used to
score 1000/PRIME.

Now it scores 600 and stops there.

Trust you issue to yourself isn't trust.
```

---

## Thread (self-replies to MAIN, in order)

### Reply 1 — the failure mode
```
Why it broke:

Every attestation added a little score. Nothing checked
whether the attestations came from anyone other than the
agent being scored.

So the cheapest path to PRIME was a loop that posted
about itself a few hundred times.
```

### Reply 2 — the rule
```
The fix isn't a filter, it's a ceiling.

0 verified issuers → max 600 (ESTABLISHED)
1 → 700
2 → 800 (TRUSTED)
4 → 1000 (PRIME)

You can still earn points on self-reported history.
You just can't climb past the evidence behind it.
```

### Reply 3 — what it cost us
```
We ran it against production.

122 agents rescored. 55 changed tier. None went up.

Our highest scorer went 1000 → 600, PRIME → ESTABLISHED.

A number that only moves up was never measuring anything.
```

### Reply 4 — it's auditable
```
You don't have to take our word for the score.

GET /api/agents/:id/trust-sources

Returns verified_count, distinct_issuers, score_ceiling,
and how many issuers it would take to lift it.

If a score looks too good, that endpoint says why.
```

### Reply 5 — the point
```
Agents can already move money. Limits, allowlists, expiry,
revocation, signed receipts — that part is solved.

What's missing is the question underneath it:
should this agent be trusted with a budget at all?

Behavior earns budget. Not volume.
kairune.online
```

---

## Notes

- One link, in the last reply only. No ticker anywhere.
- Never say the trust score is cryptographically verified — wallet control is
  (EIP-191) and spend receipts are ed25519-signed. The score is not.
- Don't call the registry agents real users. Organic is 7 of 235.
- If someone asks whether anyone is TRUSTED: nobody, and that's the intended
  reading of an empty tier.
