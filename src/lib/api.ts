/**
 * Cold-start-resilient backend access.
 *
 * The production backend runs on a free host (Render) that spins down after idle and
 * takes ~50s to wake. The app talks to it through a same-origin Vercel proxy whose
 * gateway times out at ~30s, so during a cold boot the proxy returns 502 BEFORE the
 * backend is up, and a naive poll can never warm it. That is the "waited 2 minutes,
 * still 502" failure.
 *
 * This module fixes it three ways:
 *   1. `wakeBackend()` nudges the backend awake, including a direct no-cors ping to its
 *      real origin (no 30s proxy cap), so a cold boot can actually finish.
 *   2. `apiFetch()` retries idempotent reads through a cold start, and for mutations
 *      waits until the backend answers /health BEFORE sending once (never double-sends
 *      a side effect through a retry).
 *   3. `explainError()` turns a status + body into an honest, human message (401/403/…).
 *
 * A keep-warm cron (.github/workflows/keep-warm.yml) keeps the backend from sleeping in
 * the first place; this module recovers the residual cold-start window.
 */
import { MCP_BASE, BACKEND_DIRECT_URL } from './mcpBase'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RETRYABLE = new Set([502, 503, 504])

let lastWake = 0
/**
 * Fire-and-forget wake ping. Hits the same-origin proxy (ad-blocker-safe) AND, best
 * effort, the backend origin directly with `no-cors`, the direct hit bypasses the
 * proxy's ~30s gateway cap so a cold boot can complete. Throttled so retries don't spam.
 */
export function wakeBackend(): void {
  const now = Date.now()
  if (now - lastWake < 3000) return
  lastWake = now
  try {
    void fetch(`${MCP_BASE}/health`, { cache: 'no-store' }).catch(() => {})
  } catch {
    /* ignore */
  }
  if (BACKEND_DIRECT_URL && BACKEND_DIRECT_URL !== MCP_BASE) {
    try {
      void fetch(`${BACKEND_DIRECT_URL}/health`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {})
    } catch {
      /* ignore */
    }
  }
}

/**
 * Resolve once the backend answers /health, waking it if it's cold. Bounded (~2 min),
 * fast when already warm. Call before a mutating POST so a cold start never causes a
 * double-send. Returns true if the backend came up, false if it stayed unreachable.
 */
export async function ensureAwake(onWaking?: () => void): Promise<boolean> {
  for (let i = 0; i < 24; i++) {
    try {
      const res = await fetch(`${MCP_BASE}/health`, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
      if (res.ok) return true
    } catch {
      /* down or slow, wake and retry below */
    }
    onWaking?.()
    wakeBackend()
    await sleep(2500)
  }
  return false
}

export type ApiInit = RequestInit & { retries?: number; timeoutMs?: number; onWaking?: () => void }

/**
 * fetch with cold-start resilience.
 *  - GET/HEAD: retried through a cold start (safe to repeat), waking between tries.
 *  - Mutations: the backend is woken FIRST, then the request is sent EXACTLY ONCE, so a
 *    slow cold start can never double-execute a side effect (e.g. create two agents).
 * `path` is relative (e.g. '/api/agents'); MCP_BASE is prepended.
 */
export async function apiFetch(path: string, init: ApiInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const mutating = method !== 'GET' && method !== 'HEAD'
  const { retries = 4, timeoutMs, onWaking, ...rest } = init
  const to = timeoutMs ?? (mutating ? 60_000 : 12_000)

  if (mutating) {
    await ensureAwake(onWaking)
    return doFetch(path, rest, to)
  }

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await doFetch(path, rest, to)
      if (RETRYABLE.has(res.status) && attempt < retries) {
        onWaking?.()
        wakeBackend()
        await sleep(backoff(attempt))
        continue
      }
      return res
    } catch (e) {
      lastErr = e
      if (attempt < retries) {
        onWaking?.()
        wakeBackend()
        await sleep(backoff(attempt))
        continue
      }
    }
  }
  throw lastErr ?? new Error('Backend unreachable')
}

function doFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(`${MCP_BASE}${path}`, {
    // Send the HttpOnly session cookie on every call (same-origin in prod; credentialed
    // CORS in dev) so auth no longer depends on a JS-readable token.
    credentials: 'include',
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  })
}

function backoff(attempt: number): number {
  return Math.min(9000, 2500 * (attempt + 1)) // 2.5s, 5s, 7.5s, 9s
}

/** Read JSON, tolerating an empty or non-JSON body (returns {}). */
export async function readJson<T = unknown>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T
}

/** An honest, human message for a failed request, from its status + any `{error}` body. */
export function explainError(status: number, bodyError?: string): string {
  if (status === 401)
    return 'Sign in with your wallet or an email link to do this, guest sessions are read-only.'
  if (status === 403)
    return bodyError && /owner|forbidden/i.test(bodyError)
      ? 'You can only do this on an agent you own. Register your own agent first, then try again.'
      : bodyError ?? 'You do not have permission to do this.'
  if (status === 404) return bodyError ?? 'Not found.'
  if (status === 501) return bodyError ?? 'This feature is not configured on the server yet.'
  if (status >= 502 && status <= 504)
    return 'The backend is waking up or briefly unavailable (free tier). Give it a few seconds and try again.'
  return bodyError ?? `Request failed (${status}).`
}
