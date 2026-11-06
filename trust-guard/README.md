# @a-identity/trust-guard

One line of code that stops your AI agent from paying a counterparty it should not trust.

Agents are starting to hire and pay other agents at machine speed. `trust-guard` puts a
verification gate in front of that payment: it calls the live **A-Identity Trust Oracle**
(ERC-8004 on-chain identity + KYA + a deterministic 0-1000 reputation + a Sybil check) and
**throws unless the verdict is ALLOW**. DENY means we hold evidence against the counterparty (revoked KYA, a Sybil
flag, or a low reputation with rejected settlements or guardrail override attempts on its record), or that we could
not read our record and stayed strict, and the reasons say which. It is refused at that address. A counterparty we
know nothing about, or one we hold a record of that holds nothing against it and not enough to vouch for it, gets
WARN. WARN means unknown, not clean, and it does not pay by itself: `guard()` throws on it too. If you want to pay
on WARN, say so in code with `denyOn: ['DENY']`.

```bash
npm install @a-identity/trust-guard
```

```ts
import { guard, TrustDenyError } from '@a-identity/trust-guard'

try {
  // Verify before you pay. It throws on DENY and on WARN, because the next line pays.
  await guard(counterpartyAgentId, { txContext: { amountUsd: 500, kind: 'payment' } })
  await payAgent(counterpartyAgentId, 500) // only runs on ALLOW
} catch (e) {
  if (e instanceof TrustDenyError) {
    console.warn('Blocked:', e.verdict.decision, e.verdict.reasons)
    return // do not pay. On WARN, show the reasons to a person
  }
  throw e
}
```

## Verdicts

`guard()` runs `risk_check`. It returns an `ALLOW` verdict and throws `TrustDenyError` on `DENY` and on
`WARN`, on every rail. `DENY` always throws, whatever `denyOn` says. A counterparty we know nothing about
gets `WARN`, and `WARN` does not pay by itself, so a caller who wants to pay on it says so in code and
gets the verdict back to branch on:

```ts
await guard(id) // the default: only returns on ALLOW

const verdict = await guard(id, { denyOn: ['DENY'] }) // returns on WARN as well
if (verdict.decision === 'WARN') return askAPerson(verdict.reasons)
```

The error's `verdict.decision` says which one it was, and `verdict.reasons` says why. The message on a `WARN`
says to read the reasons, because most mean we do not know the counterparty and one can name something our
record holds against it, and it names `denyOn: ['DENY']`.

An answer that is not a verdict at all, such as an HTML page, an empty body or an unknown decision, throws
`UnusableVerdictError` on every rail, whatever `denyOn` says, because the next line pays.

**Behavior change in 0.4.0.** `guard()` used to default to `denyOn: ['DENY']`, so a `WARN` returned and
the next line paid. It now defaults to `['DENY', 'WARN']` on every rail. A caller who relied on `WARN`
returning adds `denyOn: ['DENY']`. `verifyThenPay` is not affected: it never paid on `WARN` by itself.

On the `xlayer` and `algorand` rails `guard()` used to return on any answer with no recognized decision.
That is the second behavior change in 0.4.0: it throws `UnusableVerdictError` now, as the `arc` rail already did.

**If you installed 0.3.0 or earlier, read this.** The verdict's rule lives on the server, so it
reaches every installed version with no change on your side, and the default above does not. Until
2026-11-04 a counterparty with no on-chain identity or no record on our platform got `DENY`, and
`guard()` threw. Now it gets `WARN`, and your installed `guard()` returns on `WARN`, so a payee that
used to throw now returns, and code that pays on its next line pays it. If that is not what you want,
add `denyOn: ['DENY', 'WARN']`, or upgrade to 0.4.0.

## The full client

```ts
import { TrustGuard } from '@a-identity/trust-guard'

const oracle = new TrustGuard() // X Layer rail, https://a-identity-asp.onrender.com

await oracle.verify(id)        // ERC-8004 identity + KYA status
await oracle.reputation(id)    // 0-1000 score (+ its on-chain attestation, if published)
await oracle.riskCheck(id, tx) // ALLOW / WARN / DENY
await oracle.passport(id)      // identity + reputation + KYA + risk in one call
await oracle.payCheck(address) // Algorand rail: is it safe to pay this Algorand address? (5 USDC)
await oracle.guard(id, opts)   // the gate: throws on DENY and on WARN
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

await oracle.guard(counterpartyId) // pays 5 USDC for the verdict, throws unless it is ALLOW
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

**Status: an earlier build of this code ran our own 100 flows on Arc Mainnet on 2026-11-02, on its
`pay()` path, and the hosted route it calls is live. `verifyThenPay` needs version 0.4.0 or later, because
0.3.0 has no `/arc` entry point. `ownerOnly`, `approvalUrl` and the hand-off of a payment above the vault's
ceiling or off its allowlist need 0.5.0 or later. 0.4.0 has none of them: there `out.approvalUrl` is
undefined, and such a payment throws `VaultPolicyError` before anything is signed.
`npm ls @a-identity/trust-guard` says which version you have. As of 2026-11-04 no outside team has run a
published version of it.**

**Changed in 0.5.0.** On a vault with a human, a payment above the vault's ceiling or to a payee off its
allowlist used to throw `VaultPolicyError` before the check, for free. It now buys a check, 0.005 USDC per
attempt, and `verifyThenPay` returns `awaiting_human` on ALLOW or WARN, with `ownerOnly` naming the gate,
because the owner can pay it. `preflightVault` returns `ownerOnly` instead of throwing, so a returned
preflight no longer means the operator can pay. A caller who wants the free refusal reads `ownerOnly` from
`preflightVault` first. A range such as `^0.4.0` does not take this version, so moving to it is your own
step. Every `awaiting_human` result also has `approvalUrl`, the link to send the owner, or null. 0.4.0 has
neither field. Two smaller moves: a nonce the server has already seen reads as `UNCONFIRMED` with `paid` null,
not `REFUSED` with `paid` false, and `recordFlowReceipt` goes again after a 429, so it can take up to two minutes.

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
    payee,                          // the 0x address to pay; one holding no ERC-8004 agent is not refused, it gets WARN
    amountUnits: usdcUnits('0.25'), // USDC base units; no floats
    signer: fromViemWallet(wallet), // the operator, and by default the payer of the check too
  })
  if (out.outcome === 'executed') console.log(out.payment.explorerUrl, out.record.recorded)
  if (out.outcome === 'awaiting_human' && out.ownerPay.simulation.ok) await askTheOwner(out.ownerPay) // WARN: see below
} catch (e) {
  if (e instanceof TrustDenyError) console.warn('Blocked:', e.verdict.reasons, e.context?.recordUrl)
  else throw e
}
```

The order, and what each step can cost:

1. **Free checks, nothing signed.** The asset is the registry's USDC and the vault's; an agent named in
   `payeeAgentId` is the payee's; the vault's policy and a simulated `pay()` accept the payment; the
   operator can pay the gas. A refusal here costs nothing: the check is not bought, and no verdict comes back.
   A payee that holds no agent is not refused: it goes on to the check. Neither is a payment above the
   vault's ceiling or to a payee off its allowlist, on a vault with a human: the operator cannot pay it and
   the owner can, so `ownerPay` is simulated instead, `preflightVault` says so in `ownerOnly`, and it goes on
   to the check, which is still charged. On a vault whose owner is its operator both stay refusals.
2. **The verdict, 0.005 USDC.** The payer signs one Gateway authorization from its Gateway balance. It
   spends no gas. The payer needs a Gateway balance on Arc Mainnet, and may be a separate key (`payer`).
3. **The decision.** DENY throws `TrustDenyError` and never calls the operator. WARN returns
   `awaiting_human` with a prepared `ownerPay` for the vault's owner and pays nothing, unless you set
   `payOnWarn: true`. A payee we know nothing about gets WARN, so `payOnWarn` on such a payee is your own
   explicit choice to pay it. ALLOW goes on. On a payment only the owner can make, ALLOW and WARN both return
   `awaiting_human`, with `ownerOnly` naming the gate, and `payOnWarn` cannot change that.
4. **The payment.** Exactly one `sendTransaction` of `pay(payee, amountUnits)`, encoded from your own
   inputs and compared byte for byte with what the server prepared. The server's calldata is never
   executed, so a compromised server cannot redirect a payment. `maxFeePerGas` is at least 20 gwei,
   below which Arc drops a transaction with no error. The receipt is looked for on every RPC, because
   one RPC can answer null for a transaction that exists. Nothing is retried with a new nonce.
5. **The record.** The hash is posted to the flow, the server reads the receipt from the chain itself,
   and `record.recorded` says whether it did. On `awaiting_human` it is true because the flow is on record,
   with no payment made, so read `outcome` first. A post the route's rate limit turned away goes again after
   the wait its `Retry-After` names, up to a minute, at most 3 posts. Flow records are public by flow id, at
   `/api/x402/gateway/flows/<flowId>`, DENYs included. After a WARN, send `ownerPay` from the owner's key
   and close the flow with `recordFlowReceipt({ flowId, txHash })`, unless `ownerPay.simulation.ok` is
   false: the vault would refuse it right now, so sending it would revert and cost gas. An owner with a
   browser wallet does it on the vault page: send them `out.approvalUrl`. That is passed on only when it is
   the vault page for this vault and this flow, and it is null otherwise. The page approves only a check the
   operator paid for, so a flow paid by a separate `payer`, or a payment to the operator key, comes back with
   `approvalUrl` null: send `ownerPay` from the owner key. The page reads the chain when it opens and can still
   refuse a link it is given: a vault that is ours or not the build it deploys, a key stopped or replaced since
   the check, or a check older than 24 hours. For a vault the page does not act on, `ownerPay` is the way then
   too, and the integration guide has a sample for that, starting from the public flow record. A stopped or
   replaced key and a check that old are refused for the request itself, so a new check from a working agent
   key is the way there. An `ownerPay` counts toward the agent's day on the
   vault: if it uses up today's room, the agent cannot pay until 00:00 UTC unless the owner raises the cap, so
   tell the owner before they sign.

Anything that is not a usable verdict is never treated as ALLOW: a Gateway error, a settlement that does
not echo what was signed, an unknown decision, a reputation that is not a finite number, an ALLOW below
reputation 500, a WARN carrying signals that force DENY, or a verdict about another agent or amount each
throw, and the operator is not called.

What this does not remove: the verdict is not signed, so you still trust the A-Identity server and the TLS
connection to it (`baseUrl` must be https, or http on localhost). These comparisons catch a server bug and a
server answering about someone else; a tampered answer that says 545 cannot be told from a real one. The
loss from that is bounded: the server's calldata is never executed, so the payment can only go to the payee
you named, for the amount you named, within the vault's own policy. The settlement echo proves nothing
independently either: it comes from the same server, so it binds the answer to your nonce and no further.

| Error | Meaning |
| --- | --- |
| `ArcAssetError` | Not the registry's USDC. Nothing bought. |
| `PayeeNotRegisteredError` | An agent named in `payeeAgentId` is not the payee's, or the registry did not answer. Holding no agent is not this error. Nothing bought. |
| `VaultPolicyError` | The vault would refuse (its own error name), or could not be read. `stage` says whether the check was already paid. |
| `GatewayCheckError` | No usable verdict came back. `paid` is true, false, or null when the answer does not say: then look `authNonce` up on `GET /api/x402/gateway/proof`, which lists only the newest 50 rows, before you sign again. If it reads `unconfirmed`, treat that nonce as giving no flow: a new authorization costs another 0.005 USDC, and the old one may still settle until it expires. A nonce the server has already seen comes back this way too, as `UNCONFIRMED` with `serverCode` `NONCE_ALREADY_USED` and the server's steps as the message, because the first request with it may have been charged. `code` `NO_HUMAN_GATE` is a WARN on a vault whose owner and operator are one key: the check was paid, the flow is public at `recordUrl`, nothing was prepared, and the way out is a new agent key: a vault's owner cannot be changed, so give the agent its own key with `setOperator` and keep the owner key from it, or, if its process or logs have held that key, deploy a new vault. |
| `UnusableVerdictError` | The check was paid and its answer cannot be acted on. |
| `TrustDenyError` | DENY. `context` holds the flow id, the check and the record's URL. |
| `VaultPaymentError` | The payment step failed. With a `txHash`, look that hash up: never send again with a new nonce, because a transaction reported as missing can still land. |

Who gets what: `risk_check` scores the payee's address. DENY means we hold evidence against the payee: KYA revoked,
Sybil high, or, on an agent on our platform whose record holds rejected settlements or guardrail override attempts,
a reputation under 200 or a payment over 100 USD with reputation under 400. It also comes out when we could not read
our record and stayed strict, and the reasons say which. A low score alone is
not evidence. An agent on our platform with nothing against it gets WARN at those lines, with reasons that say our
record holds nothing against it and not enough to vouch for it, and the amount named when it is over 100 USD. A
payee with no on-chain identity, or with an identity and no record on our platform, is not known bad, so it gets
WARN too, with reasons that say what we do not know; such an address scores at most 60, which only says we have no
history for it. DENY binds an address we hold a proven record of: a record counts at an address only once it proved
control of it, and a payee with a bad record can appear under a new address and get WARN, so WARN means unknown, not
clean. ALLOW needs a platform agent with reputation at least 500, attested KYA and at least 7 days of tenure. The vault cannot settle an x402 offer: its agent payment path
is `pay(to, amount)`, a direct USDC transfer to the payee you checked.

For a verdict alone, with no vault, use the rail with its payer. Send the payee's address as the agent id,
never a CAIP id. `guard()` throws on DENY and on WARN by default, so your next line only runs on ALLOW;
`verifyThenPay` is the path that hands a WARN to the owner:

```ts
import { TrustGuard } from '@a-identity/trust-guard'
import { arcGatewayPayer, fromViemWallet } from '@a-identity/trust-guard/arc'

const oracle = new TrustGuard({ rail: 'arc', onPaymentRequired: arcGatewayPayer(fromViemWallet(wallet)) })
await oracle.guard(payeeAddress, { txContext: { amountUsd: 0.25 } })
```

On this rail `guard()` fails closed. DENY always throws `TrustDenyError`, and WARN does too unless you pass
`denyOn: ['DENY']`. Anything else that is not ALLOW or WARN, a verdict about another agent, a reputation that
is not a finite number in [0, 1000], an ALLOW below 500, and an answer with no settlement record for the nonce
signed for this call each throw `UnusableVerdictError`. A proxy's 200 page is one of those. The `xlayer` and
`algorand` rails do not make those checks on a verdict that is returned.

`preflightVault` runs the free checks alone and signs nothing. It returns the vault's facts, with `ownerOnly`
set when only the owner can pay, so a return does not mean `pay()` will pass: read `ownerOnly` first. `operatorGasWei`
is null for a contract operator or when `ownerOnly` is set. `ARC_MAINNET` holds the chain's constants, generated from
the A-Identity chain registry rather than typed by hand.

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
