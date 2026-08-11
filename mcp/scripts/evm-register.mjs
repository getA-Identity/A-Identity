#!/usr/bin/env node
/**
 * Register the A-Identity agent on ANY EVM chain in the registry, through the SAME
 * adapter the product uses (createEvmAdapter -> registerAgent), so a successful run
 * proves the production code path on that chain, not a bespoke script path.
 *
 * Prepared-or-executed is inherited from the adapter: without the chain's signer env
 * var this prints the exact register(call) it would make; with it, it broadcasts,
 * waits for the receipt and prints the minted agentId.
 *
 * (celo-register.mjs stays separate on purpose: it carries Celo-only devices - the
 * CIP-64 USDC fee currency and the ERC-8021 attribution suffix.)
 *
 * Usage: cd mcp && npm run build && node --env-file=.env scripts/evm-register.mjs \
 *          --chain rhchain-testnet [--uri https://a-identity.xyz/.well-known/agent-card.json]
 */
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const CHAIN_ID = arg('chain', 'rhchain-testnet')
const AGENT_URI = arg('uri', 'https://a-identity.xyz/.well-known/agent-card.json')

let getChainById, createEvmAdapter
try {
  ;({ getChainById } = await import('../dist/chains/registry.js'))
  ;({ createEvmAdapter } = await import('../dist/chains/evm/adapter.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}

const chain = getChainById(CHAIN_ID)
if (!chain) {
  console.error(`error: unknown chain '${CHAIN_ID}'`)
  process.exit(1)
}
if (chain.ecosystem !== 'evm') {
  console.error(`error: ${CHAIN_ID} is not an EVM chain`)
  process.exit(1)
}
if (!chain.contracts.identityRegistry) {
  console.error(`error: the registry has no identityRegistry for ${CHAIN_ID}; deploy it first.`)
  process.exit(1)
}

console.log(`Network:  ${chain.name} (${chain.caip2})`)
console.log(`Registry: ${chain.contracts.identityRegistry}`)
console.log(`AgentURI: ${AGENT_URI}`)

const adapter = createEvmAdapter(chain)
const result = await adapter.registerAgent(AGENT_URI)

if (!result.executed) {
  console.log('\nPREPARED (nothing was broadcast):')
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}
console.log('\nREGISTERED')
console.log(`  tx:      ${result.explorerUrl}`)
if (result.agentId !== undefined) {
  console.log(`  agentId: #${result.agentId} (${chain.caip2}:8004/${result.agentId})`)
  console.log(`  registry: ${chain.explorer}/address/${chain.contracts.identityRegistry}`)
}
