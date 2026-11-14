/**
 * The NEAR side of the chain layer: JSON-RPC READS against the descriptor's hosts, and
 * nothing that signs or sends.
 *
 * The reads anything here needs today: `status` (which network a host is on, and how far it
 * has got), `view_account` (does an account exist, and does it carry contract code), a
 * `call_function` view (a contract's read-only method, such as a NEP-141 token's ft_metadata),
 * and, for the NEAR x402 rail (near-x402/), the final `block` (the height a delegate's window
 * is measured from, and the hash a transaction references) and `view_access_key` (a key's
 * nonce and permission). Plain fetch, no SDK: NEAR's JSON-RPC is small enough that a
 * dependency would be most of the code, and this file has to stay testable with a stub.
 *
 * The discipline is chains/stellar/client.ts's, applied to a different protocol:
 *
 * - The hosts come from the descriptor through `resolveRpcUrls`, so the descriptor's
 *   `rpcEnvVar` override replaces the primary and keeps the other public hosts behind it.
 * - READS fail over, host by host, but only when a host could not answer: the request
 *   failed, the body was not JSON-RPC, the status was not 2xx and the body named no decided
 *   cause, or the error is one a different host may not repeat (an unknown or
 *   garbage-collected block on a pruned node, a shard it does not track, a timeout, an
 *   internal error). An answer about the CHAIN is final: UNKNOWN_ACCOUNT means the account
 *   does not exist at that block, and asking the next host would only be fishing for a
 *   different answer, so it is returned as decided rather than retried. The same holds for an
 *   id NEAR rejects (PARSE_ERROR, INVALID_ACCOUNT) and for a view that ran and failed
 *   (NO_CONTRACT_CODE, CONTRACT_EXECUTION_ERROR, or the `error` string nearcore returns inside
 *   a call_function result).
 * - So the body is read whatever the status. A decided error does not always come with a
 *   200: nearcore's own server sends every REQUEST_VALIDATION_ERROR as HTTP 400, a
 *   TIMEOUT_ERROR as 408 and an INTERNAL_ERROR as 500 (rpc_handler in nearcore's
 *   chain/jsonrpc/src/lib.rs), and read live 2026-11-12 both FastNEAR hosts send PARSE_ERROR
 *   as 400 where drpc sends it as 200. Judging by the status alone would call a reachable
 *   network unreachable whenever drpc was the host down. A non-2xx body that names no decided
 *   cause is still the host failing, and fails over.
 * - A submission never fails over, and none lives here. When one is added it must not route
 *   through `nearRpc`, because re-sending a transaction to a second host after a timeout is
 *   how a payment goes out twice.
 * - nearcore does not support JSON-RPC batches (docs.near.org), so each call is one request.
 */
import type { ChainDescriptor } from '../types.js'
import { parseCaip2 } from '../caip.js'
import { resolveRpcUrls } from '../evm/client.js'
import { isNearAccountId, isNearTxHash } from './ids.js'

/** The seams the unit tests use. Production passes nothing and gets the global fetch. */
export type NearReadDeps = {
  fetchImpl?: typeof fetch
  /** Per-host timeout, in milliseconds. */
  timeoutMs?: number
}

/** One host's answer. `decided` is an error about the chain itself, which no other host would contradict. */
export type NearAnswer<T> =
  | { kind: 'ok'; result: T; host: string }
  | { kind: 'decided'; cause: string; message: string; host: string }

/** Every host failed to answer. Carries each host and why, so the caller can say which. */
export class NearRpcUnreachable extends Error {
  constructor(readonly tried: { host: string; reason: string }[]) {
    super(`no NEAR RPC host answered: ${tried.map((t) => `${t.host} (${t.reason})`).join('; ') || 'none configured'}`)
    this.name = 'NearRpcUnreachable'
  }
}

/** Errors that describe the chain, not the host. See the header for why each is final. */
const DECIDED_CAUSES = new Set([
  'UNKNOWN_ACCOUNT',
  'INVALID_ACCOUNT',
  'PARSE_ERROR',
  'NO_CONTRACT_CODE',
  'CONTRACT_EXECUTION_ERROR',
  // A key the account does not hold. Current nearcore answers that inside the result instead
  // (an `error` string, read live 2026-11-12 UTC, see nearViewAccessKey), so this covers the
  // HANDLER_ERROR form of the same answer.
  'UNKNOWN_ACCESS_KEY',
])

/** The code_hash of an account with no contract: base58 of 32 zero bytes. */
export const NEAR_EMPTY_CODE_HASH = '11111111111111111111111111111111'

const DEFAULT_TIMEOUT_MS = 8_000

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Every RPC url this NEAR chain can be read from, primary (or its env override) first. */
export function nearRpcUrls(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): string[] {
  if (chain.ecosystem !== 'near') throw new Error(`nearRpcUrls: ${chain.id} is not a NEAR chain (${chain.ecosystem})`)
  const urls = resolveRpcUrls(chain, env)
  if (urls.length === 0) throw new Error(`${chain.id} declares no RPC url`)
  return urls
}

/**
 * One JSON-RPC call, asked of each host in order until one ANSWERS.
 *
 * Returns `ok` with the result, or `decided` with the cause a host gave about the chain.
 * Throws NearRpcUnreachable only when no host could answer at all.
 */
export async function nearRpc<T>(
  chain: ChainDescriptor,
  method: string,
  params: unknown,
  env: NodeJS.ProcessEnv = process.env,
  deps: NearReadDeps = {},
): Promise<NearAnswer<T>> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const tried: { host: string; reason: string }[] = []
  for (const url of nearRpcUrls(chain, env)) {
    const host = hostOf(url)
    let res: Response
    let body: {
      result?: T
      error?: { name?: string; message?: string; data?: unknown; cause?: string | { name?: string; info?: unknown } }
    }
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
    try {
      // Read whatever the status: see the header for the decided error that arrives as a 400.
      body = (await res.json()) as typeof body
    } catch (e) {
      tried.push({ host, reason: res.ok ? (e instanceof Error ? e.message : String(e)) : `HTTP ${res.status}` })
      continue
    }
    const error = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : undefined
    const cause = error ? (typeof error.cause === 'string' ? error.cause : error.cause?.name) : undefined
    if (error && cause && DECIDED_CAUSES.has(cause)) {
      const message = typeof error.data === 'string' ? error.data : (error.message ?? cause)
      return { kind: 'decided', cause, message, host }
    }
    // Past this point nothing decided was said, so a non-2xx status is the host failing,
    // whatever else its body carries.
    if (!res.ok) {
      tried.push({ host, reason: cause ? `HTTP ${res.status} ${cause}` : `HTTP ${res.status}` })
      continue
    }
    if (body && typeof body === 'object' && body.error) {
      tried.push({ host, reason: cause ?? error?.name ?? 'rpc error' })
      continue
    }
    if (!body || typeof body !== 'object' || !('result' in body)) {
      tried.push({ host, reason: 'not a JSON-RPC answer' })
      continue
    }
    return { kind: 'ok', result: body.result as T, host }
  }
  throw new NearRpcUnreachable(tried)
}

/** What `status` says about a host, after checking it is on the network the descriptor names. */
export type NearStatus = { chainId: string; protocolVersion: number; latestBlockHeight: number; syncing: boolean; host: string }

/**
 * `status`, plus the one check that makes every later read trustworthy: the host's chain_id
 * must be the network in the descriptor's CAIP-2 id (`near:testnet` -> `testnet`). An env
 * override pointed at a mainnet RPC would otherwise answer every read with mainnet state, and
 * nothing downstream could tell. A mismatch throws rather than failing over, because the next
 * read would go to that same misconfigured host first.
 */
export async function nearStatus(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env, deps: NearReadDeps = {}): Promise<NearStatus> {
  const answer = await nearRpc<{
    chain_id?: string
    protocol_version?: number
    sync_info?: { latest_block_height?: number; syncing?: boolean }
  }>(chain, 'status', [], env, deps)
  if (answer.kind === 'decided') throw new Error(`${answer.host} refused status: ${answer.cause}`)
  const expected = parseCaip2(chain.caip2)?.reference
  const chainId = String(answer.result?.chain_id ?? '')
  if (!expected || chainId !== expected) {
    throw new Error(`${answer.host} answered chain_id "${chainId}", but ${chain.id} is ${chain.caip2}`)
  }
  const height = Number(answer.result?.sync_info?.latest_block_height)
  if (!Number.isSafeInteger(height) || height < 0) throw new Error(`${answer.host} answered status with no block height`)
  return {
    chainId,
    protocolVersion: Number(answer.result?.protocol_version ?? 0),
    latestBlockHeight: height,
    syncing: Boolean(answer.result?.sync_info?.syncing),
    host: answer.host,
  }
}

export type NearAccountView =
  | {
      exists: true
      /** Balance in yoctoNEAR (10^24 per NEAR), as the integer string the RPC returns. */
      amountYocto: string
      codeHash: string
      /** False when code_hash is the empty hash: the account exists and carries no contract. */
      hasContract: boolean
      storageUsage: number
      blockHeight: number
      host: string
    }
  | { exists: false; host: string }

/** `view_account` at final finality. A missing account is a decided answer, not an error. */
export async function nearViewAccount(
  chain: ChainDescriptor,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: NearReadDeps = {},
): Promise<NearAccountView> {
  // Checked here first, so a malformed id costs no request and cannot be mistaken for a host problem.
  if (!isNearAccountId(accountId)) throw new Error(`"${accountId}" is not a NEAR account id`)
  const answer = await nearRpc<{ amount?: string; code_hash?: string; storage_usage?: number; block_height?: number }>(
    chain,
    'query',
    { request_type: 'view_account', finality: 'final', account_id: accountId },
    env,
    deps,
  )
  if (answer.kind === 'decided') {
    if (answer.cause === 'UNKNOWN_ACCOUNT') return { exists: false, host: answer.host }
    throw new Error(`${answer.host} refused view_account ${accountId}: ${answer.cause}`)
  }
  const codeHash = String(answer.result?.code_hash ?? '')
  if (!codeHash) throw new Error(`${answer.host} answered view_account ${accountId} with no code_hash`)
  return {
    exists: true,
    amountYocto: String(answer.result?.amount ?? '0'),
    codeHash,
    hasContract: codeHash !== NEAR_EMPTY_CODE_HASH,
    storageUsage: Number(answer.result?.storage_usage ?? 0),
    blockHeight: Number(answer.result?.block_height ?? 0),
    host: answer.host,
  }
}

export type NearViewResult =
  | { ok: true; value: unknown; logs: string[]; blockHeight: number; host: string }
  | { ok: false; reason: string; host: string }

/**
 * A contract's read-only method, called with JSON args, its return value parsed as JSON.
 *
 * A view that RAN and failed is a decided `ok: false` with the chain's own words: a missing
 * account, an account with no code, a method that does not exist, a panic. Those come back two
 * ways (a HANDLER_ERROR cause, or an `error` string inside the result on current nearcore,
 * read live 2026-11-12) and both are handled. Only a host that could not answer at all moves
 * the call to the next host.
 */
export async function nearViewFunction(
  chain: ChainDescriptor,
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
  deps: NearReadDeps = {},
): Promise<NearViewResult> {
  if (!isNearAccountId(contractId)) throw new Error(`"${contractId}" is not a NEAR account id`)
  const answer = await nearRpc<{ result?: number[]; logs?: string[]; block_height?: number; error?: string }>(
    chain,
    'query',
    {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    },
    env,
    deps,
  )
  if (answer.kind === 'decided') return { ok: false, reason: `${answer.cause}: ${answer.message}`, host: answer.host }
  const r = answer.result ?? {}
  if (typeof r.error === 'string') return { ok: false, reason: r.error, host: answer.host }
  if (!Array.isArray(r.result)) throw new Error(`${answer.host} answered call_function ${methodName} with no result bytes`)
  const text = Buffer.from(r.result).toString('utf8')
  let value: unknown
  try {
    value = text === '' ? null : JSON.parse(text)
  } catch {
    throw new Error(`${contractId}.${methodName} returned bytes that are not JSON`)
  }
  return { ok: true, value, logs: Array.isArray(r.logs) ? r.logs.map(String) : [], blockHeight: Number(r.block_height ?? 0), host: answer.host }
}

/** A final block: the height a delegate action's window is measured from (x402 exact on NEAR
 *  measures it at FINAL), and the hash a new transaction references. */
export type NearFinalBlock = { height: number; hash: string; host: string }

/** `block` at final finality. A host that answers with no height or no 32-byte hash fails over. */
export async function nearFinalBlock(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env, deps: NearReadDeps = {}): Promise<NearFinalBlock> {
  const answer = await nearRpc<{ header?: { height?: number; hash?: string } }>(chain, 'block', { finality: 'final' }, env, deps)
  if (answer.kind === 'decided') throw new Error(`${answer.host} refused block: ${answer.cause}`)
  const height = Number(answer.result?.header?.height)
  const hash = String(answer.result?.header?.hash ?? '')
  // A block hash is a 32-byte CryptoHash in base58, the same shape as a transaction hash.
  if (!Number.isSafeInteger(height) || height <= 0 || !isNearTxHash(hash)) throw new Error(`${answer.host} answered block with no final height or hash`)
  return { height, hash, host: answer.host }
}

/** What a key may do, as view_access_key reports it. Anything that is neither a full-access key
 *  nor a plain function-call key is Unknown, so a caller can fail closed on a kind it has never seen. */
export type NearKeyPermission = 'FullAccess' | 'FunctionCall' | 'Unknown'

export type NearAccessKeyView =
  | { exists: true; nonce: bigint; permission: NearKeyPermission; blockHeight: number; host: string }
  | { exists: false; host: string }

const NEAR_PUBLIC_KEY_RE = /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{32,90}$/

/**
 * `view_access_key` at final finality: one key's nonce and permission. A key the account does not
 * hold, or an account that does not exist, is a decided `exists: false`. Current nearcore says the
 * first inside the result, as an `error` string ("access key ... does not exist while viewing",
 * read live on rpc.testnet.fastnear.com and near-testnet.drpc.org on 2026-11-12 UTC), not as an RPC
 * error, so both forms are read.
 */
export async function nearViewAccessKey(
  chain: ChainDescriptor,
  accountId: string,
  publicKey: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: NearReadDeps = {},
): Promise<NearAccessKeyView> {
  if (!isNearAccountId(accountId)) throw new Error(`"${accountId}" is not a NEAR account id`)
  if (!NEAR_PUBLIC_KEY_RE.test(publicKey)) throw new Error('not a NEAR public key (ed25519:<base58> or secp256k1:<base58>)')
  const answer = await nearRpc<{ nonce?: number | string; permission?: unknown; block_height?: number; error?: string }>(
    chain,
    'query',
    { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey },
    env,
    deps,
  )
  if (answer.kind === 'decided') {
    if (answer.cause === 'UNKNOWN_ACCOUNT' || answer.cause === 'UNKNOWN_ACCESS_KEY') return { exists: false, host: answer.host }
    throw new Error(`${answer.host} refused view_access_key on ${accountId}: ${answer.cause}`)
  }
  const r = answer.result ?? {}
  if (typeof r.error === 'string') {
    if (/does not exist/i.test(r.error)) return { exists: false, host: answer.host }
    throw new Error(`${answer.host} answered view_access_key on ${accountId} with an error: ${r.error}`)
  }
  const rawNonce = r.nonce
  if ((typeof rawNonce !== 'number' && typeof rawNonce !== 'string') || !/^\d+$/.test(String(rawNonce))) {
    throw new Error(`${answer.host} answered view_access_key on ${accountId} with no nonce`)
  }
  const p = r.permission
  const permission: NearKeyPermission =
    p === 'FullAccess' ? 'FullAccess' : p && typeof p === 'object' && 'FunctionCall' in (p as Record<string, unknown>) ? 'FunctionCall' : 'Unknown'
  return { exists: true, nonce: BigInt(String(rawNonce)), permission, blockHeight: Number(r.block_height ?? 0), host: answer.host }
}
