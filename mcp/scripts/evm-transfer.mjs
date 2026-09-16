#!/usr/bin/env node
/**
 * Send a chain's canonical USDC (`contracts.usdc`) from that chain's signer to an address of
 * ours, and confirm the recipient's balance actually moved. Operator plumbing for funding a
 * buyer or a validator on a freshly opened chain, where no other key of ours holds anything
 * yet (Arc Mainnet, 2026-09-16).
 *
 * Prepared-or-executed: without the chain's signer env var it prints the transfer and exits.
 *
 * Usage: cd mcp && npm run build && node --env-file=.env scripts/evm-transfer.mjs \
 *          --chain arc-mainnet --to 0x... --amount 0.3
 */
import { createPublicClient, createWalletClient, parseAbi, formatUnits, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1) }

let getChainById, evmTransport
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ evmTransport } = await import('../dist/chains/evm/client.js'))
} catch {
  fail('mcp/dist not built. Run: cd mcp && npm run build')
}
const chain = getChainById(arg('chain', ''))
if (!chain || chain.ecosystem !== 'evm' || !chain.contracts.usdc) fail('--chain must be an EVM chain that declares contracts.usdc')
const to = getAddress(arg('to', '') || fail('--to is required'))
const amount = Number(arg('amount', '0'))
if (!(amount > 0 && amount <= 5)) fail('--amount must be a USD amount above 0 and at most 5 (operator funding, not treasury moves)')

const USDC = chain.contracts.usdc
const value = BigInt(Math.round(amount * 10 ** chain.usdcDecimals))
const ERC20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'])
const key = chain.signerEnvVar ? process.env[chain.signerEnvVar] : undefined
if (!key) {
  console.log(JSON.stringify({ executed: false, chain: chain.caip2, contract: USDC, function: 'transfer', args: [to, value.toString()], reason: `set ${chain.signerEnvVar} to send for real` }, null, 2))
  process.exit(0)
}
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const pub = createPublicClient({ transport: await evmTransport(chain) })
const wallet = createWalletClient({ account, transport: await evmTransport(chain) })
const bal = (a) => pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })

const [have, before] = await Promise.all([bal(account.address), bal(to)])
if (have < value) fail(`${account.address} holds ${formatUnits(have, chain.usdcDecimals)} USDC, less than ${amount}`)
const hash = await wallet.writeContract({ chain: null, address: USDC, abi: ERC20, functionName: 'transfer', args: [to, value] })
const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
if (r.status !== 'success') fail(`transfer reverted: ${chain.explorer}/tx/${hash}`)
let after = before
for (let i = 0; i < 40 && after < before + value; i++) {
  after = await bal(to)
  if (after < before + value) await new Promise((res) => setTimeout(res, 1500))
}
if (after < before + value) fail(`receipt succeeded but ${to} balance did not move (${before} -> ${after})`)
console.log(`sent      ${amount} USDC ${account.address} -> ${to}`)
console.log(`tx        ${chain.explorer}/tx/${hash} (block ${r.blockNumber}, ${r.gasUsed} gas)`)
console.log(`recipient ${formatUnits(before, chain.usdcDecimals)} -> ${formatUnits(after, chain.usdcDecimals)} USDC`)
