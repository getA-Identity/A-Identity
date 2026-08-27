import { useEffect, useState } from 'react'
import {
  checkHealth,
  getArcStatus,
  getChainStatus,
  getReputation,
  resolveAgent,
  type AgentIdentity,
  type ArcStatus,
  type ChainStatusReport,
  type Reputation,
} from '../lib/mcp-client'
import { wakeBackend } from '../lib/api'

// ── health ───────────────────────────────────────────────────────────────────

export type McpStatus = 'checking' | 'waking' | 'online' | 'offline'

/**
 * Health status with cold-start awareness. A free-tier host (e.g. Render) can take
 * ~30-50s to wake from idle; instead of flashing "offline", we show "waking" while
 * we keep polling, and only call it offline after the wake window elapses.
 */
export function useMcpHealth(): McpStatus {
  const [status, setStatus] = useState<McpStatus>('checking')

  useEffect(() => {
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      const ok = await checkHealth()
      if (cancelled) return
      if (ok) {
        attempts = 0
        setStatus('online')
        timer = setTimeout(tick, 12_000)
        return
      }
      // Actively wake a cold free-tier backend (direct no-cors ping bypasses the proxy's
      // ~30s cap) instead of passively polling a proxy that 502s during the boot window.
      wakeBackend()
      attempts += 1
      // Keep trying for longer before calling it "offline": a cold boot + wake can take
      // north of a minute, and the keep-warm cron usually prevents this entirely.
      setStatus(attempts >= 20 ? 'offline' : 'waking')
      timer = setTimeout(tick, attempts >= 20 ? 15_000 : 3_000)
    }

    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  return status
}

// ── resolve agent ─────────────────────────────────────────────────────────────

type AgentState = {
  loading: boolean
  agent: AgentIdentity | null
  source: string | null
  error: string | null
}

export function useResolveAgent(query: string | null, enabled = true) {
  const [state, setState] = useState<AgentState>({
    loading: false,
    agent: null,
    source: null,
    error: null,
  })

  useEffect(() => {
    if (!query || !enabled) return
    let cancelled = false
    setState({ loading: true, agent: null, source: null, error: null })
    resolveAgent(query).then((res) => {
      if (cancelled) return
      if (!res.ok) {
        setState({ loading: false, agent: null, source: null, error: res.error })
        return
      }
      setState({
        loading: false,
        agent: res.data.found ? (res.data.agent ?? null) : null,
        source: res.data.source ?? null,
        error: res.data.found ? null : (res.data as { reason?: string }).reason ?? 'Not found',
      })
    })
    return () => { cancelled = true }
  }, [query, enabled])

  return state
}

// ── reputation ────────────────────────────────────────────────────────────────

type RepState = {
  loading: boolean
  reputation: Reputation | null
  error: string | null
}

export function useAgentReputation(agentId: string | null, enabled = true) {
  const [state, setState] = useState<RepState>({ loading: false, reputation: null, error: null })

  useEffect(() => {
    if (!agentId || !enabled) return
    let cancelled = false
    setState({ loading: true, reputation: null, error: null })
    getReputation(agentId).then((res) => {
      if (cancelled) return
      if (!res.ok) {
        setState({ loading: false, reputation: null, error: res.error })
        return
      }
      setState({
        loading: false,
        reputation: res.data.found ? (res.data.reputation ?? null) : null,
        error: res.data.found ? null : 'No reputation data',
      })
    })
    return () => { cancelled = true }
  }, [agentId, enabled])

  return state
}

// ── chains ────────────────────────────────────────────────────────────────────

type ChainsState = {
  loading: boolean
  chains: ChainStatusReport[]
  error: string | null
}

export function useMcpChains() {
  const [state, setState] = useState<ChainsState>({ loading: false, chains: [], error: null })

  useEffect(() => {
    let cancelled = false
    setState({ loading: true, chains: [], error: null })
    getChainStatus().then((res) => {
      if (cancelled) return
      if (!res.ok) {
        setState({ loading: false, chains: [], error: res.error })
        return
      }
      setState({ loading: false, chains: res.data.chains, error: null })
    })
    return () => { cancelled = true }
  }, [])

  return state
}

// ── Arc live status ───────────────────────────────────────────────────────────

type ArcState = {
  loading: boolean
  arc: ArcStatus | null
  error: string | null
}

/** Polls live Circle Arc testnet status (chainId, latest block) from the MCP server. */
export function useArcStatus(pollMs = 15_000) {
  const [state, setState] = useState<ArcState>({ loading: true, arc: null, error: null })

  useEffect(() => {
    let cancelled = false
    const load = () =>
      getArcStatus().then((res) => {
        if (cancelled) return
        if (!res.ok) {
          setState({ loading: false, arc: null, error: res.error })
          return
        }
        setState({ loading: false, arc: res.data, error: null })
      })
    load()
    const id = setInterval(load, pollMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [pollMs])

  return state
}
