/**
 * A fake NEAR testnet behind a stubbed fetch, for the tests of nearCheck and its route. Test
 * seam only: nothing in production imports it.
 *
 * It answers the JSON-RPC calls and indexer queries the NEAR verdict engine's collectors make,
 * from a small description of the chain, whatever host they are sent to. That is deliberate: the
 * hosts come from the near-testnet descriptor, and this file states none of them (the
 * hardcoded-host guard reads it like any other module). Blocks are linear, one every 600 ms, so
 * the engine's archival probes land on their first guess. An account exists from the height it
 * was created at; a contract that is not described does not exist, which is what an undeployed
 * registry looks like on chain.
 *
 * `replayExchanges` is the other way to stub fetch: it answers only requests recorded in a live
 * read-only run (the SDK's own fixtures under near/sdk/test/fixtures), ignoring JSON-RPC ids.
 */
import type { FetchLike } from '../chains/near/engine.js'

export type FakeNearAccount = {
  /** The height the account was created at: it exists at every block from there on. */
  created: number
  /** Code hash at every block it exists at. Default: no contract. */
  codeHash?: string
  /** Full-access keys. Default 1. */
  fullAccessKeys?: number
  /** Heights of the transactions the indexer lists for it, oldest first. Default: six from creation. */
  txHeights?: number[]
}

export type FakeNearTestnet = {
  /** The latest final height. */
  head: number
  accounts: Record<string, FakeNearAccount>
  /** Contract views by contract account, then method. A contract not listed does not exist. */
  views: Record<string, Record<string, (args: Record<string, unknown>) => unknown>>
  /** Every request fails as a transport error, as when no host answers. */
  down?: boolean
  /** Waited on before each answer, so a test can hold the chain still. */
  gate?: () => Promise<void>
}

export const EMPTY_CODE_HASH = '11111111111111111111111111111111'
const BLOCK_NS = 600_000_000n
const GENESIS_NS = 1_700_000_000_000_000_000n

export const fakeBlockTs = (height: number): bigint => GENESIS_NS + BigInt(height) * BLOCK_NS
export const fakeBlockHash = (height: number): string => `Fake${height}`.padEnd(44, 'x')

const answer = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) })

function rpcError(id: unknown, cause: string, data: string) {
  return { jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name: cause, info: {} }, code: -32000, message: 'Server error', data } }
}

/** A stubbed fetch that answers as the described chain would. `calls` lists what was asked. */
export function fakeNearTestnet(chain: FakeNearTestnet): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = []
  const exists = (id: string, height: number) => {
    const a = chain.accounts[id]
    return a !== undefined && height >= a.created ? a : null
  }
  const fetchImpl: FetchLike = async (url, init) => {
    if (chain.gate) await chain.gate()
    if (chain.down) throw new TypeError(`fetch failed: ${new URL(url).host} is down`)
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    const path = new URL(url).pathname

    // FastNEAR's transactions API: the account's oldest (or newest) transactions.
    if (path.endsWith('/v0/account')) {
      const id = String(body.account_id)
      calls.push(`fastnear:${id}`)
      const a = chain.accounts[id]
      const heights = a ? (a.txHeights ?? [0, 1, 2, 3, 4, 5].map((i) => a.created + i)) : []
      const ordered = (body.desc === true ? [...heights].reverse() : heights).slice(0, Number(body.limit ?? 5))
      return answer(200, {
        account_txs: ordered.map((h) => ({ account_id: id, transaction_hash: `FakeTx${h}`, tx_block_height: h, tx_block_timestamp: String(fakeBlockTs(h)), is_signer: true, is_success: true })),
      })
    }
    if (path.includes('/v3/')) {
      calls.push(`nearblocks:${path}`)
      return answer(200, path.endsWith('/contract/deployments') ? { deployments: [] } : { data: [] })
    }

    const id = body.id
    const params = (body.params ?? {}) as Record<string, unknown>
    if (body.method === 'block') {
      const height = params.finality === 'final' ? chain.head : Number(params.block_id)
      calls.push(`block:${params.finality === 'final' ? 'final' : height}`)
      if (!Number.isSafeInteger(height) || height <= 0 || height > chain.head) return answer(200, rpcError(id, 'UNKNOWN_BLOCK', `DB Not Found Error: BLOCK HEIGHT: ${height}`))
      return answer(200, {
        jsonrpc: '2.0',
        id,
        result: { header: { height, hash: fakeBlockHash(height), prev_hash: fakeBlockHash(height - 1), timestamp_nanosec: String(fakeBlockTs(height)) } },
      })
    }
    if (body.method !== 'query') return answer(200, rpcError(id, 'PARSE_ERROR', `unknown method ${String(body.method)}`))

    const height = Number(params.block_id)
    const target = String(params.account_id)
    const at = { block_height: height, block_hash: fakeBlockHash(height) }
    calls.push(`${String(params.request_type)}:${target}${params.method_name ? `.${String(params.method_name)}` : ''}@${height}`)
    if (params.request_type === 'view_account') {
      const a = exists(target, height)
      if (!a) return answer(200, rpcError(id, 'UNKNOWN_ACCOUNT', `account ${target} does not exist while viewing`))
      return answer(200, { jsonrpc: '2.0', id, result: { amount: '5000000000000000000000000', locked: '0', code_hash: a.codeHash ?? EMPTY_CODE_HASH, storage_usage: 182, storage_paid_at: 0, ...at } })
    }
    if (params.request_type === 'view_access_key_list') {
      const a = exists(target, height)
      if (!a) return answer(200, rpcError(id, 'UNKNOWN_ACCOUNT', `account ${target} does not exist while viewing`))
      const keys = Array.from({ length: a.fullAccessKeys ?? 1 }, (_, i) => ({ public_key: `ed25519:FakeKey${i}`, access_key: { nonce: 10, permission: 'FullAccess' } }))
      return answer(200, { jsonrpc: '2.0', id, result: { keys, ...at } })
    }
    if (params.request_type === 'call_function') {
      const contract = chain.views[target]
      if (!contract) return answer(200, rpcError(id, 'UNKNOWN_ACCOUNT', `account ${target} does not exist while viewing`))
      const view = contract[String(params.method_name)]
      if (!view) return answer(200, { jsonrpc: '2.0', id, result: { error: 'wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))', logs: [], ...at } })
      const args = JSON.parse(Buffer.from(String(params.args_base64 ?? ''), 'base64').toString('utf8') || '{}') as Record<string, unknown>
      const bytes = [...Buffer.from(JSON.stringify(view(args) ?? null), 'utf8')]
      return answer(200, { jsonrpc: '2.0', id, result: { result: bytes, logs: [], ...at } })
    }
    return answer(200, rpcError(id, 'PARSE_ERROR', `unknown request_type ${String(params.request_type)}`))
  }
  return { fetch: fetchImpl, calls }
}

/** One request and its answer, as the SDK's recorded fixtures hold them. */
export type RecordedExchange = { url: string; method: string; body: unknown; status: number; text: string }

/** A stubbed fetch that answers only recorded requests (JSON-RPC ids ignored) and fails on anything else. */
export function replayExchanges(exchanges: readonly RecordedExchange[], calls: string[] = []): FetchLike {
  return async (url, init) => {
    let body: unknown = null
    if (init.body) {
      const parsed = JSON.parse(init.body) as Record<string, unknown>
      if ('jsonrpc' in parsed) delete parsed.id
      body = parsed
    }
    const key = JSON.stringify([url, init.method, body])
    calls.push(key)
    const hit = exchanges.find((x) => JSON.stringify([x.url, x.method, x.body]) === key)
    if (!hit) throw new TypeError(`unrecorded request ${key}`)
    return { status: hit.status, text: async () => hit.text }
  }
}
