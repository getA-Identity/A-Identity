/**
 * Turn an ERC-8004 explorer AGENT PAGE into the manifest URL the token actually points at.
 *
 * Quick register asks for a raw JSON manifest URL, and people paste the explorer link
 * instead, because that is where they can see the agent. The hint in guardrail-routes.ts
 * was right about what went wrong ("that is an explorer page, paste the tokenURI") but it
 * left the caller to do a job we can do ourselves: the value they were asked for is a
 * chain read we are already wired for.
 *
 * Two halves on purpose:
 *  - `parseExplorerAgentUrl` is PURE: URL text in, {chain, tokenId} out, no network. It
 *    is what the tests exercise, and it returns null for anything it does not recognise
 *    so the caller keeps its existing hint behaviour rather than guessing.
 *  - `resolveAgentManifestUrl` does the live read (tokenURI + ownerOf) through an
 *    injectable reader, so the resolution path unit-tests without an RPC.
 *
 * Nothing here is a fallback: a chain that will not answer produces a labeled error
 * naming the chain, the token and the reason, never a fabricated URL.
 */
import type { ChainDescriptor } from './types.js'
import { getChainById } from './registry.js'
import { evmPublicClient } from './evm/client.js'

/** ERC-8004 extends ERC-721, so these two reads are the whole identity surface. */
const IDENTITY_ABI = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
] as const

/**
 * Explorer hosts whose agent page URL carries the chain and the token id in the path.
 *
 * Deliberately a table rather than one hardcoded host: 8004scan is the one people paste
 * today, and the next explorer with the same shape is a row, not a branch. The chain
 * segment is matched against the REGISTRY (see below), so no chain slug is restated here.
 */
const AGENT_PAGE_PATTERNS: { host: RegExp; path: RegExp; label: string }[] = [
  {
    host: /(^|\.)8004scan\.io$/i,
    // /agents/<chain>/<tokenId>, with an optional trailing slash and any query string.
    path: /^\/agents\/([a-z0-9-]{1,32})\/(\d{1,78})\/?$/i,
    label: '8004scan',
  },
]

/** What a recognised explorer agent page resolves to BEFORE any network call. */
export interface ExplorerAgentLink {
  chain: ChainDescriptor
  tokenId: bigint
  /** The chain's ERC-8004 IdentityRegistry, from the registry. Never typed by hand. */
  registry: string
  /** Which explorer the URL came from, for the message the caller shows. */
  explorer: string
}

/**
 * PURE. Recognise an explorer agent page and say which chain and token it names.
 *
 * Returns null (never throws) when the URL is unparseable, is not one of the known
 * explorer hosts, does not have the agent-page shape, names a chain the registry does not
 * carry, or names a chain with no identity registry to read. Every one of those is a case
 * where the old hint is still the right answer, so the caller falls back to it.
 */
export function parseExplorerAgentUrl(raw: string): ExplorerAgentLink | null {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

  const host = u.hostname.toLowerCase()
  const pattern = AGENT_PAGE_PATTERNS.find((p) => p.host.test(host))
  if (!pattern) return null

  const m = pattern.path.exec(u.pathname)
  if (!m) return null

  // The chain segment is resolved through the registry, which is the only place that
  // knows what chains exist. An explorer slug we do not carry is not an error worth a
  // special message: it is simply not resolvable, so the hint stands.
  const chain = getChainById(m[1].toLowerCase())
  if (!chain || chain.ecosystem !== 'evm') return null
  const registry = chain.contracts.identityRegistry
  if (!registry) return null

  let tokenId: bigint
  try { tokenId = BigInt(m[2]) } catch { return null }

  return { chain, tokenId, registry, explorer: pattern.label }
}

/** Injectable chain read, same convention as the Celo identity path: the default is a
 *  live viem public client for the chain's own RPC list. */
export type AgentTokenReader = (fn: 'ownerOf' | 'tokenURI', tokenId: bigint) => Promise<unknown>

export type ResolveAgentDeps = { readContract?: AgentTokenReader; timeoutMs?: number }

/** What the live read produced. `tokenURI` is the string the CHAIN holds, unvalidated:
 *  whether it is fetchable JSON is the caller's next question, not this module's claim. */
export interface ResolvedAgentManifest {
  source: 'explorer-url'
  /** Every field below came from a live read, not from a cache or a constant. */
  live: true
  explorer: string
  chainId: string
  chainName: string
  registry: string
  tokenId: string
  tokenURI: string
  /** null when ownerOf did not answer; the URI read is the one that must succeed. */
  onchainOwner: string | null
  note: string
}

/** Cap on the read so a slow RPC produces a labeled timeout rather than a hung request. */
const READ_TIMEOUT_MS = 6000

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the RPC did not answer within ${ms}ms`)), ms)
    const clear = () => clearTimeout(timer)
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as unknown as { unref: () => void }).unref()
    p.then((v) => { clear(); resolve(v) }, (e) => { clear(); reject(e) })
  })
}

/**
 * Read `tokenURI(tokenId)` (and, best effort, `ownerOf`) off the link's chain.
 *
 * The URI read is the hard fact: without it there is nothing to register from, so a
 * failure returns a labeled error naming the chain, the token and what the chain said.
 * `ownerOf` is the softer one - it only powers the ownership warning, so a chain that
 * answers one call and not the other still resolves, with the warning saying so.
 */
export async function resolveAgentManifestUrl(
  link: ExplorerAgentLink,
  deps: ResolveAgentDeps = {},
): Promise<ResolvedAgentManifest | { error: string }> {
  const { chain, tokenId, registry } = link
  const timeoutMs = deps.timeoutMs ?? READ_TIMEOUT_MS
  const where = `${chain.name} identity registry ${registry}`

  let read: AgentTokenReader
  try {
    read = deps.readContract ?? (await (async () => {
      const client = await evmPublicClient(chain)
      return (fn: 'ownerOf' | 'tokenURI', id: bigint) =>
        client.readContract({ address: registry as `0x${string}`, abi: IDENTITY_ABI, functionName: fn, args: [id] })
    })())
  } catch (e) {
    return { error: `could not open an RPC connection to ${chain.name} (${msg(e)}), so tokenURI(${tokenId}) was not read` }
  }

  let tokenURI: string
  try {
    tokenURI = (await raceTimeout(read('tokenURI', tokenId), timeoutMs)) as string
  } catch (e) {
    const raw = msg(e)
    // An id nobody minted is the common case and reverts rather than erroring, so it gets
    // its own sentence: "retry" is the wrong advice for a token that does not exist.
    return {
      error: /revert/i.test(raw)
        ? `no agent #${tokenId} in the ${where} (tokenURI reverted), so there is nothing to read a manifest URL from`
        : `the live read of tokenURI(${tokenId}) on the ${where} did not come back (${raw}). Nothing was registered; retry, or paste the manifest JSON URL directly`,
    }
  }
  if (typeof tokenURI !== 'string' || !tokenURI.trim()) {
    return { error: `agent #${tokenId} exists on the ${where} but its tokenURI is empty on chain, so it points at no manifest` }
  }

  let onchainOwner: string | null = null
  try {
    const owner = await raceTimeout(read('ownerOf', tokenId), timeoutMs)
    if (typeof owner === 'string') onchainOwner = owner
  } catch {
    /* the manifest URL is the fact that matters; the ownership check degrades to unknown */
  }

  return {
    source: 'explorer-url',
    live: true,
    explorer: link.explorer,
    chainId: chain.id,
    chainName: chain.name,
    registry,
    tokenId: tokenId.toString(),
    tokenURI: tokenURI.trim(),
    onchainOwner,
    note: `you pasted a ${link.explorer} agent page, so tokenURI(${tokenId}) was read live from the ${where} and that URL was used as the manifest source`,
  }
}

/**
 * What registering off someone else's token does and does not mean.
 *
 * PURE, and separated out because it is the honest-status rule in one function: quick
 * register creates OUR record with the CALLER as owner, which is not a claim on the
 * on-chain token and must never be allowed to read like one. `claimsOnchainToken` is a
 * literal false rather than a computed value for exactly that reason.
 */
export interface OwnershipNote {
  claimsOnchainToken: false
  onchainOwner: string | null
  callerAccount: string | null
  /** null when there was nothing to compare (no owner read, or a non-wallet session). */
  matchesCaller: boolean | null
  /** null only when the caller's own address IS the on-chain owner. */
  warning: string | null
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function describeOwnership(
  onchainOwner: string | null,
  callerId: string | undefined,
  tokenId: string,
  chainName: string,
): OwnershipNote {
  const caller = callerId && EVM_ADDRESS.test(callerId.trim()) ? callerId.trim() : null
  const base = { claimsOnchainToken: false as const, onchainOwner, callerAccount: caller }

  if (!onchainOwner) {
    return {
      ...base,
      matchesCaller: null,
      warning: `ownerOf(${tokenId}) did not answer, so this registration was not checked against the on-chain owner. It is our own record either way and claims no token on ${chainName}`,
    }
  }
  if (caller && caller.toLowerCase() === onchainOwner.toLowerCase()) {
    return { ...base, matchesCaller: true, warning: null }
  }
  if (!caller) {
    return {
      ...base,
      matchesCaller: null,
      warning: `agent #${tokenId} on ${chainName} is owned on chain by ${onchainOwner}. This session is not a wallet session, so nothing was matched against that address: the registration is our own record and does not claim or transfer that token`,
    }
  }
  return {
    ...base,
    matchesCaller: false,
    warning: `agent #${tokenId} on ${chainName} is owned on chain by ${onchainOwner}, which is not ${caller}. Registering here creates YOUR record of that agent on this platform; it does not claim, transfer, or prove ownership of the on-chain token`,
  }
}

function msg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  // viem errors are multi-paragraph; the first line is the part a caller can act on.
  return raw.split('\n')[0].trim().slice(0, 200) || 'unknown error'
}
