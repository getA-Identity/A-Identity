#!/usr/bin/env node
/**
 * Deploy + configure ONE AgentSpendPolicy vault on Robinhood Chain Testnet (eip155:46630).
 *
 * The vault is per-agent runtime infrastructure (see ChainContracts.spendVault), so this
 * does not add a descriptor address; it proves the deploy path works on this chain and
 * leaves a real, linkable vault behind.
 *
 * Token honesty: no canonical USDC is documented for Robinhood Chain and the registry
 * deliberately asserts none (registry.test.ts pins contracts.usdc undefined). The vault
 * constructor requires a real token, so this script uses the TESTNET's canonical-BRIDGE
 * representation of Circle's Ethereum Sepolia USDC (0x1c7D4B19...C7238): the address is
 * not typed in as a claim but DERIVED LIVE from the chain's own L2 gateway router
 * (calculateL2TokenAddress) and verified to have code, failing closed on any mismatch
 * with the pinned value below. That is a labeled test-bridge token, not an assertion
 * that Robinhood Chain has canonical USDC; the descriptor keeps saying it does not.
 *
 * Prepared-or-executed: without RHCHAIN_TESTNET_SIGNER_KEY this prints the exact deploy
 * it would make and exits.
 *
 * Usage: cd mcp && npm run build && node --env-file=.env scripts/rh-testnet-deploy-vault.mjs \
 *          [--daily-cap 25] [--auto-approve 5] [--session-days 7]
 */
import { createPublicClient, createWalletClient, http, defineChain, encodeAbiParameters } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// Robinhood testnet L2 gateway router (docs.robinhood.com/chain/protocol-contracts,
// read 2026-08-11) and Circle's Ethereum Sepolia USDC it maps from.
const L2_GATEWAY_ROUTER = '0x77bF00A6A90c600f214b34BAFBB7918c0cF113A8'
const L1_SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
// What the router derived + eth_getCode confirmed on 2026-08-11. Re-derived on every run.
const EXPECTED_BRIDGED_USDC = '0x71c6e1c209a4e3d4bd9911b2d53c98023a56c32f'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const DAILY_CAP_USD = Number(arg('daily-cap', '25'))
const AUTO_APPROVE_USD = Number(arg('auto-approve', '5'))
const SESSION_DAYS = Number(arg('session-days', '7'))

let getChainById, resolveRpcUrls, AgentSpendPolicyAbi, AgentSpendPolicyBytecode
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ resolveRpcUrls } = await import('../dist/chains/evm/client.js'))
  ;({ AgentSpendPolicyAbi, AgentSpendPolicyBytecode } = await import('../dist/contracts/AgentSpendPolicy.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}
const chain = getChainById('rhchain-testnet')
const RPC = resolveRpcUrls(chain, process.env)[0]
const viemChain = defineChain({ id: chain.evmChainId, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })

// Derive the bridged-token address from the chain's own router; never trust the pin alone.
const ROUTER_ABI = [{ type: 'function', name: 'calculateL2TokenAddress', stateMutability: 'view', inputs: [{ name: 'l1ERC20', type: 'address' }], outputs: [{ type: 'address' }] }]
const derived = await pub.readContract({ address: L2_GATEWAY_ROUTER, abi: ROUTER_ABI, functionName: 'calculateL2TokenAddress', args: [L1_SEPOLIA_USDC] })
if (derived.toLowerCase() !== EXPECTED_BRIDGED_USDC.toLowerCase()) {
  console.error(`error: router derives ${derived}, expected ${EXPECTED_BRIDGED_USDC}. Refusing to deploy against a drifted token address.`)
  process.exit(1)
}
const tokenCode = await pub.getCode({ address: derived })
if (!tokenCode || tokenCode === '0x') {
  console.error('error: the bridged token has no code on 46630 (nobody has bridged Sepolia USDC yet). Refusing to deploy against an empty address.')
  process.exit(1)
}
const ERC20_META = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
]
const [symbol, decimals] = await Promise.all([
  pub.readContract({ address: derived, abi: ERC20_META, functionName: 'symbol' }),
  pub.readContract({ address: derived, abi: ERC20_META, functionName: 'decimals' }),
])
const units = (usd) => BigInt(Math.round(usd * 10 ** Number(decimals)))

console.log(`Target: ${chain.name} (${chain.caip2})`)
console.log(`Token:  ${derived} (${symbol}, ${decimals} decimals) - canonical-bridge of Sepolia USDC, testnet-only`)
console.log(`Policy: dailyCap $${DAILY_CAP_USD}, autoApprove $${AUTO_APPROVE_USD}, session key ${SESSION_DAYS}d`)

const key = process.env.RHCHAIN_TESTNET_SIGNER_KEY
if (!key) {
  console.log('\nNo RHCHAIN_TESTNET_SIGNER_KEY set - PREPARED deployment (nothing was broadcast):')
  console.log(JSON.stringify({
    executed: false,
    chainId: chain.evmChainId,
    deploy: 'AgentSpendPolicy',
    constructorArgs: { owner: '(signer)', operator: '(signer)', usdc: derived, dailyCap: units(DAILY_CAP_USD).toString(), autoApproveMax: units(AUTO_APPROVE_USD).toString() },
    reason: 'set the signer key to deploy the per-agent vault for real',
  }, null, 2))
  process.exit(0)
}

const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const wallet = createWalletClient({ account, chain: viemChain, transport: http(RPC, { timeout: 20000, retryCount: 2 }) })

console.log(`Signer: ${account.address}`)
const hash = await wallet.deployContract({
  abi: AgentSpendPolicyAbi,
  bytecode: AgentSpendPolicyBytecode,
  args: [account.address, account.address, derived, units(DAILY_CAP_USD), units(AUTO_APPROVE_USD)],
})
console.log(`deploy tx: ${hash}`)
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
if (receipt.status !== 'success' || !receipt.contractAddress) {
  console.error(`error: vault deploy reverted (${chain.explorer}/tx/${hash})`)
  process.exit(1)
}
const vault = receipt.contractAddress
console.log(`vault:     ${chain.explorer}/address/${vault}`)

// Configure: give the operator a time-bounded session key (a real policy write).
const expiry = BigInt(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400)
const cfgHash = await wallet.writeContract({ address: vault, abi: AgentSpendPolicyAbi, functionName: 'setSessionKeyExpiry', args: [expiry] })
const cfgReceipt = await pub.waitForTransactionReceipt({ hash: cfgHash, timeout: 180_000 })
if (cfgReceipt.status !== 'success') {
  console.error(`error: setSessionKeyExpiry reverted (${chain.explorer}/tx/${cfgHash})`)
  process.exit(1)
}
console.log(`session:   expires ${new Date(Number(expiry) * 1000).toISOString()} (${chain.explorer}/tx/${cfgHash})`)

// Read back the on-chain state - report what the CONTRACT says, not what we sent.
const read = (fn) => pub.readContract({ address: vault, abi: AgentSpendPolicyAbi, functionName: fn })
const [owner, operator, dailyCap, autoApproveMax, frozen] = await Promise.all([
  read('owner'), read('operator'), read('dailyCap'), read('autoApproveMax'), read('frozen'),
])
console.log('\nOn-chain vault state:')
console.log(JSON.stringify({ vault, owner, operator, dailyCap: dailyCap.toString(), autoApproveMax: autoApproveMax.toString(), frozen, token: derived, tokenSymbol: symbol }, null, 2))
console.log('\nNote: settlement through this vault stays PENDING until a canonical stablecoin is')
console.log('published for Robinhood Chain; the token above is the testnet bridge representation.')
