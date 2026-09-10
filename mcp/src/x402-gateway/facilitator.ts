/**
 * The Circle Gateway side of the batched x402 rail: what the facilitator advertises, how a
 * payment is settled through it, and how the resulting transfer is read back.
 *
 * Three rules, each the reason a function here exists.
 *
 * 1. The signing domain is PROVEN against the facilitator, never pasted. The registry
 *    records the GatewayWallet address Circle publishes; before a challenge is served the
 *    live /v1/x402/supported is read and the kind for the chain must name that same wallet
 *    and the chain's own USDC. A mismatch means no challenge, because an authorization
 *    signed against the wrong verifyingContract is one nobody can settle.
 * 2. Nothing counts until it is read back. Gateway's settle response says success; the
 *    transfers API is the ledger Gateway keeps of what it actually credited, and a
 *    payment is recorded only once that ledger returns it for the authorization's nonce,
 *    to our payTo, for the price. Same discipline as every other rail here, with Gateway's
 *    own record standing in for the chain receipt until the batch lands.
 * 3. Every network call is injectable and deadline-bounded, so the rail is unit-tested
 *    without a network and a stalled facilitator costs one request, not the process.
 *
 * Both Gateway hosts are permissionless for these three calls (checked live 2026-09-10:
 * supported and transfers answer 200 on gateway-api.circle.com with no key). Circle's SDK
 * accepts optional auth headers should that change; X402_GATEWAY_API_KEY is forwarded as a
 * bearer when set and ignored otherwise.
 */
import type { ChainDescriptor } from '../chains/index.js'

export type GatewayAsset = { symbol: string; address: string; decimals: number }

/** One entry of Gateway's /v1/x402/supported `kinds`. */
export type GatewayKind = {
  x402Version: number
  scheme: string
  network: string
  extra: {
    name: string
    version: string
    verifyingContract: string
    minValiditySeconds?: number
    assets?: GatewayAsset[]
    [k: string]: unknown
  }
}

export type GatewaySettleResponse = {
  success: boolean
  errorReason?: string
  message?: string
  payer?: string
  transaction?: string
  network?: string
}

/** One row of Gateway's /v1/x402/transfers, as observed live 2026-09-10 on mainnet. The
 *  SDK types the shape as open-ended and so do we: fields are preserved, not trimmed. */
export type GatewayTransfer = {
  id: string
  status: 'received' | 'batched' | 'confirmed' | 'completed' | 'failed' | string
  token?: string
  sendingNetwork?: string
  recipientNetwork?: string
  fromAddress: string
  toAddress: string
  amount: string
  nonce?: string
  txHash?: string
  createdAt?: string
  updatedAt?: string
  [k: string]: unknown
}

export type GatewayRequirements = {
  scheme: 'exact'
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: Record<string, unknown>
}

export type GatewayDeps = {
  env?: NodeJS.ProcessEnv
  getSupported?: (facilitatorUrl: string) => Promise<{ kinds: GatewayKind[] }>
  settle?: (facilitatorUrl: string, payload: unknown, requirements: GatewayRequirements) => Promise<GatewaySettleResponse>
  searchTransfers?: (facilitatorUrl: string, params: { network: string; nonce?: string; id?: string }) => Promise<GatewayTransfer[]>
  now?: () => number
  /** Sleep between read-back attempts. Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>
}

const HTTP_TIMEOUT_MS = 8000

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const key = env.X402_GATEWAY_API_KEY?.trim()
  return key ? { Authorization: `Bearer ${key}` } : {}
}

/**
 * fetch with a hard deadline. The timer is cleared on every exit and deliberately not
 * unref'd: an unref'd deadline lets the process exit with the promise still pending,
 * which is the bug class CI has caught three times on this codebase.
 */
async function fetchWithDeadline(url: string, init: RequestInit, ms = HTTP_TIMEOUT_MS): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function defaultGetSupported(facilitatorUrl: string, env: NodeJS.ProcessEnv): Promise<{ kinds: GatewayKind[] }> {
  const r = await fetchWithDeadline(`${facilitatorUrl}/v1/x402/supported`, { headers: authHeaders(env) })
  if (!r.ok) throw new Error(`Gateway supported ${r.status}`)
  return (await r.json()) as { kinds: GatewayKind[] }
}

async function defaultSettle(
  facilitatorUrl: string,
  payload: unknown,
  requirements: GatewayRequirements,
  env: NodeJS.ProcessEnv,
): Promise<GatewaySettleResponse> {
  const { BatchFacilitatorClient } = await import('@circle-fin/x402-batching/server')
  const headers = authHeaders(env)
  const client = new BatchFacilitatorClient({ url: facilitatorUrl, ...(Object.keys(headers).length ? { headers } : {}) })
  // The SDK's settle has no deadline of its own; race it against ours so a stalled
  // facilitator returns a labeled failure rather than holding the request open.
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<GatewaySettleResponse>((resolve) => {
    timer = setTimeout(() => resolve({ success: false, errorReason: `Gateway settle did not answer within ${HTTP_TIMEOUT_MS} ms` }), HTTP_TIMEOUT_MS)
  })
  try {
    return (await Promise.race([client.settle(payload as never, requirements as never) as Promise<GatewaySettleResponse>, deadline])) as GatewaySettleResponse
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function defaultSearchTransfers(
  facilitatorUrl: string,
  params: { network: string; nonce?: string; id?: string },
  env: NodeJS.ProcessEnv,
): Promise<GatewayTransfer[]> {
  if (params.id && !params.nonce) {
    const r = await fetchWithDeadline(`${facilitatorUrl}/v1/x402/transfers/${encodeURIComponent(params.id)}`, { headers: authHeaders(env) })
    if (r.status === 404) return []
    if (!r.ok) throw new Error(`Gateway transfer ${r.status}`)
    return [(await r.json()) as GatewayTransfer]
  }
  const q = new URLSearchParams({ network: params.network })
  if (params.nonce) q.set('nonce', params.nonce)
  // Gateway wants the CAIP-2 colon literal, not percent-encoded (the SDK does the same).
  const url = `${facilitatorUrl}/v1/x402/transfers?${q.toString().replaceAll('%3A', ':')}`
  const r = await fetchWithDeadline(url, { headers: authHeaders(env) })
  if (!r.ok) throw new Error(`Gateway transfers ${r.status}`)
  const body = (await r.json()) as { transfers?: GatewayTransfer[] }
  return body.transfers ?? []
}

export function gatewayCalls(deps: GatewayDeps = {}) {
  const env = deps.env ?? process.env
  return {
    env,
    getSupported: deps.getSupported ?? ((u) => defaultGetSupported(u, env)),
    settle: deps.settle ?? ((u, p, r) => defaultSettle(u, p, r, env)),
    searchTransfers: deps.searchTransfers ?? ((u, p) => defaultSearchTransfers(u, p, env)),
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  }
}

// ── the proven kind ─────────────────────────────────────────────────────────────

export type ProvenKind = {
  kind: GatewayKind
  asset: GatewayAsset
  provenAt: string
  facilitator: string
}
export type ProvenKindResult = { ok: true; proven: ProvenKind } | { ok: false; reason: string }

const KIND_TTL_MS = 10 * 60 * 1000
const kindCache = new Map<string, { at: number; result: ProvenKindResult }>()

export function clearKindCache(): void {
  kindCache.clear()
}

/**
 * Prove that Gateway sells on `chain` the way the registry says it does. The registry's
 * `gateway.wallet` is what we EXPECT; the live kind is what Gateway will actually verify
 * signatures against. They must agree, and the chain's canonical USDC must be among the
 * assets, or nothing is offered.
 */
export async function provenKind(chain: ChainDescriptor, deps: GatewayDeps = {}): Promise<ProvenKindResult> {
  if (!chain.gateway) return { ok: false, reason: `${chain.id} declares no Circle Gateway in the registry` }
  if (!chain.contracts.usdc) return { ok: false, reason: `${chain.id} declares no canonical USDC, and Gateway settles USDC only` }
  const calls = gatewayCalls(deps)
  const key = `${chain.gateway.facilitator}|${chain.caip2}`
  const cached = kindCache.get(key)
  if (cached && cached.result.ok && calls.now() - cached.at < KIND_TTL_MS) return cached.result

  let kinds: GatewayKind[]
  try {
    kinds = (await calls.getSupported(chain.gateway.facilitator)).kinds ?? []
  } catch (e) {
    return { ok: false, reason: `Gateway supported-kinds read failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  const kind = kinds.find((k) => k.network === chain.caip2 && k.scheme === 'exact' && k.extra?.name === 'GatewayWalletBatched')
  if (!kind) return { ok: false, reason: `Gateway (${chain.gateway.facilitator}) is not advertising a GatewayWalletBatched kind for ${chain.caip2} right now` }
  if (kind.extra.verifyingContract.toLowerCase() !== chain.gateway.wallet.toLowerCase()) {
    return {
      ok: false,
      reason: `Gateway advertises verifyingContract ${kind.extra.verifyingContract} for ${chain.caip2}; the registry expects ${chain.gateway.wallet}. Refusing to sell against a domain we did not verify.`,
    }
  }
  const asset = (kind.extra.assets ?? []).find((a) => a.address.toLowerCase() === (chain.contracts.usdc as string).toLowerCase())
  if (!asset) {
    return { ok: false, reason: `Gateway's asset list for ${chain.caip2} does not include this chain's canonical USDC ${chain.contracts.usdc}` }
  }
  const result: ProvenKindResult = {
    ok: true,
    proven: { kind, asset, provenAt: new Date(calls.now()).toISOString(), facilitator: chain.gateway.facilitator },
  }
  kindCache.set(key, { at: calls.now(), result })
  return result
}

// ── the read-back ───────────────────────────────────────────────────────────────

export type ReadBack = { transfer: GatewayTransfer; attempts: number }

/**
 * Find the transfer Gateway credited for this authorization. Retried a few times with a
 * short pause because the transfers index is written after settle returns; bounded so a
 * missing row costs a couple of seconds, not a request that never ends.
 */
export async function readBackTransfer(
  chain: ChainDescriptor,
  match: { nonce: string; payTo: string; value: string; payer?: string; transferId?: string },
  deps: GatewayDeps = {},
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<ReadBack | { transfer: null; attempts: number; reason: string }> {
  if (!chain.gateway) return { transfer: null, attempts: 0, reason: 'no gateway on this chain' }
  const calls = gatewayCalls(deps)
  const attempts = opts.attempts ?? 4
  const delayMs = opts.delayMs ?? 600
  let lastReason = 'no transfer returned for this nonce'
  for (let i = 1; i <= attempts; i++) {
    try {
      let rows = await calls.searchTransfers(chain.gateway.facilitator, { network: chain.caip2, nonce: match.nonce })
      if (!rows.length && match.transferId && !/^0x[0-9a-fA-F]{64}$/.test(match.transferId)) {
        rows = await calls.searchTransfers(chain.gateway.facilitator, { network: chain.caip2, id: match.transferId })
      }
      const hit = rows.find(
        (t) =>
          t.toAddress.toLowerCase() === match.payTo.toLowerCase() &&
          String(t.amount) === match.value &&
          (!match.payer || t.fromAddress.toLowerCase() === match.payer.toLowerCase()) &&
          (!t.nonce || t.nonce.toLowerCase() === match.nonce.toLowerCase()),
      )
      if (hit) return { transfer: hit, attempts: i }
      if (rows.length) lastReason = `Gateway returned ${rows.length} transfer(s) for this nonce but none to ${match.payTo} for ${match.value} units`
    } catch (e) {
      lastReason = `Gateway transfers read failed: ${e instanceof Error ? e.message : String(e)}`
    }
    if (i < attempts) await calls.sleep(delayMs)
  }
  return { transfer: null, attempts, reason: lastReason }
}
