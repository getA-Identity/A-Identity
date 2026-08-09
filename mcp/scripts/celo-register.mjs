#!/usr/bin/env node
/**
 * Celo ERC-8004 registration — prepared-or-executed, human-on-the-loop.
 *
 * Builds the IdentityRegistry `register(string agentURI)` call for Celo (the selector
 * was verified PRESENT in the deployed implementation's bytecode on 2026-08-09), appends
 * the ERC-8021 attribution suffix when ATTRIBUTION_TAG is set, and then either:
 *   - prints the EXACT prepared transaction (no CELO_SIGNER_KEY set) so a human can
 *     send it from any wallet, or
 *   - signs, broadcasts, waits for the receipt, and prints the minted agentId with
 *     explorer links (CELO_SIGNER_KEY set).
 *
 * Chain constants come from the built chain registry (mcp/dist) — run `npm run build`
 * first. Nothing here restates an address the registry already knows; the one local
 * constant is Celo's USDC fee-currency ADAPTER, which is a gas-payment device, not a
 * chain descriptor field (bytecode verified live 2026-08-09).
 *
 * Usage:
 *   cd mcp && npm run build
 *   node --env-file=.env scripts/celo-register.mjs [--testnet] [--uri <agentURI>]
 *
 * Env:
 *   CELO_SIGNER_KEY       optional - broadcast when present; else print the prepared tx
 *   ATTRIBUTION_TAG       optional - ERC-8021 code assigned at hackathon registration;
 *                         appended to calldata via @celo/attribution-tags toDataSuffix
 *   CELO_FEE_IN_USDC=1    optional - pay gas in USDC via CIP-64 feeCurrency
 *                         (MAINNET only: the adapter below is a mainnet contract)
 *   CELO_RPC_URL / CELO_SEPOLIA_RPC_URL   optional RPC overrides (registry rpcEnvVar)
 */
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseEventLogs } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo as viemCelo, celoSepolia as viemCeloSepolia } from 'viem/chains'

// ── args + env ────────────────────────────────────────────────────────────────────
const TESTNET = process.argv.includes('--testnet')
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const AGENT_URI = arg('uri', 'https://a-identity.xyz/.well-known/agent-card.json')

// ── chain facts from the built registry (single source of truth) ──────────────────
let getChainById, resolveRpcUrls
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ resolveRpcUrls } = await import('../dist/chains/evm/client.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}
const chain = getChainById(TESTNET ? 'celo-sepolia' : 'celo')
if (!chain?.contracts?.identityRegistry) {
  console.error('error: the registry has no identityRegistry for this network')
  process.exit(1)
}
const REGISTRY = chain.contracts.identityRegistry
const RPCS = resolveRpcUrls(chain, process.env)
const viemChain = TESTNET ? viemCeloSepolia : viemCelo // CIP-64 serializers included

/** Celo mainnet USDC fee-currency ADAPTER (18-dec gas interface over 6-dec USDC).
 *  Used ONLY as `feeCurrency`; bytecode verified with eth_getCode on 2026-08-09. */
const USDC_FEE_ADAPTER = '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B'
const FEE_IN_USDC = process.env.CELO_FEE_IN_USDC === '1'
if (FEE_IN_USDC && TESTNET) {
  console.error('note: CELO_FEE_IN_USDC is mainnet-only (the adapter is a mainnet contract); paying gas in CELO instead.')
}

const REGISTER_ABI = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'agentURI', type: 'string' }], outputs: [{ name: 'agentId', type: 'uint256' }] },
]

// ── calldata (+ optional ERC-8021 attribution suffix) ─────────────────────────────
let data = encodeFunctionData({ abi: REGISTER_ABI, functionName: 'register', args: [AGENT_URI] })
const TAG = process.env.ATTRIBUTION_TAG?.trim()
if (TAG) {
  const { toDataSuffix } = await import('@celo/attribution-tags')
  const suffix = toDataSuffix(TAG)
  data = data + suffix.slice(2)
  console.log(`ERC-8021 attribution suffix appended for tag '${TAG}': ${suffix}`)
} else {
  console.log('No ATTRIBUTION_TAG set - registering without an ERC-8021 suffix.')
}

console.log(`\nNetwork:  ${chain.name} (${chain.caip2})`)
console.log(`Registry: ${REGISTRY}`)
console.log(`AgentURI: ${AGENT_URI}`)

// ── prepared-or-executed ──────────────────────────────────────────────────────────
const key = process.env.CELO_SIGNER_KEY
if (!key) {
  console.log('\nNo CELO_SIGNER_KEY set - PREPARED transaction (nothing was broadcast):')
  console.log(JSON.stringify({
    executed: false,
    chainId: chain.evmChainId,
    to: REGISTRY,
    value: '0x0',
    data,
    reason: 'no signer key configured; send this call from any funded wallet to register',
  }, null, 2))
  console.log('\nTo execute: set CELO_SIGNER_KEY (a funded wallet) and re-run, or paste the tx into your wallet.')
  process.exit(0)
}

const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const transport = http(RPCS[0], { timeout: 15000, retryCount: 2 })
const pub = createPublicClient({ chain: viemChain, transport })
const wallet = createWalletClient({ account, chain: viemChain, transport })

console.log(`Signer:   ${account.address}`)
const feeCurrency = FEE_IN_USDC && !TESTNET ? USDC_FEE_ADAPTER : undefined
if (feeCurrency) console.log(`Gas paid in USDC via CIP-64 feeCurrency ${feeCurrency}`)

const hash = await wallet.sendTransaction({
  to: REGISTRY,
  data,
  ...(feeCurrency ? { feeCurrency } : {}),
})
console.log(`\nSent: ${hash}`)
console.log('Waiting for receipt...')
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
if (receipt.status !== 'success') {
  console.error(`error: transaction reverted (status ${receipt.status}). ${chain.explorer}/tx/${hash}`)
  process.exit(1)
}

// The ERC-721 mint Transfer(from=0x0) carries the new agentId as its tokenId.
const transfers = parseEventLogs({
  abi: [{
    type: 'event', name: 'Transfer', inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  }],
  eventName: 'Transfer',
  logs: receipt.logs,
})
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
const mint = transfers.find(
  (l) => l.address.toLowerCase() === REGISTRY.toLowerCase() && l.args.from.toLowerCase() === ZERO_ADDR,
)
const agentId = mint?.args?.tokenId

console.log('\nREGISTERED')
console.log(`  tx:       ${chain.explorer}/tx/${hash}`)
if (agentId !== undefined) {
  console.log(`  agentId:  #${agentId} (${chain.caip2}:8004/${agentId})`)
  console.log(`  registry: ${chain.explorer}/address/${REGISTRY}`)
  console.log(`  8004scan: https://www.8004scan.io (search agent #${agentId} on ${chain.shortName})`)
  console.log(`\nVerify the read side now: GET /api/agent?q=${chain.caip2}:8004/${agentId}`)
} else {
  console.log('  agentId: could not be parsed from the logs - check the tx on the explorer above.')
}
