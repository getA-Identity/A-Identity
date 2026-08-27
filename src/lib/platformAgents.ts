/**
 * Shared data layer for GET /api/platform-agents.
 *
 * Every app screen (Dashboard, AgentId, Wallet, Settlements, Permissions, Marketplace)
 * needs the agent list. Without a cache each navigation refires the request, a
 * "fetch storm". This is a tiny, dependency-free cache with:
 *   - in-flight dedup: concurrent callers share ONE request, and
 *   - a short TTL: a navigation within the window reuses the last result.
 * After a mutation that changes the list (create agent, anchor, permissions), call
 * `invalidatePlatformAgents()` so the next read is fresh, and any screen subscribed via
 * `subscribePlatformAgents()` re-fetches immediately, so a newly created agent shows up
 * without navigating away and back.
 *
 * Errors are NOT cached. They propagate so each screen's own try/catch still shows
 * its "backend offline" message.
 */
import { apiFetch, readJson } from './api'

const TTL_MS = 6000

let cache: { at: number; data: { agents: unknown[] } } | null = null
let inflight: Promise<{ agents: unknown[] }> | null = null

const listeners = new Set<() => void>()

/**
 * Fetch the platform agents, served from cache when fresh and deduped while in flight.
 * Cold-start resilient (retries a waking backend). Generic over the caller's agent shape.
 */
export async function fetchPlatformAgents<T = unknown>(opts: { force?: boolean } = {}): Promise<{ agents: T[] }> {
  if (!opts.force && cache && Date.now() - cache.at < TTL_MS) return cache.data as { agents: T[] }
  // A forced read must NOT be served by a request that was already in flight when the
  // caller forced: a post-mutation refetch riding a pre-mutation request would return
  // the pre-mutation list. Only unforced callers join the shared in-flight request.
  if (inflight && !opts.force) return inflight as Promise<{ agents: T[] }>
  const p = (async () => {
    const res = await apiFetch('/api/platform-agents')
    const data = await readJson<{ agents: unknown[] }>(res)
    cache = { at: Date.now(), data: { agents: data.agents ?? [] } }
    return cache.data
  })()
  // Clear only our own registration: an older overlapping request finishing late must
  // not null out the newer in-flight promise later callers are sharing. Attached on
  // both branches so a failed fetch also unregisters; the rejection itself still
  // reaches the caller through the returned promise.
  const cleanup = () => {
    if (inflight === p) inflight = null
  }
  p.then(cleanup, cleanup)
  inflight = p
  return p as Promise<{ agents: T[] }>
}


/** Drop the cache so the next fetch hits the backend, and notify subscribed screens so
 *  they re-fetch now (call after list-changing mutations: create / anchor / KYA). */
export function invalidatePlatformAgents(): void {
  cache = null
  listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* a listener throwing must not break the others */
    }
  })
}

/** Subscribe to "the agent list changed". Returns an unsubscribe fn (use in an effect). */
export function subscribePlatformAgents(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
