/**
 * Multichain module — public surface. Import chains and the EVM adapter from here.
 *
 *   import { getChain, requireChain, ARC_CHAIN, createEvmAdapter } from './chains/index.js'
 *
 * See ../../../MULTICHAIN-STRATEGY.md for the full design.
 */
export * from './types.js'
export * from './caip.js'
export * from './registry.js'
export * from './public-view.js'
export { createEvmAdapter, type EvmAdapter } from './evm/adapter.js'
export {
  resolveRpcUrls,
  evmPublicClient,
  evmWalletClient,
  usdcUnits,
  fromUsdcUnits,
  txUrl,
  addressUrl,
} from './evm/client.js'
