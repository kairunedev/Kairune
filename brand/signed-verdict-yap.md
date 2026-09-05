# Signed counterparty verdict — yap drafts

Every number and every byte below is copied from a real production response on
2026-09-05 (`POST https://kairune.online/api/counterparty/check {sign:true}`,
then `POST /api/verify`). Do not edit the canonical string, the signature or the
key id by hand — regenerate them from a live call instead, or the card and the
copy stop matching reality.

Verified facts available to draw on:
- Verdict for `pilot-09` at amount 250 was `review`, score 600, tier 2,
  suggested_max_amount 150.
- 9 signed fields: counterparty_handle, counterparty_wallet, issued_at,
  registered, requested_amount, score, suggested_max_amount, tier, verdict.
- `ephemeral_key: false`, `key_id: 4886580f-…` — a real pinned platform key,
  the same one that signs spend receipts.
- Genuine → `verified: true, mode: "verdict"`. No mode flag → auto-detected,
  still true. `verdict` flipped to `"proceed"` → `verified: false`.
- The `checks[]` prose is not covered by the signature.

Do NOT claim: that the trust score itself is cryptographically verified (it is
not — the score is a server computation over stored rows), or that this is
ERC-8126 compliant, or that Virtuals has adopted or reviewed it.

Attach: `assets/img/kairune-signed-verdict.png`

---

## MAIN

```
Your agent asks us whether to pay a counterparty. We say review, proceed, or
decline.

Until today you just had to believe that answer came from us.

Now it comes signed. Ed25519, over the decision only.

Flip one field and verification fails.
```

---

## ALT 1 — the third-party framing

```
A signed receipt proves a payment happened.

A signed verdict proves something harder: that we were asked about THIS
counterparty, at THIS amount, at THIS moment, and answered this.

The seller can check it. The escrow keeper can check it. Without our SDK.
```

## ALT 2 — what is and isn't signed

```
Nine fields are signed: who, which wallet, when, registered, the amount, score,
tier, the suggested ceiling, the verdict.

The paragraph explaining why is NOT signed.

A signature should commit to the decision, not to prose we might reword later.
```

## ALT 3 — the tamper demo

```
Real signed verdict from production, checked through the public endpoint:

verdict "review"        -> verified: true
same bytes, no mode flag -> verified: true
verdict -> "proceed"     -> verified: false

You cannot upgrade your own go/no-go.
```

## ALT 4 — the gap we closed

```
We shipped verdict signing and found the half that was missing.

The signature existed. But our public verify endpoint only understood
attestations, so a genuine signed verdict handed to it returned FALSE.

Verifiable only through our own SDK isn't verifiable.
```

## ALT 5 — ACP escrow angle

```
An agent opens an escrow job. It decided to open it because a trust check said
proceed.

That decision is now an attachable artifact: signed, scoped to the amount,
timestamped, checkable offline by whoever ends up in the dispute.

Verify, don't trust.
```

## ALT 6 — the plain one

```
POST /api/counterparty/check {"sign": true}

You get back the verdict plus an Ed25519 signature over it.

POST /api/verify {"mode": "verdict"}

Anyone can run the second call. The public key is published.
```

---

## THREAD

1/
```
Your agent asks us whether to pay a counterparty. We say review, proceed, or
decline.

Until today you just had to believe that answer came from us.

Now it comes signed.
```

2/
```
Why bother. A verdict is just JSON, and JSON is editable by whoever is holding
it.

If a buyer agent shows a seller "Kairune said proceed", the seller has no way to
tell that from a string someone typed.
```

3/
```
So we sign the decision. Ed25519, over nine fields:

counterparty_handle, counterparty_wallet, issued_at, registered,
requested_amount, score, suggested_max_amount, tier, verdict.

Fixed order, so a verifier rebuilds the exact bytes independently.
```

4/
```
Note what is missing from that list: the prose.

We explain every verdict in a `checks[]` array. That text is NOT signed.

We want to be free to reword an explanation. We should not be free to reword a
decision.
```

5/
```
The signature is scoped to the amount it was asked about.

A verdict for 250 does not verify as a verdict for 250,000. Same counterparty,
same day, different question.
```

6/
```
Then the part that took the actual work.

The signature was useless to anyone but us, because our public verify endpoint
only understood the attestation shape. Hand it a real verdict and it rebuilt the
wrong bytes and said FALSE.
```

7/
```
Fixed. /api/verify now takes mode: "verdict", and auto-detects the shape if you
don't pass one.

Stateless, public, no auth. An escrow keeper, a seller, an arbiter checks the
decision with only the published key.
```

8/
```
Tested against production, not a fixture:

genuine verdict          -> verified: true
same bytes, no mode flag -> verified: true
verdict -> "proceed"     -> verified: false

One field moved is enough.
```

9/
```
To be exact about what this does and does not prove.

It proves we issued that verdict. It does not make the trust score itself
cryptographically verifiable — the score is still our computation over rows we
store.

We're not going to blur that line.
```

10/
```
Same platform key that signs spend receipts, published at /api/platform-key.

Limits, expiry, revocation, wallet proofs, signed receipts — and now the go/no-go
that sits in front of all of them.

kairune.online
```
