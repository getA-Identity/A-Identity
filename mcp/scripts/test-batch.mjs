#!/usr/bin/env node
/**
 * On-chain integration test for batched settlement via Arc's Multicall3From, against real
 * Arc testnet by default, or any registry chain that declares `contracts.multicall3From`
 * with --chain (arc-mainnet). Settles several USDC transfers ATOMICALLY in ONE tx and verifies that the
 * batch emitted one USDC Transfer per payment with `from` = our EOA (the CallFrom
 * sender-preservation check). Transfers go back to the signer, so only gas is spent.
 *
 * Run:  node --env-file=.env scripts/test-batch.mjs   (needs a funded ARC_SIGNER_KEY)
 *       node --env-file=.env scripts/test-batch.mjs --chain arc-mainnet   (ARC_MAINNET_SIGNER_KEY)
 */
import { getChainById } from '../dist/chains/registry.js'
import { createEvmAdapter } from '../dist/chains/evm/adapter.js'
import { resolveRpcUrls } from '../dist/chains/evm/client.js'
import { createPublicClient, http, fallback, parseAbiItem, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const ci = process.argv.indexOf('--chain')
const chain = getChainById(ci >= 0 ? process.argv[ci + 1] : 'arc')
if (!chain || !chain.contracts.multicall3From) { console.error('error: --chain must be a registry chain that declares contracts.multicall3From'); process.exit(1) }
const adapter = createEvmAdapter(chain)
const signerKey = process.env[chain.signerEnvVar]
if (!signerKey) { console.error(`error: ${chain.signerEnvVar} is not set`); process.exit(1) }
const signer = privateKeyToAccount(signerKey).address
const payUsdcBatchOnchain = (payments) => adapter.payUsdcBatch(payments)
const USDC = chain.contracts.usdc.toLowerCase()
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? `  — ${extra}` : ''}`); cond ? pass++ : fail++ }

console.log(`chain: ${chain.name} (${chain.caip2})`)
console.log('signer (EOA):', signer, '\n')

// Batch 3 transfers of $0.01 back to the signer -> one atomic tx, only gas spent.
const payments = [
  { to: signer, amountUsd: 0.01 },
  { to: signer, amountUsd: 0.01 },
  { to: signer, amountUsd: 0.01 },
]
const res = await payUsdcBatchOnchain(payments)
ok('batch settled', res.executed === true, res.executed ? res.txHash : res.reason)
if (!res.executed) process.exit(1)
console.log('   tx   :', res.explorerUrl)
console.log('   count:', res.count, '| total $' + res.totalUsd)
ok('all 3 payments batched into one tx', res.count === 3)
ok('total is the sum of the batch', Math.abs(res.totalUsd - 0.03) < 1e-9, String(res.totalUsd))

// Verify on-chain: the single tx emitted 3 USDC Transfer events, each from = our EOA.
const client = createPublicClient({ transport: fallback(resolveRpcUrls(chain, process.env).map((u) => http(u))) })
const receipt = await client.getTransactionReceipt({ hash: res.txHash })
ok('the batch tx succeeded on-chain', receipt.status === 'success', receipt.status)
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const { parseEventLogs } = await import('viem')
const transfers = parseEventLogs({ abi: [transferEvent], logs: receipt.logs }).filter((l) => l.address.toLowerCase() === USDC)
ok('one USDC Transfer per payment (3) in the single tx', transfers.length === 3, `${transfers.length} transfers`)
const allFromSigner = transfers.every((t) => getAddress(t.args.from) === getAddress(signer))
ok('EOA preserved: every Transfer.from is our wallet (CallFrom)', allFromSigner)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
