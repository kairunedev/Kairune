# Green suite, three live bugs — yap drafts

Attach: brand/kairune-green-suite.png

Every number here is measured, not rounded for effect:

- `card.svg` returned 500 from `fc0b073` (2026-08-27) to `6011b8d` (2026-09-10) — 14 days
- `card.png` published `$0/day` as the og:image over the same window
- the SDK `sign:true` flag was dropped in `d078268` (2026-09-05), fixed in `940f69f` (2026-09-10) — 5 days
- suite went 509 → 526 tests, 0 failures the entire time
- route sweep finds 46 GET routes, exercises 41 (5 need fixture IDs it can't synthesise)
- `card.png` confirmed as the live `og:image` for `/a/:handle` (server.js:493, verified on prod)
- negative verification: reintroducing bug 1 fails 3 tests, bug 2 fails exactly 1

Claims deliberately avoided: nothing about the trust score being cryptographically
verified, no adoption or user numbers, one link maximum, no ticker.

---

## 1 — the thesis, plainest version

```
526 tests passing. Three bugs live in production.

Not one of them was a missing assertion. Each was a test aimed one layer away from where the bug could live.

A green suite is evidence about your tests. It is not evidence about production.
```

## 2 — the card.svg one

```
Found a route that had been returning 500 for 14 days.

The test for it passed the whole time.

It called renderCardSvg() directly. Never the route. The renderer was always fine — the handler threw before reaching it.

Testing the helper is not testing the endpoint.
```

## 3 — the plausible wrong answer

```
The worst bug I shipped this month rendered "$0/day" on every social preview of an agent card.

$0 is a real value. Tier 0 genuinely has a $0 ceiling.

So nothing looked broken. It just looked like a bad agent.

Wrong answers that are plausible outlive wrong answers that crash.
```

## 4 — the stale build

```
Shipped an SDK change. Suite green. Published.

For 5 days every caller of checkCounterparty({sign:true}) got an unsigned verdict.

The flag was in src/. The committed dist/ was 2 days older. And the test imported dist/ — so the stale build tested itself as consistent.
```

## 5 — the structural point

```
Three bugs, three different blind spots:

- test called the helper, not the route
- wrong answer was a plausible one
- test imported the build artifact

Adding assertions would have caught none of them. The tests were pointed at the wrong layer.
```

## 6 — how I actually found them

```
I did not find these from a bug report.

I walked app._router.stack and sent a GET to every registered route. 46 found, 41 reachable.

One was 500ing, and had been for two weeks.

You can only sweep what you can enumerate.
```

## 6b — same idea, shorter

```
I didn't find these from a bug report.

I walked app._router.stack and sent a GET to all 46 registered routes.

One was 500ing. For two weeks.
```

## 7 — the committed artifact lesson

```
If you commit a build artifact, it is untrusted input.

package.json points at dist/. Consumers install dist/. Nothing in CI rebuilt dist/ — only prepublishOnly did, and that runs on publish.

So src/ and dist/ drifted for 5 days and every test agreed they were fine.
```

## 8 — negative verification

```
Wrote the regression tests, they went green, and I did not believe them.

So I reintroduced each bug and watched them fail. Bug one takes down 3 tests. Bug two takes down exactly 1.

A guard you have never seen fail is not a guard. It is a decoration.
```

## 9 — the honest limitation

```
One of my new guards is weaker than I'd like.

card.png is a raster. I can't read the rendered number back out, so that path only gets a static check on the call site.

Wrote the limitation into the test itself, for whoever loosens it later.
```

## 10 — for people building agent infra

```
Agents spending money need a trust signal that is actually correct, not one that renders.

My og:image said $0/day for two weeks. That is a number a counterparty could have acted on.

Shipping the fix is the easy half. Knowing it was wrong is the hard half.
```

## 11 — short and sharp

```
"All tests passing" and "production works" are two different claims.

I had the first one for 14 days while a route returned 500.
```

## 12 — the reframe

```
Coverage tells you which lines ran.

It does not tell you whether anything ran them the way production does.

My renderer had coverage. The route that called it had none, and that is where the bug was.
```

## 13 — with the link

```
Three bugs shipped, live, and passing CI. Each invisible for a different structural reason.

Wrote up what a green suite cannot see — route-level vs helper-level, plausible wrong answers, and committed build artifacts as untrusted input.

kairune.online
```

## 14 — the two-week question

```
Ask yourself which of your endpoints you have actually sent a request to this month.

Not "which have tests." Which have you hit.

Mine had 526 passing tests. One of them had been 500ing since August 27.
```
