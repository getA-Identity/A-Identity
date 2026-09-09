/**
 * Self Agent ID reads: "is there a verified human behind this agent, and is it the same
 * human behind that other agent?"
 *
 * Self Protocol's Agent ID registry is a third-party ERC-8004 identity registry with the
 * proof-of-human extension (IERC8004ProofOfHuman). A human scans a passport in the Self
 * app, a zero-knowledge proof is verified through Self's hub on Celo, and the registry
 * mints a soulbound agent NFT bound to a scoped, opaque nullifier for that human. Nothing
 * about the person is on-chain; the nullifier is, and it is what lets two agents be
 * compared without knowing who either belongs to.
 *
 * What this module adds to KYA is one question KYA could not answer before: KYA proves an
 * agent controls its wallet, this proves a unique human vouched for the agent, and
 * `sameHuman` says whether the payer and payee of a deal are that same human, which is a
 * self-dealing signal the operator heuristics in the trust tools cannot see.
 *
 * ── the distinctions this module preserves ────────────────────────────────────────
 *
 * "This chain carries no Self registry", "this address is not registered there", and
 * "the read failed" are three different facts and are returned as three different shapes,
 * for the same reason validation-registry.ts does it: a caller must not read any of them
 * as "we checked and the agent is not human-backed".
 *
 * The registry is an upgradeable proxy owned by Self, so every read is labeled live and
 * third-party. The raw nullifier never leaves this module: `humanRef` is a one-way hash
 * of it, stable enough to compare two agents and useless for looking a person up.
 * Read-only by construction: there is no write path here and there will not be one.
 */
import { createHash } from 'node:crypto'
import { CHAINS, getChainById, type ChainDescriptor } from './chains/index.js'
import { SELF_AGENT_REGISTRY_ABI } from './chains/evm/abis.js'
import { evmPublicClient } from './chains/evm/client.js'

/** The chain carries no Self Agent ID registry we could read, and we did not pretend to look. */
export type HumanProofUnsupported = { supported: false; chain: string; reason: string }

/** A real read against a real registry. */
export type HumanProofSupported = { supported: true; chain: string; registry: string; standard: string; source: 'live' } & (
  | {
      /** The agent key that was looked up (the agent address, as the registry keys it). */
      address: string
      /** Whether the registry knows this key at all. */
      registered: boolean
      /** The Self agent id (its token id in that registry), or null when unregistered. */
      agentId: string | null
      /** A human proof exists for this agent (ignores expiry). */
      humanBacked: boolean
      /** The proof is inside its validity window (maxProofAge), or null when unregistered. */
      fresh: boolean | null
      /** ISO timestamp after which the human must re-prove, or null when none / unregistered. */
      expiresAt: string | null
      /** The proof provider contract that verified the human, or null when unregistered. */
      provider: string | null
      /** How many active agents the same human has registered, or null when unregistered. */
      agentsForSameHuman: number | null
      /** One-way hash of the human's scoped nullifier: comparable, not reversible. */
      humanRef: string | null
      note: string
    }
  /** The registry exists and the read failed. Distinct from "unregistered": retrying may work. */
  | { address: string; error: string }
)

export type HumanProofRead = HumanProofUnsupported | HumanProofSupported

const STANDARD = 'ERC-8004 proof-of-human extension (Self Agent ID)'

/** Every chain whose descriptor names a Self Agent ID registry we could read today. */
export function humanProofChains(): ChainDescriptor[] {
  return CHAINS.filter((c) => c.ecosystem === 'evm' && Boolean(c.contracts.selfAgentRegistry))
}

/** Whether a proof-of-human read is possible on this chain at all. */
export function supportsHumanProof(chainId: string): boolean {
  const chain = getChainById(chainId)
  return Boolean(chain && chain.ecosystem === 'evm' && chain.contracts.selfAgentRegistry)
}

export const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)

/**
 * The registry keys agents by `bytes32 agentKey`, the agent address left-padded with
 * zeros (what the Self SDKs expose as `agent.agentKey`). Pure, so it is unit-testable.
 */
export function agentKeyFor(address: string): `0x${string}` {
  if (!isEvmAddress(address)) throw new Error(`not an EVM address: ${address}`)
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`
}

/**
 * A comparable, non-reversible handle for a human nullifier. The nullifier itself is
 * public on-chain, but this codebase still refuses to carry it around: what a trust tool
 * needs is "same human or not", and a hash answers that without becoming a lookup key.
 */
export function humanRef(nullifier: bigint): string {
  const hex = nullifier.toString(16).padStart(64, '0')
  return `self:${createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 16)}`
}

function unsupported(chainId: string): HumanProofUnsupported {
  const chain = getChainById(chainId)
  if (!chain) return { supported: false, chain: chainId, reason: `Unknown chain "${chainId}"; it is not in the chain registry.` }
  if (chain.ecosystem !== 'evm') {
    return { supported: false, chain: chain.id, reason: `${chain.name} is a ${chain.ecosystem} chain; Self Agent ID is an EVM registry and runs on Celo.` }
  }
  return { supported: false, chain: chain.id, reason: `${chain.name} carries no Self Agent ID registry; proof-of-human is readable on ${humanProofChains().map((c) => c.name).join(', ') || 'no chain'} today.` }
}

/**
 * Read one agent address against the Self Agent ID registry on a named chain.
 * Never falls back to another chain: a Self agent id is only meaningful where it was minted.
 */
export async function readHumanProofOn(chainId: string, address: string, env: NodeJS.ProcessEnv = process.env): Promise<HumanProofRead> {
  const chain = getChainById(chainId)
  if (!chain || !supportsHumanProof(chainId)) return unsupported(chainId)
  const registry = chain.contracts.selfAgentRegistry as `0x${string}`
  const base = { supported: true as const, chain: chain.id, registry, standard: STANDARD, source: 'live' as const }
  if (!isEvmAddress(address)) return { ...base, address, error: 'not an EVM address; the registry keys agents by address' }
  try {
    const client = await evmPublicClient(chain, env)
    const read = <T>(functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address: registry, abi: SELF_AGENT_REGISTRY_ABI, functionName: functionName as never, args: args as never }) as Promise<T>
    const agentId = await read<bigint>('agentKeyToAgentId', [agentKeyFor(address)])
    if (agentId === 0n) {
      return {
        ...base, address, registered: false, agentId: null, humanBacked: false, fresh: null, expiresAt: null, provider: null, agentsForSameHuman: null, humanRef: null,
        note: `This address is not registered in the Self Agent ID registry on ${chain.name}. Unregistered is not the same as unverified elsewhere: the agent may simply never have gone through Self.`,
      }
    }
    const [humanBacked, fresh, expires, nullifier, provider] = await Promise.all([
      read<boolean>('hasHumanProof', [agentId]),
      read<boolean>('isProofFresh', [agentId]),
      read<bigint>('proofExpiresAt', [agentId]),
      read<bigint>('getHumanNullifier', [agentId]),
      read<string>('getProofProvider', [agentId]),
    ])
    const count = nullifier > 0n ? await read<bigint>('getAgentCountForHuman', [nullifier]) : 0n
    return {
      ...base, address, registered: true, agentId: agentId.toString(), humanBacked, fresh,
      expiresAt: expires > 0n ? new Date(Number(expires) * 1000).toISOString() : null,
      provider, agentsForSameHuman: Number(count), humanRef: nullifier > 0n ? humanRef(nullifier) : null,
      note: humanBacked
        ? `A unique human vouched for this agent with a passport-derived zero-knowledge proof verified by Self on ${chain.name}. Third-party registry, read live; it says a human exists, not who they are.`
        : `Registered in the Self Agent ID registry on ${chain.name} without an active human proof.`,
    }
  } catch (e) {
    return { ...base, address, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }
  }
}

/**
 * Try several candidate addresses (wallet, owner, the raw query) on the chains that can
 * answer, and return the first registered hit; else the most informative miss. When the
 * anchor chain cannot answer, every chain with a registry is tried, mainnets first,
 * because a Self agent id lives where Self minted it, not where our identity does.
 */
export async function readHumanProofFor(anchorChain: string, candidates: string[], env: NodeJS.ProcessEnv = process.env): Promise<HumanProofRead> {
  const chains = supportsHumanProof(anchorChain)
    ? [getChainById(anchorChain)!]
    : [...humanProofChains()].sort((a, b) => Number(a.testnet) - Number(b.testnet))
  if (chains.length === 0) return unsupported(anchorChain)
  const addresses = candidates.filter(isEvmAddress)
  if (addresses.length === 0) {
    return { supported: false, chain: anchorChain, reason: 'No EVM address is known for this agent, and the Self Agent ID registry keys agents by address.' }
  }
  let last: HumanProofRead | null = null
  for (const chain of chains) {
    for (const address of addresses) {
      const r = await readHumanProofOn(chain.id, address, env)
      if (r.supported && 'registered' in r && r.registered) return r
      if (!last || (r.supported && 'registered' in r)) last = r
    }
  }
  return last ?? unsupported(anchorChain)
}

/**
 * Whether two Self agent ids on the same chain are bound to the same human nullifier.
 * null when the chain cannot answer or the read failed; never a guessed false.
 */
export async function sameHumanOn(chainId: string, agentIdA: bigint, agentIdB: bigint, env: NodeJS.ProcessEnv = process.env): Promise<boolean | null> {
  const chain = getChainById(chainId)
  if (!chain || !supportsHumanProof(chainId)) return null
  try {
    const client = await evmPublicClient(chain, env)
    return (await client.readContract({
      address: chain.contracts.selfAgentRegistry as `0x${string}`,
      abi: SELF_AGENT_REGISTRY_ABI,
      functionName: 'sameHuman',
      args: [agentIdA, agentIdB],
    })) as boolean
  } catch {
    return null
  }
}
