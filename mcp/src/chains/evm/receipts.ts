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
 * The budget only decides whether another round starts, so a round that began inside it can
 * run past it, one stalled host at a time; a hard deadline (hardTimeoutMs) is the ceiling on
 * the whole read: no call starts after it and a call in flight is cut off at it.
 *
 * The block at a height is read the same way, because a host that has not reached it answers
 * null too, and the caller can name the block hash the answer must carry.
 *
 * Reusable on purpose: anything that has to prove a transaction landed can call this rather
 * than trusting whichever host a fallback client happened to reach first. Whoever just
 * broadcast calls waitForReceiptOnEveryRpc, which adds the confirmation depth a chain asks for.
 */
import { formatBlock, formatTransaction, formatTransactionReceipt, type Hex, type Transaction, type TransactionReceipt } from 'viem'
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
  /** Total time budget across rounds, in ms. 0 (the default) is a single round. It decides
   *  only whether another round starts; a round in progress runs to its end. */
  timeoutMs?: number
  /** A hard ceiling on the whole read, in ms from its start: no call starts after it, and a
   *  call in flight is cut off at it. A host never asked is recorded as such. Unset: no
   *  ceiling beyond the round budget and the per-call deadlines. */
  hardTimeoutMs?: number
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
  params: readonly unknown[],
  parse: (raw: unknown) => T,
  opts: EveryRpcOptions,
): Promise<EveryRpcRead<T>> {
  const urls = opts.urls ?? resolveRpcUrls(chain, opts.env ?? process.env)
  const call = opts.call ?? jsonRpcCall
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const perCall = opts.perCallTimeoutMs ?? DEFAULT_PER_CALL_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const start = now()
  const deadline = start + Math.max(0, opts.timeoutMs ?? 0)
  const hardStop = opts.hardTimeoutMs === undefined ? Number.POSITIVE_INFINITY : start + Math.max(0, opts.hardTimeoutMs)
  let rounds = 0
  let anyAnswered = false
  let answers: HostAnswer[] = []
  if (!urls.length) return { status: 'unreachable', rounds, answers }
  for (;;) {
    rounds += 1
    answers = []
    for (const url of urls) {
      const left = hardStop - now()
      if (left <= 0) {
        answers.push({ url, answer: 'error', error: 'not asked: the read ran out of time' })
        continue
      }
      const ms = Math.min(perCall, left)
      try {
        const raw = await withDeadline(call(url, method, params, ms), ms)
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
    if (now() + pollMs > Math.min(deadline, hardStop)) break
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

/** A block's header facts: enough to time a transaction by the chain's own clock. */
export type BlockStamp = { number: bigint; hash: Hex; timestamp: bigint }

function parseBlock(want: { number: bigint; hash?: string }) {
  return (raw: unknown): BlockStamp => {
    if (typeof raw !== 'object' || raw === null) throw new Error('the block is not an object')
    const b = formatBlock(raw as never)
    if (b.number !== want.number) throw new Error('answered with another block')
    if (typeof b.hash !== 'string' || !TX_HASH.test(b.hash)) throw new Error('the block carries no hash')
    // A host that holds another block at this height (it reorged, or it is on another fork)
    // is a failing host, not a different answer: the next host is asked.
    if (want.hash && b.hash.toLowerCase() !== want.hash.toLowerCase()) throw new Error('answered with another block at this height')
    if (typeof b.timestamp !== 'bigint') throw new Error('the block carries no timestamp')
    return { number: b.number, hash: b.hash.toLowerCase() as Hex, timestamp: b.timestamp }
  }
}

/** The receipt, from the first host that has it. */
export async function receiptFromEveryRpc(chain: ChainDescriptor, hash: Hex | string, opts: EveryRpcOptions = {}): Promise<EveryRpcRead<TransactionReceipt>> {
  if (!TX_HASH.test(hash)) throw new TypeError(`not a transaction hash: ${hash}`)
  return fromEveryRpc(chain, 'eth_getTransactionReceipt', [hash], parseReceipt(hash), opts)
}

/** The transaction itself (sender, target, input, fees), from the first host that has it. */
export async function transactionFromEveryRpc(chain: ChainDescriptor, hash: Hex | string, opts: EveryRpcOptions = {}): Promise<EveryRpcRead<Transaction>> {
  if (!TX_HASH.test(hash)) throw new TypeError(`not a transaction hash: ${hash}`)
  return fromEveryRpc(chain, 'eth_getTransactionByHash', [hash], parseTransaction(hash), opts)
}

/** The latest block number, from the first host that answers. */
export async function blockNumberFromEveryRpc(chain: ChainDescriptor, opts: EveryRpcOptions = {}): Promise<EveryRpcRead<bigint>> {
  return fromEveryRpc(
    chain,
    'eth_blockNumber',
    [],
    (raw) => {
      if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error('the block number is not hex')
      return BigInt(raw)
    },
    opts,
  )
}

/** A receipt that exists but is not yet as deep as the caller asked. Not a settlement, and not
 *  a failure either. */
export type ShallowReceipt = {
  status: 'too_shallow'
  value: TransactionReceipt
  url: string
  rounds: number
  answers: HostAnswer[]
  confirmations: number
}

export type ReceiptWait = EveryRpcRead<TransactionReceipt> | ShallowReceipt

/**
 * Wait for a transaction's receipt across every RPC, at the depth the caller asks for.
 *
 * `timeoutMs` is the time to keep asking, and no call starts past that budget plus one call's
 * deadline (`hardTimeoutMs` sets another ceiling). It never throws on a timeout: the three ways
 * of not having an answer stay apart (not_found, unreachable, too_shallow), and none of them
 * means the transaction failed. The receipt is read again while it waits for depth, because a
 * reorg can move it or take it away, and the head comes from whichever host answers first, so
 * a lagging host costs another round and nothing else.
 */
export async function waitForReceiptOnEveryRpc(
  chain: ChainDescriptor,
  hash: Hex | string,
  opts: EveryRpcOptions & { confirmations?: number } = {},
): Promise<ReceiptWait> {
  const want = Math.max(1, Math.floor(opts.confirmations ?? 1))
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const budget = Math.max(0, opts.timeoutMs ?? 0)
  const ceiling = opts.hardTimeoutMs ?? budget + (opts.perCallTimeoutMs ?? DEFAULT_PER_CALL_MS)
  const start = now()
  const left = () => Math.max(0, ceiling - (now() - start))

  let latest = await receiptFromEveryRpc(chain, hash, { ...opts, timeoutMs: budget, hardTimeoutMs: ceiling })
  if (want === 1) return latest
  for (;;) {
    if (latest.status === 'found') {
      const head = await blockNumberFromEveryRpc(chain, { ...opts, timeoutMs: 0, hardTimeoutMs: left() })
      if (head.status === 'found' && head.value >= latest.value.blockNumber + BigInt(want - 1)) return latest
    }
    if (now() - start + pollMs > budget) {
      return latest.status === 'found' ? { ...latest, status: 'too_shallow', confirmations: want } : latest
    }
    await sleep(pollMs)
    latest = await receiptFromEveryRpc(chain, hash, { ...opts, timeoutMs: 0, hardTimeoutMs: left() })
  }
}

/** Why a wait ended without a receipt, safe to publish: counts and depth, never a host. */
export function describeReceiptWait(wait: Exclude<ReceiptWait, { status: 'found' }>): string {
  if (wait.status === 'too_shallow') return `the receipt is mined but not yet ${wait.confirmations} blocks deep`
  if (wait.status === 'unreachable') return `none of ${wait.answers.length} RPC hosts answered`
  const nulls = wait.answers.filter((a) => a.answer === 'null').length
  const errors = wait.answers.filter((a) => a.answer === 'error').length
  return `no receipt on any RPC host (${nulls} answered null, ${errors} did not answer, after ${wait.rounds} rounds)`
}

/** The block at a height, header only, from the first host that has it; with `hash`, only an
 *  answer carrying that block hash counts. */
export async function blockFromEveryRpc(chain: ChainDescriptor, want: { number: bigint; hash?: string }, opts: EveryRpcOptions = {}): Promise<EveryRpcRead<BlockStamp>> {
  if (typeof want.number !== 'bigint' || want.number < 0n) throw new TypeError(`not a block number: ${String(want.number)}`)
  if (want.hash !== undefined && !TX_HASH.test(want.hash)) throw new TypeError(`not a block hash: ${want.hash}`)
  return fromEveryRpc(chain, 'eth_getBlockByNumber', [`0x${want.number.toString(16)}`, false], parseBlock(want), opts)
}
