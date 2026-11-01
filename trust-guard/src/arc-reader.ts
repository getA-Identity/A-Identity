/**
 * Read-only access to Arc Mainnet over plain JSON-RPC, host by host.
 *
 * Why not a fallback transport: a fallback moves to the next host only when one throws, and an
 * Arc host that does not have a receipt does not throw, it answers null. On 2026-10-11 one of
 * the registry's four hosts answered null for every receipt it was asked about, and on
 * 2026-11-01 three of the four returned a payment's receipt while only one returned its
 * transaction. So a transaction or a receipt is asked of EVERY host, one at a time, and the
 * first real answer wins. Null means at least one host answered and none had it; a thrown
 * ArcRpcUnreachableError means no host answered at all. The two are never read as each other.
 *
 * A contract that said no and a chain that did not answer are kept apart in the same way: a
 * revert is thrown as ArcCallRevert from the first host that reports it, and only a host that
 * failed to answer makes the next host get asked.
 */
import type { FetchLike } from './index.js'
import { ARC_MAINNET } from './arc-mainnet.generated.js'

export type Hex = `0x${string}`
export type Address = `0x${string}`

export interface ArcLog {
  address: Address
  topics: readonly Hex[]
  data: Hex
}

export interface ArcReceipt {
  transactionHash: Hex
  status: 'success' | 'reverted'
  blockNumber: bigint
  from: Address
  to: Address | null
  gasUsed: bigint
  /** Wei per gas, 18 decimals. */
  effectiveGasPrice: bigint
  logs: readonly ArcLog[]
  /** The host that answered, when known. A host name only, never a path or a query. */
  source?: string
}

export interface ArcTransaction {
  from: Address
  to: Address | null
  input: Hex
  /** Wei per gas. A legacy transaction's gasPrice; null when a host reports neither. */
  maxFeePerGas: bigint | null
  source?: string
}

/** The reads verifyThenPay makes. arcChainReader() is the real one; tests pass a fake. */
export interface ArcChainReader {
  /** eth_call at the latest block. Throws ArcCallRevert when the contract reverts. */
  call(r: { to: Address; data: Hex; from?: Address }): Promise<Hex>
  latestBlock(): Promise<{ number: bigint; timestamp: bigint }>
  /** Wei, 18 decimals. */
  gasPrice(): Promise<bigint>
  /** Wei, 18 decimals. */
  nativeBalance(a: Address): Promise<bigint>
  code(a: Address): Promise<Hex>
  /** Throws ArcCallRevert when the call would revert. */
  estimateGas(r: { from: Address; to: Address; data: Hex }): Promise<bigint>
  /** From every host. Null: a host answered and none has it. Throws: no host answered. */
  transaction(h: Hex): Promise<ArcTransaction | null>
  /** From every host. Null: a host answered and none has it. Throws: no host answered. */
  receipt(h: Hex): Promise<ArcReceipt | null>
}

/** The contract reverted. `data` holds its error bytes when the host returned them. */
export class ArcCallRevert extends Error {
  readonly data?: Hex
  constructor(message: string, data?: Hex) {
    super(message)
    this.name = 'ArcCallRevert'
    if (data) this.data = data
  }
}

/** No host gave a usable answer. Says nothing about the chain's state. */
export class ArcRpcUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArcRpcUnreachableError'
  }
}

export interface ArcChainReaderOptions {
  /** Inject a fetch implementation (tests, custom runtimes). */
  fetch?: FetchLike
  /** The deadline for one call to one host, in ms. Default 6000. */
  perCallTimeoutMs?: number
}

const DEFAULT_PER_CALL_MS = 6000
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX = /^0x[0-9a-fA-F]*$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function quantity(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(`${what} is not a hex quantity`)
  return BigInt(v)
}

function hexData(v: unknown, what: string): Hex {
  if (typeof v !== 'string' || !HEX.test(v)) throw new Error(`${what} is not hex`)
  return v as Hex
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'rpc'
  }
}

function parseReceipt(raw: unknown, hash: string, source: string): ArcReceipt {
  if (!isObject(raw)) throw new Error('the receipt is not an object')
  if (typeof raw.transactionHash !== 'string' || raw.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('answered with a receipt for another transaction')
  if (raw.status !== '0x1' && raw.status !== '0x0') throw new Error('the receipt carries no status')
  if (!Array.isArray(raw.logs)) throw new Error('the receipt carries no logs array')
  if (typeof raw.from !== 'string' || !ADDRESS.test(raw.from)) throw new Error('the receipt carries no sender')
  return {
    transactionHash: raw.transactionHash.toLowerCase() as Hex,
    status: raw.status === '0x1' ? 'success' : 'reverted',
    blockNumber: quantity(raw.blockNumber, 'blockNumber'),
    from: raw.from.toLowerCase() as Address,
    to: typeof raw.to === 'string' ? (raw.to.toLowerCase() as Address) : null,
    gasUsed: raw.gasUsed === undefined ? 0n : quantity(raw.gasUsed, 'gasUsed'),
    effectiveGasPrice: raw.effectiveGasPrice === undefined ? 0n : quantity(raw.effectiveGasPrice, 'effectiveGasPrice'),
    logs: raw.logs.map((l: unknown) => {
      if (!isObject(l) || typeof l.address !== 'string' || !Array.isArray(l.topics)) throw new Error('a log is malformed')
      return { address: l.address.toLowerCase() as Address, topics: l.topics.map((t) => hexData(t, 'a topic')), data: hexData(l.data, 'log data') }
    }),
    source,
  }
}

function parseTransaction(raw: unknown, hash: string, source: string): ArcTransaction {
  if (!isObject(raw)) throw new Error('the transaction is not an object')
  if (typeof raw.hash !== 'string' || raw.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('answered with another transaction')
  if (typeof raw.from !== 'string' || !ADDRESS.test(raw.from)) throw new Error('the transaction carries no sender')
  const fee = raw.maxFeePerGas ?? raw.gasPrice
  return {
    from: raw.from.toLowerCase() as Address,
    to: typeof raw.to === 'string' ? (raw.to.toLowerCase() as Address) : null,
    input: hexData(raw.input, 'input').toLowerCase() as Hex,
    maxFeePerGas: fee === undefined || fee === null ? null : quantity(fee, 'maxFeePerGas'),
    source,
  }
}

/**
 * The real reader. Default hosts: the registry's, in the registry's order.
 *
 * Nothing here signs or broadcasts: there is no eth_sendRawTransaction in this file.
 */
export function arcChainReader(rpcUrls: readonly string[] = ARC_MAINNET.rpcUrls, opts: ArcChainReaderOptions = {}): ArcChainReader {
  if (!rpcUrls.length) throw new TypeError('arcChainReader needs at least one RPC URL')
  const found = opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch
  if (!found) throw new Error('No fetch available; pass opts.fetch.')
  const doFetch: FetchLike = found
  const perCall = opts.perCallTimeoutMs ?? DEFAULT_PER_CALL_MS

  /** One request to one host. Resolves with `result`, null included. */
  async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
    const ctl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort()
        reject(new Error(`no answer within ${perCall} ms`))
      }, perCall)
    })
    const ask = async () => {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctl.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
      if (body.error) {
        const message = String(body.error.message ?? '')
        const data = typeof body.error.data === 'string' && HEX.test(body.error.data) ? (body.error.data as Hex) : undefined
        if (body.error.code === 3 || /revert/i.test(message)) throw new ArcCallRevert(message || 'execution reverted', data)
        throw new Error(`RPC error ${body.error.code ?? ''} ${message}`.trim())
      }
      if (!('result' in body)) throw new Error('the JSON-RPC answer carries no result')
      return body.result
    }
    try {
      return await Promise.race([ask(), deadline])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** The first host that answers with a value. A revert is an answer and stops the walk. */
  async function first<T>(method: string, params: readonly unknown[], parse: (raw: unknown) => T): Promise<T> {
    const failures: string[] = []
    for (const url of rpcUrls) {
      try {
        const raw = await rpc(url, method, params)
        if (raw === null || raw === undefined) {
          failures.push(`${hostOf(url)}: null`)
          continue
        }
        return parse(raw)
      } catch (e) {
        if (e instanceof ArcCallRevert) throw e
        failures.push(`${hostOf(url)}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    throw new ArcRpcUnreachableError(`no RPC answered ${method} (${failures.join('; ')})`)
  }

  /** Every host in turn. A malformed answer, or one about another transaction, is that host
   *  failing rather than proving anything, so the next host is still asked. */
  async function every<T>(method: string, params: readonly unknown[], parse: (raw: unknown, source: string) => T): Promise<T | null> {
    let answered = false
    const failures: string[] = []
    for (const url of rpcUrls) {
      try {
        const raw = await rpc(url, method, params)
        if (raw === null || raw === undefined) {
          answered = true
          continue
        }
        return parse(raw, hostOf(url))
      } catch (e) {
        failures.push(`${hostOf(url)}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (answered) return null
    throw new ArcRpcUnreachableError(`no RPC answered ${method} (${failures.join('; ')})`)
  }

  const requireHash = (h: string) => {
    if (!HASH.test(h)) throw new TypeError(`not a transaction hash: ${h}`)
  }

  return {
    call: (r) => first('eth_call', [{ to: r.to, data: r.data, ...(r.from ? { from: r.from } : {}) }, 'latest'], (x) => hexData(x, 'eth_call result')),
    latestBlock: () =>
      first('eth_getBlockByNumber', ['latest', false], (x) => {
        if (!isObject(x)) throw new Error('the block is not an object')
        return { number: quantity(x.number, 'number'), timestamp: quantity(x.timestamp, 'timestamp') }
      }),
    gasPrice: () => first('eth_gasPrice', [], (x) => quantity(x, 'eth_gasPrice')),
    nativeBalance: (a) => first('eth_getBalance', [a, 'latest'], (x) => quantity(x, 'eth_getBalance')),
    code: (a) => first('eth_getCode', [a, 'latest'], (x) => hexData(x, 'eth_getCode')),
    estimateGas: (r) => first('eth_estimateGas', [{ from: r.from, to: r.to, data: r.data }], (x) => quantity(x, 'eth_estimateGas')),
    transaction: async (h) => {
      requireHash(h)
      return every('eth_getTransactionByHash', [h], (x, source) => parseTransaction(x, h, source))
    },
    receipt: async (h) => {
      requireHash(h)
      return every('eth_getTransactionReceipt', [h], (x, source) => parseReceipt(x, h, source))
    },
  }
}
