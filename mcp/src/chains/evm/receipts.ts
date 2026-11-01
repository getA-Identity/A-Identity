/**
 * Read a transaction's receipt, or the transaction itself, from EVERY RPC a chain lists, one
 * host at a time.
 *
 * Why not the fallback transport the rest of this directory uses: viem's fallback moves to
 * the next transport only when one throws, and a host that does not have a receipt does not
 * throw, it answers null. On 2026-10-11 the Blockdaemon host on Arc Mainnet answered null for
 * every one of the 19 receipts the provenance ledger cites, so a fallback client that asked
 * it first reported a mined transaction as unknown. Reading the transaction is no better:
 * on 2026-11-01, for the vault payment 0xc1f3eb7f, three of Arc Mainnet's four hosts returned
 * the receipt and only dRPC returned the transaction.
 *
 * So each round asks every host in resolveRpcUrls(chain) order by itself, the first non-null
 * answer wins, and the two failures are kept apart: not_found means at least one host
 * answered and none had it (it may not have landed yet), unreachable means no host answered
 * at all. Rounds repeat until the time budget is spent; the default budget is a single round.
 * Every call has its own deadline, so one stalled host costs its timeout and not the request.
 *
 * Reusable on purpose: anything that has to prove a transaction landed can call this rather
 * than trusting whichever host a fallback client happened to reach first.
 */
import { formatTransaction, formatTransactionReceipt, type Hex, type Transaction, type TransactionReceipt } from 'viem'
import type { ChainDescriptor } from '../types.js'
import { resolveRpcUrls } from './client.js'

/** One JSON-RPC request against one URL. Resolves with the raw `result`, null included;
 *  rejects when the host gave no usable answer (transport error, HTTP error, RPC error). */
export type RpcCall = (url: string, method: string, params: readonly unknown[], timeoutMs: number) => Promise<unknown>

/** What one host said in the last round. */
export type HostAnswer = { url: string; answer: 'found' | 'null' | 'error'; error?: string }

export type EveryRpcRead<T> =
  | { status: 'found'; value: T; url: string; rounds: number; answers: HostAnswer[] }
  /** At least one host answered, and none had it. */
  | { status: 'not_found'; rounds: number; answers: HostAnswer[] }
  /** No host gave a usable answer in any round. */
  | { status: 'unreachable'; rounds: number; answers: HostAnswer[] }

export type EveryRpcOptions = {
  env?: NodeJS.ProcessEnv
  /** The hosts to ask, in order. Default: resolveRpcUrls(chain, env). */
  urls?: readonly string[]
  /** The JSON-RPC caller. Injected by tests; the default is a plain fetch. */
  call?: RpcCall
  /** Total time budget across rounds, in ms. 0 (the default) is a single round. */
  timeoutMs?: number
  /** Deadline for each single call, in ms. Default 6000. */
  perCallTimeoutMs?: number
  /** Pause between rounds, in ms. Default 1500. */
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const DEFAULT_PER_CALL_MS = 6000
const DEFAULT_POLL_MS = 1500
const TX_HASH = /^0x[0-9a-fA-F]{64}$/

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Race a promise against a deadline. The timer is cleared on every exit and deliberately not
 * unref'd: an unref'd deadline lets the process exit with the promise still pending.
 */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([p, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The default caller: one JSON-RPC POST, aborted at the deadline. */
export const jsonRpcCall: RpcCall = async (url, method, params, timeoutMs) => {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctl.signal,
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const body = (await r.json()) as { result?: unknown; error?: { code?: number; message?: string } }
    if (body.error) throw new Error(`RPC error ${body.error.code ?? ''} ${body.error.message ?? ''}`.trim())
    if (!('result' in body)) throw new Error('the JSON-RPC answer carries no result')
    return body.result
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Where an answer came from, safe to publish. A registry host is named by its host; an
 * override from the chain's rpcEnvVar may carry credentials in its path or query, so it is
 * only ever called the override, never printed.
 */
export function rpcSourceLabel(chain: ChainDescriptor, url: string): string {
  if (!chain.rpcUrls.includes(url)) return `${chain.rpcEnvVar ?? 'rpc'} override`
  try {
    return new URL(url).host
  } catch {
    return 'registry rpc'
  }
}

async function fromEveryRpc<T>(
  chain: ChainDescriptor,
  method: string,
  hash: string,
  parse: (raw: unknown) => T,
  opts: EveryRpcOptions,
): Promise<EveryRpcRead<T>> {
  if (!TX_HASH.test(hash)) throw new TypeError(`not a transaction hash: ${hash}`)
  const urls = opts.urls ?? resolveRpcUrls(chain, opts.env ?? process.env)
  const call = opts.call ?? jsonRpcCall
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const perCall = opts.perCallTimeoutMs ?? DEFAULT_PER_CALL_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const deadline = now() + Math.max(0, opts.timeoutMs ?? 0)
  let rounds = 0
  let anyAnswered = false
  let answers: HostAnswer[] = []
  if (!urls.length) return { status: 'unreachable', rounds, answers }
  for (;;) {
    rounds += 1
    answers = []
    for (const url of urls) {
      try {
        const raw = await withDeadline(call(url, method, [hash], perCall), perCall)
        if (raw === null || raw === undefined) {
          anyAnswered = true
          answers.push({ url, answer: 'null' })
          continue
        }
        // A malformed answer, or one about another transaction, is this host failing, not
        // this host proving anything; the next host is still asked.
        const value = parse(raw)
        answers.push({ url, answer: 'found' })
        return { status: 'found', value, url, rounds, answers }
      } catch (e) {
        answers.push({ url, answer: 'error', error: msg(e) })
      }
    }
    if (now() + pollMs > deadline) break
    await sleep(pollMs)
  }
  return anyAnswered ? { status: 'not_found', rounds, answers } : { status: 'unreachable', rounds, answers }
}

function parseReceipt(hash: string) {
  return (raw: unknown): TransactionReceipt => {
    if (typeof raw !== 'object' || raw === null) throw new Error('the receipt is not an object')
    const r = formatTransactionReceipt(raw as never) as TransactionReceipt
    if (typeof r.transactionHash !== 'string' || r.transactionHash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error('answered with a receipt for another transaction')
    }
    if (r.status !== 'success' && r.status !== 'reverted') throw new Error('the receipt carries no status')
    if (typeof r.blockNumber !== 'bigint') throw new Error('the receipt carries no block number')
    if (!Array.isArray(r.logs)) throw new Error('the receipt carries no logs array')
    return r
  }
}

function parseTransaction(hash: string) {
  return (raw: unknown): Transaction => {
    if (typeof raw !== 'object' || raw === null) throw new Error('the transaction is not an object')
    const t = formatTransaction(raw as never) as Transaction
    if (typeof t.hash !== 'string' || t.hash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error('answered with another transaction')
    }
    if (typeof t.from !== 'string' || typeof t.input !== 'string') throw new Error('the transaction carries no sender or input')
    return t
  }
}

/** The receipt, from the first host that has it. */
export function receiptFromEveryRpc(chain: ChainDescriptor, hash: Hex | string, opts: EveryRpcOptions = {}): Promise<EveryRpcRead<TransactionReceipt>> {
  return fromEveryRpc(chain, 'eth_getTransactionReceipt', hash, parseReceipt(hash), opts)
}

/** The transaction itself (sender, target, input, fees), from the first host that has it. */
export function transactionFromEveryRpc(chain: ChainDescriptor, hash: Hex | string, opts: EveryRpcOptions = {}): Promise<EveryRpcRead<Transaction>> {
  return fromEveryRpc(chain, 'eth_getTransactionByHash', hash, parseTransaction(hash), opts)
}
