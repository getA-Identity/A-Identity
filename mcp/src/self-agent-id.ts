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
 *
 * ── where a Self Agent ID is found ────────────────────────────────────────────────
 *
 * A Self Agent ID can be reached two ways, and a lookup that knows only one misses every agent
 * that only the other reaches:
 *
 *   - By agent key. The registry keys every ID by its agent's address (agentKeyToAgentId).
 *     When that key is an address the read knows this agent by (its wallet, its owner, the
 *     address asked about), the read verifies the key itself. Self's simple registration
 *     makes the human's own wallet the key, which is how an owner is found this way.
 *   - By holder, for Self's linked mode. The ID is held by a wallet the human named when
 *     registering, and the agent key is a separate address. An ERC-8004 agent whose owner is
 *     that wallet is found through the owner: balanceOf, then ownerOf across the ids, because
 *     the registry is a soulbound ERC-721 without the enumerable extension. That verifies who
 *     holds the ID, not that this agent signs with its key, and the answer says so in words.
 *
 * For an ERC-8004 agent on a chain with a Self registry (Celo), its ERC-8004 agent wallet
 * (getAgentWallet, read when its token id is known) is one more agent-key candidate, tried after
 * every older one, and linked mode is read only when no agent key matched. So an agent found
 * before this was written is found the same way, with the same answer.
 *
 * How an answer reached its ID (HumanProofFoundBy) is told to the caller beside the answer, not
 * in it, because the answer's fields are published. counterparty_check needs it: an ID the owner
 * holds says which human is behind the agent only when the read found every ID the owner holds
 * and they all name the same one.
 */
import { createHash } from 'node:crypto'
import { CHAINS, getChainById, type ChainDescriptor } from './chains/index.js'
import { ERC8004_AGENT_WALLET_ABI, SELF_AGENT_REGISTRY_ABI } from './chains/evm/abis.js'
import { evmPublicClient } from './chains/evm/client.js'

/** The chain carries no Self Agent ID registry we could read, and we did not pretend to look. */
export type HumanProofUnsupported = { supported: false; chain: string; reason: string }

/** A real read against a real registry. */
export type HumanProofSupported = { supported: true; chain: string; registry: string; standard: string; source: 'live' } & (
  | {
      /**
       * The address the registry was asked about: an agent key (the agent address, as the
       * registry keys it), or in Self's linked mode the wallet that holds the ID. The note says
       * which one it is.
       */
      address: string
      /** Whether a Self Agent ID was found: keyed by this address, or held by it in linked mode. */
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

const isZeroAddress = (s: string) => /^0x0{40}$/i.test(s)

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

// ── the reads ─────────────────────────────────────────────────────────────────

/** One view call, in the shape viem's readContract takes it. */
export type ViewCall = { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }

/**
 * The chain reads behind an answer, replaceable so every path here runs offline against a
 * registry a test describes. `read` throws when the call reverts or the RPC fails. `readMany`
 * makes many calls in one round trip and answers null where a call reverted; it throws when
 * the batch itself could not be made, so a failed batch is never read as "nobody holds these".
 */
export type ChainReads = {
  read(call: ViewCall): Promise<unknown>
  readMany(calls: ViewCall[]): Promise<unknown[]>
}

/** The one method chainReadsOver needs of a viem public client. */
export type ReadContractClient = { readContract(args: never): Promise<unknown> }

/**
 * ChainReads over a viem public client: one view call through readContract, and a batch through
 * the chain's Multicall3 with aggregate3 called directly. viem's own multicall turns a failed RPC
 * call into a failure for every call in it, which is the same shape as a revert, and here a revert
 * means "no holder" while a failed call means "we could not look". So a call that reverted inside
 * the batch answers null, and the batch throws when the RPC failed, when the answer has the wrong
 * length or does not decode, and when the chain names no Multicall3. Production builds it in
 * liveReads; a test hands it a client whose transport the test describes.
 */
export function chainReadsOver(client: ReadContractClient, multicall: `0x${string}` | undefined, chainName: string): ChainReads {
  return {
    read: (call) => client.readContract(call as never),
    async readMany(calls) {
      if (calls.length === 0) return []
      if (!multicall) throw new Error(`${chainName} names no Multicall3 contract, so a batch read cannot be made there`)
      const { decodeFunctionResult, encodeFunctionData, multicall3Abi } = await import('viem')
      const results = (await client.readContract({
        address: multicall,
        abi: multicall3Abi,
        functionName: 'aggregate3',
        args: [calls.map((c) => ({ target: c.address, allowFailure: true, callData: encodeFunctionData(c as never) }))],
      } as never)) as readonly { success: boolean; returnData: `0x${string}` }[]
      if (results.length !== calls.length) throw new Error(`Multicall3 answered ${results.length} results for ${calls.length} calls`)
      return results.map((r, i) => (r.success ? decodeFunctionResult({ abi: calls[i].abi, functionName: calls[i].functionName, data: r.returnData } as never) : null))
    },
  }
}

/** Production's reads: the chain's RPCs through viem, as chainReadsOver makes them. */
async function liveReads(chain: ChainDescriptor, env: NodeJS.ProcessEnv): Promise<ChainReads> {
  return chainReadsOver(await evmPublicClient(chain, env), chain.contracts.multicall3 as `0x${string}` | undefined, chain.name)
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200)

const selfCall = (registry: `0x${string}`, functionName: string, args: readonly unknown[]): ViewCall => ({ address: registry, abi: SELF_AGENT_REGISTRY_ABI, functionName, args })

const baseOf = (chain: ChainDescriptor) => ({
  supported: true as const,
  chain: chain.id,
  registry: chain.contracts.selfAgentRegistry as `0x${string}`,
  standard: STANDARD,
  source: 'live' as const,
})

/** The proof fields of one Self agent id, as the registry answers them. */
type ProofFields = { humanBacked: boolean; fresh: boolean; expires: bigint; nullifier: bigint; provider: string }

/** A registered answer, from the proof fields of the id that was found and the note that says how. */
function registeredAnswer(chain: ChainDescriptor, address: string, agentId: bigint, p: ProofFields, count: bigint, note: string): HumanProofRead {
  return {
    ...baseOf(chain), address, registered: true, agentId: agentId.toString(), humanBacked: p.humanBacked, fresh: p.fresh,
    expiresAt: p.expires > 0n ? new Date(Number(p.expires) * 1000).toISOString() : null,
    provider: p.provider, agentsForSameHuman: Number(count), humanRef: p.nullifier > 0n ? humanRef(p.nullifier) : null,
    note,
  }
}

const humanBackedNote = (chain: ChainDescriptor, subject: string) =>
  `A unique human vouched for ${subject} with a passport-derived zero-knowledge proof verified by Self on ${chain.name}. Third-party registry, read live; it says a human exists, not who they are.`

const unregisteredNote = (chain: ChainDescriptor) =>
  `This address is not registered in the Self Agent ID registry on ${chain.name}. Unregistered is not the same as unverified elsewhere: the agent may simply never have gone through Self.`

/**
 * Read one agent address against the Self Agent ID registry on a named chain.
 * Never falls back to another chain: a Self agent id is only meaningful where it was minted.
 * `reads` replaces the chain for a test.
 */
export async function readHumanProofOn(chainId: string, address: string, env: NodeJS.ProcessEnv = process.env, reads?: ChainReads): Promise<HumanProofRead> {
  const chain = getChainById(chainId)
  if (!chain || !supportsHumanProof(chainId)) return unsupported(chainId)
  const registry = chain.contracts.selfAgentRegistry as `0x${string}`
  const base = baseOf(chain)
  if (!isEvmAddress(address)) return { ...base, address, error: 'not an EVM address; the registry keys agents by address' }
  try {
    const r = reads ?? (await liveReads(chain, env))
    const read = <T>(functionName: string, args: readonly unknown[] = []) => r.read(selfCall(registry, functionName, args)) as Promise<T>
    const agentId = await read<bigint>('agentKeyToAgentId', [agentKeyFor(address)])
    if (agentId === 0n) {
      return {
        ...base, address, registered: false, agentId: null, humanBacked: false, fresh: null, expiresAt: null, provider: null, agentsForSameHuman: null, humanRef: null,
        note: unregisteredNote(chain),
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
    return registeredAnswer(chain, address, agentId, { humanBacked, fresh, expires, nullifier, provider }, count,
      humanBacked ? humanBackedNote(chain, 'this agent') : `Registered in the Self Agent ID registry on ${chain.name} without an active human proof.`)
  } catch (e) {
    return { ...base, address, error: errorText(e) }
  }
}

// ── linked mode: which Self Agent IDs a wallet holds ──────────────────────────────

/** Ids one aggregate3 call reads. On Celo on 2026-11-18, 260 ownerOf reads took about 300 ms. */
const HOLDER_SCAN_CHUNK = 500
/** A cap, so a registry that never ends cannot hold a read open: 20,000 ids, past which we say we could not look. */
const HOLDER_SCAN_MAX_CHUNKS = 40

/**
 * What a scan has learned about who holds which Self agent id. A Self Agent ID is soulbound
 * (minted and burned, never transferred) and ids are minted in sequence, so "id N is held by
 * wallet W" stays true until the id is burned, and every id below `next` has been read. That
 * is what makes it safe to keep across calls: a later read starts at `next`, and an id read
 * from here is read again, with ownerOf, before any answer rests on it.
 */
type HolderIndex = { next: bigint; held: Map<string, Set<bigint>>; scanning: Promise<void> | null }
const holderIndexes = new Map<string, HolderIndex>()

/** Forget every holder scan. For tests, where each registry is a different fake on the same chain. */
export function __resetSelfHolderIndexForTests(): void {
  holderIndexes.clear()
}

/**
 * Read the ids past what the index has seen, a chunk at a time, until a chunk where nobody
 * holds any id: that is past the last id minted. Ids after the last held one may not be
 * minted yet, so `next` stops at the last held id and they are read again next time. One
 * limit, stated: a run of HOLDER_SCAN_CHUNK burned ids in a row would end a scan early.
 */
async function extendHolderIndex(index: HolderIndex, registry: `0x${string}`, reads: ChainReads): Promise<void> {
  for (let chunk = 0; chunk < HOLDER_SCAN_MAX_CHUNKS; chunk++) {
    const start = index.next
    const ids = Array.from({ length: HOLDER_SCAN_CHUNK }, (_, i) => start + BigInt(i))
    const holders = await reads.readMany(ids.map((id) => selfCall(registry, 'ownerOf', [id])))
    let last: bigint | null = null
    for (let i = 0; i < ids.length; i++) {
      const h = holders[i]
      if (typeof h !== 'string' || !isEvmAddress(h) || isZeroAddress(h)) continue
      const holder = h.toLowerCase()
      const set = index.held.get(holder) ?? new Set<bigint>()
      set.add(ids[i])
      index.held.set(holder, set)
      last = ids[i]
    }
    if (last === null) return
    if (last + 1n > index.next) index.next = last + 1n
  }
  throw new Error(`the Self registry holds more than ${HOLDER_SCAN_CHUNK * HOLDER_SCAN_MAX_CHUNKS} ids, past what one read scans`)
}

/** The ids `holder` held when the registry was last scanned, after reading what is new. */
async function idsHeldBy(chain: ChainDescriptor, holder: string, reads: ChainReads): Promise<bigint[]> {
  const registry = chain.contracts.selfAgentRegistry as `0x${string}`
  const key = `${chain.id}:${registry.toLowerCase()}`
  const index = holderIndexes.get(key) ?? { next: 1n, held: new Map(), scanning: null }
  holderIndexes.set(key, index)
  if (!index.scanning) {
    index.scanning = extendHolderIndex(index, registry, reads).finally(() => {
      index.scanning = null
    })
  }
  await index.scanning
  return [...(index.held.get(holder) ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** One Self agent id a wallet holds, with what the registry says about it. */
type HeldId = ProofFields & { id: bigint; key: string }

const PER_ID_READS = ['ownerOf', 'agentIdToAgentKey', 'hasHumanProof', 'isProofFresh', 'proofExpiresAt', 'getHumanNullifier', 'getProofProvider'] as const

/**
 * Every Self agent id `holder` holds, read again now: an id burned since the index saw it is
 * dropped, and an id whose fields do not answer fails the read rather than being skipped.
 */
async function readHeld(chain: ChainDescriptor, holder: string, ids: bigint[], reads: ChainReads): Promise<HeldId[]> {
  const registry = chain.contracts.selfAgentRegistry as `0x${string}`
  const answers = await reads.readMany(ids.flatMap((id) => PER_ID_READS.map((fn) => selfCall(registry, fn, [id]))))
  const out: HeldId[] = []
  ids.forEach((id, i) => {
    const [owner, key, humanBacked, fresh, expires, nullifier, provider] = answers.slice(i * PER_ID_READS.length, (i + 1) * PER_ID_READS.length)
    if (typeof owner !== 'string' || owner.toLowerCase() !== holder) return
    if (typeof key !== 'string' || typeof humanBacked !== 'boolean' || typeof fresh !== 'boolean' || typeof expires !== 'bigint' || typeof nullifier !== 'bigint' || typeof provider !== 'string') {
      throw new Error(`the Self registry did not answer every field of agent #${id}`)
    }
    out.push({ id, key: agentKeyText(key), humanBacked, fresh, expires, nullifier, provider })
  })
  return out
}

/** A bytes32 agent key as an address when it is one, else the key itself (an Ed25519 agent's). */
function agentKeyText(key: string): string {
  const k = key.toLowerCase()
  return /^0x0{24}[0-9a-f]{40}$/.test(k) ? `0x${k.slice(26)}` : k
}

const listOf = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** How many different humans the ids carry a proof for (each nullifier is one human). */
const humansOf = (held: HeldId[]) => new Set(held.filter((h) => h.nullifier > 0n).map((h) => h.nullifier)).size

/**
 * Of several held ids, the one to report: one whose agent key is among `known`, the addresses this
 * read knows the agent by (it is what an agent-key read that did not return it would have found),
 * then a fresh human proof, then any human proof, then the newest.
 */
function preferred(held: HeldId[], known: string[]): HeldId {
  const rank = (h: HeldId) => (known.includes(h.key) ? 4 : 0) + (h.humanBacked && h.fresh ? 2 : h.humanBacked ? 1 : 0)
  return [...held].sort((a, b) => rank(b) - rank(a) || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0))[0]
}

/**
 * What a linked-mode answer says, in words that claim no more than was read: who holds the ID,
 * and whether its agent key is one of `known`, the addresses this read knows the agent by. It
 * is not one whenever the agent-key reads answered (they would have found it), and when one of
 * them failed it may be, so it is checked rather than assumed. An ID keyed to the holder itself
 * is Self's simple registration, not linked mode, and is named as that. `balance` is what
 * balanceOf says the holder holds, so an answer that found fewer IDs says so.
 */
function linkedNote(chain: ChainDescriptor, holder: string, held: HeldId[], chosen: HeldId, known: string[], balance: bigint): string {
  const mode = "Self's linked mode, where the ID is held by a wallet the human named when registering and the agent key is a separate address"
  const simple = "Self's simple registration, where the human's own wallet is the agent key"
  const ownKey = chosen.key === holder
  const keyKnown = known.includes(chosen.key)
  const parts: string[] = []
  if (held.length === 1) {
    parts.push(
      ownKey
        ? `Self Agent ID #${chosen.id} is held by this agent's owner, ${holder}, and keyed to it: ${simple}. This read found it through the IDs the owner holds, because the agent-key read did not return it.`
        : `Self Agent ID #${chosen.id} is held by this agent's owner, ${holder}: ${mode}.`,
    )
  } else {
    const own = held.filter((h) => h.key === holder).map((h) => `#${h.id}`)
    const except = own.length > 0 ? `, except ${listOf(own)}, keyed to the owner itself (${simple})` : ''
    parts.push(`This agent's owner, ${holder}, holds ${held.length} Self Agent IDs, ${listOf(held.map((h) => `#${h.id}`))}: ${mode}${except}.`)
    const humans = humansOf(held)
    const binding =
      humans > 1
        ? keyKnown
          ? `They are bound to ${humans} different humans`
          : `They are bound to ${humans} different humans, and the registry does not say which of them, if any, is this agent's`
        : humans === 1 && held.every((h) => h.nullifier > 0n)
          ? 'They are bound to the same human'
          : 'Not all of them carry a human proof'
    const which = ownKey
      ? 'the one keyed to the owner itself, which the agent-key read did not return'
      : keyKnown
        ? 'the one whose agent key is an address this read knows this agent by'
        : chosen.humanBacked && chosen.fresh
          ? 'the newest with a fresh human proof'
          : chosen.humanBacked
            ? 'the newest with a human proof'
            : 'the newest'
    parts.push(`${binding}; this read reports #${chosen.id}, ${which}.`)
  }
  if (BigInt(held.length) < balance) {
    parts.push(`balanceOf reports ${balance} Self Agent IDs held by this owner and this read found ${held.length}, so it may not name every ID the owner holds or every human they are bound to.`)
  }
  parts.push(
    keyKnown
      ? `Its agent key, ${chosen.key}, is among the addresses this read knows this agent by, so the agent key is verified as well.`
      : `Its agent key, ${chosen.key}, is not among the addresses this read knows this agent by, so this read verified who holds the ID, not that this agent signs with that key.`,
  )
  parts.push(chosen.humanBacked ? humanBackedNote(chain, 'that ID') : 'That ID carries no active human proof.')
  return parts.join(' ')
}

/**
 * How a registered answer reached its Self Agent ID. It is not a field of the answer, whose fields
 * are published; a caller that weighs the find rather than shows it, as counterparty_check does,
 * is told it through HumanProofOptions.onFound.
 *
 *   - 'agent-key': an address this agent is known by is the ID's agent key. Every find was this
 *     one before linked mode was read.
 *   - 'agent-wallet': its ERC-8004 agent wallet is the ID's agent key.
 *   - 'holder': its owner holds the ID (Self's linked mode), the read found as many IDs as
 *     balanceOf says the owner holds, and every one of them that carries a human proof is bound
 *     to the same human. The agent key is not verified.
 *   - 'holder-ambiguous': its owner holds IDs bound to more than one human, or more IDs than the
 *     read found, so which human, if any, is this agent's is not known.
 */
export type HumanProofFoundBy = 'agent-key' | 'agent-wallet' | 'holder' | 'holder-ambiguous'

/**
 * How a linked-mode answer reached `chosen`: by key when its agent key is one of `keys` (or the
 * agent wallet, `walletKey`), else by holder, ambiguous when the held ids name more than one human
 * or fewer were found than balanceOf reports.
 */
function holderFoundBy(held: HeldId[], chosen: HeldId, keys: string[], walletKey: string | null, balance: bigint): HumanProofFoundBy {
  if (keys.includes(chosen.key)) return 'agent-key'
  if (walletKey !== null && chosen.key === walletKey) return 'agent-wallet'
  return humansOf(held) > 1 || BigInt(held.length) < balance ? 'holder-ambiguous' : 'holder'
}

/** An ERC-8004 agent on a chain with a Self registry, as Self's linked mode is read through it. */
export type LinkedIdentity = {
  /** The chain the ERC-8004 identity is on; the Self read is made there and nowhere else. */
  chain: string
  /**
   * Its ERC-8004 token id, for getAgentWallet, or null when the identity is known by its owner
   * only (a partial identity), in which case the agent wallet is not read.
   */
  tokenId: bigint | null
  /** Its ERC-8004 owner (ownerOf): the wallet that holds a Self Agent ID in linked mode. */
  owner: string
}

export type HumanProofOptions = {
  env?: NodeJS.ProcessEnv
  /**
   * Set for an ERC-8004 agent on a chain with a Self registry (Celo): its agent wallet becomes
   * one more agent-key candidate when its token id is known, and linked mode is read through its
   * owner. Absent, the lookup is the agent-key lookup it always was.
   */
  erc8004?: LinkedIdentity | null
  /**
   * Told how a registered Self Agent ID was reached (HumanProofFoundBy), once, before the answer
   * is returned; not called when none was found.
   */
  onFound?: (how: HumanProofFoundBy) => void
  /** The chain reads, for a test. Production reads the chain. */
  reads?: (chain: ChainDescriptor) => ChainReads | Promise<ChainReads>
}

/** An answer, and how it reached its Self Agent ID when it found one. */
type Lookup = { read: HumanProofRead; foundBy: HumanProofFoundBy | null }

/**
 * The lookup for an ERC-8004 agent on a chain with a Self registry, in the order the module
 * header gives: every older key candidate exactly as before, then the ERC-8004 agent wallet as a
 * key, then the Self Agent IDs its owner holds. A read that failed on the way turns "none found"
 * into "unknown", never into "unregistered".
 */
async function readHumanProofForAgent(chain: ChainDescriptor, keys: string[], linked: LinkedIdentity, env: NodeJS.ProcessEnv, readsFor?: HumanProofOptions['reads']): Promise<Lookup> {
  const base = baseOf(chain)
  const owner = linked.owner.toLowerCase()
  let reads: ChainReads
  try {
    reads = readsFor ? await readsFor(chain) : await liveReads(chain, env)
  } catch (e) {
    return { read: { ...base, address: owner, error: errorText(e) }, foundBy: null }
  }
  const failed: string[] = []
  const tried: string[] = []

  // The owner is an agent-key candidate too (Self's simple registration keys the ID by the
  // human's own wallet); the trust tools already pass it, so this only fills it in for a caller
  // that did not.
  const ordered = keys.some((k) => k.toLowerCase() === owner) ? keys : [...keys, owner]
  for (const key of ordered) {
    const r = await readHumanProofOn(chain.id, key, env, reads)
    tried.push(key.toLowerCase())
    if (r.supported && 'registered' in r && r.registered) return { read: r, foundBy: 'agent-key' }
    if (r.supported && 'error' in r) failed.push(`agent key ${key}: ${r.error}`)
  }
  const keyed = [...tried]

  // The ERC-8004 agent wallet, as one more agent key. It is read only now, so it can never take
  // the place of a key that matched above, and only with a token id: a partial identity names its
  // owner, not which token it holds.
  let walletKey: string | null = null
  const identityRegistry = chain.contracts.identityRegistry as `0x${string}` | undefined
  if (identityRegistry && linked.tokenId !== null) {
    try {
      const w = await reads.read({ address: identityRegistry, abi: ERC8004_AGENT_WALLET_ABI, functionName: 'getAgentWallet', args: [linked.tokenId] })
      const wallet = typeof w === 'string' && isEvmAddress(w) && !isZeroAddress(w) ? w.toLowerCase() : null
      if (wallet && !tried.includes(wallet)) {
        walletKey = wallet
        tried.push(wallet)
        const r = await readHumanProofOn(chain.id, wallet, env, reads)
        if (r.supported && 'registered' in r && r.registered) {
          return {
            read: { ...r, note: `Found through this agent's ERC-8004 agent wallet, ${wallet}, which is the agent key of Self Agent ID #${r.agentId}. ${r.note}` },
            foundBy: 'agent-wallet',
          }
        }
        if (r.supported && 'error' in r) failed.push(`agent wallet ${wallet}: ${r.error}`)
      }
    } catch (e) {
      failed.push(`the ERC-8004 agent wallet: ${errorText(e)}`)
    }
  }

  // Linked mode: the Self Agent IDs the owner holds.
  const registry = chain.contracts.selfAgentRegistry as `0x${string}`
  try {
    const n = await reads.read(selfCall(registry, 'balanceOf', [owner]))
    if (typeof n !== 'bigint') throw new Error('balanceOf did not answer a number')
    if (n > 0n) {
      const ids = await idsHeldBy(chain, owner, reads)
      const held = ids.length > 0 ? await readHeld(chain, owner, ids, reads) : []
      if (held.length > 0) {
        const chosen = preferred(held, tried)
        const count = chosen.nullifier > 0n ? ((await reads.read(selfCall(registry, 'getAgentCountForHuman', [chosen.nullifier]))) as bigint) : 0n
        return {
          read: registeredAnswer(chain, owner, chosen.id, chosen, count, linkedNote(chain, owner, held, chosen, tried, n)),
          foundBy: holderFoundBy(held, chosen, keyed, walletKey, n),
        }
      }
      failed.push(`this agent's owner holds ${n} Self Agent ID${n === 1n ? '' : 's'} by balanceOf, and a scan of the registry did not find which`)
    }
  } catch (e) {
    failed.push(`the Self Agent IDs this agent's owner holds (linked mode): ${errorText(e)}`)
  }

  if (failed.length > 0) {
    return {
      read: { ...base, address: owner, error: `No Self Agent ID was found for this agent on ${chain.name}, but not every read answered, so this is unknown, not unregistered: ${failed.join('; ')}`.slice(0, 600) },
      foundBy: null,
    }
  }
  return {
    read: {
      ...base, address: owner, registered: false, agentId: null, humanBacked: false, fresh: null, expiresAt: null, provider: null, agentsForSameHuman: null, humanRef: null,
      note:
        `No Self Agent ID was found for this agent on ${chain.name}. In agent-key mode the registry keys an ID by the agent's own address, and none of the addresses this read knows this agent by (${listOf(tried)}) is one; in linked mode a wallet holds the ID, and this agent's owner holds none. ` +
        'Unregistered is not the same as unverified elsewhere: the agent may simply never have gone through Self.',
    },
    foundBy: null,
  }
}

/**
 * Try several candidate addresses (wallet, owner, the raw query) on the chains that can
 * answer, and return the first registered hit; else the most informative miss. When the
 * anchor chain cannot answer, every chain with a registry is tried, mainnets first,
 * because a Self agent id lives where Self minted it, not where our identity does.
 *
 * With `opts.erc8004` naming an ERC-8004 agent on the anchor chain, and that chain carrying a
 * Self registry, the lookup also reads Self's linked mode (readHumanProofForAgent). Without it,
 * or anywhere else, this is the agent-key lookup it always was. A registered answer is also
 * told to `opts.onFound`, with how it was reached.
 */
export async function readHumanProofFor(anchorChain: string, candidates: string[], opts: HumanProofOptions = {}): Promise<HumanProofRead> {
  const { read, foundBy } = await lookupHumanProof(anchorChain, candidates, opts)
  if (foundBy) opts.onFound?.(foundBy)
  return read
}

async function lookupHumanProof(anchorChain: string, candidates: string[], opts: HumanProofOptions): Promise<Lookup> {
  const env = opts.env ?? process.env
  const linked = opts.erc8004
  if (linked && linked.chain === anchorChain && supportsHumanProof(linked.chain) && isEvmAddress(linked.owner)) {
    return readHumanProofForAgent(getChainById(linked.chain)!, candidates.filter(isEvmAddress), linked, env, opts.reads)
  }
  const chains = supportsHumanProof(anchorChain)
    ? [getChainById(anchorChain)!]
    : [...humanProofChains()].sort((a, b) => Number(a.testnet) - Number(b.testnet))
  if (chains.length === 0) return { read: unsupported(anchorChain), foundBy: null }
  const addresses = candidates.filter(isEvmAddress)
  if (addresses.length === 0) {
    return { read: { supported: false, chain: anchorChain, reason: 'No EVM address is known for this agent, and the Self Agent ID registry keys agents by address.' }, foundBy: null }
  }
  let last: HumanProofRead | null = null
  for (const chain of chains) {
    const reads = opts.reads ? await opts.reads(chain) : undefined
    for (const address of addresses) {
      const r = await readHumanProofOn(chain.id, address, env, reads)
      if (r.supported && 'registered' in r && r.registered) return { read: r, foundBy: 'agent-key' }
      if (!last || (r.supported && 'registered' in r)) last = r
    }
  }
  return { read: last ?? unsupported(anchorChain), foundBy: null }
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
