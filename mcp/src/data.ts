/**
 * Static, read-only reference data for the A-Identity MCP server.
 *
 * No fabricated agents: identity resolution is REAL on-chain (see erc8004.ts, which
 * reads Circle Arc's deployed ERC-8004 registry), and the agent list / reputation
 * come from real platform state (see http.ts / platform.ts). What remains here is
 * chain metadata (CHAIN_CONFIG) and the capability manifest (listCapabilities).
 */

export type ChainName = 'arc' | 'xlayer' | 'ethereum' | 'base' | 'arbitrum' | 'stellar' | 'algorand'

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

export const CHAIN_CONFIG = [
  {
    id: 'arc', name: 'Circle Arc (Testnet)', shortName: 'Arc', chainId: 5042002 as number | null,
    evmCompatible: true, color: '#2775CA',
    identity: 'ERC-8004', erc8004Native: true, x402: true,
    role: 'Primary payment rail: gas in USDC, sub-second finality, App Kit unified balance.',
    // Active: the core flow (identity, KYA, vault, USDC settlement) runs on Arc testnet
    // today with real transactions. Value matches src/lib/chains.ts (arc: 'active');
    // base/arbitrum are 'planned' EVM fallbacks, not yet wired end to end.
    status: 'active',
  },
  {
    id: 'base', name: 'Base', shortName: 'Base', chainId: 8453,
    evmCompatible: true, color: '#0052FF',
    identity: 'ERC-8004', erc8004Native: true, x402: true,
    role: 'EVM fallback: ERC-8004 compatible, Coinbase ecosystem, low fees.',
    status: 'planned',
  },
  {
    id: 'arbitrum', name: 'Arbitrum One', shortName: 'Arbitrum', chainId: 42161,
    evmCompatible: true, color: '#28A0F0',
    identity: 'ERC-8004', erc8004Native: true, x402: true,
    role: 'DeFi gateway: large protocol ecosystem, USDC via Circle, ERC-8004 compatible.',
    status: 'planned',
  },
  {
    id: 'stellar', name: 'Stellar', shortName: 'Stellar', chainId: null,
    evmCompatible: false, color: '#C79A1E',
    identity: 'Soroban registry + SEP-10', erc8004Native: false, x402: true,
    role: 'Fast, low-cost settlement: USDC + EURC native (Circle), Soroban contracts.',
    status: 'planned',
  },
  {
    id: 'algorand', name: 'Algorand', shortName: 'Algorand', chainId: null,
    evmCompatible: false, color: '#1A1A1A',
    identity: 'did:algo + ARC registry', erc8004Native: false, x402: true,
    role: 'Instant finality: USDC native (Circle), W3C did:algo, ARC smart contracts.',
    status: 'planned',
  },
]

export function listCapabilities() {
  return {
    name: 'A-Identity',
    version: '0.2.0',
    status: 'preview',
    capabilities: {
      identity: {
        standard: 'ERC-8004',
        evmChains: ['ethereum-mainnet', 'base', 'arbitrum-one', 'arc'],
        nonEvmChains: [
          { chain: 'stellar', standard: 'Soroban registry + SEP-10', note: 'ERC-8004 passport bridged from EVM' },
          { chain: 'algorand', standard: 'did:algo + ARC registry', note: 'ERC-8004 passport bridged from EVM' },
        ],
        status: 'preview',
      },
      payments: {
        standard: 'x402',
        settlement: 'USDC',
        also_supported: ['USDT', 'PYUSD', 'EURC'],
        rails: ['arc', 'base', 'arbitrum', 'stellar', 'algorand'],
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
