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
await oracle.payCheck(address) // Algorand rail: is it safe to pay this Algorand address? (5 USDC)
await oracle.guard(id, opts)   // the gate: throws on DENY
```

## Three rails

Every call is paid per request over x402. Pick where the money moves:

| Rail | Settles in | verify | reputation | risk_check | passport | batch audit |
| --- | --- | --- | --- | --- | --- | --- |
| `xlayer` (default) | USDT0 on X Layer mainnet | $0.001 | $0.002 | $0.005 | $0.01 | n/a |
| `algorand` | USDC on Algorand mainnet | $1 | $2 | $5 | $10 | $4 per agent, up to 50 |
| `arc` | USDC through Circle Gateway on Arc Mainnet | $0.001 | $0.002 | $0.005 | $0.01 | n/a |

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
    maxUsdPerCall: 10,                     // refuses anything pricier, before signing
  }),
})

await oracle.guard(counterpartyId) // pays 5 USDC for the verdict, throws on DENY
```

What the payer signs, and nothing more: one USDC transfer of exactly the quoted amount to the
quoted payTo, with fee zero, grouped with an unsigned fee-payer transaction the GoPlausible
facilitator signs and pays for. The account needs USDC and no ALGO for fees, and the key never
leaves your process. A challenge above `maxUsdPerCall` (default 10), for any asset other
than native Circle USDC, or on an unknown network is refused before anything is signed.

The oracle produces its answer before it submits your payment and releases it only once the
transfer is confirmed on-chain, so a check that fails costs you nothing.

### Auditing a shortlist

```ts
const audit = await oracle.batchAudit(['#12', '#907', '#4411'], { amountUsd: 250 })
audit.summary            // { ALLOW: 2, WARN: 0, DENY: 1 }
audit.results[2].reasons // why #4411 was refused
```

One paid call, up to 50 agents, $4 each. Raise `maxUsdPerCall` to cover the list (50 agents
is $200).

### From an MCP client

`@a-identity/trust-mcp` wraps this package as an MCP server your agent runs with its own
account:

```bash
claude mcp add a-identity-trust -e A_IDENTITY_ALGORAND_MNEMONIC="..." -- npx -y @a-identity/trust-mcp
```

## Verify, then pay from a vault, on Arc Mainnet

**Status: built and tested with fakes, not yet published to npm. The hosted route it calls is live.
Publishing 0.4.0 is Meric's step; until then this section describes the code in this repository,
not the package you get from `npm install`.**

`verifyThenPay` buys a `risk_check` through Circle Gateway and then pays the payee from an
[AgentSpendPolicy](https://a-identity.xyz) vault, with keys only you hold. It needs Node and two
optional peers:

```bash
npm install @a-identity/trust-guard viem @circle-fin/x402-batching
```

```ts
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { TrustDenyError } from '@a-identity/trust-guard'
import { arcViemChain, fromViemWallet, usdcUnits, verifyThenPay } from '@a-identity/trust-guard/arc'

const wallet = createWalletClient({
  account: privateKeyToAccount(process.env.VAULT_OPERATOR_KEY as `0x${string}`),
  chain: arcViemChain,
  transport: http(),
})

try {
  const out = await verifyThenPay({
    vault,                          // the vault whose operator this key is
    payee,                          // the 0x address to pay, holding an ERC-8004 agent on Arc Mainnet
    amountUnits: usdcUnits('0.25'), // USDC base units; no floats
    signer: fromViemWallet(wallet), // the operator, and by default the payer of the check too
  })
  if (out.outcome === 'executed') console.log(out.payment.explorerUrl, out.record.recorded)
  if (out.outcome === 'awaiting_human') await askTheOwner(out.ownerPay) // WARN: see below
} catch (e) {
  if (e instanceof TrustDenyError) console.warn('Blocked:', e.verdict.reasons, e.context?.recordUrl)
  else throw e
}
```

The order, and what each step can cost:

1. **Free checks, nothing signed.** The asset is the registry's USDC and the vault's; the payee holds
   an ERC-8004 agent on Arc Mainnet; the vault's policy and a simulated `pay()` accept the payment; the
   operator can pay the gas. A refusal here costs nothing: the check is not bought.
2. **The verdict, 0.005 USDC.** The payer signs one Gateway authorization from its Gateway balance. It
   spends no gas. The payer needs a Gateway balance on Arc Mainnet, and may be a separate key (`payer`).
3. **The decision.** DENY throws `TrustDenyError` and never calls the operator. WARN returns
   `awaiting_human` with a prepared `ownerPay` for the vault's owner and pays nothing, unless you set
   `payOnWarn: true`. ALLOW goes on.
4. **The payment.** Exactly one `sendTransaction` of `pay(payee, amountUnits)`, encoded from your own
   inputs and compared byte for byte with what the server prepared. The server's calldata is never
   executed, so a compromised server cannot redirect a payment. `maxFeePerGas` is at least 20 gwei,
   below which Arc drops a transaction with no error. The receipt is looked for on every RPC, because
   one RPC can answer null for a transaction that exists. Nothing is retried with a new nonce.
5. **The record.** The hash is posted to the flow, the server reads the receipt from the chain itself,
   and `record.recorded` says whether it did. Flow records are public by flow id, at
   `/api/x402/gateway/flows/<flowId>`, DENYs included. After a WARN, send `ownerPay` from the owner's key
   and close the flow with `recordFlowReceipt({ flowId, txHash })`.

Anything that is not a usable verdict is never treated as ALLOW: a Gateway error, a settlement that does
not echo what was signed, an unknown decision, a reputation that is not a finite number, an ALLOW below
reputation 500, or a verdict about another agent or amount each throw, and the operator is not called.

What this does not remove: the verdict is not signed, so you still trust the A-Identity server and the TLS
connection to it (`baseUrl` must be https, or http on localhost). These comparisons catch a server bug and a
server answering about someone else; a tampered answer that says 545 cannot be told from a real one. The
loss from that is bounded: the server's calldata is never executed, so the payment can only go to the payee
you named, for the amount you named, within the vault's own policy. The settlement echo proves nothing
independently either: it comes from the same server, so it binds the answer to your nonce and no further.

| Error | Meaning |
| --- | --- |
| `ArcAssetError` | Not the registry's USDC. Nothing bought. |
| `PayeeNotRegisteredError` | The payee holds no agent on Arc Mainnet, or the registry did not answer. Nothing bought. |
| `VaultPolicyError` | The vault would refuse (its own error name), or could not be read. `stage` says whether the check was already paid. |
| `GatewayCheckError` | No usable verdict came back. `paid` is true, false, or null when the answer does not say. `code` `NO_HUMAN_GATE` is a WARN on a vault whose owner and operator are one key: the check was paid, the flow is public at `recordUrl`, nothing was prepared, and the fix is an owner key the agent does not hold. |
| `UnusableVerdictError` | The check was paid and its answer cannot be acted on. |
| `TrustDenyError` | DENY. `context` holds the flow id, the check and the record's URL. |
| `VaultPaymentError` | The payment step failed. With a `txHash`, look that hash up: never send again with a new nonce, because a transaction reported as missing can still land. |

Who can get ALLOW: `risk_check` scores the payee's address, and any address that is not an A-Identity
platform agent scores at most 60 and gets DENY. ALLOW needs a platform agent with reputation at least 500,
attested KYA and at least 7 days of tenure. The vault cannot settle an x402 offer: its agent payment path
is `pay(to, amount)`, a direct USDC transfer to the payee you checked.

For a verdict alone, with no vault, use the rail with its payer. Send the payee's address as the agent id,
never a CAIP id. If your next line pays, pass `denyOn: ['DENY', 'WARN']`, because WARN returns by default
here and it does not mean pay; `verifyThenPay` is the path that holds WARN for the owner by itself:

```ts
import { TrustGuard } from '@a-identity/trust-guard'
import { arcGatewayPayer, fromViemWallet } from '@a-identity/trust-guard/arc'

const oracle = new TrustGuard({ rail: 'arc', onPaymentRequired: arcGatewayPayer(fromViemWallet(wallet)) })
await oracle.guard(payeeAddress, { txContext: { amountUsd: 0.25 }, denyOn: ['DENY', 'WARN'] })
```

On this rail `guard()` fails closed. DENY always throws `TrustDenyError`. Anything else that is not ALLOW or
WARN, a verdict about another agent, a reputation that is not a finite number in [0, 1000], an ALLOW below
500, and an answer with no settlement record for the nonce signed for this call each throw
`UnusableVerdictError`. A proxy's 200 page is one of those. The `xlayer` and `algorand` rails keep their
behaviour since 0.1, where only a verdict named in `denyOn` throws.

`preflightVault` runs the free checks alone and signs nothing. `ARC_MAINNET` holds the chain's constants,
generated from the A-Identity chain registry rather than typed by hand.

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
  `@a-identity/trust-guard/algorand` needs `algosdk`, and only `@a-identity/trust-guard/arc` needs
  `viem` and `@circle-fin/x402-batching` (Node only). Each is loaded when it is first used.
- Point `baseUrl` at your own instance if you self-host the oracle.
- Verify first. Pay at machine speed.

MIT
