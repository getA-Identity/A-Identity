/**
 * Reads from NEAR in the browser, over JSON-RPC, and nothing that signs or sends.
 *
 * The same discipline as the backend's reader (mcp/src/chains/near/client.ts), which src/
 * cannot import, and the same reason for plain fetch over an SDK: NEAR's JSON-RPC is small
 * enough that a dependency would be most of the code, and this file stays testable with a stub.
 *
 * - The hosts are the registry's (src/lib/chains.ts, generated). This file names none.
 * - A read FAILS OVER host by host only when a host could not answer: the request failed, the
 *   body was not JSON-RPC, the status was not 2xx and the body decided nothing, or the error is
 *   one another host may not repeat (a timeout, an internal error, a pruned block).
 * - An answer about the CHAIN is final and comes back as `decided`: UNKNOWN_ACCOUNT means the
 *   account does not exist at that block, and asking the next host would only be fishing for a
 *   different answer. So is an id NEAR rejects and a view that ran and failed.
 * - The body is read whatever the HTTP status, because nearcore sends a decided PARSE_ERROR as a
 *   400 on some hosts and a 200 on others (read live 2026-11-12).
 * - A view that ran and failed also arrives as a 200 with an `error` string inside the result
 *   (CodeDoesNotExist, MethodNotFound, a panic), and is decided the same way.
 *
 * Transaction status is the one read that treats "not found" as "ask the next host": a host that
 * has not seen a hash yet, or a pruned node that forgot it, says UNKNOWN_TRANSACTION, and the
 * archival host the registry lists last may know it.
 *
 * Import-free (types aside), so near.test.ts can load it through Node's type stripping.
 */

export type RpcDeps = {
  /** Production passes nothing and gets the global fetch. */
  fetchImpl?: typeof fetch
  /** Per-host timeout, in milliseconds. */
  timeoutMs?: number
}

/** One host's reply, judged on its own. */
export type HostReply<T> =
  | { kind: 'ok'; result: T }
  | { kind: 'decided'; cause: string; message: string; blockHeight: number | null }
  | { kind: 'failed'; reason: string }

/** Every host failed to answer. Carries each host and why, so the page can say which. */
export class NearUnreachable extends Error {
  readonly tried: { host: string; reason: string }[]
  constructor(tried: { host: string; reason: string }[]) {
    super(`no NEAR RPC host answered: ${tried.map((t) => `${t.host} (${t.reason})`).join('; ') || 'none configured'}`)
    this.name = 'NearUnreachable'
    this.tried = tried
  }
}

/** Causes that describe the chain, not the host. */
const DECIDED_CAUSES = new Set([
  'UNKNOWN_ACCOUNT',
  'INVALID_ACCOUNT',
  'PARSE_ERROR',
  'NO_CONTRACT_CODE',
  'CONTRACT_EXECUTION_ERROR',
  'UNKNOWN_ACCESS_KEY',
  'UNKNOWN_TRANSACTION',
])

const DEFAULT_TIMEOUT_MS = 8_000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Judge one host's reply. `body` is the parsed JSON, or undefined when the body was not JSON.
 * Pure: the whole failover policy lives here and in the loop below.
 */
export function judgeReply<T>(status: number, body: unknown): HostReply<T> {
  const ok = status >= 200 && status < 300
  if (body === undefined) return { kind: 'failed', reason: ok ? 'the reply was not JSON' : `HTTP ${status}` }
  const error = isObject(body) && isObject(body.error) ? body.error : null
  const rawCause = error?.cause
  const cause = typeof rawCause === 'string' ? rawCause : isObject(rawCause) && typeof rawCause.name === 'string' ? rawCause.name : null
  if (error && cause && DECIDED_CAUSES.has(cause)) {
    const info = isObject(rawCause) && isObject(rawCause.info) ? rawCause.info : null
    const height = info && typeof info.block_height === 'number' ? info.block_height : null
    const message = typeof error.data === 'string' ? error.data : typeof error.message === 'string' ? error.message : cause
    return { kind: 'decided', cause, message, blockHeight: height }
  }
  // Nothing decided past this point, so a non-2xx status is the host failing.
  if (!ok) return { kind: 'failed', reason: cause ? `HTTP ${status} ${cause}` : `HTTP ${status}` }
  if (error) return { kind: 'failed', reason: cause ?? (typeof error.name === 'string' ? error.name : 'RPC error') }
  if (!isObject(body) || !('result' in body)) return { kind: 'failed', reason: 'not a JSON-RPC answer' }
  return { kind: 'ok', result: body.result as T }
}

export type RpcAnswer<T> =
  | { kind: 'ok'; result: T; host: string }
  | { kind: 'decided'; cause: string; message: string; blockHeight: number | null; host: string }

/** One JSON-RPC call, asked of each host in order until one ANSWERS. Throws NearUnreachable when none does. */
export async function nearRpc<T>(urls: readonly string[], method: string, params: unknown, deps: RpcDeps = {}): Promise<RpcAnswer<T>> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const tried: { host: string; reason: string }[] = []
  for (const url of urls) {
    const host = hostOf(url)
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'a-identity', method, params }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (e) {
      tried.push({ host, reason: e instanceof Error ? e.message : String(e) })
      continue
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    const reply = judgeReply<T>(res.status, body)
    if (reply.kind === 'failed') {
      tried.push({ host, reason: reply.reason })
      continue
    }
    return { ...reply, host }
  }
  throw new NearUnreachable(tried)
}

/** JSON args as the base64 a call_function query carries, UTF-8 safe. */
export function encodeArgs(args: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(args))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** A view's result bytes (an array of byte values) as JSON. Empty is null. Throws on bytes that are not JSON. */
export function decodeResult(bytes: unknown): unknown {
  if (!Array.isArray(bytes) || bytes.some((b) => typeof b !== 'number' || b < 0 || b > 255 || !Number.isInteger(b))) {
    throw new Error('the view returned no result bytes')
  }
  const text = new TextDecoder().decode(Uint8Array.from(bytes as number[]))
  return text === '' ? null : JSON.parse(text)
}

/** Why a view did not return a value. */
export type ViewFailure = 'no-account' | 'no-code' | 'no-method' | 'panic' | 'not-json' | 'other'

/** The chain's own words for a failed view, sorted into what the page can say about it. */
export function classifyViewError(text: string): ViewFailure {
  if (/UNKNOWN_ACCOUNT|does not exist while viewing/.test(text)) return 'no-account'
  if (/CodeDoesNotExist|NO_CONTRACT_CODE/.test(text)) return 'no-code'
  if (/MethodNotFound|MethodResolveError/.test(text)) return 'no-method'
  if (/GuestPanic|panicked|Smart contract panicked/.test(text)) return 'panic'
  return 'other'
}

export type ViewResult =
  | { ok: true; value: unknown; blockHeight: number; host: string }
  | { ok: false; why: ViewFailure; detail: string; blockHeight: number | null; host: string }

/** A contract's read-only method at the latest final block, its return value parsed as JSON. */
export async function viewCall(urls: readonly string[], contractId: string, method: string, args: Record<string, unknown> = {}, deps: RpcDeps = {}): Promise<ViewResult> {
  const answer = await nearRpc<{ result?: unknown; error?: unknown; block_height?: unknown }>(
    urls,
    'query',
    { request_type: 'call_function', finality: 'final', account_id: contractId, method_name: method, args_base64: encodeArgs(args) },
    deps,
  )
  if (answer.kind === 'decided') {
    const detail = `${answer.cause}: ${answer.message}`
    return { ok: false, why: classifyViewError(detail), detail, blockHeight: answer.blockHeight, host: answer.host }
  }
  const r = isObject(answer.result) ? answer.result : {}
  const height = typeof r.block_height === 'number' ? r.block_height : null
  if (typeof r.error === 'string') return { ok: false, why: classifyViewError(r.error), detail: r.error, blockHeight: height, host: answer.host }
  try {
    return { ok: true, value: decodeResult(r.result), blockHeight: height ?? 0, host: answer.host }
  } catch (e) {
    return { ok: false, why: 'not-json', detail: e instanceof Error ? e.message : String(e), blockHeight: height, host: answer.host }
  }
}

/** The empty contract hash: base58 of 32 zero bytes. An account with it carries no contract. */
export const EMPTY_CODE_HASH = '11111111111111111111111111111111'

export type AccountRead =
  | { exists: false; blockHeight: number | null; host: string }
  | {
      exists: true
      amountYocto: bigint
      lockedYocto: bigint
      codeHash: string
      hasContract: boolean
      storageUsage: number
      blockHeight: number
      host: string
    }

/** A view_account result, checked field by field. Null when it is not one. */
export function parseAccountView(r: unknown): Omit<Extract<AccountRead, { exists: true }>, 'host'> | null {
  if (!isObject(r)) return null
  const { amount, locked, code_hash: codeHash, storage_usage: storage, block_height: height } = r
  if (typeof amount !== 'string' || !/^\d+$/.test(amount) || typeof codeHash !== 'string' || codeHash === '') return null
  return {
    exists: true,
    amountYocto: BigInt(amount),
    lockedYocto: typeof locked === 'string' && /^\d+$/.test(locked) ? BigInt(locked) : 0n,
    codeHash,
    hasContract: codeHash !== EMPTY_CODE_HASH,
    storageUsage: typeof storage === 'number' ? storage : 0,
    blockHeight: typeof height === 'number' ? height : 0,
  }
}

/** view_account at the latest final block. A missing account is an answer, not an error. */
export async function viewAccount(urls: readonly string[], accountId: string, deps: RpcDeps = {}): Promise<AccountRead> {
  const answer = await nearRpc<unknown>(urls, 'query', { request_type: 'view_account', finality: 'final', account_id: accountId }, deps)
  if (answer.kind === 'decided') {
    if (answer.cause === 'UNKNOWN_ACCOUNT') return { exists: false, blockHeight: answer.blockHeight, host: answer.host }
    throw new Error(`${answer.host} refused view_account for ${accountId}: ${answer.cause}`)
  }
  const parsed = parseAccountView(answer.result)
  if (!parsed) throw new Error(`${answer.host} answered view_account for ${accountId} with something that is not an account`)
  return { ...parsed, host: answer.host }
}

export type AccessKey = {
  publicKey: string
  nonce: string
  permission: { kind: 'full' } | { kind: 'call'; receiverId: string; methodNames: string[]; allowanceYocto: bigint | null }
}

/**
 * A view_access_key_list result. Null when the shape is not one.
 *
 * Careful with an empty list: NEAR answers `keys: []` for an account that does not exist, so an
 * empty list says nothing about a vault until view_account has shown the account is there.
 */
export function parseAccessKeys(r: unknown): { keys: AccessKey[]; blockHeight: number } | null {
  if (!isObject(r) || !Array.isArray(r.keys)) return null
  const keys: AccessKey[] = []
  for (const k of r.keys) {
    if (!isObject(k) || typeof k.public_key !== 'string' || !isObject(k.access_key)) return null
    const { nonce, permission } = k.access_key
    const n = typeof nonce === 'number' || typeof nonce === 'string' ? String(nonce) : '0'
    if (permission === 'FullAccess') {
      keys.push({ publicKey: k.public_key, nonce: n, permission: { kind: 'full' } })
      continue
    }
    const fc = isObject(permission) && isObject(permission.FunctionCall) ? permission.FunctionCall : null
    if (!fc || typeof fc.receiver_id !== 'string' || !Array.isArray(fc.method_names)) return null
    const allowance = typeof fc.allowance === 'string' && /^\d+$/.test(fc.allowance) ? BigInt(fc.allowance) : null
    keys.push({
      publicKey: k.public_key,
      nonce: n,
      permission: { kind: 'call', receiverId: fc.receiver_id, methodNames: fc.method_names.map(String), allowanceYocto: allowance },
    })
  }
  return { keys, blockHeight: typeof r.block_height === 'number' ? r.block_height : 0 }
}

/** The access keys an account carries, read live. Pair it with viewAccount: see parseAccessKeys. */
export async function viewAccessKeys(urls: readonly string[], accountId: string, deps: RpcDeps = {}): Promise<{ keys: AccessKey[]; blockHeight: number; host: string }> {
  const answer = await nearRpc<unknown>(urls, 'query', { request_type: 'view_access_key_list', finality: 'final', account_id: accountId }, deps)
  if (answer.kind === 'decided') throw new Error(`${answer.host} refused view_access_key_list for ${accountId}: ${answer.cause}`)
  const parsed = parseAccessKeys(answer.result)
  if (!parsed) throw new Error(`${answer.host} answered view_access_key_list for ${accountId} with something that is not a key list`)
  return { ...parsed, host: answer.host }
}

/** The latest final block: its height and its own clock, which is the clock the vault enforces days and expiries by. */
export async function finalBlock(urls: readonly string[], deps: RpcDeps = {}): Promise<{ height: number; timestampNs: bigint; host: string }> {
  const answer = await nearRpc<{ header?: { height?: unknown; timestamp_nanosec?: unknown } }>(urls, 'block', { finality: 'final' }, deps)
  if (answer.kind === 'decided') throw new Error(`${answer.host} refused block: ${answer.cause}`)
  const h = answer.result?.header
  const ts = h?.timestamp_nanosec
  if (typeof h?.height !== 'number' || typeof ts !== 'string' || !/^\d+$/.test(ts)) throw new Error(`${answer.host} answered block with no height or time`)
  return { height: h.height, timestampNs: BigInt(ts), host: answer.host }
}

export type TxLookup =
  /** No host has seen this hash: not yet, or not with this signer. */
  | { state: 'unknown' }
  /** A host has it, not final yet. */
  | { state: 'pending'; finality: string; host: string }
  | { state: 'final'; outcome: unknown; host: string }

/**
 * Where a transaction stands, asked without waiting (wait_until NONE), so one call never blocks
 * on a host's 10 second deadline. A host that has not seen the hash moves the question on to
 * the next one; only every host failing to answer at all is thrown.
 */
export async function txStatus(urls: readonly string[], hash: string, signerId: string, deps: RpcDeps = {}): Promise<TxLookup> {
  let pending: TxLookup | null = null
  let answered = false
  const tried: { host: string; reason: string }[] = []
  for (const url of urls) {
    let answer: RpcAnswer<{ final_execution_status?: unknown }>
    try {
      answer = await nearRpc(
        [url],
        'tx',
        { tx_hash: hash, sender_account_id: signerId, wait_until: 'NONE' },
        deps,
      )
    } catch (e) {
      if (e instanceof NearUnreachable) tried.push(...e.tried)
      continue
    }
    answered = true
    if (answer.kind === 'decided') continue
    const finality = typeof answer.result?.final_execution_status === 'string' ? answer.result.final_execution_status : 'NONE'
    if (finality === 'FINAL') return { state: 'final', outcome: answer.result, host: answer.host }
    pending ??= { state: 'pending', finality, host: answer.host }
  }
  if (pending) return pending
  if (!answered) throw new NearUnreachable(tried)
  return { state: 'unknown' }
}
