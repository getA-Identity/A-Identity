import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { KeyPair } from '@near-js/crypto'
import { KeyPairSigner } from '@near-js/signers'
import { actionCreators, buildDelegateAction, encodeSignedDelegate } from '@near-js/transactions'
import { baseEncode } from '@near-js/utils'
import { getChainById } from '../chains/registry.js'
import { NEAR_CHECK_BUDGET, rateBudget } from '../rate-budget.js'
import { __resetNearCheckForTests, nearCheck, type NearCheckAnswer, type NearCheckDeps } from '../near-check/check.js'
import { replayExchanges, type RecordedExchange } from '../near-check/fake-chain.js'
import { __resetNearX402ForTests, NEAR_X402_PATH, NEAR_X402_PAY_TO, type NearX402Deps } from '../near-x402/rail.js'
import { __resetRelayForTests } from '../near-x402/relay.js'
import { fakeNear, type FakeNearOptions } from '../near-x402/fake-near.js'
import { handleNearX402Routes } from './near-x402-routes.js'
import { handleNearCheckRoutes } from './near-check-routes.js'
import type { RouteCtx } from './shared.js'

/**
 * GET /api/near/x402/check at the boundary a buyer codes against, over a fake NEAR testnet that
 * executes the relayed transaction (near-x402/fake-near.ts): the 402, a payment that settles once,
 * every refusal before broadcast, a broadcast that does not pay, an unresolved broadcast, the rail
 * switched off, and the relayer key kept out of every byte that leaves.
 */
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const USDC = getChainById('near-testnet')!.documentedTokens!.find((t) => t.symbol === 'USDC')!.address
const RELAYER = 'x402-relayer.a-identity.testnet'
const PAYER = 'aid-demo-agent.testnet'
const relayerKey = KeyPair.fromRandom('ed25519')
const SECRET = relayerKey.toString()
const SECRET_BODY = SECRET.slice('ed25519:'.length)
const ENV = { NEAR_X402_RELAYER_ACCOUNT: RELAYER, NEAR_X402_RELAYER_KEY: SECRET }

type World = ReturnType<typeof fakeNear> & { buyer: KeyPair; spent: Set<string>; logs: string[]; deps: NearX402Deps; leaks: string[] }

/** A verdict as GET /api/near/check returns it, enough for the paid path to wrap. */
function verdict(account: string): NearCheckAnswer {
  return {
    account,
    caip2: 'near:testnet',
    network: 'testnet',
    testnet: true,
    verdict: 'WARN',
    score: 440,
    reasons: [{ code: 'new_account' }],
    block: { height: 277_429_000, hash: 'H', timestamp_ns: '0' },
    labels: { network: 'n', read: 'r', settlement: 'nothing settles on NEAR through A-Identity yet: this is a verdict, not a payment' },
    cached: false,
  } as unknown as NearCheckAnswer
}

function world(o: Partial<FakeNearOptions> & { buyerPermission?: 'FullAccess' | 'FunctionCall'; env?: NodeJS.ProcessEnv } = {}): World {
  __resetNearX402ForTests()
  __resetRelayForTests()
  const buyer = KeyPair.fromRandom('ed25519')
  const chain = fakeNear({
    height: 277_430_000,
    token: USDC,
    accounts: {
      [RELAYER]: { amount: '2000000000000000000000000', keys: { [relayerKey.getPublicKey().toString()]: { nonce: 100n, permission: 'FullAccess' } } },
      [PAYER]: { keys: { [buyer.getPublicKey().toString()]: { nonce: 277_284_573_000_001n, permission: o.buyerPermission ?? 'FullAccess' } } },
      [NEAR_X402_PAY_TO]: {},
    },
    balances: { [PAYER]: 2_000_000n },
    registered: [PAYER, NEAR_X402_PAY_TO],
    ...o,
  })
  const spent = new Set<string>()
  const logs: string[] = []
  const leaks: string[] = []
  const deps: NearX402Deps = {
    env: o.env ?? ENV,
    fetchImpl: chain.fetch,
    check: async (account) => verdict(account),
    loadSpent: async () => [...spent],
    persistSpent: async (k) => void spent.add(k),
    log: (line) => void logs.push(line),
    sleep: async () => {},
    pollMs: 0,
    lookupMs: 0,
  }
  return Object.assign(chain, { buyer, spent, logs, deps, leaks })
}

async function payment(w: World, o: { amount?: string; to?: string; token?: string; deposit?: bigint; nonce?: bigint; accepted?: Record<string, unknown>; window?: number } = {}): Promise<string> {
  const da = buildDelegateAction({
    actions: [actionCreators.functionCall('ft_transfer', { receiver_id: o.to ?? NEAR_X402_PAY_TO, amount: o.amount ?? '10000' }, 30_000_000_000_000n, o.deposit ?? 1n)],
    maxBlockHeight: BigInt(w.height + (o.window ?? 100)),
    nonce: o.nonce ?? 277_284_573_000_002n,
    publicKey: w.buyer.getPublicKey(),
    receiverId: o.token ?? USDC,
    senderId: PAYER,
  })
  const [, sd] = await new KeyPairSigner(w.buyer).signDelegateAction(da)
  const accepted = { scheme: 'exact', network: 'near:testnet', asset: USDC, amount: '10000', payTo: NEAR_X402_PAY_TO, maxTimeoutSeconds: 120, extra: {}, ...o.accepted }
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { signedDelegateAction: Buffer.from(encodeSignedDelegate(sd)).toString('base64') } })).toString('base64')
}

type Answer = { handled: boolean; status?: number; headers: Record<string, string>; body?: Record<string, any>; deliver: (delivered: boolean) => void }

async function call(w: World | null, path: string, pay?: string, method = 'GET', deps?: NearX402Deps): Promise<Answer> {
  const out: Answer = { handled: false, headers: {}, deliver: () => {} }
  let onClose: (() => void) | null = null
  let finished = true
  const res = {
    destroyed: false,
    get writableFinished() {
      return finished
    },
    once: (_: 'close', cb: () => void) => void (onClose = cb),
    setHeader: (k: string, v: string) => void (out.headers[k.toLowerCase()] = v),
    writeHead(status: number) {
      out.status = status
      return this
    },
    end: (payload?: string) => {
      if (payload) out.body = JSON.parse(payload) as Record<string, any>
    },
  }
  const headers: Record<string, string> = pay ? { 'payment-signature': pay } : {}
  const ctx: RouteCtx = { req: { method, headers } as never, res: res as never, url: new URL(`http://localhost${path}`), caller: null, callerId: undefined }
  out.handled = await handleNearX402Routes(ctx, deps ?? w?.deps ?? {})
  out.deliver = (delivered) => {
    finished = delivered
    onClose?.()
  }
  // Everything that leaves, kept for the key check.
  w?.leaks.push(JSON.stringify(out.headers), JSON.stringify(out.body ?? null))
  return out
}

const PATH = `${NEAR_X402_PATH}?account=aid-demo-merchant.testnet`
const sendsOf = (w: World) => w.calls.filter((c) => c.method === 'send_tx').length

test('rail off: without both relayer variables the route answers 503 rail off, serves no challenge and reads nothing', async () => {
  for (const env of [{}, { NEAR_X402_RELAYER_ACCOUNT: RELAYER }, { NEAR_X402_RELAYER_KEY: SECRET }, { NEAR_X402_RELAYER_ACCOUNT: RELAYER, NEAR_X402_RELAYER_KEY: `ed25519:${SECRET_BODY.slice(0, 40)}!` }]) {
    const w = world({ env })
    const r = await call(w, PATH, await payment(w))
    assert.equal(r.status, 503)
    assert.equal(r.body!.code, 'rail_off')
    assert.equal(r.body!.error, 'rail off')
    assert.match(r.body!.reason, /NEAR_X402_RELAYER_(ACCOUNT|KEY)/)
    assert.equal(r.headers['payment-required'], undefined, 'a challenge was served with the rail off')
    assert.ok(!('accepts' in r.body!))
    assert.equal(r.headers['retry-after'], '30')
    assert.equal(w.calls.length, 0, 'the rail read the chain while off')
    assert.ok(!JSON.stringify(r.body).includes(SECRET_BODY.slice(0, 16)))
  }
})

test('the 402 is x402 v2 exact on near:testnet with exactly the spec fields, in PAYMENT-REQUIRED and the body, and the relayer only in notes', async () => {
  const w = world()
  const r = await call(w, PATH)
  assert.equal(r.status, 402)
  assert.equal(r.headers['cache-control'], 'no-store')
  const header = JSON.parse(Buffer.from(r.headers['payment-required'], 'base64').toString('utf8'))
  assert.deepEqual(header, r.body)
  assert.equal(r.body!.x402Version, 2)
  assert.deepEqual(r.body!.accepts, [{ scheme: 'exact', network: 'near:testnet', asset: USDC, amount: '10000', payTo: 'a-identity.testnet', maxTimeoutSeconds: 120, extra: {} }])
  assert.ok(!JSON.stringify(r.body!.accepts).includes(RELAYER), 'the spec keeps the relayer out of the requirements')
  assert.match(r.body!.notes.relayer, new RegExp(RELAYER.replace(/\./g, '\\.')))
  assert.equal(r.body!.resource.url, PATH)
  assert.match(r.body!.notes.sells, /GET \/api\/near\/check/)
  assert.equal(sendsOf(w), 0)
  // A refused account is 400 before any challenge, and a payTo that cannot receive is no challenge at all.
  const bad = await call(w, `${NEAR_X402_PATH}?account=wrap.near`)
  assert.equal(bad.status, 400)
  assert.equal(bad.body!.code, 'mainnet')
  const unready = world({ registered: [PAYER] })
  const u = await call(unready, PATH)
  assert.equal(u.status, 503)
  assert.equal(u.body!.code, 'not_ready')
  assert.match(u.body!.reason, /holds no storage registration/)
  assert.equal(u.headers['payment-required'], undefined)
  const wrongToken = world({ metadata: { spec: 'ft-1.0.0', symbol: 'USDC', decimals: 18 } })
  assert.equal((await call(wrongToken, PATH)).body!.code, 'not_ready')
  const mainnetHost = world({ chainId: 'mainnet' })
  assert.match((await call(mainnetHost, PATH)).body!.reason, /could not be read: .*mainnet/)
})

test('a valid payment settles once: verified, relayed with its hash recorded before the send, proven, served, and every replay refused', async () => {
  const w = world()
  // At the moment of the send the hash must already be in the server's own record (its log line).
  const inner = w.deps.fetchImpl!
  w.deps.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.method === 'send_tx') {
      const bytes = Buffer.from(body.params.signed_tx_base64, 'base64')
      const hash = baseEncode(createHash('sha256').update(bytes.subarray(0, bytes.length - 65)).digest())
      assert.ok(w.logs.some((l) => l.includes(`broadcasting ${hash}`)), 'sent before its hash was recorded')
    }
    return inner(input, init)
  }) as typeof fetch
  const pay = await payment(w)
  const r = await call(w, PATH, pay)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(sendsOf(w), 1)
  const tx = w.sends[0].hash
  assert.equal(w.sends[0].relayerSignatureValid, true)
  assert.deepEqual(JSON.parse(Buffer.from(r.headers['payment-response'], 'base64').toString('utf8')), { success: true, transaction: tx, network: 'near:testnet', payer: PAYER, amount: '10000' })
  assert.equal(r.body!.verdict, 'WARN')
  assert.equal(r.body!.payment.transaction, tx)
  assert.equal(r.body!.payment.relayer, RELAYER)
  assert.equal(r.body!.payment.reconciled, false)
  assert.match(r.body!.payment.event, /"old_owner_id":"aid-demo-agent\.testnet","new_owner_id":"a-identity\.testnet","amount":"10000"/)
  assert.match(r.body!.labels.settlement, /^paid over x402 on NEAR testnet/)
  assert.equal(w.balances.get(NEAR_X402_PAY_TO), 10_000n)
  assert.deepEqual([...w.spent].map((k) => k.split('/').slice(0, 4).join('/')), [`near:testnet/nep141:${USDC}/nep366/${PAYER}`])
  r.deliver(true)

  // The same payment again: refused from the payments in hand, then from the durable set alone,
  // then, with both forgotten, by the chain itself (the delegate's nonce is spent). Nothing is sent.
  const again = await call(w, PATH, pay)
  assert.equal(again.status, 402)
  assert.equal(again.body!.refused.code, 'already_redeemed')
  __resetNearX402ForTests()
  assert.equal((await call(w, PATH, pay)).body!.refused.code, 'already_redeemed')
  __resetNearX402ForTests()
  w.spent.clear()
  const chainSays = await call(w, PATH, pay)
  assert.equal(chainSays.status, 402)
  assert.equal(chainSays.body!.refused.code, 'invalid_exact_near_payload_delegate_action_nonce_already_used')
  assert.equal(sendsOf(w), 1, 'a replay was broadcast')
  assert.equal(w.balances.get(NEAR_X402_PAY_TO), 10_000n)
})

test('a payment whose answer never reached the socket is served again to the same request with no second broadcast; another request is 409', async () => {
  const w = world()
  const pay = await payment(w)
  const first = await call(w, PATH, pay)
  assert.equal(first.status, 200)
  // While the first answer is still on its way, the same payment waits.
  assert.equal((await call(w, PATH, pay)).status, 409)
  first.deliver(false)
  const second = await call(w, PATH, pay)
  assert.equal(second.status, 200)
  assert.equal(second.body!.payment.reconciled, true)
  assert.equal(second.body!.payment.transaction, first.body!.payment.transaction)
  second.deliver(false)
  const other = await call(w, `${NEAR_X402_PATH}?account=aid-demo-merchamt.testnet`, pay)
  assert.equal(other.status, 409)
  assert.equal(other.body!.code, 'request_mismatch')
  assert.equal(sendsOf(w), 1)
})

test('a payment for another amount, payee, asset, network or key kind is refused before anything is broadcast', async () => {
  const cases: [string, (w: World) => Promise<string>, string, FakeNearOptions['accounts'] | null][] = [
    ['amount', (w) => payment(w, { accepted: { amount: '9999' } }), 'wrong_amount', null],
    ['payTo', (w) => payment(w, { accepted: { payTo: 'thief.testnet' } }), 'wrong_recipient', null],
    ['asset', (w) => payment(w, { accepted: { asset: 'usdc.testnet' } }), 'wrong_asset', null],
    ['network', (w) => payment(w, { accepted: { network: 'near:mainnet' } }), 'wrong_network', null],
    ['scheme', (w) => payment(w, { accepted: { scheme: 'upto' } }), 'unsupported_scheme', null],
    // What was accepted matches, and what was SIGNED does not: @x402/near's verify refuses it.
    ['signed amount', (w) => payment(w, { amount: '9999' }), 'invalid_exact_near_payload_amount_mismatch', null],
    ['signed payee', (w) => payment(w, { to: 'thief.testnet' }), 'invalid_exact_near_payload_recipient_mismatch', null],
    ['signed token', (w) => payment(w, { token: 'usdc.testnet' }), 'invalid_exact_near_payload_token_contract_mismatch', null],
    ['no yoctoNEAR', (w) => payment(w, { deposit: 0n }), 'invalid_exact_near_payload_attached_deposit', null],
    ['a window past maxTimeoutSeconds', (w) => payment(w, { window: 500 }), 'invalid_exact_near_payload_delegate_action_timeout_window_exceeds_max_timeout', null],
  ]
  for (const [name, make, code] of cases) {
    const w = world()
    const r = await call(w, PATH, await make(w))
    assert.equal(r.status, 402, name)
    assert.equal(r.body!.refused.code, code, `${name}: ${JSON.stringify(r.body!.refused)}`)
    assert.ok(r.headers['payment-required'], `${name}: the refusal is a fresh challenge`)
    assert.equal(sendsOf(w), 0, `${name} was broadcast`)
  }
  // A function-call key cannot pay: nearcore would refuse its yoctoNEAR, so verify refuses first.
  const fc = world({ buyerPermission: 'FunctionCall' })
  const r = await call(fc, PATH, await payment(fc))
  assert.equal(r.body!.refused.code, 'invalid_exact_near_function_call_key_not_allowed')
  assert.equal(sendsOf(fc), 0)
  // Garbage is a fresh challenge too.
  const g = world()
  assert.equal((await call(g, PATH, Buffer.from('{"x402Version":2}').toString('base64'))).body!.refused.code, 'malformed_payload')
  assert.equal((await call(g, PATH, await payment(g, { accepted: {} }).then((p) => p.replace(/./, '!')))).status, 402)
})

test('a broadcast that does not move the money is not counted as paid: no verdict, no PAYMENT-RESPONSE, no replay key', async () => {
  for (const [transfer, reason] of [
    ['panic', /^receipt_failure/],
    ['no_event', /^no_matching_ft_transfer/],
    ['fake_event_elsewhere', /^no_matching_ft_transfer/],
  ] as const) {
    const w = world({ transfer })
    const pay = await payment(w)
    const r = await call(w, PATH, pay)
    assert.equal(r.status, 502, transfer)
    assert.equal(r.body!.code, 'not_paid')
    assert.match(r.body!.reason, reason, transfer)
    assert.equal(r.body!.transaction, w.sends[0].hash)
    assert.equal(r.headers['payment-response'], undefined)
    assert.ok(!('verdict' in r.body!), `${transfer}: a verdict was served for a payment that did not pay`)
    assert.equal(w.spent.size, 0)
    // Sent again, it is not broadcast again, and still not served.
    const again = await call(w, PATH, pay)
    assert.equal(again.status, 402)
    assert.equal(again.body!.refused.code, 'not_paid')
    assert.equal(sendsOf(w), 1)
  }
})

test('a send with no FINAL answer is 502 with its hash; the same payment is served once the transaction shows up, and nothing is sent twice', async () => {
  const w = world({ send: 'timeout_lost' })
  const pay = await payment(w)
  const first = await call(w, PATH, pay)
  assert.equal(first.status, 502)
  assert.equal(first.body!.code, 'settlement_pending')
  assert.equal(first.body!.ambiguous, true)
  const tx = w.sends[0].hash
  assert.equal(first.body!.transaction, tx)
  assert.equal(first.headers['payment-response'], undefined)
  // Still not visible: still pending, still one send.
  assert.equal((await call(w, PATH, pay)).body!.code, 'settlement_pending')
  w.reveal(tx)
  const second = await call(w, PATH, pay)
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.equal(second.body!.payment.transaction, tx)
  assert.equal(second.body!.payment.reconciled, true)
  assert.equal(sendsOf(w), 1)
})

test('the relayer key never leaves: no response, header or log line carries any part of it', async () => {
  const out: string[] = []
  const realError = console.error
  const realLog = console.log
  console.error = (...a: unknown[]) => void out.push(a.map(String).join(' '))
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(' '))
  try {
    const flows: World[] = []
    for (const o of [{}, { transfer: 'panic' as const }, { send: 'timeout_lost' as const }, { registered: [PAYER] }]) {
      const w = world(o)
      flows.push(w)
      await call(w, PATH)
      const pay = await payment(w)
      const r = await call(w, PATH, pay)
      r.deliver(true)
      await call(w, PATH, pay)
      await call(w, `${NEAR_X402_PATH}?account=x`, pay)
    }
    const bad = world({ env: { NEAR_X402_RELAYER_ACCOUNT: 'relayer.near', NEAR_X402_RELAYER_KEY: SECRET } })
    flows.push(bad)
    await call(bad, PATH)
    const everything = [...flows.flatMap((w) => [...w.leaks, ...w.logs]), ...out].join('\n')
    assert.ok(everything.length > 1000, 'the flows produced nothing to check')
    for (let i = 0; i + 12 <= SECRET_BODY.length; i += 6) {
      assert.ok(!everything.includes(SECRET_BODY.slice(i, i + 12)), 'a piece of the relayer key left the server')
    }
  } finally {
    console.error = realError
    console.log = realLog
  }
})

test('the paid answer is the free answer, from the same engine, plus how it was paid for', async () => {
  __resetNearCheckForTests()
  const merchant = JSON.parse(readFileSync(`${REPO}near/sdk/test/fixtures/collect-merchant.json`, 'utf8')) as { exchanges: RecordedExchange[] }
  const checkDeps: NearCheckDeps = { clock: () => new Date('2026-11-12T00:00:00.000Z'), sleep: async () => {}, env: {}, fetch: replayExchanges(merchant.exchanges, []) }
  const free: Answer = { handled: false, headers: {}, deliver: () => {} }
  const res = {
    setHeader: () => {},
    writeHead(status: number) {
      free.status = status
      return this
    },
    end: (payload?: string) => void (free.body = JSON.parse(payload!)),
  }
  await handleNearCheckRoutes({ req: { method: 'GET', headers: {} } as never, res: res as never, url: new URL('http://localhost/api/near/check?account=aid-demo-merchant.testnet'), caller: null, callerId: undefined }, checkDeps)
  assert.equal(free.status, 200)
  const w = world()
  w.deps.check = (account, vault) => nearCheck(account, { vault }, checkDeps)
  const paid = await call(w, PATH, await payment(w))
  assert.equal(paid.status, 200, JSON.stringify(paid.body))
  const { payment: how, labels, cached: _c1, ...rest } = paid.body!
  const { labels: freeLabels, cached: _c2, ...freeRest } = free.body!
  assert.deepEqual(rest, freeRest, 'the paid verdict differs from the free one')
  assert.deepEqual({ ...labels, settlement: freeLabels.settlement }, freeLabels)
  assert.equal(how.transaction, w.sends[0].hash)
})

test('the route answers GET only, owns its one path, is charged to the NEAR bucket, and http.ts dispatches it', async () => {
  const w = world()
  const post = await call(w, PATH, undefined, 'POST')
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET')
  assert.equal((await call(w, '/api/near/x402/checks?account=a.testnet')).handled, false)
  assert.equal((await call(w, '/api/near/check?account=a.testnet')).handled, false)
  assert.deepEqual(rateBudget('GET', NEAR_X402_PATH), { ...NEAR_CHECK_BUDGET })
  assert.equal(rateBudget('GET', NEAR_X402_PATH)?.bucket, rateBudget('GET', '/api/near/check')?.bucket)
  const http = readFileSync(`${REPO}mcp/src/http.ts`, 'utf8')
  assert.match(http, /if \(await handleNearX402Routes\(ctx\)\) return/)
})
