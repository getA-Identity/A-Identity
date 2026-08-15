#!/usr/bin/env node
/**
 * Prove the gasless buyer on Stellar, before any of it is abstracted into a rail.
 *
 * The product claim on every EVM chain we sell on is: the buyer signs, we broadcast, the
 * buyer pays no gas. On Stellar the mechanism is different enough that it is worth proving
 * on the live network before writing a module around it.
 *
 * On EVM the buyer signs typed data and the seller calls transferWithAuthorization, which
 * only works because the TOKEN implements EIP-3009. On Stellar the buyer signs a Soroban
 * AUTHORIZATION ENTRY, which is a host-level primitive available for any require_auth call
 * on any contract. Nothing has to be special about the token. Whoever assembles the
 * transaction is its source account and pays its fee.
 *
 * What this script proves, in one run:
 *   1. the buyer signs an authorization entry and nothing else
 *   2. a different account assembles the transaction, signs the ENVELOPE, and submits
 *   3. USDC moves out of the buyer
 *   4. the buyer's XLM balance is byte-for-byte unchanged, so it paid no fee
 *   5. confirmStellarTransfer finds the transfer independently, off the ledger
 *
 * Point 4 is the one that matters. Everything else could be true of a buyer who simply
 * paid for its own transaction.
 *
 *   node scripts/stellar-prove-gasless.mjs
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk'
import { execFileSync } from 'node:child_process'

import { confirmStellarTransfer } from '../dist/x402-stellar/confirm.js'
import { getChainById } from '../dist/chains/registry.js'

const chain = getChainById('stellar-testnet')
const server = new rpc.Server('https://soroban-testnet.stellar.org')
const PASSPHRASE = Networks.TESTNET
const SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const AMOUNT = 2_500_000n // 0.25 USDC

const seed = (name) =>
  execFileSync('stellar', ['keys', 'show', name], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^S[A-Z2-7]{55}$/.test(l))

const buyer = Keypair.fromSecret(seed('asp-buyer'))
/** Stands in for our facilitator: it holds XLM, and it never holds the buyer's asset. */
const relayer = Keypair.fromSecret(seed('asp-owner'))
const seller = Keypair.fromSecret(seed('asp-payee')).publicKey()

const balances = async (g) => {
  const a = await (await fetch(`https://horizon-testnet.stellar.org/accounts/${g}`)).json()
  const pick = (code) => a.balances.find((b) => (b.asset_code ?? 'XLM') === code)?.balance ?? '0'
  return { xlm: pick('XLM'), usdc: pick('USDC') }
}

const i128 = (v) => nativeToScVal(BigInt(v), { type: 'i128' })
const addr = (g) => new Address(g).toScVal()
const sac = new Contract(SAC)

const before = { buyer: await balances(buyer.publicKey()), relayer: await balances(relayer.publicKey()), seller: await balances(seller) }
console.log('before')
console.log(`  buyer    XLM ${before.buyer.xlm}  USDC ${before.buyer.usdc}`)
console.log(`  relayer  XLM ${before.relayer.xlm}`)
console.log(`  seller   USDC ${before.seller.usdc}`)

// ── 1. Discover what the buyer has to authorize ─────────────────────────────────────
//
// Built with the RELAYER as source from the start, because the source account is who pays
// the fee and that is the whole point. Simulation then tells us which authorization
// entries are required, and they name the buyer, not the relayer.
const latest = await server.getLatestLedger()
const draft = new TransactionBuilder(new Account(relayer.publicKey(), '0'), {
  fee: BASE_FEE,
  networkPassphrase: PASSPHRASE,
})
  .addOperation(sac.call('transfer', addr(buyer.publicKey()), addr(seller), i128(AMOUNT)))
  .setTimeout(300)
  .build()

const probe = await server.simulateTransaction(draft)
if (rpc.Api.isSimulationError(probe)) throw new Error(`simulation refused it: ${probe.error}`)
const required = probe.result?.auth ?? []
console.log(`\n1. simulation says ${required.length} authorization entry needs signing`)
for (const e of required) {
  console.log(`   credentials: ${e.credentials().switch().name}`)
}

// ── 2. The buyer signs the ENTRY. It never sees a transaction. ──────────────────────
const signedAuth = []
for (const entry of required) {
  signedAuth.push(await authorizeEntry(entry, buyer, latest.sequence + 100, PASSPHRASE))
}
console.log('2. the buyer signed the entry, and touched nothing else')

// ── 3. The relayer assembles, pays and submits ──────────────────────────────────────
//
// The signed entries have to be ON THE OPERATION before assembly, not passed alongside
// it. rpc/transaction.js is explicit about why: "if auth entries are already present, we
// consider this advanced usage and disregard ALL auth entries from the simulation." The
// converse bites silently. Build the operation with empty auth and assembleTransaction
// will helpfully put the simulation's UNSIGNED entries back, the transaction will be
// submitted, it will consume a real fee, and it will fail on chain with "failed account
// authentication" pointing at a buyer who did in fact sign. Cost us one transaction to
// learn: c51c4778..., ledger 4148262.
const account = await server.getAccount(relayer.publicKey())
const authedOp = Operation.invokeHostFunction({
  func: draft.operations[0].func,
  auth: signedAuth,
})
const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
  .addOperation(authedOp)
  .setTimeout(300)
  .build()

const sim = await server.simulateTransaction(tx)
if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation with the signed auth failed: ${sim.error}`)
const assembled = rpc.assembleTransaction(tx, sim).build()
assembled.sign(relayer) // the ENVELOPE only. The buyer's signature is inside the auth entry.
console.log('3. the relayer signed the envelope and is submitting')

const sent = await server.sendTransaction(assembled)
let got = await server.getTransaction(sent.hash)
for (let i = 0; i < 30 && got.status === 'NOT_FOUND'; i += 1) {
  await new Promise((r) => setTimeout(r, 1000))
  got = await server.getTransaction(sent.hash)
}
console.log(`   ${got.status}  ${sent.hash}`)
console.log(`   https://stellar.expert/explorer/testnet/tx/${sent.hash}`)

// ── 4. The claim, measured ──────────────────────────────────────────────────────────
const after = { buyer: await balances(buyer.publicKey()), relayer: await balances(relayer.publicKey()), seller: await balances(seller) }
console.log('\nafter')
console.log(`  buyer    XLM ${after.buyer.xlm}  USDC ${after.buyer.usdc}`)
console.log(`  relayer  XLM ${after.relayer.xlm}`)
console.log(`  seller   USDC ${after.seller.usdc}`)

const buyerPaidGas = before.buyer.xlm !== after.buyer.xlm
const relayerPaidGas = before.relayer.xlm !== after.relayer.xlm
console.log('\n4. the claim')
console.log(`   buyer's XLM unchanged : ${!buyerPaidGas ? 'YES' : `NO (${before.buyer.xlm} -> ${after.buyer.xlm})`}`)
console.log(`   relayer paid the fee  : ${relayerPaidGas ? 'YES' : 'NO'}`)
console.log(`   USDC actually moved   : ${before.seller.usdc !== after.seller.usdc ? 'YES' : 'NO'}`)

// ── 5. And we confirm it ourselves rather than trusting any of the above ────────────
const confirmed = await confirmStellarTransfer(chain, sent.hash, {
  sac: SAC,
  to: seller,
  amountRaw: AMOUNT,
})
console.log('\n5. confirmStellarTransfer, reading the ledger itself')
console.log(`   ${JSON.stringify(confirmed)}`)
