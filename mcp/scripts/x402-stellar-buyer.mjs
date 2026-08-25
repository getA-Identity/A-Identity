#!/usr/bin/env node
/**
 * Minimal x402 v2 buyer for the Soroban rail: pays one of our /api/x402/stellar/tools
 * endpoints end to end and prints the served result. The Stellar twin of
 * scripts/x402-3009-buyer.mjs and scripts/celo-x402-buyer.mjs, and the half of the rail
 * that was missing: the seller side has been live since 2026-08-15, but nothing in this
 * repo demonstrated the 402 -> sign -> retry loop from the buyer's side.
 *
 * WHAT MAKES THIS RAIL DIFFERENT FROM THE EVM BUYERS
 *
 * You do not sign a transaction and you pay no network fee. You sign a Soroban
 * AUTHORIZATION ENTRY for one specific `transfer` call, and the seller assembles, pays the
 * fee and submits. So this script never touches a sequence number, never pays a stroop and
 * never submits anything. It builds a draft only to ask the network which entries need
 * signing, signs one, and hands it over in a header.
 *
 * Three details that are easy to get wrong, all of them load-bearing:
 *
 *  1. The draft is built with a source account that is NOT the buyer. If the buyer were the
 *     source, Soroban's direct-call rule would satisfy the token's from-side auth with a
 *     SOURCE-ACCOUNT credential, and the seller refuses those on sight
 *     (src/x402-stellar/settle.ts, decodeAuthEntry): a source-account credential authorizes
 *     whoever submits the transaction, which is the seller, not this purchase. We use the
 *     payTo account as the draft source. Nothing is signed or submitted with it; it exists
 *     so that simulation returns an ADDRESS credential naming the buyer.
 *  2. The signature expiration is a LEDGER, not a timestamp. The seller enforces headroom in
 *     ledgers (X402_STELLAR_EXPIRY_HEADROOM_LEDGERS, 12 by default) precisely so nobody
 *     divides by an assumed close time, so we sign well past it rather than computing one.
 *  3. The network passphrase is inside the signed preimage, so a testnet signature is
 *     worthless on pubnet. We take it from the challenge rather than assuming, and check it
 *     against the registry before signing.
 *
 * Usage:
 *   node scripts/x402-stellar-buyer.mjs \
 *     --url http://localhost:3399/api/x402/stellar/tools/verify_agent --agent '#849980'
 *
 *   --quote-only   fetch the 402 and print what it would cost and sign, then stop.
 *                  Needs no key and moves nothing. Use this first.
 *
 * Env:
 *   X402_STELLAR_BUYER_SECRET  required unless --quote-only. An S... seed for an account
 *                              holding the challenge's USDC and a trustline for it. Use a
 *                              DEDICATED buyer account, never a server signer or fee payer.
 *   X402_STELLAR_BUYER_RPC     optional. Overrides the RPC used for simulation. The default
 *                              comes from the chain registry, never from a literal here.
 */
import { Account, Keypair, TransactionBuilder, BASE_FEE, Contract, rpc, xdr, authorizeEntry } from '@stellar/stellar-sdk'
import { CHAINS } from '../dist/chains/registry.js'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const has = (name) => process.argv.includes(`--${name}`)

const URL_ARG = arg('url', '')
const AGENT = arg('agent', '#849980')
const QUOTE_ONLY = has('quote-only')

if (!URL_ARG) {
  console.error('error: pass --url http://<host>/api/x402/stellar/tools/<tool>')
  process.exit(1)
}

// ── 1. quote: GET the 402 challenge ───────────────────────────────────────────────
console.log(`GET     ${URL_ARG}`)
const quoteRes = await fetch(URL_ARG, { signal: AbortSignal.timeout(15000) })
const quote = await quoteRes.json().catch(() => ({}))

if (quoteRes.status === 501) {
  // Fail-closed, not broken. The rail refuses to serve rather than serving free.
  console.error(`error: the rail is not configured on this host (501): ${quote.reason ?? ''}`)
  console.error('       set X402_STELLAR_NETWORKS, X402_STELLAR_PAYTO and a fee payer on the server.')
  process.exit(1)
}
if (quoteRes.status !== 402 || !Array.isArray(quote.accepts) || !quote.accepts[0]) {
  console.error(`error: expected a 402 challenge, got ${quoteRes.status}:`)
  console.error(JSON.stringify(quote, null, 2))
  process.exit(1)
}

const req = quote.accepts[0]
const passphrase = req.extra?.networkPassphrase
const sac = req.asset
const payTo = req.payTo
const amountRaw = req.maxAmountRequired

// The challenge is the seller's word. Check it against our own registry before signing
// anything: a passphrase or a SAC we cannot corroborate is a signature we should not make.
const chain = CHAINS.find((c) => c.caip2 === req.network)
if (!chain) {
  console.error(`error: the challenge names network '${req.network}', which is not in the chain registry`)
  process.exit(1)
}
const known = (chain.settlementTokens ?? []).find((t) => t.address === sac)
if (!known) {
  console.error(`error: the challenge's asset ${sac} is not a settlement token the registry records for ${chain.id}`)
  process.exit(1)
}
if (typeof passphrase !== 'string' || passphrase.trim() === '') {
  console.error('error: the challenge carries no extra.networkPassphrase, and guessing one is how a testnet signature reaches pubnet')
  process.exit(1)
}

console.log(`Quote:  ${amountRaw} base units of ${known.symbol} (${known.decimals} dp) on ${chain.name} -> ${payTo}`)
console.log(`Sign:   ${req.extra?.function ?? 'transfer'} on ${sac}, as a Soroban authorization entry`)
console.log(`Fee:    0. The seller assembles, pays and submits (broadcaster: ${req.extra?.broadcaster ?? 'unknown'})`)

if (QUOTE_ONLY) {
  console.log('\n--quote-only: stopping before anything is signed. Nothing moved.')
  process.exit(0)
}

const secret = process.env.X402_STELLAR_BUYER_SECRET
if (!secret) {
  console.error('error: X402_STELLAR_BUYER_SECRET not set (an S... seed holding this USDC; never a server signer)')
  process.exit(1)
}
const buyer = Keypair.fromSecret(secret.trim())
console.log(`Buyer:  ${buyer.publicKey()}`)

// ── 2. ask the network which entries need signing ─────────────────────────────────
const rpcUrl = process.env.X402_STELLAR_BUYER_RPC?.trim() || chain.rpcUrls[0]
console.log(`RPC:    ${rpcUrl}`)
const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') })

const scAddress = (g) => xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeAccount(Keypair.fromPublicKey(g).xdrAccountId()))
const i128 = (v) => {
  const n = BigInt(v)
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString((n >> 64n).toString()), lo: xdr.Uint64.fromString((n & 0xffffffffffffffffn).toString()) }))
}

const latest = await server.getLatestLedger()
// The draft source is payTo, deliberately not the buyer. See note 1 in the header.
const draft = new TransactionBuilder(new Account(payTo, '0'), { fee: BASE_FEE, networkPassphrase: passphrase })
  .addOperation(new Contract(sac).call('transfer', scAddress(buyer.publicKey()), scAddress(payTo), i128(amountRaw)))
  .setTimeout(300)
  .build()

const probe = await server.simulateTransaction(draft)
if (rpc.Api.isSimulationError(probe)) {
  console.error(`error: simulation refused the transfer: ${probe.error}`)
  console.error('       the usual cause is no USDC trustline on the buyer, or too little balance.')
  process.exit(1)
}
const required = probe.result?.auth ?? []
const mine = required.filter((e) => e.credentials().switch().name === 'sorobanCredentialsAddress')
if (mine.length !== 1) {
  console.error(`error: expected exactly one address-credential entry to sign, simulation returned ${mine.length}`)
  process.exit(1)
}

// ── 3. sign the ENTRY. No transaction, no sequence number, no fee. ────────────────
const validUntilLedger = latest.sequence + 100 // far past the seller's ledger headroom
const signed = await authorizeEntry(mine[0], buyer, validUntilLedger, passphrase)
const authEntryXdr = signed.toXDR('base64')
console.log(`Signed: authorization entry, valid through ledger ${validUntilLedger} (now ${latest.sequence})`)

// ── 4. retry the original request with the credential ─────────────────────────────
const payment = { x402Version: 2, scheme: 'exact', network: req.network, payload: { authEntryXdr } }
const header = Buffer.from(JSON.stringify(payment)).toString('base64')

console.log(`POST    ${URL_ARG}`)
const paidRes = await fetch(URL_ARG, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-PAYMENT': header },
  body: JSON.stringify({ agentId: AGENT }),
  signal: AbortSignal.timeout(60000),
})
const paid = await paidRes.json().catch(() => ({}))

// 202 is its own outcome on this rail and is NOT a failure: the payment was broadcast and
// we could not confirm it in time. Nothing was marked spent, so do not pay again blindly.
if (paidRes.status === 202) {
  console.log(`\n202 unconfirmed: ${paid.error ?? ''}`)
  console.log(JSON.stringify(paid, null, 2))
  process.exit(2)
}
if (paidRes.status !== 200) {
  console.error(`\nerror: ${paidRes.status}`)
  console.error(JSON.stringify(paid, null, 2))
  process.exit(1)
}

console.log('\n200 served. Settlement:')
console.log(JSON.stringify(paid.settlement ?? {}, null, 2))
console.log('\nResult:')
console.log(JSON.stringify(paid.result ?? paid, null, 2))
