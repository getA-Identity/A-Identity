/**
 * ERC-8004 identity resolution - REAL on-chain reads via viem, no mocks.
 *
 * The chains it dials are exactly `identityChains()` from the registry: every EVM
 * descriptor carrying a known `contracts.identityRegistry`. Resolving an agent id or
 * token id does a live `ownerOf` + `tokenURI` read. Read-only: no keys, no funds,
 * no writes.
 */
import type { AgentIdentity } from './data.js'
import { getChainById, identityChains, resolveRpcUrls, type ChainDescriptor } from './chains/index.js'
import {
  parseStellar8004Id,
  readStellar8004Agent,
  type Stellar8004Read,
} from './chains/stellar/stellar8004.js'

/**
 * What `resolve` answers with.
 *
 * `AgentIdentity` plus three fields that appear ONLY on a third-party registry read, so a
 * caller that does nothing new keeps getting exactly what it got, and a caller that shows
 * the answer to somebody cannot present Trion's Soroban registry as an ERC-8004 result.
 * The extras are not decoration: an agent id there is a u32 in its own space, it proves no
 * link to any EVM identity, and the registry is upgradeable by its owner.
 */
export type ResolvedIdentity = AgentIdentity & {
  /** Present and true only when the registry read is somebody else's, never ours. */
  thirdParty?: true
  /** The caveat in one sentence, so it cannot be rendered as a field name. */
  note?: string
  /** The full third-party read, with the registry state that produced it. */
  stellar8004?: Stellar8004Read
}

export interface IdentityProvider {
  resolve(query: string): Promise<ResolvedIdentity | null>
  readonly kind: 'rpc'
  /** The chain slugs this provider actually dials, so coverage can be asserted rather
   *  than assumed (a silently empty client list would just resolve nothing). */
  readonly chains: readonly string[]
}

// ── Minimal ERC-721 ABI for on-chain reads ────────────────────────────────────
// ERC-8004 extends ERC-721: ownerOf + tokenURI are sufficient for identity reads.
const ERC721_ABI = [
  {
    name: 'ownerOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'tokenURI',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

type ChainClient = {
  chainId: number
  chainName: string
  rpcUrl: string
  registry: `0x${string}`
  caipPrefix: string
}

/**
 * Real on-chain ERC-8004 reads using viem.
 * Multi-chain: one client per chain, routed by CAIP-10 prefix or token id.
 */
export class RpcIdentityProvider implements IdentityProvider {
  readonly kind = 'rpc' as const
  private clients: ChainClient[]

  constructor(clients: ChainClient[]) {
    this.clients = clients
  }

  get chains(): readonly string[] {
    return this.clients.map((c) => c.chainName)
  }

  async resolve(query: string): Promise<ResolvedIdentity | null> {
    const q = query.trim()

    // A Stellar 8004 id is answered FIRST and by a different registry, because it is not an
    // ERC-8004 id and nothing below could read it: the shapes are disjoint (they carry a
    // C... Soroban contract id or the stellar8004: prefix, never eip155), so no EVM query
    // reaches this branch and every EVM path below is unchanged.
    const stellar = parseStellar8004Id(q)
    if (stellar.kind === 'refused') {
      // A Stellar 8004 id naming a registry our descriptors do not declare. Falling through
      // to the EVM clients would read a u32 as an ERC-8004 token id on eight chains and
      // hand back whichever stranger owns that number.
      return null
    }
    if (stellar.kind === 'stellar8004') {
      const chain = getChainById(stellar.chain)
      if (!chain) return null
      const read = await this._readStellar8004(chain, stellar.agentId)
      // A registry we could not read and an agent the registry does not have both resolve to
      // null here, which is the same thing every EVM path already does with a failed read.
      // The difference between them is preserved where it can be acted on: call
      // readStellar8004Agent directly and the archived and unreachable arms are distinct.
      if (!read.readable || !read.found) return null
      const domain = read.agent.registration?.domain
      return {
        agentId: read.label,
        tokenId: read.agent.id,
        owner: read.agent.owner ?? '',
        registrationUri: read.agent.agentUri ?? '',
        domain: typeof domain === 'string' ? domain : '',
        // Never self-attestable, for the same reason the EVM path pins it false: the
        // registration document is hosted by whoever registered the agent.
        valid: false,
        // Not dated. The EVM path defaults this to today when metadata is missing; a
        // registration date we did not read is not a date, and this registry does not
        // expose one.
        registeredAt: '',
        chain: chain.id as AgentIdentity['chain'],
        thirdParty: true,
        note: read.note,
        stellar8004: read,
      }
    }

    // Lazy import viem so the mock path never loads it.
    const { createPublicClient, http, isAddress } = await import('viem')

    // Detect CAIP-10 format: eip155:chainId:8004/tokenId
    const caipMatch = q.match(/^eip155:(\d+):8004\/(\d+)$/i)
    if (caipMatch) {
      const chainId = Number(caipMatch[1])
      const tokenId = BigInt(caipMatch[2])
      const client = this.clients.find((c) => c.chainId === chainId)
      if (!client) return null
      return this._readToken(createPublicClient, http, client, tokenId)
    }

    // Token id: "#3" or "3"
    const tokenMatch = q.match(/^#?(\d+)$/)
    if (tokenMatch) {
      const tokenId = BigInt(tokenMatch[1])
      // A bare token id is CHAIN-AMBIGUOUS: token #6271 on Arc and token #6271 on X Layer are
      // unrelated agents. This used to stop at the first chain in registry order, which meant
      // typing our own OKX agent number returned an unrelated Arc token's owner, presented as
      // the answer. Probe every chain and DISCLOSE a collision instead of silently picking one.
      const probed = await Promise.all(
        this.clients.map(async (client) => ({
          client,
          hit: await this._readToken(createPublicClient, http, client, tokenId),
        })),
      )
      const matches = probed.filter((p) => p.hit)
      if (!matches.length) return null
      const primary = matches[0].hit as AgentIdentity
      if (matches.length === 1) return primary
      return {
        ...primary,
        ambiguity: {
          note:
            `Token id ${tokenMatch[1]} exists on ${matches.length} chains, so this number alone does not identify one agent. ` +
            'Use the full id to be certain.',
          matches: matches.map((m) => ({
            chain: m.client.chainName,
            caip: `${m.client.caipPrefix}:8004/${tokenMatch[1]}`,
            owner: String(m.hit?.owner ?? ''),
          })),
        },
      }
    }

    // Owner address: resolve first token owned
    if (isAddress(q)) {
      for (const client of this.clients) {
        const result = await this._readByOwner(createPublicClient, http, client, q)
        if (result) return result
      }
      return null
    }

    // Domain lookups aren't resolvable on-chain in ERC-8004 v0.1 (no reverse index),
    // so we don't fabricate one - resolve by agent id, token id, or owner address.
    return null
  }

  /**
   * The third-party read, as its own method so a test can replace it without a network.
   * Same seam `_readToken` uses, for the same reason.
   */
  private async _readStellar8004(chain: ChainDescriptor, agentId: number): Promise<Stellar8004Read> {
    return readStellar8004Agent(chain, agentId)
  }

  private async _readToken(
    createPublicClient: typeof import('viem').createPublicClient,
    httpTransport: typeof import('viem').http,
    chain: ChainClient,
    tokenId: bigint,
  ): Promise<AgentIdentity | null> {
    try {
      const client = createPublicClient({ transport: httpTransport(chain.rpcUrl) })
      // ownerOf is the identity's existence proof (reverts if the token doesn't exist).
      // tokenURI is best-effort metadata: some ERC-8004 tokens revert / return nothing for
      // it, and that must NOT make an existing agent unresolvable (this is what hid the
      // Meridian #849980 showcase from /api/agent).
      const owner = (await client.readContract({
        address: chain.registry,
        abi: ERC721_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      })) as `0x${string}`
      let tokenUri = ''
      try {
        tokenUri = (await client.readContract({
          address: chain.registry,
          abi: ERC721_ABI,
          functionName: 'tokenURI',
          args: [tokenId],
        })) as string
      } catch {
        /* tokenURI unavailable - resolve from on-chain ownership alone */
      }

      // Fetch registration JSON from tokenURI (display metadata only).
      let domain = ''
      let registeredAt = new Date().toISOString().slice(0, 10)
      // `valid` is NOT self-attestable: the tokenURI JSON is hosted by the agent itself,
      // so reading `valid` from it lets any agent mark itself verified (and an unreachable
      // URI would default it to `true`). Authoritative verification comes from the on-chain
      // ERC-8004 ValidationRegistry (readValidation), surfaced separately by callers.
      const valid = false
      if (isSafePublicHttpUrl(tokenUri)) {
        try {
          // redirect:'error' so a public URL can't 30x us into an internal target.
          const reg = await fetch(tokenUri, { signal: AbortSignal.timeout(4000), redirect: 'error' })
          if (reg.ok) {
            const data = (await reg.json()) as Partial<AgentIdentity>
            domain = data.domain ?? ''
            registeredAt = data.registeredAt ?? registeredAt
          }
        } catch {
          // tokenURI not reachable - use on-chain data only
        }
      }

      return {
        agentId: `${chain.caipPrefix}:8004/${tokenId}`,
        tokenId: Number(tokenId),
        owner,
        registrationUri: tokenUri,
        domain,
        valid,
        registeredAt,
        chain: chain.chainName as AgentIdentity['chain'],
      }
    } catch {
      return null
    }
  }

  private async _readByOwner(
    createPublicClient: typeof import('viem').createPublicClient,
    httpTransport: typeof import('viem').http,
    chain: ChainClient,
    address: `0x${string}`,
  ): Promise<AgentIdentity | null> {
    try {
      const client = createPublicClient({ transport: httpTransport(chain.rpcUrl) })
      const balance = await client.readContract({
        address: chain.registry,
        abi: ERC721_ABI,
        functionName: 'balanceOf',
        args: [address],
      }) as bigint
      if (balance === 0n) return null
      // The registry isn't enumerable on Arc (totalSupply reverts), and token ids are large
      // (e.g. #849980), so a 1..N scan can't find them. Instead read the Transfer(to=address)
      // logs - `to` is indexed, so this is a cheap filter - and return the newest token this
      // address still owns (it may have transferred some out since).
      let logs: Array<{ args?: unknown }> = []
      try {
        logs = await client.getLogs({
          address: chain.registry,
          event: {
            type: 'event',
            name: 'Transfer',
            inputs: [
              { name: 'from', type: 'address', indexed: true },
              { name: 'to', type: 'address', indexed: true },
              { name: 'tokenId', type: 'uint256', indexed: true },
            ],
          },
          args: { to: address },
          fromBlock: 0n,
          toBlock: 'latest',
        })
      } catch {
        // Some public RPCs (X Layer caps getLogs at 100 blocks) can't enumerate the
        // owner's tokens. balanceOf > 0 is still a REAL on-chain proof that this address
        // holds an identity in the registry - return a partial identity rather than
        // pretending the agent doesn't exist. Callers surface "resolve by token id for
        // the full record".
        return {
          agentId: `${chain.caipPrefix}:8004/owned-by-${address.toLowerCase()}`,
          tokenId: 0,
          owner: address,
          registrationUri: '',
          domain: '',
          valid: false,
          registeredAt: '',
          chain: chain.chainName as AgentIdentity['chain'],
          partial: true,
        }
      }
      const tokenIds = [...new Set(logs.map((l) => (l.args as { tokenId?: bigint }).tokenId).filter((t): t is bigint => t !== undefined))].reverse()
      for (const tokenId of tokenIds) {
        try {
          const owner = await client.readContract({
            address: chain.registry,
            abi: ERC721_ABI,
            functionName: 'ownerOf',
            args: [tokenId],
          }) as `0x${string}`
          if (owner.toLowerCase() === address.toLowerCase()) {
            return this._readToken(createPublicClient, httpTransport, chain, tokenId)
          }
        } catch { /* burned / moved since the transfer */ }
      }
      return null
    } catch {
      return null
    }
  }
}

/**
 * SSRF guard for the agent-controlled tokenURI. The URI is set by whoever registered the
 * agent, and we fetch it server-side - so it must not be allowed to point at loopback, a
 * private range, or cloud metadata (169.254.169.254). Best-effort literal-host filtering
 * (no DNS): blocks the obvious internal targets; callers also fetch with redirect:'error'.
 */
export function isSafePublicHttpUrl(raw: string): boolean {
  let u: URL
  try { u = new URL(raw) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  // Strip IPv6 brackets so `[::1]` normalizes to `::1` for the checks below.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1]), b = Number(m[2])
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false // link-local incl. the metadata endpoint
    if (a === 192 && b === 168) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  }
  if (host.includes(':')) {
    if (host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return false
  }
  return true
}

export function createIdentityProvider(env: NodeJS.ProcessEnv = process.env): IdentityProvider {
  /**
   * The client list IS `identityChains()`, so adding an identity chain is a descriptor
   * edit and nothing else. This used to be that filter PLUS three env-gated ad-hoc
   * clients (A_IDENTITY_RPC_URL, BASE_ERC8004_REGISTRY, ARB_ERC8004_REGISTRY, referenced
   * nowhere else in the repo): a second way to add a chain that no test, no manifest and
   * no public surface could see, which is the drift the registry exists to prevent.
   *
   * Each descriptor's `rpcEnvVar` still overrides its RPC through `resolveRpcUrls`, which
   * is the supported way to point a chain at a private endpoint.
   */
  const clients: ChainClient[] = identityChains().map((c) => ({
    chainId: c.evmChainId as number,
    chainName: c.id,
    rpcUrl: resolveRpcUrls(c, env)[0],
    registry: c.contracts.identityRegistry as `0x${string}`,
    caipPrefix: c.caip2,
  }))

  return new RpcIdentityProvider(clients)
}
