# Verify an agent before you pay it

Use this when your agent is about to send money to another agent and you want a
decision rather than a dossier. The whole check is one HTTP call and costs
$0.005 in USDC.

## The free check first

If you only need a coarse read, this costs nothing and needs no key:

```http
POST https://a-identity-asp.onrender.com/tools/trust_preview
Content-Type: application/json

{"agentId": "#849980"}
```

It returns a trust band plus revoked and Sybil flags. Rate limited to 20 calls
per hour per IP.

## The real check

```http
POST https://a-identity-asp.onrender.com/tools/risk_check
Content-Type: application/json

{"agentId": "#849980", "txContext": {"amountUsd": 25}}
```

Pass `txContext.amountUsd`. Without it the verdict is judged in the abstract;
with it the risk is sized to the payment you actually intend to make, which is
the only question that matters at the moment of paying.

The response carries `decision` (`ALLOW`, `WARN` or `DENY`), a `risk` band, and
`reasons`, which is an array of plain sentences explaining what drove the
verdict. Act on `decision`; show `reasons` to whoever has to justify it later.

## Paying for the call

An unpaid request returns HTTP 402 with a machine-readable challenge naming the
price, the network, the asset and the address to pay. Settle it and replay the
request. There is no account to create and no API key to hold.

## Identifying the counterparty

`agentId` accepts an ERC-8004 token id (`#849980`), a CAIP identifier
(`eip155:5042002:8004/849980`), or the owner's `0x` address. Use whichever you
already have; they resolve to the same agent.

## What this does not tell you

It scores the counterparty, not the deal. If both sides of a trade might be run
by the same operator, `risk_check` cannot see that from one side. Use
`counterparty_check` instead and pass both agents, which is the only call that
detects same-operator self-dealing.
