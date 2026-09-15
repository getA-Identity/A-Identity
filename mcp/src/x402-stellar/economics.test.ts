import test from 'node:test'
import assert from 'node:assert/strict'

import { stellarFeeEconomics } from './economics.js'
import { getChainById } from '../chains/registry.js'
import { RAIL_BASE_PRICES_USD } from './rail.js'
import type { StellarSettlementRecord } from '../storage.js'

const PUBNET = getChainById('stellar')!
const TESTNET = getChainById('stellar-testnet')!

/** The exact body Horizon returned for the pubnet XLM/USDC book on 2026-09-15. */
const BOOK = {
  bids: [{ price_r: { n: 190979, d: 1000000 }, price: '0.1909790', amount: '2435.5935386' }],
  asks: [{ price_r: { n: 191, d: 1000 }, price: '0.1910000', amount: '143750.7577576' }],
  base: { asset_type: 'native' },
  counter: { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
}

const NO_ROWS = async () => [] as StellarSettlementRecord[]
const AT = () => new Date('2026-09-15T00:00:00.000Z')

const row = (over: Partial<StellarSettlementRecord>): StellarSettlementRecord => ({
  ts: '2026-09-15T00:00:00.000Z',
  outcome: 'settled',
  tool: 'verify_agent',
  resource: '/api/x402/stellar/tools/verify_agent',
  network: PUBNET.caip2,
  asset: 'C',
  assetSymbol: 'USDC',
  assetDecimals: 7,
  value: '10000',
  amountUsd: 0.001,
  baseUsd: 0.001,
  payer: 'G',
  payTo: 'G',
  broadcaster: 'self',
  confirmedBy: 'soroban-rpc',
  ...over,
})

const served = (body: unknown) => {
  const seen: string[] = []
  return {
    seen,
    fetchJson: async (url: string) => {
      seen.push(url)
      return body
    },
  }
}

test('the whole sum runs off live inputs, and every number in it is checkable by hand', async () => {
  const f = served(BOOK)
  const r = await stellarFeeEconomics(PUBNET, { fetchJson: f.fetchJson, load: NO_ROWS, now: AT })
  assert.equal(r.live, true)
  if (!r.live) return
  assert.equal(r.xlmUsdcBid, 0.190979)
  // No log rows, so the documented pubnet measurement, and it says that in `basis` rather
  // than letting a constant pass for an observation.
  assert.equal(r.measuredFeeStroops, '23479')
  assert.match(r.basis, /documented measurement/)
  // 23479 stroops is 0.0023479 XLM; at 0.190979 USDC per XLM that is 0.000448390... USD.
  assert.equal(r.settlementCostUsd, Number((0.0023479 * 0.190979).toFixed(9)))
  assert.equal(r.cheapestToolUsd, 0.001)
  // The share and the break-even are the same fact stated twice, so they must agree: at the
  // break-even price the share is exactly 1.
  assert.equal(r.costShareOfCheapestSale, Number((r.settlementCostUsd / 0.001).toFixed(6)))
  assert.equal(r.breakEvenXlmUsd, Number((0.001 / 0.0023479).toFixed(6)))
  assert.ok(Math.abs(r.costShareOfCheapestSale - r.xlmUsdcBid / r.breakEvenXlmUsd) < 1e-4)
  assert.equal(r.readAt, '2026-09-15T00:00:00.000Z')
})

test('the cheapest tool is READ from the price table, never typed next to it', () => {
  // If a cheaper tool is ever added, the break-even must move with it. Asserting the number
  // here and deriving it there would be two things that must agree; this is the one thing.
  assert.equal(Math.min(...Object.values(RAIL_BASE_PRICES_USD)), 0.001)
})

test('the order book URL is built from the registry, host and asset both', async () => {
  const f = served(BOOK)
  await stellarFeeEconomics(PUBNET, { fetchJson: f.fetchJson, load: NO_ROWS, now: AT })
  const url = f.seen[0]
  const [code, issuer] = PUBNET.settlementTokens![0].classicAsset!.split(':')
  assert.ok(url.startsWith(PUBNET.horizonUrls![0]), 'the Horizon host comes from the descriptor')
  assert.ok(url.includes('selling_asset_type=native'))
  assert.ok(url.includes(`buying_asset_code=${code}`))
  assert.ok(url.includes(`buying_asset_issuer=${issuer}`))
  // Four characters, so alphanum4. Derived from the code rather than assumed, because the
  // wrong type is a 400 that would read here as an empty market.
  assert.ok(url.includes('buying_asset_type=credit_alphanum4'))
})

test('the two networks price against their own book and their own measurement', async () => {
  const f = served(BOOK)
  const t = await stellarFeeEconomics(TESTNET, { fetchJson: f.fetchJson, load: NO_ROWS, now: AT })
  assert.equal(t.live, true)
  if (!t.live) return
  assert.equal(t.measuredFeeStroops, '22973', 'testnet has its own measured settlement')
  assert.ok(f.seen[0].startsWith(TESTNET.horizonUrls![0]))
  assert.notEqual(TESTNET.horizonUrls![0], PUBNET.horizonUrls![0])
})

test('a charged fee in our own log beats the documented constant, and says so', async () => {
  const f = served(BOOK)
  const rows = async () => [
    row({ feeStroops: '34035', feeChargedStroops: '20000' }),
    // Newest wins, and it is the CHARGE that is read: a row carrying only the bid must not
    // be mistaken for a measurement, or the overstatement comes straight back.
    row({ feeStroops: '34035', feeChargedStroops: '21111' }),
    row({ feeStroops: '99999' }),
  ]
  const r = await stellarFeeEconomics(PUBNET, { fetchJson: f.fetchJson, load: rows, now: AT })
  assert.equal(r.live, true)
  if (!r.live) return
  assert.equal(r.measuredFeeStroops, '21111')
  assert.match(r.basis, /our own settlement log/)
  assert.doesNotMatch(r.basis, /documented measurement/)
})

test('a charged fee recorded on the OTHER network is not borrowed', async () => {
  const f = served(BOOK)
  const rows = async () => [row({ network: TESTNET.caip2, feeChargedStroops: '11111' })]
  const r = await stellarFeeEconomics(PUBNET, { fetchJson: f.fetchJson, load: rows, now: AT })
  assert.equal(r.live, true)
  if (!r.live) return
  // A pubnet fee and a testnet fee are not comparable quantities, which is the same reason
  // the daily budget is scoped by network.
  assert.equal(r.measuredFeeStroops, '23479')
})

test('a malformed fee in the log is skipped rather than guessed at', async () => {
  const f = served(BOOK)
  const rows = async () => [
    row({ feeChargedStroops: '19000' }),
    row({ feeChargedStroops: 'not-a-number' }),
    row({ feeChargedStroops: '0' }),
  ]
  const r = await stellarFeeEconomics(PUBNET, { fetchJson: f.fetchJson, load: rows, now: AT })
  assert.equal(r.live, true)
  if (!r.live) return
  assert.equal(r.measuredFeeStroops, '19000', 'the newest row we can actually read')
})

test('an unreachable Horizon is live:false with a reason, never a remembered price', async () => {
  const r = await stellarFeeEconomics(PUBNET, {
    fetchJson: async () => {
      throw new Error('ETIMEDOUT')
    },
    load: NO_ROWS,
    now: AT,
  })
  assert.equal(r.live, false)
  if (r.live) return
  assert.match(r.reason, /ETIMEDOUT/)
  // The whole point: no price, no cost, no break-even. A stale rate wearing a live label is
  // worse than saying nothing.
  assert.equal((r as Record<string, unknown>).xlmUsdcBid, undefined)
  assert.equal((r as Record<string, unknown>).settlementCostUsd, undefined)
})

test('an empty book is a market state, not an exception', async () => {
  for (const body of [{ bids: [] }, { bids: [{ price: '0' }] }, { bids: [{ price: 'x' }] }, {}, null]) {
    const r = await stellarFeeEconomics(PUBNET, { fetchJson: async () => body, load: NO_ROWS, now: AT })
    assert.equal(r.live, false, `no usable bid in ${JSON.stringify(body)} must not be live`)
    if (!r.live) assert.match(r.reason, /no usable bid/)
  }
})

test('a chain with no Horizon and a chain with no classic asset both refuse by name', async () => {
  const noHorizon = { ...PUBNET, horizonUrls: undefined }
  const a = await stellarFeeEconomics(noHorizon, { fetchJson: async () => BOOK, load: NO_ROWS, now: AT })
  assert.equal(a.live, false)
  if (!a.live) assert.match(a.reason, /no Horizon endpoint/)

  const noAsset = { ...PUBNET, settlementTokens: [{ ...PUBNET.settlementTokens![0], classicAsset: undefined }] }
  const b = await stellarFeeEconomics(noAsset, { fetchJson: async () => BOOK, load: NO_ROWS, now: AT })
  assert.equal(b.live, false)
  if (!b.live) assert.match(b.reason, /classicAsset/)
})

test('an unreadable settlement log degrades to the documented measurement instead of throwing', async () => {
  const r = await stellarFeeEconomics(PUBNET, {
    fetchJson: async () => BOOK,
    load: async () => {
      throw new Error('postgres is down')
    },
    now: AT,
  })
  // The log improves the fee; it is not required for the price. A status endpoint must not
  // go dark because the database did.
  assert.equal(r.live, true)
  if (r.live) assert.equal(r.measuredFeeStroops, '23479')
})

test('the timeout is passed to the caller doing the I/O, so nothing can hang unbounded', async () => {
  let saw = -1
  await stellarFeeEconomics(PUBNET, {
    fetchJson: async (_url, timeoutMs) => {
      saw = timeoutMs
      return BOOK
    },
    load: NO_ROWS,
    now: AT,
  })
  assert.equal(saw, 15_000)
  await stellarFeeEconomics(PUBNET, {
    fetchJson: async (_url, timeoutMs) => {
      saw = timeoutMs
      return BOOK
    },
    load: NO_ROWS,
    now: AT,
    timeoutMs: 250,
  })
  assert.equal(saw, 250)
})

test('the prose the rail carried is now a number this file produces', async () => {
  // rail.ts documents a break-even of XLM at 0.4353 USD, worked out by hand from the 22973
  // stroop testnet measurement against the 0.001 USD tool. Reproducing it here is what makes
  // the paragraph checkable instead of remembered: same inputs, same answer.
  const r = await stellarFeeEconomics(TESTNET, { fetchJson: async () => BOOK, load: NO_ROWS, now: AT })
  assert.equal(r.live, true)
  if (!r.live) return
  assert.equal(r.measuredFeeStroops, '22973')
  assert.ok(Math.abs(r.breakEvenXlmUsd - 0.4353) < 0.0001, `break-even drifted to ${r.breakEvenXlmUsd}`)
})
