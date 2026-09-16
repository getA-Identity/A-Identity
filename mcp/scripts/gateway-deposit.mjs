#!/usr/bin/env node
/**
 * Deposit USDC into Circle Gateway on any chain whose registry descriptor declares a
 * `gateway`, so that key holds the Gateway balance a Nanopayments buyer spends from.
 *
 * gateway.ts does the same approve + deposit, but it is bound to Arc TESTNET through
 * ARC_CHAIN and its testnet API host. This is the chain-generic version the day a mainnet
 * rail needs a funded buyer, reading the wallet and the API host from the descriptor.
 *
 * Nothing is reported as deposited until the deposit receipt succeeds AND Gateway's own
 * /v1/balances shows the depositor's balance for this chain's domain (Circle credits a
 * deposit once it sees the chain's finality, which on Arc is one block).
 *
 * Prepared-or-executed: without the key env var this prints the exact calls and exits.
 *
 * Usage: cd mcp && npm run build && node --env-file=.env scripts/gateway-deposit.mjs \
 *          --chain arc-mainnet --amount 0.2 [--key-env X402_GATEWAY_BUYER_KEY]
 */
import { createPublicClient, createWalletClient, parseAbi, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const CHAIN_ID = arg('chain', '')
const AMOUNT = Number(arg('amount', '0'))
const KEY_ENV = arg('key-env', 'X402_GATEWAY_BUYER_KEY')

let getChainById, evmTransport
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ evmTransport } = await import('../dist/chains/evm/client.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}
const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1) }
const chain = getChainById(CHAIN_ID)
if (!chain) fail(`unknown chain '${CHAIN_ID}'`)
if (!chain.gateway || !chain.contracts.usdc || chain.cctpDomain === null) fail(`${CHAIN_ID} declares no Circle Gateway, USDC or domain in the registry`)
if (!(AMOUNT > 0)) fail('--amount must be a positive USD amount')

const USDC = chain.contracts.usdc
const WALLET = chain.gateway.wallet
const value = BigInt(Math.round(AMOUNT * 1e6))
const ERC20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'])
const GATEWAY = parseAbi(['function deposit(address token,uint256 value)'])

const balanceOnGateway = async (depositor) => {
  const res = await fetch(`${chain.gateway.facilitator}/v1/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'USDC', sources: [{ domain: chain.cctpDomain, depositor }] }),
  })
  if (!res.ok) throw new Error(`Gateway balances answered ${res.status}`)
  const b = (await res.json()).balances?.[0]
  return { available: Number(b?.balance ?? 0), pending: Number(b?.pendingBatch ?? 0) }
}

const key = process.env[KEY_ENV]
if (!key) {
  console.log(`No ${KEY_ENV} set - PREPARED (nothing was broadcast):`)
  console.log(JSON.stringify({
    executed: false,
    chain: chain.caip2,
    steps: [
      { contract: USDC, function: 'approve', args: [WALLET, value.toString()] },
      { contract: WALLET, function: 'deposit', args: [USDC, value.toString()] },
    ],
    reason: `set ${KEY_ENV} to deposit for real`,
  }, null, 2))
  process.exit(0)
}

const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const pub = createPublicClient({ transport: await evmTransport(chain) })
const wallet = createWalletClient({ account, transport: await evmTransport(chain) })
console.log(`Chain:     ${chain.name} (${chain.caip2}), Gateway wallet ${WALLET}`)
console.log(`Depositor: ${account.address} (${KEY_ENV})`)

const have = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [account.address] })
if (have < value) fail(`${account.address} holds ${formatUnits(have, 6)} USDC, less than ${AMOUNT}`)
const before = await balanceOnGateway(account.address)

const send = async (label, req) => {
  const hash = await wallet.writeContract({ chain: null, ...req })
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (r.status !== 'success') fail(`${label} reverted: ${chain.explorer}/tx/${hash}`)
  console.log(`${label.padEnd(9)} ${chain.explorer}/tx/${hash} (block ${r.blockNumber}, ${r.gasUsed} gas)`)
  return hash
}
const allowance = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'allowance', args: [account.address, WALLET] })
if (allowance < value) await send('approve', { address: USDC, abi: ERC20, functionName: 'approve', args: [WALLET, value] })
const depositTx = await send('deposit', { address: WALLET, abi: GATEWAY, functionName: 'deposit', args: [USDC, value] })

let after = before
for (let i = 0; i < 36; i++) {
  after = await balanceOnGateway(account.address)
  if (after.available + after.pending > before.available + before.pending) break
  await new Promise((r) => setTimeout(r, 5000))
}
if (after.available + after.pending <= before.available + before.pending) {
  fail(`deposit ${depositTx} succeeded on-chain but Gateway has not credited it after 3 minutes (before ${JSON.stringify(before)}, now ${JSON.stringify(after)})`)
}
console.log(`Gateway:   available ${before.available} -> ${after.available}, pending ${before.pending} -> ${after.pending} USDC on domain ${chain.cctpDomain}`)
