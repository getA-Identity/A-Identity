/**
 * The ONE public projection of the chain registry.
 *
 * Before this file there were three hand-maintained chain lists that drifted:
 * `chains/registry.ts` (7 chains), `data.ts` CHAIN_CONFIG (which is what
 * `GET /api/chains` and the `get_chain_status` MCP tool actually served), and the
 * frontend's `src/lib/chains.ts`. Adding a chain meant three edits, and forgetting
 * one shipped a lie to whichever surface was missed.
 *
 * Now the registry is the single source of truth and everything public is DERIVED:
 *   - `publicChains()`      -> what the REST + MCP surfaces serve (data.ts CHAIN_CONFIG)
 *   - `renderFrontendChains()` -> the generated `src/lib/chains.ts` module text
 *
 * The frontend cannot import from `mcp/` (separate package, separate deploy), so it
 * gets a GENERATED file instead of a runtime fetch: the landing and console render
 * chains without a network round-trip, and `frontend-sync.test.ts` fails the build if
 * the generated file drifts from the registry. See ./README.md.
 */
import type { ChainDescriptor, ChainStatus } from './types.js'
import { CHAINS } from './registry.js'

/**
 * The public, serializable shape of a chain. A deliberate SUPERSET of the old
 * CHAIN_CONFIG: every key that `GET /api/chains` used to return is still here (so no
 * existing consumer breaks), plus the richer fields the frontend needs.
 *
 * `status` uses the registry's honest lifecycle vocabulary (`live` | `beta` |
 * `planned` | `deprecated`), not the old `active`/`preview` labels.
 */
export type PublicChain = {
  id: string
  name: string
  shortName: string
  color: string
  /** EIP-155 chain id. Null for non-EVM chains. */
  chainId: number | null
  caip2: string
  evmCompatible: boolean
  testnet: boolean
  stablecoins: string[]
  /** Primary RPC. The registry's env-var override is deliberately NOT applied here:
   *  this is public metadata, not the transport the server actually dials. */
  rpcUrl: string | null
  explorer: string | null
  role: string
  status: ChainStatus
  protocols: {
    payment: { x402: boolean; note?: string }
    identity: { standard: string; erc8004Native: boolean; note?: string }
  }
  /** Flat aliases of the `protocols` fields, kept so the pre-unification
   *  `GET /api/chains` response shape stays backward compatible. */
  identity: string
  erc8004Native: boolean
  x402: boolean
  /**
   * The canonical ERC-8004 addresses this chain actually carries. An absent key is an
   * absent deployment: nothing is listed that eth_getCode did not confirm.
   *
   * This exists because the frontend had no way to know which chains carry a registry,
   * so it guessed - and the console told every non-Arc chain it had "no live agents yet"
   * while three of them carried real ones. Deriving it here means the UI can stop guessing.
   */
  registries: { identity?: string; reputation?: string; validation?: string }
  /** True when a live identity read works on this chain today. Derived, never restated. */
  identityLive: boolean
  /** Symbol of the token our own x402 rail settles in on this chain, or null when we run
   *  no rail here. Derived from the descriptor's settlement tokens, so a surface can say
   *  which chains actually take money without keeping its own list. */
  settlementSymbol: string | null
}

/** Project one descriptor into its public shape. */
export function toPublicChain(c: ChainDescriptor): PublicChain {
  return {
    id: c.id,
    name: c.name,
    shortName: c.shortName,
    color: c.color,
    chainId: c.evmChainId,
    caip2: c.caip2,
    evmCompatible: c.ecosystem === 'evm',
    testnet: c.testnet,
    stablecoins: [...c.stablecoins],
    rpcUrl: c.rpcUrls[0] ?? null,
    explorer: c.explorer,
    role: c.role,
    status: c.status,
    protocols: {
      payment: { x402: c.payment.x402, ...(c.payment.note ? { note: c.payment.note } : {}) },
      identity: {
        standard: c.identity.standard,
        erc8004Native: c.identity.erc8004Native,
        ...(c.identity.note ? { note: c.identity.note } : {}),
      },
    },
    identity: c.identity.standard,
    erc8004Native: c.identity.erc8004Native,
    x402: c.payment.x402,
    registries: {
      ...(c.contracts.identityRegistry ? { identity: c.contracts.identityRegistry } : {}),
      ...(c.contracts.reputationRegistry ? { reputation: c.contracts.reputationRegistry } : {}),
      ...(c.contracts.validationRegistry ? { validation: c.contracts.validationRegistry } : {}),
    },
    identityLive: Boolean(c.contracts.identityRegistry),
    settlementSymbol: (c.settlementTokens ?? []).find((t) => t.authorization === 'eip3009')?.symbol ?? null,
  }
}

/** Every chain in the registry, in registry order, as public metadata. */
export function publicChains(): PublicChain[] {
  // Frontend display order: live first, then beta, then planned; stable inside each
  // group so the registry's own order still decides ties. The registry array itself
  // stays in its documented order (tests pin it); only the generated view is sorted.
  const rank: Record<string, number> = { live: 0, beta: 1, planned: 2, deprecated: 3 }
  return [...CHAINS]
    .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3))
    .map(toPublicChain)
}

const GENERATED_HEADER = `/**
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Source of truth: mcp/src/chains/registry.ts
 * Regenerate:     cd mcp && npm run gen:chains
 *
 * Editing this file directly will fail \`cd mcp && npm test\`
 * (see mcp/src/chains/frontend-sync.test.ts). Add or change a chain in the registry
 * and regenerate, so the backend, the REST surface and the UI can never disagree.
 */
`

/**
 * Render the frontend's `src/lib/chains.ts` module text from the registry.
 *
 * Lives here (not in the generator script) so the drift test can render the expected
 * text with the exact same code that writes it.
 */
export function renderFrontendChains(): string {
  const chains = publicChains()
  const ids = chains.map((c) => `'${c.id}'`).join(' | ')
  const body = chains.map((c) => `  ${JSON.stringify(c, null, 2).split('\n').join('\n  ')},`).join('\n')

  return `${GENERATED_HEADER}
/** Short slug of a chain in the registry. */
export type ChainId = ${ids}

export type ChainProtocols = {
  /** x402 HTTP-402 payment support. Settlement is in a stablecoin. */
  payment: { x402: boolean; note?: string }
  /** Identity standard. ERC-8004 is EVM-only; non-EVM chains map to a native equivalent. */
  identity: { standard: string; erc8004Native: boolean; note?: string }
}

/** Lifecycle status. Only \`live\` (and \`beta\`) chains are wired end to end. */
export type ChainStatus = 'live' | 'beta' | 'planned' | 'deprecated'

export type Chain = {
  id: ChainId
  name: string
  shortName: string
  /** Hex color for UI badges and chips. Readable as colored tag text in both themes. */
  color: string
  /** EIP-155 chain id. Null for non-EVM chains. */
  chainId: number | null
  /** CAIP-2 chain identifier. */
  caip2: string
  evmCompatible: boolean
  testnet: boolean
  /** Stablecoins available on this chain. First is the default settlement coin. */
  stablecoins: string[]
  rpcUrl: string | null
  explorer: string | null
  role: string
  status: ChainStatus
  protocols: ChainProtocols
  /** Flat aliases of \`protocols\`, mirroring the GET /api/chains payload. */
  identity: string
  erc8004Native: boolean
  x402: boolean
  /** Canonical ERC-8004 addresses this chain carries. An absent key is an absent
   *  deployment: the UI must never infer one. */
  registries: { identity?: string; reputation?: string; validation?: string }
  /** True when a live identity read works on this chain today. */
  identityLive: boolean
  /** Symbol our x402 rail settles in here, or null when we run no rail on this chain. */
  settlementSymbol: string | null
}

export const CHAINS: readonly Chain[] = [
${body}
] as const

export const CHAIN_BY_ID = Object.fromEntries(CHAINS.map((c) => [c.id, c])) as Record<
  ChainId,
  Chain
>
`
}
