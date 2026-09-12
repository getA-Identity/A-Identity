# @a-identity/trust-guard

One line of code that stops your AI agent from paying a counterparty it should not trust.

Agents are starting to hire and pay other agents at machine speed. `trust-guard` puts a
verification gate in front of that payment: it calls the live **A-Identity Trust Oracle**
(ERC-8004 on-chain identity + KYA + a deterministic 0-1000 reputation + a Sybil check) and
**throws if the verdict is DENY**, so a revoked, Sybil, or unverified counterparty never gets paid.

```bash
npm install @a-identity/trust-guard
```

```ts
import { guard, TrustDenyError } from '@a-identity/trust-guard'

try {
  // Verify before you pay. Throws if the counterparty is DENY.
  await guard(counterpartyAgentId, { txContext: { amountUsd: 500, kind: 'payment' } })
  await payAgent(counterpartyAgentId, 500) // only runs if the guard passed
} catch (e) {
  if (e instanceof TrustDenyError) {
    console.warn('Blocked:', e.verdict.decision, e.verdict.reasons)
    return // do not pay
  }
  throw e
}
```

## Verdicts

`guard()` runs `risk_check` and returns an `ALLOW` / `WARN` verdict, or throws `TrustDenyError`
on `DENY`. Block warnings too by widening `denyOn`:

```ts
await guard(id, { denyOn: ['DENY', 'WARN'] }) // stricter: throw on WARN as well
```

## The full client

```ts
import { TrustGuard } from '@a-identity/trust-guard'

const oracle = new TrustGuard() // X Layer rail, https://a-identity-asp.onrender.com

await oracle.verify(id)        // ERC-8004 identity + KYA status
await oracle.reputation(id)    // 0-1000 score (+ its on-chain attestation, if published)
await oracle.riskCheck(id, tx) // ALLOW / WARN / DENY
await oracle.passport(id)      // identity + reputation + KYA + risk in one call
await oracle.guard(id, opts)   // the gate: throws on DENY
```

## Two rails

Every call is paid per request over x402. Pick where the money moves:

| Rail | Settles in | verify | reputation | risk_check | passport | batch audit |
| --- | --- | --- | --- | --- | --- | --- |
| `xlayer` (default) | USDT0 on X Layer mainnet | $0.001 | $0.002 | $0.005 | $0.01 | n/a |
| `algorand` | USDC on Algorand mainnet | $0.01 | $0.02 | $0.05 | $0.10 | $0.04 per agent, up to 50 |

The live price is always the one in the 402 challenge; the table is a convenience.

### Paying on Algorand from your own account

```bash
npm install @a-identity/trust-guard algosdk
```

```ts
import { TrustGuard } from '@a-identity/trust-guard'
import { algorandPayer, SpendCapError } from '@a-identity/trust-guard/algorand'

const oracle = new TrustGuard({
  rail: 'algorand',
  onPaymentRequired: algorandPayer({
    mnemonic: process.env.AGENT_MNEMONIC!, // the agent's own account, opted in to USDC
    maxUsdPerCall: 0.1,                    // refuses anything pricier, before signing
  }),
})

await oracle.guard(counterpartyId) // pays 0.05 USDC for the verdict, throws on DENY
```

What the payer signs, and nothing more: one USDC transfer of exactly the quoted amount to the
quoted payTo, with fee zero, grouped with an unsigned fee-payer transaction the GoPlausible
facilitator signs and pays for. The account needs USDC and no ALGO for fees, and the key never
leaves your process. A challenge above `maxUsdPerCall` (default 0.25), for any asset other
than native Circle USDC, or on an unknown network is refused before anything is signed.

The oracle produces its answer before it submits your payment and releases it only once the
transfer is confirmed on-chain, so a check that fails costs you nothing.

### Auditing a shortlist

```ts
const audit = await oracle.batchAudit(['#12', '#907', '#4411'], { amountUsd: 250 })
audit.summary            // { ALLOW: 2, WARN: 0, DENY: 1 }
audit.results[2].reasons // why #4411 was refused
```

One paid call, up to 50 agents, $0.04 each. Raise `maxUsdPerCall` to cover the list (50 agents
is $2.00).

### From an MCP client

`@a-identity/trust-mcp` wraps this package as an MCP server your agent runs with its own
account:

```bash
claude mcp add a-identity-trust -e A_IDENTITY_ALGORAND_MNEMONIC="..." -- npx -y @a-identity/trust-mcp
```

## Paying on X Layer

The X Layer rail settles through OKX. If a call returns HTTP 402, the guard invokes your
`onPaymentRequired` payer and retries; without one it throws `PaymentRequiredError` carrying the
challenge. Wire your OKX Agentic Wallet (or any x402 client) to sign the payment:

```ts
const oracle = new TrustGuard({
  onPaymentRequired: async (challenge, { resource }) => {
    const header = await myWallet.payX402(challenge) // your x402 signer
    return { 'X-PAYMENT': header }                   // headers to retry with
  },
})
```

## Notes

- The core import has zero runtime dependencies and uses the global `fetch` (Node >= 18, Deno,
  Bun, browsers); inject `opts.fetch` for other runtimes or tests. Only
  `@a-identity/trust-guard/algorand` needs `algosdk`.
- Point `baseUrl` at your own instance if you self-host the oracle.
- Verify first. Pay at machine speed.

MIT
