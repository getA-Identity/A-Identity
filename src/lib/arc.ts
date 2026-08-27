/**
 * Circle Arc chain configuration and helpers.
 *
 * Arc is an EVM-compatible chain where gas is paid in USDC (not a volatile native
 * token), with deterministic sub-second finality. Mainnet is not public yet, so we
 * target Arc Testnet. Source: https://docs.arc.io/arc-chain and /references/rpc-endpoints
 *
 * Chain id, RPC host and explorer come from the GENERATED registry mirror
 * (src/lib/chains.ts), never typed here: three hand-copied Arc configs had already
 * drifted apart once, which is exactly the class of bug the registry generator exists
 * to prevent. Only the facts the registry mirror does not carry (the dual-decimals
 * native token, the websocket endpoint, finality) are stated locally.
 *
 * Dual USDC interface: the native balance uses 18 decimals while the ERC-20
 * interface uses 6 decimals; both share the same underlying balance.
 */

import { CHAIN_BY_ID } from './chains'

// Non-null by construction for Arc, an EVM chain with a public RPC; the registry
// types allow null only because non-EVM entries exist.
const ARC = CHAIN_BY_ID.arc

export const ARC_TESTNET = {
  id: ARC.chainId as number,
  caip2: ARC.caip2,
  name: 'Arc Testnet',
  network: 'arc-testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpc: {
    http: ARC.rpcUrl as string,
    ws: (ARC.rpcUrl as string).replace(/^https:/, 'wss:'),
  },
  blockExplorer: ARC.explorer as string,
  /** Native USDC uses 18 decimals; the ERC-20 interface uses 6. Same balance. */
  nativeDecimals: 18,
  erc20Decimals: 6,
  finality: 'Deterministic, sub-second (~0.48s block time)',
  gasToken: 'USDC',
  testnet: true,
} as const
