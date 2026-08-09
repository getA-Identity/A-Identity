/**
 * Static, read-only reference data for the A-Identity MCP server.
 *
 * No fabricated agents: identity resolution is REAL on-chain (see erc8004.ts, which
 * reads Circle Arc's deployed ERC-8004 registry), and the agent list / reputation
 * come from real platform state (see http.ts / platform.ts). What remains here is
 * the public chain projection (CHAIN_CONFIG, derived from chains/registry.ts) and the
 * capability manifest (listCapabilities).
 */
import { publicChains } from './chains/public-view.js'

export type ChainName = 'arc' | 'xlayer' | 'ethereum' | 'base' | 'arbitrum' | 'stellar' | 'celo' | 'celo-sepolia'

export type AgentIdentity = {
  agentId: string
  tokenId: number
  owner: string
  registrationUri: string
  domain: string
  valid: boolean
  registeredAt: string
  chain: ChainName
  /** True when only EXISTENCE could be proven (owner holds an identity token) but the
   *  token id could not be enumerated (e.g. X Layer's public RPC caps getLogs), so
   *  tokenId/tokenURI fields are unset. Resolve by token id for the full identity. */
  partial?: boolean
  /**
   * Set when a BARE token id matched on more than one chain. The same number is a different
   * agent on every registry, so a bare id does not identify one: returning whichever chain
   * happens to be listed first would present a stranger's agent as the answer.
   */
  ambiguity?: {
    note: string
    matches: { chain: string; caip: string; owner: string }[]
  }
}

export type AgentActionHistory = {
  agentId: string
  settledActions: number
  disputes: number
  registeredAt: string
}

/** No fabricated agents. Real agents are resolved on-chain (erc8004.ts) and listed
 *  from live platform state (http.ts). Kept as an empty typed export for consumers. */
export const AGENTS: AgentIdentity[] = []

/** No fabricated history. Reputation is computed from real platform settlements
 *  (platform.ts repOf) and real on-chain identity/validation. */
const HISTORY: Record<string, AgentActionHistory> = {}

export function resolveAgent(query: string): AgentIdentity | null {
  const q = query.trim().toLowerCase()
  return (
    AGENTS.find(
      (a) =>
        a.agentId.toLowerCase() === q ||
        `#${a.tokenId}` === q ||
        String(a.tokenId) === q ||
        a.owner.toLowerCase() === q ||
        a.domain.toLowerCase() === q,
    ) ?? null
  )
}

export function getHistory(agentId: string): AgentActionHistory | null {
  const agent = resolveAgent(agentId)
  if (!agent) return null
  return HISTORY[agent.agentId] ?? null
}

export function listAgents(chain?: string): AgentIdentity[] {
  if (!chain) return AGENTS
  const chainKey = chain.toLowerCase()
  return AGENTS.filter((a) => a.chain === chainKey)
}

/**
 * The chains this server reports, DERIVED from the one source of truth
 * (`chains/registry.ts`). Adding a chain is a registry edit; this list, the
 * `GET /api/chains` payload, the `get_chain_status` MCP tool and the frontend's
 * generated `src/lib/chains.ts` all follow automatically.
 *
 * Status uses the registry's honest lifecycle vocabulary: `live` (wired end to end,
 * Arc today) | `beta` | `planned` | `deprecated`.
 */
export const CHAIN_CONFIG = publicChains()

export function listCapabilities() {
  return {
    name: 'A-Identity',
    version: '0.2.0',
    status: 'preview',
    capabilities: {
      // Also derived from the registry, so the manifest can never advertise a chain
      // the rest of the system does not know about.
      identity: {
        standard: 'ERC-8004',
        evmChains: CHAIN_CONFIG.filter((c) => c.evmCompatible).map((c) => c.id),
        nonEvmChains: CHAIN_CONFIG.filter((c) => !c.evmCompatible).map((c) => ({
          chain: c.id,
          standard: c.protocols.identity.standard,
          note: c.protocols.identity.note ?? 'ERC-8004 passport bridged from EVM',
        })),
        status: 'preview',
      },
      payments: {
        standard: 'x402',
        settlement: 'USDC',
        also_supported: ['USDT', 'PYUSD', 'EURC'],
        rails: CHAIN_CONFIG.filter((c) => c.x402).map((c) => c.id),
        wallets: 'circle-agent-wallets',
        status: 'planned',
      },
      connectivity: {
        standard: 'model-context-protocol',
        paidTools: 'x402-mcp',
        status: 'preview',
      },
      reputation: { model: 'deterministic', range: [0, 1000], crossChain: true, status: 'preview' },
    },
    humanOversight:
      'Actions that hold a key, deploy a contract, or move value require explicit human approval.',
  }
}
