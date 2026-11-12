import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NEAR_EMPTY_CODE_HASH,
  NearRpcUnreachable,
  nearRpc,
  nearRpcUrls,
  nearStatus,
  nearViewAccount,
  nearViewFunction,
} from './client.js'
import { nearLiveCheck } from '../proof.js'
import { getChainById, requireChain } from '../registry.js'

/**
 * Every test here runs against a stubbed fetch, so none needs a network and none can pass
 * because a public host happened to be up. The answer shapes are the ones the real hosts gave
 * on 2026-11-12 (rpc.testnet.fastnear.com and near-testnet.drpc.org): UNKNOWN_ACCOUNT as a
 * HANDLER_ERROR cause, PARSE_ERROR as a REQUEST_VALIDATION_ERROR cause (HTTP 400 on both
 * FastNEAR hosts, HTTP 200 on drpc), and a failed view as an `error` string inside the result.
 */
const NEAR = getChainById('near-testnet') ?? assert.fail('the registry carries no near-testnet')
const [PRIMARY, FALLBACK, ARCHIVAL] = NEAR.rpcUrls.map((u) => new URL(u).host)

const USDC_ACCOUNT = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'
/** USDC's real code_hash, read with view_account on 2026-11-12. */
const USDC_CODE_HASH = 'EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z'

type Sent = { host: string; method: string; params: Record<string, unknown> | unknown[] }
type Reply = Response | Error

function stub(reply: (host: string, sent: Sent) => Reply) {
  const calls: Sent[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: Sent['params'] }
    const sent = { host: new URL(String(input)).host, method: body.method, params: body.params }
    calls.push(sent)
    const out = reply(sent.host, sent)
    if (out instanceof Error) throw out
    return out
  }) as typeof fetch
  return { calls, deps: { fetchImpl } }
}

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ jsonrpc: '2.0', id: 'a-identity', result })
const handlerError = (cause: string, data = 'Server error') =>
  json({ jsonrpc: '2.0', id: 'a-identity', error: { name: 'HANDLER_ERROR', cause: { name: cause, info: {} }, code: -32000, message: 'Server error', data } })
const status = (chainId = 'testnet', height = 277291084) =>
  ok({ chain_id: chainId, protocol_version: 88, sync_info: { latest_block_height: height, syncing: false } })
const account = (codeHash: string) => ok({ amount: '7992885010462500000000000', code_hash: codeHash, storage_usage: 182, block_height: 277291099 })

test('status names the network and the height, and a host on the wrong network fails loudly', async () => {
  const live = stub(() => status())
  const s = await nearStatus(NEAR, {}, live.deps)
  assert.deepEqual(s, { chainId: 'testnet', protocolVersion: 88, latestBlockHeight: 277291084, syncing: false, host: PRIMARY })
  assert.deepEqual(live.calls.map((c) => [c.host, c.method]), [[PRIMARY, 'status']])

  // A mainnet RPC behind the env override would answer every later read with mainnet state.
  // It throws rather than failing over, because the next read would go to that same host first.
  const wrong = stub(() => status('mainnet'))
  await assert.rejects(nearStatus(NEAR, {}, wrong.deps), /answered chain_id "mainnet", but near-testnet is near:testnet/)
  assert.equal(wrong.calls.length, 1)
})

test('a host that cannot answer moves the read to the next one, in descriptor order', async () => {
  // A transport failure, a 503 and an error a pruned node may give are all "could not answer".
  const s = stub((host) =>
    host === PRIMARY ? new TypeError('fetch failed') : host === FALLBACK ? json({ error: 'busy' }, 503) : status(),
  )
  assert.equal((await nearStatus(NEAR, {}, s.deps)).host, ARCHIVAL)
  assert.deepEqual(s.calls.map((c) => c.host), [PRIMARY, FALLBACK, ARCHIVAL])

  const pruned = stub((host) => (host === PRIMARY ? handlerError('UNKNOWN_BLOCK') : account(USDC_CODE_HASH)))
  const view = await nearViewAccount(NEAR, USDC_ACCOUNT, {}, pruned.deps)
  assert.equal(view.exists && view.host, FALLBACK)
  assert.equal(pruned.calls.length, 2)
})

test('UNKNOWN_ACCOUNT is the chain answering, so no other host is asked and the account reads as missing', async () => {
  const s = stub(() => handlerError('UNKNOWN_ACCOUNT', 'account registry.a-identity.testnet does not exist while viewing'))
  assert.deepEqual(await nearViewAccount(NEAR, 'registry.a-identity.testnet', {}, s.deps), { exists: false, host: PRIMARY })
  assert.equal(s.calls.length, 1, 'a decided answer is not retried on another host')
  assert.deepEqual(s.calls[0].params, { request_type: 'view_account', finality: 'final', account_id: 'registry.a-identity.testnet' })

  // The low-level call says why, in the host's words.
  const raw = await nearRpc(NEAR, 'query', {}, {}, stub(() => handlerError('UNKNOWN_ACCOUNT', 'gone')).deps)
  assert.deepEqual(raw, { kind: 'decided', cause: 'UNKNOWN_ACCOUNT', message: 'gone', host: PRIMARY })

  // A decided answer does not always come with a 200: both FastNEAR hosts send PARSE_ERROR as
  // HTTP 400 (drpc as 200, read live 2026-11-12). The body is read whatever the status, so a
  // network that answered is not reported as one that could not.
  const rejected = stub(() =>
    json(
      {
        jsonrpc: '2.0',
        id: 'a-identity',
        error: {
          name: 'REQUEST_VALIDATION_ERROR',
          cause: { name: 'PARSE_ERROR', info: {} },
          code: -32700,
          message: 'Parse error',
          data: 'Failed parsing args: the Account ID contains an invalid character',
        },
      },
      400,
    ),
  )
  assert.deepEqual(await nearRpc(NEAR, 'query', {}, {}, rejected.deps), {
    kind: 'decided',
    cause: 'PARSE_ERROR',
    message: 'Failed parsing args: the Account ID contains an invalid character',
    host: PRIMARY,
  })
  assert.equal(rejected.calls.length, 1, 'a decided answer sent as HTTP 400 is not retried on another host')
})

test('an account with code and an account without are told apart by the empty code hash', async () => {
  const withCode = await nearViewAccount(NEAR, USDC_ACCOUNT, {}, stub(() => account(USDC_CODE_HASH)).deps)
  assert.ok(withCode.exists)
  assert.equal(withCode.hasContract, true)
  assert.equal(withCode.codeHash, USDC_CODE_HASH)

  const noCode = await nearViewAccount(NEAR, 'a-identity.testnet', {}, stub(() => account(NEAR_EMPTY_CODE_HASH)).deps)
  assert.ok(noCode.exists)
  assert.equal(noCode.hasContract, false, 'an account that exists with no contract is not a deployed contract')
  assert.equal(noCode.amountYocto, '7992885010462500000000000')
  assert.equal(NEAR_EMPTY_CODE_HASH, '1'.repeat(32))
})

test('a view that ran and failed is decided, whichever way nearcore reports it', async () => {
  // Current nearcore: the failure arrives inside the result (read live 2026-11-12).
  const inResult = stub(() =>
    ok({ block_height: 277291822, logs: [], error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }),
  )
  const a = await nearViewFunction(NEAR, USDC_ACCOUNT, 'no_such_method', {}, {}, inResult.deps)
  assert.deepEqual(a, { ok: false, reason: 'wasm execution failed with error: MethodResolveError(MethodNotFound)', host: PRIMARY })
  assert.equal(inResult.calls.length, 1)

  // The structured form, for hosts that report it as a cause instead.
  for (const cause of ['NO_CONTRACT_CODE', 'CONTRACT_EXECUTION_ERROR', 'UNKNOWN_ACCOUNT']) {
    const s = stub(() => handlerError(cause, 'said by the chain'))
    const r = await nearViewFunction(NEAR, 'a-identity.testnet', 'get', {}, {}, s.deps)
    assert.deepEqual(r, { ok: false, reason: `${cause}: said by the chain`, host: PRIMARY }, cause)
    assert.equal(s.calls.length, 1, `${cause} is not retried`)
  }
})

test('a view sends its args as base64 JSON in one request, and its return bytes come back as JSON', async () => {
  const metadata = { spec: 'ft-1.0.0', name: 'USDC', symbol: 'USDC', decimals: 6 }
  const s = stub(() => ok({ block_height: 277291098, logs: [], result: [...Buffer.from(JSON.stringify(metadata))] }))
  const r = await nearViewFunction(NEAR, USDC_ACCOUNT, 'ft_metadata', { account_id: 'alice.testnet' }, {}, s.deps)
  assert.deepEqual(r, { ok: true, value: metadata, logs: [], blockHeight: 277291098, host: PRIMARY })
  const [sent] = s.calls
  assert.equal(sent.method, 'query')
  const params = sent.params as Record<string, string>
  assert.equal(params.request_type, 'call_function')
  assert.equal(params.finality, 'final')
  assert.equal(params.method_name, 'ft_metadata')
  assert.equal(Buffer.from(params.args_base64, 'base64').toString('utf8'), '{"account_id":"alice.testnet"}')
})

test('every host failing throws, naming each host and why, and never invents an answer', async () => {
  const s = stub((host) => (host === ARCHIVAL ? json({ jsonrpc: '2.0', id: 'a-identity' }) : new TypeError('fetch failed')))
  const err = await nearStatus(NEAR, {}, s.deps).catch((e: unknown) => e)
  assert.ok(err instanceof NearRpcUnreachable)
  assert.deepEqual(err.tried, [
    { host: PRIMARY, reason: 'fetch failed' },
    { host: FALLBACK, reason: 'fetch failed' },
    { host: ARCHIVAL, reason: 'not a JSON-RPC answer' },
  ])

  // A non-2xx that names no decided cause is the host failing, even as well-formed JSON-RPC
  // (nearcore sends INTERNAL_ERROR as HTTP 500), and it is said by its status.
  const internal = { jsonrpc: '2.0', id: 'a-identity', error: { name: 'INTERNAL_ERROR', cause: { name: 'INTERNAL_ERROR', info: {} }, code: -32000, message: 'Server error' } }
  const failing = stub((host) =>
    host === PRIMARY ? json(internal, 500) : host === FALLBACK ? new Response('<html>bad gateway</html>', { status: 502 }) : json({ error: 'busy' }, 503),
  )
  const down = await nearStatus(NEAR, {}, failing.deps).catch((e: unknown) => e)
  assert.ok(down instanceof NearRpcUnreachable)
  assert.deepEqual(down.tried, [
    { host: PRIMARY, reason: 'HTTP 500 INTERNAL_ERROR' },
    { host: FALLBACK, reason: 'HTTP 502' },
    { host: ARCHIVAL, reason: 'HTTP 503' },
  ])
})

test('the env override replaces the primary and keeps the other hosts; a bad id or a non-NEAR chain costs no request', async () => {
  const rpcEnvVar = NEAR.rpcEnvVar ?? assert.fail('near-testnet declares no rpcEnvVar')
  assert.deepEqual(nearRpcUrls(NEAR, { [rpcEnvVar]: 'https://private.example/near' }), [
    'https://private.example/near',
    ...NEAR.rpcUrls.slice(1),
  ])
  assert.deepEqual(nearRpcUrls(NEAR, {}), NEAR.rpcUrls)
  assert.throws(() => nearRpcUrls(requireChain('eip155:5042002'), {}), /is not a NEAR chain/)

  const s = stub(() => status())
  await assert.rejects(nearViewAccount(NEAR, 'Not-Valid', {}, s.deps), /is not a NEAR account id/)
  await assert.rejects(nearViewFunction(NEAR, 'two..dots.testnet', 'ft_metadata', {}, {}, s.deps), /is not a NEAR account id/)
  assert.equal(s.calls.length, 0)
})

test('the proof live check reads NEAR by its own protocol: status, then view_account for each contract', async () => {
  const contracts = [
    { name: 'not deployed yet', address: 'vault.example.testnet' },
    { name: 'Circle USDC', address: USDC_ACCOUNT },
    { name: 'account with no code', address: 'a-identity.testnet' },
  ]
  const s = stub((_host, sent) => {
    if (sent.method === 'status') return status()
    const id = (sent.params as Record<string, string>).account_id
    return id === USDC_ACCOUNT ? account(USDC_CODE_HASH) : id === 'a-identity.testnet' ? account(NEAR_EMPTY_CODE_HASH) : handlerError('UNKNOWN_ACCOUNT')
  })
  const live = await nearLiveCheck(NEAR, { contracts }, {}, '2026-11-12T00:00:00.000Z', s.deps)
  assert.deepEqual(live, {
    reachable: true,
    checkedAt: '2026-11-12T00:00:00.000Z',
    blockNumber: '277291084',
    contracts: [
      { name: 'not deployed yet', address: 'vault.example.testnet', deployed: false },
      { name: 'Circle USDC', address: USDC_ACCOUNT, deployed: true },
      { name: 'account with no code', address: 'a-identity.testnet', deployed: false },
    ],
  })
  assert.ok(s.calls.every((c) => c.method === 'status' || c.method === 'query'), 'nothing EVM-shaped was asked')

  // Unreachable is said as unreachable, with the reason, and a wrong network is not a reading.
  const down = await nearLiveCheck(NEAR, { contracts }, {}, 'now', stub(() => new TypeError('fetch failed')).deps)
  assert.equal(down.reachable, false)
  assert.match(down.reachable ? '' : down.reason, /no NEAR RPC host answered/)
  const mainnet = await nearLiveCheck(NEAR, { contracts }, {}, 'now', stub(() => status('mainnet')).deps)
  assert.equal(mainnet.reachable, false)
})
