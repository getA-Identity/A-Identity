#!/usr/bin/env node
/**
 * Fund the Robinhood Chain Testnet signer with testnet ETH via the native bridge.
 *
 * Robinhood Chain Testnet (eip155:46630) is an Arbitrum Orbit chain whose parent chain
 * is Ethereum Sepolia. Depositing ETH means calling depositEth() on the chain's Delayed
 * Inbox ON SEPOLIA; the sender's own address is credited on the L2 a few minutes later
 * (EOA senders are not aliased). The Inbox address comes from
 * docs.robinhood.com/chain/protocol-contracts ("Delayed Inbox", testnet column),
 * read 2026-08-11. This script re-verifies it live with eth_getCode before sending,
 * so a doc drift fails closed instead of sending ETH to a dead address.
 *
 * Prepared-or-executed (project law):
 *   - no RHCHAIN_TESTNET_SIGNER_KEY  -> prints the EXACT Sepolia tx and exits; nothing sent
 *   - key set                        -> broadcasts on Sepolia, waits for the receipt, then
 *                                       polls the L2 balance until the deposit is credited
 *
 * Usage: cd mcp && npm run build && node --env-file=.env scripts/rh-testnet-bridge.mjs [--amount 0.05]
 * Env:   RHCHAIN_TESTNET_SIGNER_KEY   wallet to fund (the SAME key signs the L1 deposit)
 *        SEPOLIA_RPC_URL              optional Ethereum Sepolia RPC override
 */
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

// Robinhood Chain Testnet Delayed Inbox, on Ethereum Sepolia (see header for provenance).
const DELAYED_INBOX = '0xF2939afA86F6f933A3CE17fCAB007907B6b0B7a4'
// depositEth() — the standard Arbitrum Inbox ETH deposit entrypoint.
const DEPOSIT_ETH_CALLDATA = '0x439370b1'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const AMOUNT_ETH = arg('amount', '0.05')

let getChainById, resolveRpcUrls
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ resolveRpcUrls } = await import('../dist/chains/evm/client.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}
const chain = getChainById('rhchain-testnet')
const L2_RPC = resolveRpcUrls(chain, process.env)[0]
const L1_RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'

const l1 = createPublicClient({ chain: sepolia, transport: http(L1_RPC, { timeout: 15000, retryCount: 2 }) })
const l2 = createPublicClient({ transport: http(L2_RPC, { timeout: 15000, retryCount: 2 }) })

// Fail closed if the documented Inbox is not actually a contract on Sepolia.
const inboxCode = await l1.getCode({ address: DELAYED_INBOX })
if (!inboxCode || inboxCode === '0x') {
  console.error(`error: no code at the documented Delayed Inbox ${DELAYED_INBOX} on Sepolia; refusing to send.`)
  process.exit(1)
}

console.log(`Bridge:   Ethereum Sepolia -> ${chain.name} (${chain.caip2})`)
console.log(`Inbox:    ${DELAYED_INBOX} (code present on Sepolia)`)
console.log(`Amount:   ${AMOUNT_ETH} ETH (testnet)`)

const key = process.env.RHCHAIN_TESTNET_SIGNER_KEY
if (!key) {
  console.log('\nNo RHCHAIN_TESTNET_SIGNER_KEY set - PREPARED transaction (nothing was broadcast):')
  console.log(JSON.stringify({
    executed: false,
    chainId: sepolia.id,
    to: DELAYED_INBOX,
    value: parseEther(AMOUNT_ETH).toString(),
    data: DEPOSIT_ETH_CALLDATA,
    reason: 'depositEth() on the Robinhood testnet Delayed Inbox; the sender address is credited on chain 46630',
  }, null, 2))
  process.exit(0)
}

const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const wallet = createWalletClient({ account, chain: sepolia, transport: http(L1_RPC, { timeout: 15000, retryCount: 2 }) })

const [l1Bal, l2Before] = await Promise.all([
  l1.getBalance({ address: account.address }),
  l2.getBalance({ address: account.address }),
])
console.log(`Signer:   ${account.address}`)
console.log(`Balance:  ${formatEther(l1Bal)} Sepolia ETH | ${formatEther(l2Before)} ETH on 46630`)
if (l1Bal < parseEther(AMOUNT_ETH)) {
  console.error('error: not enough Sepolia ETH for this deposit.')
  process.exit(1)
}

const hash = await wallet.sendTransaction({ to: DELAYED_INBOX, value: parseEther(AMOUNT_ETH), data: DEPOSIT_ETH_CALLDATA })
console.log(`\nSent on Sepolia: ${hash}`)
const receipt = await l1.waitForTransactionReceipt({ hash, timeout: 180_000 })
if (receipt.status !== 'success') {
  console.error(`error: deposit tx reverted on Sepolia (https://sepolia.etherscan.io/tx/${hash})`)
  process.exit(1)
}
console.log(`L1 receipt ok (block ${receipt.blockNumber}). Waiting for the L2 credit (usually a few minutes)...`)

const DEADLINE = Date.now() + 30 * 60_000
for (;;) {
  await new Promise((r) => setTimeout(r, 15_000))
  const bal = await l2.getBalance({ address: account.address }).catch(() => null)
  if (bal !== null && bal > l2Before) {
    console.log(`\nCREDITED: ${formatEther(bal)} ETH on ${chain.name}`)
    console.log(`Explorer: ${chain.explorer}/address/${account.address}`)
    process.exit(0)
  }
  if (Date.now() > DEADLINE) {
    console.error(`\nTimed out waiting for the L2 credit. The L1 deposit DID land (${hash});`)
    console.error('check the address on the L2 explorer later - retryable deposits can lag.')
    process.exit(1)
  }
  process.stdout.write('.')
}
