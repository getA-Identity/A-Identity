/**
 * Circle CCTP - native USDC cross-chain via burn-and-mint (Bridge Kit).
 *
 * A second cross-chain rail alongside Gateway (`gateway.ts`). Where Gateway moves a
 * unified balance via the Forwarding Service, CCTP is the canonical burn-and-mint:
 * USDC is burned on Arc and minted natively on the destination - never wrapped. We
 * drive it with Circle's Bridge Kit (CCTPv2 under the hood): approve -> burn ->
 * fetchAttestation -> mint, each a real tx with an explorer link.
 *
 * Env-gated behind ARC_SIGNER_KEY like every write path; a clean `prepared` no-op
 * without it. Note: leaving Arc, the amount must exceed the CCTPv2 max fee, so the
 * demo defaults to 1.0 USDC.
 *
 * SDK: @circle-fin/bridge-kit + @circle-fin/adapter-viem-v2.
 */

/** A single bridge step surfaced from Bridge Kit's lifecycle events. */
type BridgeStep = { name: string; state: string; txHash?: string; explorerUrl?: string }

/**
 * One-click CCTP demo: bridge `amountUsd` of native USDC from Arc Testnet to Base
 * Sepolia via burn-and-mint, returning the per-step on-chain trail. Env-gated; a
 * `prepared` result without a signer key.
 */
export async function runCctpDemo(
  input: { amountUsd?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  | { executed: false; reason: string; route: string }
  | { executed: true; amountUsd: number; route: string; state: string; steps: BridgeStep[]; reason?: string }
> {
  const route = 'Arc Testnet -> Base Sepolia'
  const key = env.ARC_SIGNER_KEY
  if (!key) {
    return {
      executed: false,
      route,
      reason: 'No ARC_SIGNER_KEY set. With a funded key this bridges native USDC Arc -> Base Sepolia via CCTP burn-and-mint (approve -> burn -> attestation -> mint).',
    }
  }
  // Leaving Arc, the amount must clear the CCTPv2 max fee - default to 1.0 USDC.
  const amountUsd = Math.max(1, input.amountUsd ?? 1)

  try {
    const { createViemAdapterFromPrivateKey } = await import('@circle-fin/adapter-viem-v2')
    const { BridgeKit } = await import('@circle-fin/bridge-kit')
    const adapter = createViemAdapterFromPrivateKey({
      privateKey: (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`,
    })
    const kit = new BridgeKit()

    const steps: BridgeStep[] = []
    kit.on('*', (payload: unknown) => {
      const v = (payload as { values?: { name?: string; state?: string; txHash?: string; explorerUrl?: string } })?.values
      if (v?.name && v.state) steps.push({ name: v.name, state: v.state, txHash: v.txHash, explorerUrl: v.explorerUrl })
    })

    const result = (await kit.bridge({
      from: { adapter, chain: 'Arc_Testnet' },
      to: { adapter, chain: 'Base_Sepolia' },
      amount: String(amountUsd),
    } as never)) as { state?: string; steps?: BridgeStep[] }

    // Prefer the returned steps (authoritative) but fall back to collected events.
    const finalSteps = Array.isArray(result.steps) && result.steps.length ? result.steps.map(normalizeStep) : steps
    return { executed: true, amountUsd, route, state: result.state ?? 'submitted', steps: finalSteps }
  } catch (e) {
    return { executed: false, route, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Normalize a Bridge Kit step object into our compact shape. */
function normalizeStep(s: unknown): BridgeStep {
  const o = s as { name?: string; state?: string; txHash?: string; data?: { txHash?: string }; explorerUrl?: string }
  return {
    name: o.name ?? 'step',
    state: o.state ?? 'unknown',
    txHash: o.txHash ?? o.data?.txHash,
    explorerUrl: o.explorerUrl,
  }
}
