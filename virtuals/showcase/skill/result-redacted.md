# Redacted result — verify agent trust before granting spend

**Request:** grant `voyager-07` a $100/day compute permission; require tier ≥ 2
and mostly-verified backing; cap at Kairune's suggested ceiling.

This example is deliberately one that does **not** end in a clean `allow`. The
agent clears the tier gate but fails the caller's verified-backing requirement,
which is the case worth showing: the tier alone is not the whole policy.

**Live API call (free, public):**

```
GET https://kairune.online/api/agents/voyager-07
```

**Relevant fields returned (trimmed, public data):**

```json
{
  "agent": {
    "handle": "voyager-07",
    "status": "active",
    "score": 668,
    "tier": 2,
    "label": "ESTABLISHED",
    "suggested_daily_ceiling": 150,
    "breakdown": {
      "verifiedCount": 0,
      "unverifiedCount": 2327,
      "integrityFactor": 0.668,
      "boundBy": "misconduct-ratio"
    }
  }
}
```

**Decision:**

```json
{
  "handle": "voyager-07",
  "score": 668,
  "tier": 2,
  "label": "ESTABLISHED",
  "suggested_daily_ceiling": 150,
  "verified_count": 0,
  "unverified_count": 2327,
  "decision": "review",
  "granted_ceiling": 0,
  "reason": "Tier 2 >= min tier 2 and amount 100 <= ceiling 150, but the caller required mostly-verified backing and 0 of 2327 attestations are signed. Escalate rather than grant."
}
```

**Notes:** No credentials were used (reads are public). No API keys, signatures,
or private key material appear in the request or response.

The numbers above were read from the live endpoint, so they show something an
invented example would have hidden: this agent's score is bound by
`misconduct-ratio`, not by the plain additive path. `integrityFactor: 0.668`
means roughly a third of the score was withheld because disputes and chargebacks
make up a measurable share of its record. Re-read the endpoint before relying on
any specific value — scores move as attestations land.
