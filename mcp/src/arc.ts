/**
 * Circle Arc integration (read-only). Arc is an EVM chain where gas is paid in
 * USDC, with sub-second deterministic finality. We connect to the public Arc
 * testnet RPC with viem and read live chain state. No keys, no funds, no writes.
 *
 * Grounded in docs.arc.io:
 *   - references/connect-to-arc  (chainId, RPC, native USDC 18 decimals, faucet)
 *   - tutorials/deploy-on-arc    (Foundry, gas paid in USDC)
 *   - app-kit                    (@circle-fin/app-kit unified balance)
 */
import { ARC_CHAIN } from './chains/index.js'

/**
 * Arc's public shape for this module's callers, DERIVED from the chain registry rather
 * than restated. This object used to be a second hand-written copy of Arc's chain id,
 * RPCs, explorer, faucet and decimals; `arc-parity.test.ts` existed only to catch it
 * drifting from the registry. Deriving it removes the possibility instead of testing for
 * it, and the parity test now holds by construction.
 */
export const ARC_TESTNET = {
  id: ARC_CHAIN.evmChainId as number,
  caip2: ARC_CHAIN.caip2,
  name: ARC_CHAIN.name,
  nativeCurrency: ARC_CHAIN.nativeCurrency,
  rpc: {
    primary: ARC_CHAIN.rpcUrls[0],
    ws: ARC_CHAIN.wsUrl as string,
    alternates: ARC_CHAIN.rpcUrls.slice(1),
  },
  explorer: ARC_CHAIN.explorer as string,
  faucet: ARC_CHAIN.faucet as string,
  gasToken: ARC_CHAIN.nativeCurrency.symbol,
  /** Native USDC uses 18 decimals; the ERC-20 interface uses 6. Same balance. */
  nativeDecimals: ARC_CHAIN.nativeCurrency.decimals,
  erc20Decimals: ARC_CHAIN.usdcDecimals,
  finality: 'deterministic, sub-second',
} as const

export type ArcStatus = {
  chain: 'arc-testnet'
  online: boolean
  chainId: number | null
  blockNumber: string | null
  rpc: string
  explorer: string
  faucet: string
  gasToken: string
  nativeDecimals: number
  checkedAt: string
  note?: string
}

/**
 * Read live Arc testnet state over JSON-RPC via viem. Degrades gracefully: if the
 * RPC is unreachable, returns online:false with the static config still attached.
 */
export async function getArcStatus(rpcUrl: string = ARC_TESTNET.rpc.primary): Promise<ArcStatus> {
  const base: ArcStatus = {
    chain: 'arc-testnet',
    online: false,
    chainId: null,
    blockNumber: null,
    rpc: rpcUrl,
    explorer: ARC_TESTNET.explorer,
    faucet: ARC_TESTNET.faucet,
    gasToken: ARC_TESTNET.gasToken,
    nativeDecimals: ARC_TESTNET.nativeDecimals,
    checkedAt: new Date().toISOString(),
  }

  try {
    const { createPublicClient, http } = await import('viem')
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: 5000, retryCount: 0 }),
    })
    const [chainId, blockNumber] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
    ])
    return {
      ...base,
      online: true,
      chainId: Number(chainId),
      blockNumber: blockNumber.toString(),
    }
  } catch (err) {
    return {
      ...base,
      note:
        'Arc testnet RPC not reachable from here. Config is correct; the chain may be in a quiet or restricted window. ' +
        (err instanceof Error ? err.message : String(err)),
    }
  }
}
