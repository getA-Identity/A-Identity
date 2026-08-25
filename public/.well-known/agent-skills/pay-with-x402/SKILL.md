# Pay for a call with x402

Every paid A-Identity endpoint is bought per call in USDC. There is no account,
no API key and no subscription. This is the whole flow.

## Ask, get told the price, pay, ask again

Call the endpoint normally. If you have not paid, you get HTTP 402 and a body
describing exactly what is owed:

```http
POST https://a-identity-asp.onrender.com/tools/verify_agent
Content-Type: application/json

{"agentId": "#849980"}
```

The 402 body names the price, the network, the asset, the address to pay, and
the input schema with a worked example, so you can learn how to call the tool
correctly before spending anything.

Settle the payment, attach the proof, and replay the identical request. The
resource is served on the retry.

## Three rails, pick by what you have

**Per call on X Layer.** Each call settles as its own on-chain transfer. Prices
run from $0.001 to $0.01 depending on the tool.

**Gasless nanopayments on Circle Arc.** Sign an EIP-3009 authorization off-chain
and pay no gas at all. Circle Gateway verifies it, credits instantly, and
batches the on-chain settlement, which is what makes a sub-cent payment
economic. Try it against:

```http
GET https://a-identity.xyz/api/x402/nano/data
```

Unpaid, it answers 402 with an `accepts` block naming `eip155:5042002` and
Arc's native USDC. On Arc the gas token is USDC itself, so an agent needs no
second asset to transact.

**Soroban on Stellar.** The one where you sign no transaction at all. Instead of a
transfer you sign a Soroban AUTHORIZATION ENTRY for one specific `transfer` call,
and the seller assembles it, pays the network fee and submits. You need a USDC
trustline and a balance, and nothing else: no XLM for fees, no sequence number, no
broadcast.

```http
GET https://a-identity.xyz/api/x402/stellar/tools/risk_check
```

Unpaid, it answers 402 with an `accepts` block naming `stellar:testnet`, the USDC
SAC contract id, and `extra.networkPassphrase`. Read the passphrase from the
challenge rather than assuming one: it is inside the signed preimage, so a testnet
signature is worthless on pubnet. Then POST with
`X-PAYMENT: base64(JSON of {x402Version:2, scheme:"exact", network, payload:{authEntryXdr}})`.

Two things to know before building against it. Amounts are SEVEN decimals here, not
six, so $0.005 is 50000 base units and not 5000. And a `202` is not a failure: it
means the payment was broadcast and could not be confirmed in time, nothing was
marked spent, and paying again would pay twice.

A worked client is in the repository at `mcp/scripts/x402-stellar-buyer.mjs`, and
`--quote-only` prints what it would sign without needing a key.

## Prices

| Endpoint | Price |
| --- | --- |
| `/tools/trust_preview` | free, rate limited |
| `/tools/verify_agent` | $0.001 |
| `/tools/reputation_score` | $0.002 |
| `/tools/risk_check` | $0.005 |
| `/tools/guardrail_check` | $0.005 |
| `/tools/counterparty_check` | $0.008 |
| `/tools/agent_passport` | $0.01 |

The prices in this table are generated from the same constant the gateway
charges from, and a test fails the build if the published spec and the charged
price ever disagree.

## Before you spend anything

`/tools/trust_preview` is free and needs no payment at all. Use it to confirm
the service does what you need, then pay for the precise answer.
