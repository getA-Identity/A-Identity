/**
 * Thin client for the A-Identity MCP HTTP server (POST /mcp, JSON-RPC 2.0).
 * The server runs at localhost:3399 by default; set VITE_MCP_URL to override.
 * enableJsonResponse is true on the server so responses are plain JSON, not SSE.
 */

import { MCP_BASE as BASE } from './mcpBase'
import { wakeBackend } from './api'

let _reqId = 1

/**
 * Cold-start-resilient fetch for this module's READ-ONLY calls (the tools called here
 * never mutate, so retrying the POST is safe). Mirrors the GET posture in lib/api.ts:
 * a 502/503/504 from the Vercel proxy or a network throw during Render's ~50s free-tier
 * wake is retried with a wake ping between attempts, instead of surfacing a false
 * "MCP server offline" on the public Explorer / TrustSpotlight / AgentVitrine surfaces.
 * Credentials ride along like every other backend call (harmless on public reads).
 */
const RETRY_STATUS = new Set([502, 503, 504])

async function fetchWithWake(url: string, init: RequestInit, timeoutMs: number, retries = 4): Promise<Response> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      void wakeBackend()
      await new Promise((r) => setTimeout(r, Math.min(2500 * attempt, 9000)))
    }
    try {
      const res = await fetch(url, {
        ...init,
        credentials: 'include',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (RETRY_STATUS.has(res.status) && attempt < retries) continue
      return res
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error('Backend unreachable')
}

async function callTool<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetchWithWake(`${BASE}/mcp`, {
      method: 'POST',
      // Streamable HTTP requires both accept types; enableJsonResponse=true returns plain JSON.
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: _reqId++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }, 8000)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const json = (await res.json()) as {
      result?: { content?: { type: string; text: string }[] }
      error?: { message?: string }
    }
    if (json.error) return { ok: false, error: json.error.message ?? 'MCP error' }
    const text = json.result?.content?.[0]?.text
    if (!text) return { ok: false, error: 'Empty response' }
    return { ok: true, data: JSON.parse(text) as T }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg.includes('fetch') ? 'MCP server offline' : msg }
  }
}

// ── types ─────────────────────────────────────────────────────────────────────

export type AgentIdentity = {
  agentId: string
  tokenId: number
  owner: string
  domain: string
  valid: boolean
  registeredAt: string
  registrationUri?: string
  chain?: string
  /** Existence proven (owner holds an identity token) but the token id could not be
   *  enumerated on this chain's public RPC; tokenId is 0 and metadata is unset. */
  partial?: boolean
  /** Set when a BARE token id matched on more than one chain, so the number alone does not
   *  identify one agent. The UI must say so rather than present one of them as the answer. */
  ambiguity?: { note: string; matches: { chain: string; caip: string; owner: string }[] }
}

export type Behavioral = {
  completedJobs: number
  contestedJobs: number
  disputeRate: number
  avgRating: number | null
  ratedJobs: number
}

export type Sybil = {
  level: 'none' | 'low' | 'medium' | 'high'
  siblingCount: number
  jobs: number
  selfDealt: number
  selfDealRate: number
  diversity: number
}

export type Reputation = {
  score: number
  breakdown: { settlement: number; validation: number; tenure: number; behavior?: number }
  behavioral?: Behavioral | null
  sybil?: Sybil | null
  settledOnchain?: number
  settledUsd?: number
  name?: string | null
  onchain?: string
  kya?: 'verified' | 'unverified' | 'revoked'
  /** A1: the latest ERC-8004 on-chain attestation of this score, if one has been published. */
  onchainAttestation?: {
    tokenId: string
    score: number
    score100: number
    chain: string
    registry: string
    validator: string
    txHash: string
    txUrl: string
    attestedAt: string
  } | null
  agentId: string
  computedAt: string
}

/** One chain's row from the get_chain_status tool. Named -Report because the generated
 *  src/lib/chains.ts already exports a DIFFERENT `ChainStatus` (the lifecycle union
 *  'live' | 'beta' | ...); a file importing both used to collide on the name. */
export type ChainStatusReport = {
  id: string
  name: string
  shortName: string
  chainId: number | null
  evmCompatible: boolean
  role: string
  status: string
  agentCount: number
}

// ── API surface ───────────────────────────────────────────────────────────────

export async function resolveAgent(
  query: string,
): Promise<{ ok: true; data: { found: boolean; source?: string; agent?: AgentIdentity } } | { ok: false; error: string }> {
  return callTool('resolve_agent', { query })
}

export async function getReputation(
  agentId: string,
): Promise<{ ok: true; data: { found: boolean; reputation?: Reputation } } | { ok: false; error: string }> {
  return callTool('get_reputation', { agentId })
}

export async function getChainStatus(): Promise<
  { ok: true; data: { chains: ChainStatusReport[] } } | { ok: false; error: string }
> {
  return callTool('get_chain_status', {})
}

export type ArcStatus = {
  chain: string
  online: boolean
  chainId: number | null
  blockNumber: string | null
  rpc: string
  explorer: string
  faucet: string
  gasToken: string
  nativeDecimals: number
  checkedAt: string
  note?: string
}

/** Live Circle Arc testnet status via the MCP REST companion. */
export async function getArcStatus(): Promise<
  { ok: true; data: ArcStatus } | { ok: false; error: string }
> {
  try {
    // The endpoint returns 200 when online, 503 when the Arc RPC is unreachable; both
    // carry the body. A 503 here is therefore ambiguous during a cold start, and the
    // retry loop treats it as retryable: a genuinely offline Arc RPC re-answers 503 on
    // the last attempt and still lands in the `online: false` payload below.
    const res = await fetchWithWake(`${BASE}/api/arc`, {}, 8000)
    const data = (await res.json()) as ArcStatus
    return { ok: true, data }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg.includes('fetch') ? 'MCP server offline' : msg }
  }
}

export type FeedAgent = {
  id: string
  name: string
  category: string
  kya?: 'verified' | 'unverified' | 'revoked'
  onchain?: string
  onchainAgentId?: string | null
  reputation?: { score: number; breakdown?: { settlement: number; validation: number; tenure: number; behavior?: number } }
  walletAddress?: string | null
  followers?: number
  /** Guardrail standing. Only populated when the owner published their badge (Phase 1.5
   *  made that opt-in), so `published: false` is the normal case, not an error. */
  guardrails?: { published: boolean; level?: string; label?: string; surfaces?: string[] }
}

/** The public Agent House feed: KYA-verified agents ranked by trust. Backs the leaderboard. */
export async function getLeaderboard(): Promise<{ ok: true; data: FeedAgent[] } | { ok: false; error: string }> {
  try {
    const res = await fetchWithWake(`${BASE}/api/marketplace`, {}, 8000)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const json = (await res.json()) as { agents?: FeedAgent[] }
    return { ok: true, data: json.agents ?? [] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg.includes('fetch') ? 'MCP server offline' : msg }
  }
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}
