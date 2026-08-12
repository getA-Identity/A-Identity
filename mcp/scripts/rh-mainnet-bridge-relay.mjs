#!/usr/bin/env node
/**
 * Move ETH from Arbitrum One to Robinhood Chain MAINNET (eip155:4663) through Relay,
 * one of the bridges Robinhood's own docs list for this chain
 * (docs.robinhood.com/chain/bridging). The native path is unusable here: Robinhood
 * Chain's parent is Ethereum L1, so an Arbitrum One exit would take 7 days.
 *
 * How it works: Relay's public API quotes the route and returns ONE deposit
 * transaction to send on Arbitrum One; a solver fills the same amount (minus its
 * quoted fee) on 4663 in seconds. The script re-verifies chain support and re-quotes
 * on every run (quotes expire), prints the exact in/out/fee, and then follows
 * prepared-or-executed: without RHCHAIN_SIGNER_KEY nothing is sent.
 *
 * This moves REAL money (mainnet ETH). It exists because a funding deposit landed on
 * Arbitrum One (the usual exchange-withdrawal default) instead of Robinhood Chain.
 *
 * Usage: cd mcp && node --env-file=.env scripts/rh-mainnet-bridge-relay.mjs [--amount 0.0015]
 * Env:   RHCHAIN_SIGNER_KEY   the wallet holding the ETH on Arbitrum One; the same
 *                             address receives on 4663
 *        ARB_RPC_URL          optional Arbitrum One RPC override
 */
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'

const RELAY_API = 'https://api.relay.link'
const ZERO = '0x0000000000000000000000000000000000000000'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const AMOUNT_ETH = arg('amount', '0.0015')

let getChainById, resolveRpcUrls
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ resolveRpcUrls } = await import('../dist/chains/evm/client.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}
const dest = getChainById('rhchain')
const destRpc = resolveRpcUrls(dest, process.env)[0]
const originRpc = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc'

// Fail closed unless Relay itself says both ends are enabled right now.
const chainsRes = await fetch(`${RELAY_API}/chains`)
const relayChains = (await chainsRes.json()).chains ?? []
for (const id of [42161, dest.evmChainId]) {
  const c = relayChains.find((x) => x.id === id)
  if (!c || c.disabled || !c.depositEnabled) {
    console.error(`error: Relay does not currently support chain ${id}; refusing to quote.`)
    process.exit(1)
  }
}

const key = process.env.RHCHAIN_SIGNER_KEY
const account = key ? privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`) : null
// Without a key there is still a meaningful prepared output: quote for the known signer.
const user = account?.address ?? '0xd305607510E0Db2c95807173c7A05BEA53c1ed36'

const quoteRes = await fetch(`${RELAY_API}/quote`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    user,
    recipient: user,
    originChainId: 42161,
    destinationChainId: dest.evmChainId,
    originCurrency: ZERO,
    destinationCurrency: ZERO,
    amount: parseEther(AMOUNT_ETH).toString(),
    tradeType: 'EXACT_INPUT',
  }),
})
const quote = await quoteRes.json()
if (!quote.steps?.length) {
  console.error('error: Relay returned no executable steps:', JSON.stringify(quote).slice(0, 400))
  process.exit(1)
}
const det = quote.details ?? {}
console.log(`Route:  Arbitrum One -> ${dest.name} (${dest.caip2}) via Relay`)
console.log(`In:     ${det.currencyIn?.amountFormatted} ETH   Out: ${det.currencyOut?.amountFormatted} ETH`)
console.log(`Fee:    ${quote.fees?.relayer?.amountFormatted} ETH (relayer)   ETA: ${det.timeEstimate}s`)

const txs = quote.steps.flatMap((s) => s.items ?? []).map((it) => it.data).filter(Boolean)
if (txs.some((t) => t.chainId !== 42161)) {
  console.error('error: Relay asked for a transaction outside Arbitrum One; refusing.')
  process.exit(1)
}

if (!account) {
  console.log('\nNo RHCHAIN_SIGNER_KEY set - PREPARED transaction(s) (nothing was broadcast):')
  console.log(JSON.stringify(txs, null, 2))
  process.exit(0)
}

const origin = createPublicClient({ chain: arbitrum, transport: http(originRpc, { timeout: 15000, retryCount: 2 }) })
const wallet = createWalletClient({ account, chain: arbitrum, transport: http(originRpc, { timeout: 15000, retryCount: 2 }) })
const destClient = createPublicClient({ transport: http(destRpc, { timeout: 15000, retryCount: 2 }) })
const before = await destClient.getBalance({ address: account.address })
console.log(`\nSigner: ${account.address} (${formatEther(await origin.getBalance({ address: account.address }))} ETH on Arbitrum One)`)

for (const t of txs) {
  const hash = await wallet.sendTransaction({ to: t.to, value: BigInt(t.value ?? 0), data: t.data ?? '0x' })
  console.log(`sent on Arbitrum One: ${hash}`)
  const r = await origin.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (r.status !== 'success') {
    console.error(`error: deposit reverted on Arbitrum One (https://arbiscan.io/tx/${hash})`)
    process.exit(1)
  }
}

console.log('deposit confirmed; waiting for the fill on 4663...')
const DEADLINE = Date.now() + 10 * 60_000
for (;;) {
  await new Promise((r) => setTimeout(r, 5000))
  const bal = await destClient.getBalance({ address: account.address }).catch(() => null)
  if (bal !== null && bal > before) {
    console.log(`\nFILLED: ${formatEther(bal)} ETH on ${dest.name}`)
    console.log(`Explorer: ${dest.explorer}/address/${account.address}`)
    process.exit(0)
  }
  if (Date.now() > DEADLINE) {
    console.error('Timed out waiting for the fill. The deposit DID land on Arbitrum One; check relay.link support with the tx hash above.')
    process.exit(1)
  }
  process.stdout.write('.')
}
