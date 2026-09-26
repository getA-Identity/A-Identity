import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { clearPayCheckCache, hostOf, runPayCheck, type PayCheckResult } from './check.js'

// Real-shaped Algorand addresses (valid checksums), so the engine's own address check runs.
function algoAddress(): string {
  const pk = randomBytes(32)
  const ck = createHash('sha512-256').update(pk).digest().subarray(28)
  const bytes = Buffer.concat([pk, ck])
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let val = 0
  let out = ''
  for (const b of bytes) {
    val = (val << 8) | b
    bits += 8
    while (bits >= 5) {
      out += abc[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += abc[(val << (5 - bits)) & 31]
  return out
}

const SELLER = algoAddress()
const CREATOR = algoAddress()
const FAC = 'https://facilitator.test'
const NOW = Date.parse('2026-09-26T12:00:00Z')
const DAY = 86_400
const USDC = 31566704

type World = {
  account?: { created: number; usdc: boolean } | null
  /** Unix seconds of the seller's creating payment. */
  bornAt?: number
  inbound?: { payer: string; amount: number }[]
  /** payer -> the wallet that created it */
  funders?: Record<string, string>
  leaderboard?: Record<string, unknown>[]
  facilitatorDown?: boolean
  ledgerDown?: boolean
}

function fetcherFor(w: World): typeof fetch {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.hostname === 'facilitator.test') {
      if (w.facilitatorDown) throw new Error('facilitator unreachable')
      if (url.pathname === '/data/leaderboards') return json({ items: url.searchParams.get('offset') === '0' ? (w.leaderboard ?? []) : [] })
      if (url.pathname === '/discovery/merchants') return json({ items: [] })
    }
    if (url.hostname.includes('nf.domains')) return json({}, 404)
    if (w.ledgerDown) return json({ message: 'down' }, 503)
    const acct = url.pathname.match(/^\/v2\/accounts\/([A-Z2-7]{58})$/)
    if (acct) {
      const who = acct[1]
      if (who === SELLER) {
        if (!w.account) return json({ message: 'no accounts found' }, 404)
        return json({ account: { address: SELLER, 'created-at-round': w.account.created, assets: w.account.usdc ? [{ 'asset-id': USDC, amount: 0 }] : [] } })
      }
      return json({ account: { address: who, 'created-at-round': 100 } })
    }
    if (url.pathname === `/v2/accounts/${SELLER}/transactions`) {
      return json({
        transactions: (w.inbound ?? []).map((t) => ({
          sender: t.payer,
          'asset-transfer-transaction': { 'asset-id': USDC, amount: t.amount, receiver: SELLER },
        })),
      })
    }
    if (url.pathname === '/v2/transactions') {
      const who = url.searchParams.get('address')!
      const sender = who === SELLER ? CREATOR : (w.funders?.[who] ?? algoAddress())
      return json({ transactions: [{ sender, 'round-time': who === SELLER ? (w.bornAt ?? NOW / 1000 - 400 * DAY) : NOW / 1000 - 400 * DAY }] })
    }
    return json({ message: 'unexpected ' + url.pathname }, 500)
  }) as typeof fetch
}

async function check(w: World, q = SELLER): Promise<PayCheckResult> {
  clearPayCheckCache()
  const env = { ALGORAND_MAINNET_INDEXER_URL: 'https://idx.test' }
  const r = await runPayCheck(q, { fetcher: fetcherFor(w), env, now: () => NOW, facilitator: FAC })
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`)
  return r
}

const payers = (n: number, each = 10_000) => Array.from({ length: n }, () => ({ payer: algoAddress(), amount: each }))

test('pay_check says do not pay when the address was never used, cannot take USDC, or the facilitator blocked it', async () => {
  const never = await check({ account: null })
  assert.equal(never.verdict, 'dont_pay')
  assert.equal(never.reasons[0].code, 'no_account')

  const noUsdc = await check({ account: { created: 1, usdc: false }, inbound: [] })
  assert.equal(noUsdc.verdict, 'dont_pay')
  assert.ok(noUsdc.reasons.some((r) => r.code === 'no_usdc'))

  // A long, diverse history does not outweigh a facilitator block.
  const blocked = await check({
    account: { created: 1, usdc: true },
    inbound: payers(10),
    leaderboard: [{ rank: 3, address: SELLER, sub: 'seller.example', blocked: { reason: 'synthetic payment traffic', since: '2026-09-15' } }],
  })
  assert.equal(blocked.verdict, 'dont_pay')
  assert.match(blocked.reasons[0].text, /Blocked by the x402 facilitator since Sep 15: synthetic payment traffic/)
})

test('pay_check says be careful when the seller pays itself through wallets it created, or that created it', async () => {
  const own = algoAddress()
  const r = await check({
    account: { created: 1, usdc: true },
    inbound: [{ payer: own, amount: 900_000 }, ...payers(3, 10_000)],
    funders: { [own]: SELLER },
  })
  assert.equal(r.verdict, 'careful')
  assert.ok(r.reasons.some((x) => x.code === 'self_funded'))
  assert.ok((r.facts.payers?.sellerFundedShare ?? 0) > 0.9)

  // The wallet that created the seller, paying it, is the same money moving in a circle.
  const viaCreator = await check({ account: { created: 1, usdc: true }, inbound: [{ payer: CREATOR, amount: 900_000 }, ...payers(3)] })
  assert.ok(viaCreator.reasons.some((x) => x.code === 'self_funded'))
})

test('pay_check says be careful for a brand-new account and for one wallet making most payments, saying the single-payer case once', async () => {
  const fresh = await check({ account: { created: 1, usdc: true }, bornAt: NOW / 1000 - 2 * DAY, inbound: payers(5) })
  assert.equal(fresh.verdict, 'careful')
  assert.match(fresh.reasons[0].text, /created 2 days ago/)

  const whale = algoAddress()
  const one = await check({ account: { created: 1, usdc: true }, inbound: [1, 2, 3, 4].map(() => ({ payer: whale, amount: 50_000 })) })
  assert.equal(one.verdict, 'careful')
  assert.ok(one.reasons.some((x) => x.text === 'All of its payments came from a single wallet.'))
  assert.ok(!one.reasons.some((x) => x.code === 'few_payers'), 'the single payer is reported once')
})

test('pay_check says looks safe only for an established account paid by at least three different wallets', async () => {
  const safe = await check({
    account: { created: 1, usdc: true },
    inbound: payers(12),
    leaderboard: [{ rank: 10, address: SELLER, sub: 'seller.example', settles: 400 }],
  })
  assert.equal(safe.verdict, 'safe')
  assert.equal(safe.headline, 'Looks safe to pay')
  assert.ok(safe.reasons.some((x) => x.text === 'Paid by 12 different wallets.'))
  assert.equal(safe.facts.seller?.domain, 'seller.example')

  const thin = await check({ account: { created: 1, usdc: true }, inbound: payers(2) })
  assert.equal(thin.verdict, 'unknown')
  const quiet = await check({ account: { created: 1, usdc: true }, inbound: [] })
  assert.equal(quiet.verdict, 'unknown')
  assert.ok(quiet.reasons.some((x) => x.code === 'no_payments'))
})

test('pay_check resolves a listed seller from its link, and refuses input that is neither an address nor a link', async () => {
  const lb = [{ rank: 1, address: SELLER, sub: 'seller.example' }]
  const viaUrl = await check({ account: { created: 1, usdc: true }, inbound: payers(4), leaderboard: lb }, 'https://www.seller.example/api/tool')
  assert.equal(viaUrl.address, SELLER)
  assert.equal(viaUrl.resolvedFrom, 'url')
  const viaDomain = await check({ account: { created: 1, usdc: true }, inbound: payers(4), leaderboard: lb }, 'seller.example')
  assert.equal(viaDomain.resolvedFrom, 'domain')

  clearPayCheckCache()
  const env = { ALGORAND_MAINNET_INDEXER_URL: 'https://idx.test' }
  const unknown = await runPayCheck('nobody.example', { fetcher: fetcherFor({ leaderboard: lb }), env, now: () => NOW, facilitator: FAC })
  assert.ok('error' in unknown && unknown.httpStatus === 404)
  const junk = await runPayCheck('not an address', { fetcher: fetcherFor({}), env, now: () => NOW, facilitator: FAC })
  assert.ok('error' in junk && junk.httpStatus === 400)
  assert.equal(hostOf('HTTPS://Www.Seller.Example/x?y=1'), 'seller.example')
  assert.equal(hostOf(SELLER), null)
})

test('pay_check keeps its verdict when the facilitator is down, and refuses to guess when the ledger is', async () => {
  const noFacilitator = await check({ account: { created: 1, usdc: true }, inbound: payers(5), facilitatorDown: true })
  assert.equal(noFacilitator.verdict, 'safe')
  assert.equal(noFacilitator.facts.seller, null)

  clearPayCheckCache()
  const env = { ALGORAND_MAINNET_INDEXER_URL: 'https://idx.test' }
  const r = await runPayCheck(SELLER, { fetcher: fetcherFor({ ledgerDown: true }), env, now: () => NOW, facilitator: FAC })
  assert.ok('error' in r && r.httpStatus === 502, 'no verdict is invented without the ledger')
})

test('the paid report adds the per-payer breakdown that the free answer leaves out', async () => {
  clearPayCheckCache()
  const env = { ALGORAND_MAINNET_INDEXER_URL: 'https://idx.test' }
  const own = algoAddress()
  const w: World = { account: { created: 1, usdc: true }, inbound: [{ payer: own, amount: 60_000 }, ...payers(4)], funders: { [own]: SELLER } }
  const free = await runPayCheck(SELLER, { fetcher: fetcherFor(w), env, now: () => NOW, facilitator: FAC })
  const paid = await runPayCheck(SELLER, { fetcher: fetcherFor(w), env, now: () => NOW, facilitator: FAC, detailed: true })
  assert.ok(!('error' in free) && free.details === undefined)
  assert.ok(!('error' in paid) && paid.details)
  const top = paid.details!.topPayers[0]
  assert.equal(top.address, own)
  assert.equal(top.linked, true)
  assert.equal(top.usdc, 0.06)
  assert.equal(paid.details!.sellerFunder, CREATOR)
})
