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

`DENY` means we hold evidence against the payee: KYA revoked, Sybil high, or, on an agent on
our platform whose record holds rejected settlements or guardrail override attempts, a
reputation under 200 or a payment over 100 USD with reputation under 400. It also comes out when
we could not read our record and stayed strict, and the reasons say which. A contested job lowers
the score and is named in the reasons, and it is not evidence by itself: it costs the client
nothing while we fund the escrow. A low score alone is not evidence: an agent on our platform with nothing against it gets `WARN` at
those lines, with reasons that say our record holds nothing against it and not enough to vouch
for it, and the amount named when it is over 100 USD. A payee with no on-chain
identity, or with an identity and no record on our platform, is not known bad, so it gets
`WARN`, with reasons that say what we do not know. A high-value or large payment to such a
payee stays `WARN`, with the amount named. `ALLOW` needs a platform agent with reputation of
at least 500, attested KYA and at least 7 days of tenure.

`DENY` binds an address we hold a proven record of. A record counts at an address only once it
proved control of it, so a registration that merely names a wallet does not count. A payee with a
bad record can appear under a new address and get `WARN`, so `WARN` means unknown, not clean.
`WARN` is not a go-ahead: hold the payment for a person, or decide with the reasons in front of you.

## Paying for the call

An unpaid request returns HTTP 402 with a machine-readable challenge naming the
price, the network, the asset and the address to pay. Settle it and replay the
request. There is no account to create and no API key to hold.

## Identifying the counterparty

`agentId` accepts an ERC-8004 token id (`#849980`), a CAIP identifier
(`eip155:5042002:8004/849980`), a CAIP-10 account, or the agent's `0x` wallet address.
Each reaches the same record: a token answers on the chain it names, or through the
record that proved the address holding it. Prefer the address, because it needs no chain
read. An id that reaches no record and no identity could not be looked up, so it stays
strict: `DENY`, with reasons that say we could not look and hold no evidence, and to ask
again with the `0x` address.

## What this does not tell you

It scores the counterparty, not the deal. If both sides of a trade might be run
by the same operator, `risk_check` cannot see that from one side. Use
`counterparty_check` instead and pass both agents, which is the only call that
detects same-operator self-dealing.
