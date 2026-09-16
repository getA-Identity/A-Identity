#!/usr/bin/env node
/**
 * Fund a Soroban AgentSpendPolicy vault with its own token (USDC through the SAC), and prove
 * it by reading the vault's balance back from the contract.
 *
 * Why this exists: on 2026-09-16 a third-party review of a post about the pubnet vault read
 * its state for the first time in weeks and found balance 0. Every earlier payment had spent
 * the dust it was funded with, so "the vault holds real USDC", true when written, had quietly
 * become false. Refilling it is a plain SEP-41 transfer from any account of ours to the
 * contract address; the vault needs no call of its own to receive money, and the owner
 * multisig is not involved.
 *
 * The token is read from the vault itself (`token()`) and checked against the registry's
 * declared settlement token before anything is signed, so a mistyped vault id cannot send
 * USDC to a contract that does not hold USDC.
 *
 * Prepared-or-executed: without the key env var it prints the transfer it would submit.
 *
 * --check: read-only monitor mode for .github/workflows/stellar-ops.yml. Prints the live
 * policy and balance, never signs, and exits 1 when the balance is 0, because public copy
 * says the pubnet vault holds USDC and that is exactly the claim that went false unnoticed.
 *
 * Usage: cd mcp && npm run build && node --env-file=.env scripts/stellar-vault-fund.mjs \
 *          --chain stellar --vault C... --amount 0.04 --key-env STELLAR_BURNER_SECRET
 *        node scripts/stellar-vault-fund.mjs --chain stellar --vault C... --check
 */
import { Address, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from '@stellar/stellar-sdk'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1) }

let getChainById, createStellarAdapter, sorobanServer, networkPassphrase
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ createStellarAdapter } = await import('../dist/chains/stellar/adapter.js'))
  ;({ sorobanServer, networkPassphrase } = await import('../dist/chains/stellar/client.js'))
} catch {
  fail('mcp/dist not built. Run: cd mcp && npm run build')
}

const chain = getChainById(arg('chain', ''))
if (!chain || chain.ecosystem !== 'stellar') fail('--chain must be a Stellar chain in the registry (stellar or stellar-testnet)')
const vault = arg('vault', '')
if (!/^C[A-Z2-7]{55}$/.test(vault)) fail('--vault must be a Soroban contract id (C...)')
const CHECK = process.argv.includes('--check')
const amount = Number(arg('amount', CHECK ? '0.01' : '0'))
if (!(amount > 0 && amount <= 1)) fail('--amount must be above 0 and at most 1 (the vault policy is dust by design)')
const keyEnv = arg('key-env', '')

const adapter = createStellarAdapter(chain)
const before = await adapter.readVault(vault, {})
const token = chain.settlementTokens?.[0]
if (!token || before.token !== token.address) fail(`vault token ${before.token} is not the registry's settlement token ${token?.address}`)
const units = BigInt(Math.round(amount * 10 ** before.decimals))
const human = (raw) => Number(raw) / 10 ** before.decimals

console.log(`Chain:  ${chain.name} (${chain.caip2})`)
console.log(`Vault:  ${vault}, token ${token.symbol} ${token.address}`)
console.log(`Policy: daily cap ${human(before.dailyCapRaw)}, auto-approve ${human(before.autoApproveMaxRaw)}, balance ${human(before.balanceRaw)} ${token.symbol}`)

if (CHECK) {
  if (BigInt(before.balanceRaw) === 0n) {
    console.log(`EMPTY: ${vault} holds 0 ${token.symbol}. Public copy says this vault holds USDC; refill it or change the copy.`)
    process.exit(1)
  }
  console.log(`ok: ${vault} holds ${human(before.balanceRaw)} ${token.symbol}`)
  process.exit(0)
}

const secret = keyEnv ? process.env[keyEnv] : undefined
if (!secret) {
  console.log(JSON.stringify({ executed: false, contract: token.address, function: 'transfer', args: ['(funder)', vault, units.toString()], reason: 'pass --key-env with a funded Stellar secret to submit' }, null, 2))
  process.exit(0)
}
const kp = Keypair.fromSecret(secret)
const server = sorobanServer(chain, process.env)
const account = await server.getAccount(kp.publicKey())
const tx = new TransactionBuilder(account, { fee: '100000', networkPassphrase: networkPassphrase(chain) })
  .addOperation(new Contract(token.address).call('transfer', new Address(kp.publicKey()).toScVal(), new Address(vault).toScVal(), nativeToScVal(units, { type: 'i128' })))
  .setTimeout(120)
  .build()
const prepared = await server.prepareTransaction(tx)
prepared.sign(kp)
const sent = await server.sendTransaction(prepared)
if (sent.status === 'ERROR') fail(`submit rejected: ${JSON.stringify(sent.errorResult ?? sent)}`)
console.log(`Funder: ${kp.publicKey()} (${keyEnv})`)
console.log(`tx:     ${sent.hash}`)
let got
for (let i = 0; i < 40; i++) {
  got = await server.getTransaction(sent.hash)
  if (got.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) break
  await new Promise((r) => setTimeout(r, 1500))
}
if (got?.status !== rpc.Api.GetTransactionStatus.SUCCESS) fail(`transaction ${sent.hash} ended ${got?.status}`)
let after = before
for (let i = 0; i < 20; i++) {
  after = await adapter.readVault(vault, {})
  if (BigInt(after.balanceRaw) >= BigInt(before.balanceRaw) + units) break
  await new Promise((r) => setTimeout(r, 1500))
}
if (BigInt(after.balanceRaw) < BigInt(before.balanceRaw) + units) fail(`tx succeeded but the vault balance reads ${human(after.balanceRaw)}`)
console.log(`ledger: ${got.ledger}`)
console.log(`Vault balance ${human(before.balanceRaw)} -> ${human(after.balanceRaw)} ${token.symbol}, read back from the contract`)
