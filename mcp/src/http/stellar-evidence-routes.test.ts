import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CHAINS, txUrl } from '../chains/index.js'
import type { ChainDescriptor } from '../chains/types.js'
import type { HttpFetch } from '../chains/stellar/tx-evidence.js'
import { PASSKEY_SET_POLICY, REFUSED_OVER_LIMIT } from '../chains/stellar/fixtures/tx-evidence-fixtures.js'
import { __clearStellarEvidenceCacheForTests, createStellarEvidenceRoutes } from './stellar-evidence-routes.js'
import type { RouteCtx } from './shared.js'

/**
 * GET /api/stellar/tx/:hash at the boundary a page codes against: which status each outcome
 * carries, that a refusal happens before any network call, that links come from the registry,
 * and that a found transaction is not fetched twice. The network is an injected fetcher
 * answering with committed real transactions, so nothing here goes online.
 */

const testnet = CHAINS.find((c) => c.id === 'stellar-testnet') as ChainDescriptor
const NO_ENV = {} as NodeJS.ProcessEnv

function fakeRes() {
  const out: { status?: number; body?: Record<string, unknown> } = {}
  return {
    out,
    res: {
      setHeader: () => undefined,
      writeHead(status: number) {
        out.status = status
        return this
      },
      end: (payload?: string) => {
        if (payload) out.body = JSON.parse(payload) as Record<string, unknown>
      },
    } as never,
  }
}

/** Every RPC says not found, Horizon answers with `horizon`, the indexer has nothing. */
function fetcher(horizon: { status: number; body?: unknown } | Error) {
  const calls: string[] = []
  const fetch: HttpFetch = async (url) => {
    calls.push(url)
    if (testnet.rpcUrls.some((u) => url.startsWith(u))) {
      return { status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { status: 'NOT_FOUND' } }) }
    }
    if (url.startsWith(testnet.horizonUrls?.[0] as string)) {
      if (horizon instanceof Error) throw horizon
      return { status: horizon.status, json: async () => horizon.body }
    }
    return { status: 404, json: async () => ({}) }
  }
  return { fetch, calls }
}

async function get(path: string, fetch: HttpFetch, method = 'GET') {
  const { out, res } = fakeRes()
  const ctx: RouteCtx = {
    req: { method, headers: {} } as never,
    res,
    url: new URL(`http://localhost${path}`),
    caller: null,
    callerId: undefined,
  }
  const handled = await createStellarEvidenceRoutes({ fetch, env: NO_ENV, retryDelayMs: 0 })(ctx)
  return { handled, ...out }
}

test('a found transaction is 200 with the decoded evidence, and every link derives from the registry', async () => {
  __clearStellarEvidenceCacheForTests()
  const { fetch } = fetcher({ status: 200, body: { ...PASSKEY_SET_POLICY } })
  const r = await get(`/api/stellar/tx/${PASSKEY_SET_POLICY.hash}?network=${testnet.caip2}`, fetch)
  assert.equal(r.handled, true)
  assert.equal(r.status, 200)
  const b = r.body as Record<string, any>
  assert.equal(b.network, testnet.caip2)
  assert.equal(b.chainId, testnet.id)
  assert.equal(b.realMoney, false)
  assert.equal(b.hash, PASSKEY_SET_POLICY.hash)
  assert.equal(b.ledger, PASSKEY_SET_POLICY.ledger)
  assert.equal(b.status, 'success')
  assert.equal(b.feeAccount, PASSKEY_SET_POLICY.fee_account)
  assert.equal(b.fetchedFrom, 'horizon')
  assert.equal(b.auth[0].signers[0].kind, 'webauthn-secp256r1')
  assert.equal(b.auth[0].signers[0].webauthn.authenticatorData.flagsByte, '0x05')
  assert.equal(b.explorer.tx, txUrl(testnet, PASSKEY_SET_POLICY.hash))
  assert.ok(String(b.explorer.feeAccount).startsWith(testnet.explorer as string))
  for (const link of Object.values(b.explorer.contracts as Record<string, string>)) assert.ok(link.startsWith(`${testnet.explorer}/contract/`))
  assert.ok(Array.isArray(b.caveats) && b.caveats.length > 0)
  assert.equal(typeof b.summary, 'string')
})

test('the registry id is accepted as the network too, and a found answer is served from cache the second time', async () => {
  __clearStellarEvidenceCacheForTests()
  const { fetch, calls } = fetcher({ status: 200, body: { ...REFUSED_OVER_LIMIT } })
  const first = await get(`/api/stellar/tx/${REFUSED_OVER_LIMIT.hash}?network=${testnet.id}`, fetch)
  assert.equal(first.status, 200)
  assert.equal((first.body as Record<string, any>).resultCode.tx, 'txFailed')
  const n = calls.length
  const second = await get(`/api/stellar/tx/${REFUSED_OVER_LIMIT.hash.toUpperCase()}?network=${testnet.caip2}`, fetch)
  assert.equal(second.status, 200)
  assert.equal(calls.length, n, 'a transaction in a ledger never changes, so it is not fetched again')
})

test('no network, an unknown network or a malformed hash is 400 before any fetch', async () => {
  const { fetch, calls } = fetcher({ status: 500 })
  for (const path of [
    `/api/stellar/tx/${PASSKEY_SET_POLICY.hash}`,
    `/api/stellar/tx/${PASSKEY_SET_POLICY.hash}?network=eip155:1`,
    `/api/stellar/tx/${PASSKEY_SET_POLICY.hash}?network=testnet`,
    `/api/stellar/tx/xyz?network=${testnet.caip2}`,
    `/api/stellar/tx/${PASSKEY_SET_POLICY.hash}00?network=${testnet.caip2}`,
  ]) {
    const r = await get(path, fetch)
    assert.equal(r.status, 400, path)
    assert.equal((r.body as Record<string, unknown>).error, 'bad_request')
  }
  assert.equal(calls.length, 0)
})

test('not found on every source is 404, and no source answering is 502 with a timestamp', async () => {
  __clearStellarEvidenceCacheForTests()
  const missing = await get(`/api/stellar/tx/${'cd'.repeat(32)}?network=${testnet.caip2}`, fetcher({ status: 404 }).fetch)
  assert.equal(missing.status, 404)
  assert.equal((missing.body as Record<string, unknown>).error, 'not_found')

  const down: HttpFetch = async () => {
    throw new Error('fetch failed')
  }
  const failed = await get(`/api/stellar/tx/${'cd'.repeat(32)}?network=${testnet.caip2}`, down)
  assert.equal(failed.status, 502)
  const b = failed.body as Record<string, unknown>
  assert.equal(b.error, 'read_failed')
  assert.equal(typeof b.at, 'string')
})

test('paths and methods this group does not own are passed on', async () => {
  const { fetch } = fetcher({ status: 500 })
  assert.equal((await get('/api/stellar/vaults', fetch)).handled, false)
  assert.equal((await get(`/api/stellar/tx/${PASSKEY_SET_POLICY.hash}/extra?network=${testnet.caip2}`, fetch)).handled, false)
  assert.equal((await get(`/api/stellar/tx/${PASSKEY_SET_POLICY.hash}?network=${testnet.caip2}`, fetch, 'POST')).handled, false)
})
