/**
 * ERC-8004 ValidationRegistry reads, driven by the chain registry instead of by one chain.
 *
 * KYA (Know Your Agent) anchoring used to be Arc-only, not because the standard is, but
 * because the lookup was written as `identity.chain === 'arc'`. Two more chains carry the
 * canonical registry at the same cross-chain address now, and a hardcoded slug means their
 * attestations are unreadable while the code reports a number as if it had looked.
 *
 * ── the distinction this module exists to preserve ──────────────────────────────────
 *
 * "This chain has no ValidationRegistry" and "this agent has zero attestations" are
 * DIFFERENT FACTS, and collapsing them is the exact dishonesty the honest-status rule
 * exists to prevent: `kyaCount: 0` reads as "we checked and found nothing", which would be
 * a claim we never earned. So a chain that cannot answer returns `supported: false` with a
 * reason, and `kyaCount` is simply not present.
 *
 * It also refuses BEFORE calling the adapter. `chains/evm/adapter.ts` casts
 * `c.validationRegistry as Hex` without checking it, so a descriptor with no registry
 * would reach viem with an undefined address and come back as a generic read error, which
 * is a third thing again and the least informative of the three.
 */
import { CHAINS, createEvmAdapter, getChainById, type ChainDescriptor, type EvmAdapter } from './chains/index.js'

/** The chain carries no ValidationRegistry we can read, and we did not pretend to look. */
export type ValidationUnsupported = {
  supported: false
  chain: string
  agentId: string
  reason: string
}

/** A real read against a real registry. */
export type ValidationSupported = { supported: true; chain: string } & (
  | { agentId: string; validations: number; kyaCount: number; kyaAverage: number; registry: string; explorer: string }
  /** The registry exists and the read failed. Distinct from "no registry": retrying may work. */
  | { agentId: string; error: string }
)

export type ValidationRead = ValidationUnsupported | ValidationSupported

/**
 * Adapters are cached because a descriptor never changes at runtime and building one per
 * call would rebuild the same closure on every paid tool invocation.
 */
const ADAPTERS = new Map<string, EvmAdapter>()
function adapterFor(chain: ChainDescriptor): EvmAdapter {
  let a = ADAPTERS.get(chain.id)
  if (!a) {
    a = createEvmAdapter(chain)
    ADAPTERS.set(chain.id, a)
  }
  return a
}

/** Every chain whose descriptor declares a ValidationRegistry we could read today. */
export function validationChains(): ChainDescriptor[] {
  return CHAINS.filter((c) => c.ecosystem === 'evm' && Boolean(c.contracts.validationRegistry))
}

/** Whether an attestation on this chain is readable at all. */
export function supportsValidation(chainId: string): boolean {
  const chain = getChainById(chainId)
  return Boolean(chain && chain.ecosystem === 'evm' && chain.contracts.validationRegistry)
}

/**
 * Read one agent's KYA validation summary on a named chain.
 *
 * `chainId` is a registry slug, because that is what an identity resolve already reports.
 * An ERC-8004 token id is only meaningful on the chain that minted it: the same number
 * elsewhere is a different agent, so this never falls back to another chain when the
 * requested one cannot answer.
 */
export async function readValidationOn(
  chainId: string,
  agentId: bigint,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ValidationRead> {
  const id = agentId.toString()
  const chain = getChainById(chainId)
  if (!chain) {
    return { supported: false, chain: chainId, agentId: id, reason: `Unknown chain "${chainId}"; it is not in the chain registry.` }
  }
  if (chain.ecosystem !== 'evm') {
    return {
      supported: false,
      chain: chain.id,
      agentId: id,
      reason: `${chain.name} is a ${chain.ecosystem} chain; the ERC-8004 ValidationRegistry read is EVM-only.`,
    }
  }
  if (!chain.contracts.validationRegistry) {
    return {
      supported: false,
      chain: chain.id,
      agentId: id,
      // Says what is missing and what that does NOT mean, because the wrong reading of
      // this line is the whole reason the field exists.
      reason: `${chain.name} carries no ERC-8004 ValidationRegistry, so an attestation cannot be anchored or read there. This is not the same as the agent having zero attestations.`,
    }
  }
  const result = await adapterFor(chain).readValidation(agentId, env)
  return { supported: true, chain: chain.id, ...result }
}
