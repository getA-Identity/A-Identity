import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getChainById } from '../chains/registry.js'
import { rateBudget, rateLimited } from '../rate-budget.js'
import { __resetNearCheckForTests, type NearCheckDeps } from '../near-check/check.js'
import { fakeNearTestnet, replayExchanges, type RecordedExchange } from '../near-check/fake-chain.js'
import { handleNearCheckRoutes, NEAR_CHECK_PATH } from './near-check-routes.js'
import { handleX402GatewayRoutes } from './x402-gateway-routes.js'
import type { RouteCtx } from './shared.js'

/**
 * GET /api/near/check at the boundary a page or an agent codes against, with fetch stubbed:
 * the recorded live collection of the demo merchant (an SDK fixture) and a fake NEAR testnet.
 * Which status each outcome carries, what the body holds, what is cached, and what is refused
 * before any read.
 */

/** Compiled to dist/http/, so the repository is three levels up. */
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const merchant = JSON.parse(readFileSync(`${REPO}near/sdk/test/fixtures/collect-merchant.json`, 'utf8')) as {
  expected: { verdict: string; score: number; codes: string[]; snapshot_sha256: string; chain_sha256: string; block: { height: number } }
  exchanges: RecordedExchange[]
}
const USDC = getChainById('near-testnet')!.documentedTokens!.find((t) => t.symbol === 'USDC')!.address
const base: NearCheckDeps = { clock: () => new Date('2026-11-12T00:00:00.000Z'), sleep: async () => {}, env: {} }

async function call(path: string, deps: NearCheckDeps, method = 'GET') {
  const out: { status?: number; headers: Record<string, string>; body?: Record<string, any> } = { headers: {} }
  const res = {
    setHeader: (k: string, v: string) => {
      out.headers[k.toLowerCase()] = v
    },
    writeHead(status: number) {
      out.status = status
      return this
    },
    end: (payload?: string) => {
      if (payload) out.body = JSON.parse(payload) as Record<string, any>
    },
  }
  const ctx: RouteCtx = { req: { method, headers: {} } as never, res: res as never, url: new URL(`http://localhost${path}`), caller: null, callerId: undefined }
  const handled = await handleNearCheckRoutes(ctx, deps)
  return { handled, ...out }
}

test('GET /api/near/check answers the demo merchant with the SDK\'s own verdict and digests, then from the 60 s cache', async () => {
  __resetNearCheckForTests()
  const calls: string[] = []
  const deps = { ...base, fetch: replayExchanges(merchant.exchanges, calls) }
  const r = await call('/api/near/check?account=aid-demo-merchant.testnet', deps)
  assert.equal(r.handled, true)
  assert.equal(r.status, 200)
  assert.equal(r.headers['cache-control'], 'public, max-age=60')
  const b = r.body!
  assert.equal(b.verdict, merchant.expected.verdict)
  assert.equal(b.score, merchant.expected.score)
  assert.deepEqual(b.reasons.map((x: { code: string }) => x.code), merchant.expected.codes)
  assert.equal(b.snapshot_sha256, merchant.expected.snapshot_sha256)
  assert.equal(b.chain_sha256, merchant.expected.chain_sha256)
  assert.equal(b.recompute.command, `cd near && npm run verdict -- aid-demo-merchant.testnet --at-block ${merchant.expected.block.height}`)
  // The CLI's --json fields are all here, so the two outputs compare field by field.
  for (const k of ['account', 'network', 'mode', 'verdict', 'score', 'warn_kind', 'reasons', 'registry_reasons', 'block', 'snapshot_sha256', 'chain_sha256', 'evidence', 'engine_version', 'policy_id', 'endpoints', 'notes']) {
    assert.ok(k in b, `the answer lacks the CLI's ${k}`)
  }
  assert.equal(b.network, 'testnet')
  assert.equal(b.testnet, true)
  assert.match(b.labels.settlement, /nothing settles on NEAR/)
  assert.equal(b.registry.state, 'not_deployed')
  assert.equal(b.cached, false)
  const reads = calls.length
  const again = await call('/api/near/check?account=near:testnet:aid-demo-merchant.testnet', deps)
  assert.equal(again.status, 200)
  assert.equal(again.body!.cached, true)
  assert.equal(again.body!.chain_sha256, merchant.expected.chain_sha256)
  assert.equal(calls.length, reads, 'the cached answer read nothing')
})

test('a .testnet name nobody registered is 200 DENY account_not_found, and a vault is read when one is named', async () => {
  __resetNearCheckForTests()
  const vault = 'vault.aid-demo-owner.testnet'
  const fake = fakeNearTestnet({
    head: 277_300_000,
    accounts: {},
    views: {
      [USDC]: { is_blocklisted: () => false, storage_balance_of: () => null },
      [vault]: { get_config: () => ({ registry_id: null, token_id: USDC }), paid_count: () => 0, refusal_count: () => 4, guard_refusal_count: () => 1, is_allowed: () => false, list_allowlist: () => [] },
    },
  })
  const r = await call(`/api/near/check?account=nobody-registered-this-zz.testnet&vault=${vault}`, { ...base, fetch: fake.fetch })
  assert.equal(r.status, 200)
  assert.equal(r.body!.verdict, 'DENY')
  assert.equal(r.body!.reasons[0].code, 'account_not_found')
  assert.deepEqual(r.body!.vault, { id: vault, state: 'read', paid_count: 0, refusal_count: 4, guard_refusal_count: 1, allowlisted: false })
  assert.match(r.body!.recompute.command, new RegExp(`--vault ${vault.replace(/\./g, '\\.')}$`))
})

test('a mainnet account, an unrouted id and a missing one are 400 with the reason, before any read', async () => {
  __resetNearCheckForTests()
  const reads: string[] = []
  const deps: NearCheckDeps = { ...base, fetch: async (url) => { reads.push(url); throw new Error('no read for a refused id') } }
  for (const [path, code] of [
    ['/api/near/check?account=wrap.near', 'mainnet'],
    ['/api/near/check?account=near:mainnet:wrap.near', 'mainnet'],
    [`/api/near/check?account=${'ab'.repeat(32)}`, 'ambiguous'],
    ['/api/near/check?account=Not%20an%20id', 'invalid'],
    ['/api/near/check', 'missing'],
    ['/api/near/check?account=alice.testnet&vault=vault.near', 'mainnet'],
  ] as const) {
    const r = await call(path, deps)
    assert.equal(r.status, 400, path)
    assert.equal(r.body!.code, code, `${path}: ${r.body!.error}`)
    assert.equal(typeof r.body!.error, 'string')
  }
  assert.deepEqual(reads, [])
})

test('when NEAR testnet does not answer the route says so: 503 with Retry-After, never a verdict', async () => {
  __resetNearCheckForTests()
  const down = fakeNearTestnet({ head: 1, accounts: {}, views: {}, down: true })
  const r = await call('/api/near/check?account=ghost-payee-zz.testnet', { ...base, fetch: down.fetch })
  assert.equal(r.status, 503)
  assert.equal(r.headers['retry-after'], '30')
  assert.equal(r.body!.code, 'no_verdict')
  assert.ok(!('verdict' in r.body!))
})

test('the route answers GET only, owns no other path, and is free but budgeted in its own bucket', async () => {
  const deps: NearCheckDeps = { ...base, fetch: async () => { throw new Error('no read') } }
  const put = await call('/api/near/check?account=alice.testnet', deps, 'PUT')
  assert.equal(put.status, 405)
  assert.equal(put.headers.allow, 'GET')
  assert.equal((await call('/api/near/checks?account=alice.testnet', deps)).handled, false)
  assert.equal((await call('/api/algorand/check?q=x', deps)).handled, false)
  assert.equal(NEAR_CHECK_PATH, '/api/near/check')
  assert.deepEqual(rateBudget('GET', NEAR_CHECK_PATH), { bucket: 'near-check', max: 20, windowMs: 60_000 })
  assert.notEqual(rateBudget('GET', NEAR_CHECK_PATH)?.bucket, rateBudget('GET', '/api/algorand/check')?.bucket)
  // http.ts dispatches it, alongside the other free checks.
  const http = readFileSync(`${REPO}mcp/src/http.ts`, 'utf8')
  assert.match(http, /if \(await handleNearCheckRoutes\(ctx\)\) return/)
})

test('the free trust_preview on a NEAR testnet account is charged to this route\'s bucket, and on any other target to none', async () => {
  // The Gateway's free preview runs the same NEAR collection for a NEAR target, so a client
  // past its NEAR budget here is refused there too, before anything is read; every other
  // target is served exactly as before, however often it is asked.
  const budget = rateBudget('GET', NEAR_CHECK_PATH)!
  const ip = '198.51.100.61'
  const served: string[] = []
  const preview = async (agentId: string) => {
    const out: { status?: number; headers: Record<string, string>; body?: Record<string, any> } = { headers: {} }
    const res = {
      setHeader: (k: string, v: string) => {
        out.headers[k.toLowerCase()] = v
      },
      writeHead(status: number) {
        out.status = status
        return this
      },
      end: (payload?: string) => {
        if (payload) out.body = JSON.parse(payload) as Record<string, any>
      },
    }
    const url = new URL(`http://localhost/api/x402/gateway/tools/trust_preview?agentId=${encodeURIComponent(agentId)}`)
    const ctx: RouteCtx = { req: { method: 'GET', headers: {}, socket: { remoteAddress: ip } } as never, res: res as never, url, caller: null, callerId: undefined }
    const handled = await handleX402GatewayRoutes(ctx, {
      freeTool: async (input) => {
        served.push(input.agentId ?? '')
        return { tool: 'trust_preview', agentId: input.agentId }
      },
    })
    assert.equal(handled, true)
    return out
  }

  const others = ['not-a-real-id', 'agent_doesnotexist0', '849980', `0x${'ab'.repeat(20)}`, 'example.com', 'wrap.near']
  for (let i = 0; i < budget.max + 5; i++) assert.equal((await preview(others[i % others.length])).status, 200)
  for (let i = 0; i < budget.max; i++) {
    const r = await preview(i % 2 ? `near:testnet:payee-${i}.testnet` : `payee-${i}.testnet`)
    assert.equal(r.status, 200, `NEAR call ${i + 1} of ${budget.max}`)
  }
  const over = await preview('one-more-payee.testnet')
  assert.equal(over.status, 429)
  assert.equal(over.headers['retry-after'], String(budget.windowMs / 1000))
  assert.match(over.body!.error, /GET \/api\/near\/check/)
  assert.ok(!served.includes('one-more-payee.testnet'), 'refused before the preview ran, so nothing was read')
  // One budget: GET /api/near/check from this address is over it now as well (http.ts charges
  // `<ip>:<bucket>` before the route runs).
  assert.equal(rateLimited(`${ip}:${budget.bucket}`, budget.max, budget.windowMs), true)
  // And every other target is still served, uncharged.
  for (const other of others) assert.equal((await preview(other)).status, 200, other)
  assert.equal(served.length, budget.max + 5 + budget.max + others.length)
})
