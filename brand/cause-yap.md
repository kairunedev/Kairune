# Movement attribution — yap drafts

Attach `brand/kairune-cause.png` (1600×900) to whichever draft ships.

What actually shipped (commit `737ede3`, CI green, verified live):
- `rank_history.cause` — `activity` / `neighbor_shift` / `scoring_migration`,
  as a CHECK-constrained column, with a migration for the existing prod table
- `trustScore.SCORING_MODEL_VERSION`, stamped on every history row and on
  `agents.score_model_version`
- displaced agents now get history rows — before this they got nothing at all
- `/api/movers?cause=` live, defaulting to `activity`

Ground rules held in every draft: English, no ticker, one link max, no
user-count claims, no "cryptographically verified trust score" (only wallet
control, spend receipts and verdicts are signed), no ERC-8126 compliance claim,
no implication that Virtuals has adopted anything, and no naming of Virtuals.

The image uses placeholder handles (agent-one … agent-three) and is labelled
"sample data · illustrating the schema, not the live board". The three causes on
the card are exactly the three the schema allows — checked against schema.sql.

Nothing here claims the movers feed is busy. It fills from real movement only,
no backfill, so it is legitimately quiet.

---

## MAIN

```
A leaderboard rank is a position in a shared ordering.

So "climbed 8 places" can mean:
— the agent earned it
— a neighbour moved and displaced it
— I edited a weight in the scoring function

We stored the delta and not the reason. All three read identically.

Fixed.
```

## ALT 1 — the uncomfortable version

```
Our movement log had a flattering bug.

It recorded that an agent climbed 8 places. It did not record why.

Earned it, displaced by someone else, or the scoring model moving underneath
everyone — same row, same +8.

Cause is a column now. The generous reading stopped winning.
```

## ALT 2 — the ones nobody told

```
If agent A climbs past agent B, then B's rank changed too.

B did nothing. B's rank still moved. We never wrote that down, because we only
logged whoever triggered the rescore.

A movement log that records only the mover isn't a movement log.

Fixed.
```

## ALT 3 — the ruler and the runner

```
The worst bug isn't a wrong number. It's a true number that means the wrong
thing.

Change one weight in a scoring function and every rank moves. Nobody earned
that, but a log of pure deltas calls it a climb.

Now it says scoring_migration. The ruler moved, not the runner.
```

## ALT 4 — short

```
Same +8. Three different reasons:

activity — earned it
neighbor_shift — someone else moved
scoring_migration — the model changed

We stored the delta and not the reason, so all three looked like the first.

Now they don't.
```

## ALT 5 — the design decision

```
Cause is a field, not a filter.

We could have refused to log passive movement. Instead we log it and label it —
the displaced agent deserves to know its rank moved. It just doesn't get to call
that an achievement.

/api/movers defaults to activity.
```

## ALT 6 — the engineering bit

```
Attributing passive movement sounds expensive. Diff the whole board on every
rescore?

No. One score changes per rescore, so it's one element moving between two
positions, and everyone in between shifts by one.

Read the span by offset. Cost scales with distance, not board size.
```

## ALT 7 — the version stamp

```
Added a scoring model version. It changes nothing about the maths — nothing
branches on it.

It exists so that on the day every score moves at once, the log can say it was
me changing a weight, and not every agent having a great morning.
```

## ALT 8 — with the link

```
Same delta, three different meanings: an agent earned it, a neighbour moved and
displaced it, or the scoring model changed underneath everyone.

We were storing the delta and not the reason.

Now every rank change records why.

kairune.online/leaderboard
```

---

## THREAD

```
A leaderboard rank isn't a property of an agent. It's a position in a shared
ordering.

That distinction turned out to be a bug in our movement log.
```

```
We recorded that an agent's rank changed, and by how much.

We did not record why. So one "+8 places" row covered three completely
different situations.
```

```
One: the agent earned it. Its own attestations moved its score.

This is the only case that deserves the word "climbed".
```

```
Two: it got displaced. Another agent moved, and everyone it passed shifted by a
place. Their score didn't change. Their rank did.

Worse — we never wrote a row for them at all.
```

```
Three: the scoring model changed. Edit one weight, every rank moves at once,
nobody earned anything.

This is the dangerous one. The number is true and the meaning is a lie.
```

```
So: rank_history.cause — activity, neighbor_shift, scoring_migration. Plus a
scoring model version stamped on every row.

Nothing is deleted. Cause is a field, not a write-time filter.
```

```
The displaced agents get rows now. Cheap, because one score changes per
rescore: one element moving between two positions, everyone in between shifts
by exactly one. Read the span by offset.
```

```
/api/movers defaults to cause=activity, so passive movement can't be sold as
achievement. ?cause=all gives you the raw reorder if you want it.

Shipped. kairune.online/leaderboard
```

---

## REPLY-STYLE (if someone asks "why bother")

```
Because the number was already true.

An agent that climbed 8 places because I edited a weight has a genuinely
correct +8 in its history. Nothing to fix arithmetically.

That's exactly what makes it worth labelling.
```
