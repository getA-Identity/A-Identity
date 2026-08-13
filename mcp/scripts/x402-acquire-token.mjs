#!/usr/bin/env node
/**
 * Acquire a chain's settlement token permissionlessly, into a dedicated BUYER wallet.
 *
 * The rail cannot be proven without a buyer who actually holds the token, and buying it
 * must not require a centralized exchange or a KYC step: the whole argument is that this
 * settles on a permissionless chain. Relay quotes and executes a same-chain swap from
 * native ETH into the settlement token in one transaction.
 *
 * Prepared-or-executed: without --execute (or without X402_3009_BUYER_KEY) it prints the
 * exact transactions it would send and stops. With both, it sends them and then proves
 * the acquisition by reading balanceOf BEFORE and AFTER; a run that does not increase the
 * balance is reported as a failure, never as a success.
 *
 * Nothing here restates a chain id or a token address: both come from the built registry.
 *
 * Usage:
 *   cd mcp && npm run build
 *   node --env-file=.env scripts/x402-acquire-token.mjs --network eip155:46630 --usd 1
 *   node --env-file=.env scripts/x402-acquire-token.mjs --network eip155:46630 --usd 1 --execute
 */
import { createPublicClient, createWalletClient, http, defineChain, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const RELAY_API = 'https://api.relay.link'
const NATIVE = '0x0000000000000000000000000000000000000000'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const EXECUTE = process.argv.includes('--execute')
const NETWORK = arg('network', '')
const USD = Number(arg('usd', '1'))

let getChainById, getChain, resolveRpcUrls
try {
  ;({ getChainById, getChain } = await import('../dist/chains/registry.js'))
  ;({ resolveRpcUrls } = await import('../dist/chains/evm/client.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}

const chain = NETWORK ? (getChain(NETWORK) ?? getChainById(NETWORK)) : null
if (!chain) {
  console.error(`error: --network must name a registry chain (CAIP-2 id or slug). Got '${NETWORK}'.`)
  process.exit(1)
}
const token = (chain.settlementTokens ?? []).find((t) => t.authorization === 'eip3009')
if (!token) {
  console.error(`error: ${chain.id} declares no EIP-3009 settlement token, so there is nothing to acquire for this rail.`)
  process.exit(1)
}

const RPC = resolveRpcUrls(chain, process.env)[0]
const viemChain = defineChain({ id: chain.evmChainId, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })

// The wallet that SPENDS native gas for the swap. Separate from the recipient on
// purpose: the buyer wallet only ever needs to hold the settlement token, because on
// this rail it signs and never broadcasts.
const key = process.env.X402_3009_FUNDER_KEY ?? process.env.RHCHAIN_SIGNER_KEY
const account = key ? privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`) : null
const buyer = arg('recipient', '') || account?.address || ''
if (!buyer) {
  console.error('error: no recipient. Pass --recipient 0x..., or set a funder key so the recipient defaults to it.')
  process.exit(1)
}

console.log(`Chain:  ${chain.name} (${chain.caip2})`)
console.log(`Token:  ${token.symbol} at ${token.address} (${token.decimals} decimals)`)
console.log(`Recipient: ${buyer}`)
console.log(`Funder: ${account ? account.address : '(none set; quoting only)'}`)
console.log(`Target: ${USD} ${token.symbol}`)

const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }]
const balanceOf = async () => pub.readContract({ address: token.address, abi: ERC20, functionName: 'balanceOf', args: [buyer] })

const before = await balanceOf()
console.log(`Balance before: ${Number(before) / 10 ** token.decimals} ${token.symbol}`)

// Relay must say it supports this chain before we quote anything against it.
const chainsRes = await fetch(`${RELAY_API}/chains`)
const relayChains = (await chainsRes.json()).chains ?? []
const relayChain = relayChains.find((c) => c.id === chain.evmChainId)
if (!relayChain || relayChain.disabled) {
  console.error(`error: Relay does not currently support chain ${chain.evmChainId}; acquire the token another way.`)
  process.exit(1)
}

const amountOut = BigInt(Math.round(USD * 10 ** token.decimals)).toString()
const quoteRes = await fetch(`${RELAY_API}/quote`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    user: buyer,
    recipient: buyer,
    originChainId: chain.evmChainId,
    destinationChainId: chain.evmChainId,
    originCurrency: NATIVE,
    destinationCurrency: token.address,
    amount: amountOut,
    tradeType: 'EXACT_OUTPUT',
  }),
})
const quote = await quoteRes.json()
if (!quote.steps?.length) {
  console.error('error: Relay returned no executable route:', JSON.stringify(quote).slice(0, 400))
  process.exit(1)
}
const det = quote.details ?? {}
console.log(`\nQuote: ${det.currencyIn?.amountFormatted} ${det.currencyIn?.currency?.symbol} -> ${det.currencyOut?.amountFormatted} ${det.currencyOut?.currency?.symbol}`)

const txs = quote.steps.flatMap((s) => s.items ?? []).map((i) => i.data).filter(Boolean)
if (txs.some((t) => t.chainId !== chain.evmChainId)) {
  console.error('error: Relay asked for a transaction on another chain; refusing.')
  process.exit(1)
}

if (!account || !EXECUTE) {
  console.log('\nPREPARED (nothing was broadcast):')
  console.log(JSON.stringify(txs.map((t) => ({ chainId: t.chainId, to: t.to, value: t.value, dataBytes: (String(t.data ?? '0x').length - 2) / 2 })), null, 2))
  console.log(account ? '\nRe-run with --execute to send these.' : '\nSet X402_3009_BUYER_KEY and re-run with --execute to send these.')
  process.exit(0)
}

const wallet = createWalletClient({ account, chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })
const nativeBefore = await pub.getBalance({ address: account.address })
console.log(`Native balance: ${formatEther(nativeBefore)} ${chain.nativeCurrency.symbol}`)

for (const t of txs) {
  const hash = await wallet.sendTransaction({ to: t.to, value: BigInt(t.value ?? 0), data: t.data ?? '0x' })
  console.log(`sent: ${hash}`)
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (r.status !== 'success') {
    console.error(`error: reverted (${chain.explorer}/tx/${hash})`)
    process.exit(1)
  }
}

// The acquisition is only real if the balance moved. Poll briefly: a Relay swap can fill
// a moment after the deposit receipt.
const deadline = Date.now() + 3 * 60_000
for (;;) {
  const after = await balanceOf()
  if (after > before) {
    console.log(`\nACQUIRED: ${Number(after - before) / 10 ** token.decimals} ${token.symbol} (balance now ${Number(after) / 10 ** token.decimals})`)
    console.log(`Explorer: ${chain.explorer}/address/${buyer}`)
    console.log(`\nAdd this address to X402_3009_INTERNAL_PAYERS so its settlements are labeled internal:`)
    console.log(`  ${buyer}`)
    process.exit(0)
  }
  if (Date.now() > deadline) {
    console.error('\nTimed out waiting for the balance to increase. The transactions landed; check the explorer above before retrying.')
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 5000))
}
