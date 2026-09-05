# Yap tweets — misconduct is a ratio (2026-09-05)

**Attach (main):** `brand/kairune-misconduct-ratio.png` (1600×900) — before/after on
one chargeback, severity bars, and the "same 498 at any volume" row.
**Alt image:** `brand/kairune-nobody-trusted.png` (the live board + ceiling)

> Angle: misconduct is priced as a *share* of the record, not a fixed deduction,
> so volume can't buy it back. Every number is measured from the real
> computeScore via scripts/probe-asymmetry.mjs on 2026-09-05:
>   100 clean → 979/PRIME; +1 chargeback → 845/TRUSTED (−134);
>   it takes ~640 clean payments to climb back from that one event.
>   dispute −80, chargeback −134, anomaly −167 (severity preserved).
>   5% chargeback rate → 498/EMERGING at 200, 1,000, and 3,000 clean, all
>   bound_by "misconduct-ratio".

---

## MAIN (recommended)

```
An agent with 100 clean payments scores 979. PRIME.

One chargeback drops it to 845.

To climb back from that single event: ~640 more
clean payments.

Misconduct isn't a deduction you outspend. It's a
ratio of your whole record.
```

---

## ALT A — the "volume can't save you" cut

```
200 clean payments, 5% chargebacks → 498.
1,000 clean payments, 5% chargebacks → 498.
3,000 clean payments, 5% chargebacks → 498.

Same score. Because it's a rate, not a running total.

You can't out-volume a bad chargeback rate.
```

---

## ALT B — builder yap

```
gm

Most "trust scores" are a sum. Do enough good stuff,
bury the bad stuff. Volume wins.

Ours prices misconduct as a share of your record:

  score = min(earned, misconduct_ratio, ceiling)

One chargeback on a clean history costs ~640 payments
to undo. That's the point.
```

---

## ALT C — severity angle

```
Not all bad events are equal, and the score knows it.

dispute      −80
chargeback   −134
anomaly      −167

(from the same 100-clean-payment baseline)

Worse conduct, sharper fall. The reason gets written
into the score, not averaged out of it.
```

---

## ALT D — short + technical

```
score = min(earned, misconduct_ratio, corroboration_ceiling)

misconduct_ratio = f(bad_weight / total_weight)

So a 5% chargeback rate scores the same at 200 clean
or 3,000 clean. Volume is in the denominator too.

bound_by: "misconduct-ratio"
```

---

## ALT E — very short

```
100 clean payments → 979.
+1 chargeback → 845.

~640 clean payments to undo one bad one.

Trust is asymmetric. So is the score.
```

---

## Thread (self-replies to MAIN, in order)

### Reply 1 — why a sum fails
```
The naive version adds a little score per good event
and subtracts per bad one.

At scale the positives overflow the top, the clamp
eats the penalty, and a 5% chargeback agent still
reads 1000/PRIME.

We had exactly that bug. A sum can't price risk.
```

### Reply 2 — the fix
```
So misconduct is multiplicative, not additive:

  factor = 1 − (bad_weight / total_weight) × slope

It's a share of your whole record, so it survives the
clamp and it's volume-normalised. A big honest operator
isn't punished for having one dispute in a huge history.
```

### Reply 3 — severity is kept
```
It reads the signed weights, not a count, so severity
carries through:

  dispute    −40  → −80 off a 979
  chargeback −70  → −134
  anomaly    −90  → −167

A chargeback should cost more than a dispute. It does.
```

### Reply 4 — it's auditable
```
The score tells you which rule bound it:

  bound_by: "additive"              → earned it
  bound_by: "misconduct-ratio"      → conduct capped it
  bound_by: "corroboration-ceiling" → no verified issuers

GET /api/agents/:id and read the breakdown. No black box.
```

### Reply 5 — the point
```
Agents can already move money. Limits, allowlists,
expiry, revocation, signed receipts — solved.

The open question is whether an agent should be trusted
with a budget at all.

A record you can outspend isn't a record.
kairune.online
```

---

## Notes

- One link, last reply only. No ticker anywhere.
- Numbers are from computeScore, not production rows — say "an agent with 100
  clean payments" (hypothetical), not a named handle. Our live agents have 0
  verified attestations, so they're not the illustration here.
- Never claim the trust score is cryptographically verified (wallet control is,
  EIP-191; spend receipts are ed25519-signed). The score is not.
- Never claim ERC-8126 compliance (adapter is derived, compliant:false).
- The three bound_by values are exactly: additive, misconduct-ratio,
  corroboration-ceiling.
