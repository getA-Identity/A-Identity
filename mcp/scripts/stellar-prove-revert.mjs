#!/usr/bin/env node
/**
 * Produce an on-chain transaction that FAILS with the contract's own typed error.
 *
 * Why this script has to exist, and what it taught us:
 *
 * On EVM a reverted payment is still a mined transaction. You get a hash, you open it on
 * the explorer, and the revert reason is right there. That is the shape the Instawards
 * success metric assumes when it asks for "an over-limit one that reverts with a typed
 * policy error ... provable through public transaction hashes on stellar.expert".
 *
 * Soroban does not work that way. Every normal client simulates first, and a call the
 * contract refuses fails in SIMULATION, so nothing is ever submitted and no transaction
 * exists. `stellar contract invoke` will not send it even with --send=yes, and
 * --build-only produces a transaction with no Soroban resource footprint, which the
 * network rejects outright as TxMalformed. Verified both, and confirmed against Horizon
 * that the hash the CLI prints in that case resolves to 404: it is a local computation of
 * a transaction that never entered the ledger.
 *
 * So a refused payment normally leaves NO evidence on chain. That is a real gap between
 * the metric as written and how the platform behaves, and it is worth stating plainly
 * rather than quietly substituting a screenshot.
 *
 * There is an honest way to get the transaction, and it is not a trick: make the payment
 * fail at APPLY time rather than at simulation. That happens whenever the policy tightens
 * between the moment the agent builds its payment and the moment the ledger includes it,
 * which is precisely the race a real agent hits when a human moves the limit mid-flight.
 * The transaction is included, it consumes its fee, and it is recorded as failed with the
 * contract's own error code.
 *
 * The sequence:
 *   1. cap is high, so a 2 USDC payment simulates cleanly and gets a real footprint
 *   2. the transaction is assembled and signed, and then HELD
 *   3. the human lowers the daily cap underneath it
 *   4. the held transaction is submitted, and fails on chain with DailyCapExceeded
 *
 * Usage (testnet only, throwaway keys):
 *   node scripts/stellar-prove-revert.mjs
 */
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk'
import { execFileSync } from 'node:child_process'

const RPC_URL = 'https://soroban-testnet.stellar.org'
const PASSPHRASE = Networks.TESTNET
const CONTRACT = process.env.VAULT ?? 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI'

/** Read a throwaway testnet seed out of the CLI keystore. Testnet only, by design. */
const seed = (name) =>
  execFileSync('stellar', ['keys', 'show', name], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^S[A-Z2-7]{55}$/.test(l))

const server = new rpc.Server(RPC_URL)
const owner = Keypair.fromSecret(seed('asp-owner'))
const operator = Keypair.fromSecret(seed('asp-operator'))
const payee = Keypair.fromSecret(seed('asp-payee')).publicKey()
const vault = new Contract(CONTRACT)

const i128 = (n) => nativeToScVal(BigInt(n), { type: 'i128' })
const addr = (g) => new Address(g).toScVal()

/** Build, simulate, assemble (which is what attaches the footprint), sign. */
async function prepare(kp, op) {
  const account = await server.getAccount(kp.publicKey())
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(300)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation refused it: ${sim.error}`)
  const assembled = rpc.assembleTransaction(tx, sim).build()
  assembled.sign(kp)
  return assembled
}

async function submit(tx, label) {
  const sent = await server.sendTransaction(tx)
  const hash = sent.hash
  if (sent.status === 'ERROR') {
    console.log(`  ${label}: REJECTED before the ledger (${sent.errorResult?.result()?.switch()?.name})`)
    return { hash, landed: false }
  }
  let got = await server.getTransaction(hash)
  for (let i = 0; i < 30 && got.status === 'NOT_FOUND'; i += 1) {
    await new Promise((r) => setTimeout(r, 1000))
    got = await server.getTransaction(hash)
  }
  console.log(`  ${label}: ${got.status}  ${hash}`)
  console.log(`    https://stellar.expert/explorer/testnet/tx/${hash}`)
  return { hash, landed: true, status: got.status, raw: got }
}

const read = async (fn) => {
  const account = await server.getAccount(owner.publicKey())
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(vault.call(fn))
    .setTimeout(30)
    .build()
  const sim = await server.simulateTransaction(tx)
  // scValToNative, not .value(): an i128 ScVal is a structured object, and stringifying
  // it directly prints "[object Object]" rather than the number.
  if (rpc.Api.isSimulationError(sim)) return `ERR ${sim.error}`
  return String(scValToNative(sim.result.retval))
}

console.log(`vault ${CONTRACT}`)
console.log(`  cap now: ${await read('daily_cap')}   spent today: ${await read('spent_today')}`)

// 1. Raise the cap so the payment we are about to build is genuinely valid right now.
console.log('\n1. owner raises the daily cap to 10 USDC')
await submit(
  await prepare(
    owner,
    vault.call('set_policy', i128(100_000_000), i128(20_000_000), nativeToScVal(false)),
  ),
  'set_policy',
)

// 2. The agent builds and signs a payment that is inside the policy AT THIS MOMENT.
console.log('\n2. the agent prepares a 2 USDC payment (valid: ceiling 2, cap 10, spent 1)')
const inFlight = await prepare(operator, vault.call('pay', addr(payee), i128(20_000_000)))
console.log('   simulated clean, footprint attached, signed, and held')

// 3. The human moves the limit while that payment is in flight.
console.log('\n3. the human lowers the daily cap to 1 USDC, under the in-flight payment')
await submit(
  await prepare(
    owner,
    vault.call('set_policy', i128(10_000_000), i128(20_000_000), nativeToScVal(false)),
  ),
  'set_policy',
)
console.log(`   cap now: ${await read('daily_cap')}   spent today: ${await read('spent_today')}`)

// 4. The held payment lands, and is refused by the ledger rather than by a simulator.
console.log('\n4. the held payment is submitted and lands over the cap')
const result = await submit(inFlight, 'pay (expected to FAIL)')
if (result.landed && result.status === 'FAILED') {
  console.log('\n   This is the evidence: a real transaction, in the ledger, refused by the')
  console.log('   contract itself. Open it and the diagnostic event names the gate.')
}
