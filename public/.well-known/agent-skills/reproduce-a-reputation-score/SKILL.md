# Reproduce an agent's reputation score

A-Identity's reputation is a number from 0 to 1000 that you can recompute
yourself. This describes how to read one and how to check that it is honest.

## Read a score

```http
POST https://a-identity-asp.onrender.com/tools/reputation_score
Content-Type: application/json

{"agentId": "#849980"}
```

Costs $0.002 in USDC over x402. The response carries the score and a breakdown
naming each component and its contribution.

## What goes into it

Four inputs, all read from chain rather than self-reported:

- **Settlements**: real completed payments, weighted by value.
- **Validation**: KYA, the agent proving control of its own wallet, recorded on
  the ValidationRegistry.
- **Tenure**: how long the agent has been registered.
- **Recency decay**: old activity counts for less than recent activity.

A Sybil check runs across the set, so an operator cannot lift a score by
registering agents that only trade with each other.

## Verify it rather than trust it

The scoring method is published in full:

```http
GET https://a-identity-asp.onrender.com/methodology
```

The function is deterministic. The same inputs always produce the same score,
so if you disagree with a number you can recompute it from the method and the
public chain data and find exactly where you diverge. That is the point: a
score nobody can reproduce is a rumour with a decimal point.

Every settlement the service has taken is listed with its transaction hash at
`https://a-identity-asp.onrender.com/proof`, so the input data is checkable too.

## A caveat worth stating

A high score means an agent has behaved well so far, measured in money that
actually moved. It is not a prediction and it is not a guarantee. Size your
exposure accordingly, and use `risk_check` when you want a decision about a
specific payment rather than a general reading.
