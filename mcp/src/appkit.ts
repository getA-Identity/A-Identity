/**
 * Circle App Kit - the Send / Swap / Unified Balance surface on Arc.
 *
 * We already drove Bridge Kit directly for CCTP (`cctp.ts`). App Kit is the umbrella
 * over the same family, and it unlocks the one capability that makes the Arc argument
 * concrete rather than rhetorical: **Arc Testnet is the only testnet where Swap works**,
 * and it is the only one that publishes an EURC address, so a USDC->EURC swap is
 * something this product can demonstrate on Arc and nowhere else in testing.
 *
 * Three entry points, in rising order of privilege:
 *   - `appKitCapabilities()`  read-only, no key, no network write. Answers "what can
 *                             App Kit do on Arc" straight from the SDK's own chain table.
 *   - `quoteArcSwap()`        a real quote from Circle's rate service. Still no key.
 *   - `runArcSwapDemo()`      the actual on-chain swap, env-gated behind ARC_SIGNER_KEY
 *                             exactly like every other write path here.
 *
 * SDK: @circle-fin/app-kit + @circle-fin/adapter-viem-v2 (already a dependency).
 */

import { ARC_CHAIN as ARC } from './chains/registry.js'

/**
 * App Kit's own name for Arc Testnet. Everything numeric (the EVM chain id, the explorer
 * host) comes from the chain registry rather than being retyped here, which is what
 * `chains/no-hardcoded-chains.test.ts` enforces across the codebase.
 */
export const ARC_CHAIN = 'Arc_Testnet'
const ARC_CHAIN_ID = ARC.evmChainId
const ARC_EXPLORER = ARC.explorer

type ChainInfo = {
  chain?: string
  chainId?: number
  isTestnet?: boolean
  usdcAddress?: string | null
  eurcAddress?: string | null
  explorerUrl?: string
}

/** Lazily construct an AppKit; the import is dynamic so a missing SDK degrades cleanly. */
async function loadKit() {
  const mod = (await import('@circle-fin/app-kit')) as unknown as {
    AppKit: new (opts?: unknown) => {
      swap: (p: unknown) => Promise<unknown>
      estimateSwap: (p: unknown) => Promise<unknown>
      getTokenRates: (p: unknown) => Promise<unknown>
      getSupportedChains: (c: string) => ChainInfo[]
      send: (p: unknown) => Promise<unknown>
      estimateSend: (p: unknown) => Promise<unknown>
    }
  }
  return new mod.AppKit()
}

/**
 * What App Kit can actually do on Arc, read from the SDK's own chain table rather than
 * from a doc we copied. Deliberately key-free so the UI can render it cold.
 */
export async function appKitCapabilities(): Promise<{
  chain: string
  chainId: number | null
  capabilities: { name: string; supported: boolean; note?: string }[]
  tokens: { usdc?: string | null; eurc?: string | null }
  swapTestnetsSupported: string[]
  explorerUrl?: string
}> {
  const kit = await loadKit()
  const find = (cap: string) => kit.getSupportedChains(cap).find((c) => c.chain === ARC_CHAIN)

  const swapChains = kit.getSupportedChains('swap')
  const arcSwap = swapChains.find((c) => c.chain === ARC_CHAIN)
  const arcBridge = find('bridge')
  const arcUnified = find('unifiedBalance')

  return {
    chain: ARC_CHAIN,
    chainId: arcSwap?.chainId ?? ARC_CHAIN_ID,
    capabilities: [
      { name: 'Send', supported: true, note: 'Same-chain USDC transfer through App Kit.' },
      { name: 'Bridge', supported: Boolean(arcBridge), note: 'CCTP burn-and-mint, also driven directly in cctp.ts.' },
      {
        name: 'Swap',
        supported: Boolean(arcSwap),
        note: 'USDC and EURC on Arc. Arc Testnet is the only testnet App Kit can swap on.',
      },
      { name: 'Unified Balance', supported: Boolean(arcUnified), note: 'One USDC balance spendable across chains.' },
    ],
    tokens: { usdc: arcSwap?.usdcAddress, eurc: arcSwap?.eurcAddress },
    // The claim that makes Arc special, computed rather than asserted.
    swapTestnetsSupported: swapChains.filter((c) => c.isTestnet).map((c) => c.chain ?? '?'),
    explorerUrl: arcSwap?.explorerUrl,
  }
}

/** A real USDC->EURC rate from Circle's service. No key, no write, safe to call cold. */
export async function quoteArcSwap(
  input: { amountUsd?: number } = {},
): Promise<{ ok: boolean; amountUsd: number; tokenIn: string; tokenOut: string; rate?: unknown; reason?: string }> {
  const amountUsd = Math.max(0.01, input.amountUsd ?? 1)
  try {
    const kit = await loadKit()
    const rate = await kit.getTokenRates({
      chain: ARC_CHAIN,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amount: String(amountUsd),
    })
    return { ok: true, amountUsd, tokenIn: 'USDC', tokenOut: 'EURC', rate }
  } catch (e) {
    return {
      ok: false,
      amountUsd,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * The real thing: swap USDC for EURC on Arc Testnet through App Kit.
 *
 * Env-gated behind ARC_SIGNER_KEY, and a clean `executed: false` no-op without it, so the
 * endpoint is safe to expose and never fabricates a transaction.
 */
export async function runArcSwapDemo(
  input: { amountUsd?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  executed: boolean
  route: string
  amountUsd: number
  tokenIn: string
  tokenOut: string
  txHash?: string
  explorerUrl?: string
  state?: string
  reason?: string
}> {
  const route = 'USDC -> EURC on Arc Testnet'
  const amountUsd = Math.max(0.01, input.amountUsd ?? 1)
  const key = env.ARC_SIGNER_KEY
  if (!key) {
    return {
      executed: false,
      route,
      amountUsd,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      reason:
        'No ARC_SIGNER_KEY set. With a funded key this swaps USDC for EURC on Arc Testnet through Circle App Kit, the only testnet where App Kit supports swap.',
    }
  }

  try {
    const { createViemAdapterFromPrivateKey } = await import('@circle-fin/adapter-viem-v2')
    const adapter = createViemAdapterFromPrivateKey({
      privateKey: (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`,
    })
    const kit = await loadKit()

    const result = (await kit.swap({
      from: { adapter, chain: ARC_CHAIN },
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amount: String(amountUsd),
    } as never)) as { txHash?: string; hash?: string; state?: string; explorerUrl?: string }

    const txHash = result.txHash ?? result.hash
    return {
      executed: Boolean(txHash),
      route,
      amountUsd,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      txHash,
      explorerUrl: result.explorerUrl ?? (txHash ? `${ARC_EXPLORER}/tx/${txHash}` : undefined),
      state: result.state ?? (txHash ? 'submitted' : 'unknown'),
      // Honesty: a call that returns without a hash is not a settled swap.
      reason: txHash ? undefined : 'App Kit returned no transaction hash; treating the swap as not executed.',
    }
  } catch (e) {
    return {
      executed: false,
      route,
      amountUsd,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}
