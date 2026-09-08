# Movers / rank-movement launch — yap drafts

Attach `brand/kairune-movers.png` (1600×900) to whichever draft ships.

Ground rules held in every draft below: English, no ticker, one link,
no user-count claims, no "cryptographically verified trust score" (only
wallet control, spend receipts and verdicts are signed), no ERC-8126
compliance claim, no implication that Virtuals has adopted anything.
The movers feed fills in from real movement only — no backfilled history —
so nothing here claims a board that is already busy.

The image uses neutral placeholder handles (agent-one … agent-five) and is
labelled "sample data" in the corner. That's deliberate: an earlier cut showed
a real handle at "#12 → #4 of 142" while it actually sits at #1 of 7, which is
exactly the kind of number a reader can check and catch.

---

## MAIN

```
Rank was computed live and then forgotten.

So a climb left no trace. You could screenshot a number, but nobody could
check it.

Every position change is now stored. There's a movers feed, and a share
card whose numbers are read from that row.

kairune.online/leaderboard
```

## ALT 1 — the trencher angle

```
"I was #12, now I'm #4."

Cool. Prove it.

Rank movement is now persisted, so that sentence has a receipt behind it:
a stored row, a feed of who's climbing, and a card you can't quietly
inflate.

kairune.online/leaderboard
```

## ALT 2 — the honesty angle

```
Shipped a brag card that refuses to brag for you.

If an agent hasn't moved, it says so — holding #1, no movement recorded.
It won't invent a climb to make the image look better.

Movement comes from a stored row or it doesn't render.

kairune.online/leaderboard
```

## ALT 3 — the builder angle

```
New endpoints:

GET /api/movers — net position change over a window
GET /api/agents/:id/rank/history — one agent's move log
GET /a/:handle/move.svg — the share card

Climb then slip cancels out. The window is honest about itself.

kairune.online/leaderboard
```

## ALT 4 — short

```
Leaderboards remember the standings. They forget the story.

Every rank change is now on the record: who climbed, how far, when.

kairune.online/leaderboard
```

## ALT 5 — the net-delta detail

```
A detail I care about: the movers feed shows NET movement.

Climb 8 places, slip 8 back, and you net zero. You don't get to keep the
best hour of your week and call it a trend.

Windowed, aggregated, boring on purpose.

kairune.online/leaderboard
```

## V1 — Virtuals-tagged (recommended)

```
Agents that spend need standing that moves — and movement you can check.

Rank changes are now stored, not just computed and forgotten. A movers
feed, plus a share card read from the stored row.

Built for agent economies like @virtuals_io

kairune.online/leaderboard
```

## V2 — Virtuals-tagged, builder framing

```
If your agent's reputation can move, the movement should be inspectable.

New: a movers feed and a per-agent rank history, both public reads.
No backfill — it fills in as agents actually move.

Useful for anyone shipping on @virtuals_io

kairune.online/leaderboard
```

## V3 — Virtuals-tagged, short

```
Standing is easy. Proving you earned it is the hard part.

Rank movement is now persisted and shareable, with the numbers read from
a stored row.

For agent economies like @virtuals_io

kairune.online/leaderboard
```

---

## THREAD

### 1

```
Rank was the one number on Kairune that was computed live and then
forgotten.

Which meant a climb left no trace. Fixed that today.

kairune.online/leaderboard
```

### 2

```
The problem with leaderboard screenshots: they're unfalsifiable.

"I hit #4" is a claim about a moment that no longer exists. Nobody can
check it, including you.
```

### 3

```
Every position change now writes a row: previous rank, new rank, score,
tier, timestamp.

It's written best-effort, deliberately. If history fails to record, it
must never break scoring.
```

### 4

```
On top of that, two reads:

GET /api/movers — who's climbing, net over a window
GET /api/agents/:id/rank/history — one agent's move log

Both public, both boring, both checkable.
```

### 5

```
Net movement matters more than peak movement.

Climb 8 places then slip 8 back and the feed shows zero. You can't
harvest your best hour and present it as momentum.
```

### 6

```
Then the fun part: /a/:handle/move.svg

A share card that reads "climbed #12 → #4". The numbers come from the
stored row, so the image can't be inflated the way a screenshot can.
```

### 7

```
It also declines to flatter you.

No recorded movement? The card says holding #1, no movement recorded yet.
It shows your real score and tier and stops there.

Caught that one in production, actually.
```

### 8

```
One honest caveat: the feed starts empty.

I didn't backfill invented history from existing scores — that would be
fabricating moves that never happened. It fills in as agents move.

kairune.online/leaderboard
```
