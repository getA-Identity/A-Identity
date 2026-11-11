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
 * on every run (quotes expire), prints the exact in/out/fee, and prints the prepared
 * transaction(s). It never sends anything: it used to sign with RHCHAIN_SIGNER_KEY, which held
 * the key of the operating wallet 0xd305 until 2026-11-11; someone else has also held that key
 * since at least 2026-11-01.
 * The person who holds the wallet named by --user sends the prepared transaction from it.
 *
 * Sending it moves REAL money (mainnet ETH). It exists because a funding deposit landed on
 * Arbitrum One (the usual exchange-withdrawal default) instead of Robinhood Chain.
 *
 * Usage: cd mcp && node scripts/rh-mainnet-bridge-relay.mjs --user 0x... [--amount 0.0015]
 *        --user is the wallet holding the ETH on Arbitrum One; the same address receives on 4663.
 */
import { parseEther } from 'viem'

const RELAY_API = 'https://api.relay.link'
const ZERO = '0x0000000000000000000000000000000000000000'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const AMOUNT_ETH = arg('amount', '0.0015')

let getChainById
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}
const dest = getChainById('rhchain')

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

// RHCHAIN_SIGNER_KEY held the operating wallet 0xd305, whose key someone else has also held since at
// least 2026-11-01, so this no longer reads it or defaults to that address: name the user with --user.
const user = arg('user', '')
if (!/^0x[0-9a-fA-F]{40}$/.test(user)) {
  console.error('error: pass --user 0x... (the wallet to quote for). This script no longer reads RHCHAIN_SIGNER_KEY.')
  process.exit(1)
}

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

console.log(`\nPREPARED transaction(s) for ${user} (nothing was broadcast; send them from that wallet):`)
console.log(JSON.stringify(txs, null, 2))
