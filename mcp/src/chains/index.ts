/**
 * Multichain module - public surface. Import chains and the EVM adapter from here.
 *
 *   import { getChain, requireChain, ARC_CHAIN, createEvmAdapter } from './chains/index.js'
 *
 * See ./README.md for the full design.
 */
export * from './types.js'
export * from './caip.js'
export * from './registry.js'
export * from './public-view.js'
export { createEvmAdapter, type EvmAdapter } from './evm/adapter.js'
export { createStellarAdapter, type StellarAdapter, type CallOutcome, type VaultState } from './stellar/adapter.js'
export { EIP3009_ABI } from './evm/abis.js'
export {
  resolveRpcUrls,
  evmPublicClient,
  evmWalletClient,
  evmWalletClientFromKey,
  usdcUnits,
  fromUsdcUnits,
  tokenUnits,
  fromTokenUnits,
} from './evm/client.js'
// Explorer links come from the ecosystem-aware module, NOT from evm/client.js. Every
// caller already passes a ChainDescriptor, so the EVM behaviour is byte-identical and the
// non-EVM chains stop getting a route their explorer does not have. See ./explorer.ts.
export { txUrl, addressUrl } from './explorer.js'
export * from './stellar/strkey.js'
