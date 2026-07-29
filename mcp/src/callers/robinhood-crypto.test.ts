import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseAsset, robinhoodCryptoAdapter as rh } from './robinhood-crypto.js'
import { evaluateAction } from '../policy/engine.js'
import { defaultActionPolicy } from '../policy/policy.js'
import type { AccountSnapshot } from '../policy/types.js'

// Phase 6.2. The venue is not reachable yet, which is exactly why these are pure translation
// tests: no network, no credentials, no invented market data. The point is that when the
// crypto agent surface ships, the engine needs no change.

const AT = new Date('2026-07-29T03:00:00Z') // deliberately outside any equity session

// ── valuing the order ─────────────────────────────────────────────────────────────

test('a limit order valued in USD uses quote_amount directly', () => {
  const r = rh.normalizeAction({
    symbol: 'BTC-USD',
    side: 'buy',
    type: 'limit',
    limit_order_config: { quote_amount: '250.50', limit_price: '61000', time_in_force: 'gtc' },
  })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.value.notionalUsd, 250.5)
  assert.equal(r.ok && r.value.assetClass, 'crypto')
  assert.equal(r.ok && r.value.side, 'buy')
})

test('quantity times the limit price is used when there is no quote amount', () => {
  const r = rh.normalizeAction({
    symbol: 'ETH-USD',
    side: 'buy',
    type: 'limit',
    limit_order_config: { asset_quantity: '0.5', limit_price: '3000' },
  })
  assert.equal(r.ok && r.value.notionalUsd, 1500)
})

test('a market order needs a mark, and fails rather than estimating without one', () => {
  // The most tempting place to guess, and the least defensible: an unpriced market order
  // would be checked against a number nobody supplied.
  const without = rh.normalizeAction({
    symbol: 'BTC-USD',
    side: 'buy',
    type: 'market',
    market_order_config: { asset_quantity: '0.01' },
  })
  assert.equal(without.ok, false)
  assert.ok(!without.ok && without.reason.includes('estimate is not good enough'))

  const withMark = rh.normalizeAction({
    symbol: 'BTC-USD',
    side: 'buy',
    type: 'market',
    market_order_config: { asset_quantity: '0.01' },
    markPriceUsd: 61000,
  })
  assert.equal(withMark.ok && withMark.value.notionalUsd, 610)
})

test('stop orders are valued from the price the payload carries', () => {
  const stopLimit = rh.normalizeAction({
    symbol: 'SOL-USD', side: 'sell', type: 'stop_limit',
    stop_limit_order_config: { asset_quantity: '10', limit_price: '150', stop_price: '145' },
  })
  assert.equal(stopLimit.ok && stopLimit.value.notionalUsd, 1500)

  const stopLoss = rh.normalizeAction({
    symbol: 'SOL-USD', side: 'sell', type: 'stop_loss',
    stop_loss_order_config: { asset_quantity: '10', stop_price: '145' },
  })
  assert.equal(stopLoss.ok && stopLoss.value.notionalUsd, 1450)
})

test('a negative or reversed quantity still yields a positive amount at risk', () => {
  const r = rh.normalizeAction({
    symbol: 'BTC-USD', side: 'sell', type: 'limit',
    limit_order_config: { asset_quantity: '-0.5', limit_price: '60000' },
  })
  assert.equal(r.ok && r.value.notionalUsd, 30_000)
})

// ── refusing to translate rather than guessing ────────────────────────────────────

test('a malformed order is refused with a reason, not coerced', () => {
  const cases: [unknown, string][] = [
    [null, 'No order payload'],
    [{ side: 'buy', type: 'market' }, 'names no symbol'],
    [{ symbol: 'BTC-USD', type: 'market' }, 'Unrecognized side'],
    [{ symbol: 'BTC-USD', side: 'long', type: 'market' }, 'Unrecognized side'],
    [{ symbol: 'BTC-USD', side: 'buy', type: 'trailing_stop' }, 'Unrecognized order type'],
  ]
  for (const [payload, expect] of cases) {
    const r = rh.normalizeAction(payload as never)
    assert.equal(r.ok, false, JSON.stringify(payload))
    assert.ok(!r.ok && r.reason.includes(expect), `${JSON.stringify(payload)} -> ${!r.ok ? r.reason : ''}`)
  }
})

// ── the pair-versus-asset trap ────────────────────────────────────────────────────

test('the symbol is reduced to its base asset', () => {
  // "Only trade BTC" must not silently miss BTC-USDC because the list held BTC-USD.
  assert.equal(baseAsset('BTC-USD'), 'BTC')
  assert.equal(baseAsset('btc-usdc'), 'BTC')
  assert.equal(baseAsset('ETH'), 'ETH')
  const r = rh.normalizeAction({
    symbol: 'btc-usdc', side: 'buy', type: 'limit',
    limit_order_config: { quote_amount: 10 },
  })
  assert.equal(r.ok && r.value.symbol, 'BTC')
  assert.equal(r.ok && r.value.label, 'BTC-USDC', 'the full pair is kept for the audit row')
})

test('a symbol allow list written as an asset matches any quote currency', () => {
  const base = defaultActionPolicy('p', AT.toISOString())
  const policy = { ...base, trade: { ...base.trade, allowSymbols: ['BTC'] } }
  const snapshot: AccountSnapshot = { todayNotionalUsd: 0, positions: [], cashAvailableUsd: 500, marginUsedUsd: 0 }
  for (const symbol of ['BTC-USD', 'BTC-USDC']) {
    const n = rh.normalizeAction({ symbol, side: 'buy', type: 'limit', limit_order_config: { quote_amount: 50 } })
    assert.ok(n.ok)
    const d = evaluateAction({ surface: 'trade', policy, intent: n.value, snapshot, now: AT })
    assert.equal(d.verdict, 'ALLOW', symbol)
  }
})

// ── the 24/7 market ───────────────────────────────────────────────────────────────

test('an equity session window does not refuse a crypto order', () => {
  // Robinhood calls this "round-the-clock trading". A 13:30-20:00 window is a limit the user
  // placed on an equity session, not on a market that never closes, so applying it to crypto
  // would refuse every overnight order and read as a bug rather than a policy.
  const base = defaultActionPolicy('p', AT.toISOString())
  const policy = { ...base, trade: { ...base.trade, tradingHoursUtc: { start: '13:30', end: '20:00' } } }
  const snapshot: AccountSnapshot = { todayNotionalUsd: 0, positions: [], cashAvailableUsd: 500, marginUsedUsd: 0 }

  const crypto = rh.normalizeAction({ symbol: 'BTC-USD', side: 'buy', type: 'limit', limit_order_config: { quote_amount: 50 } })
  assert.ok(crypto.ok)
  const dCrypto = evaluateAction({ surface: 'trade', policy, intent: crypto.value, snapshot, now: AT })
  assert.equal(dCrypto.codes.includes('OUTSIDE_HOURS'), false)
  assert.equal(dCrypto.verdict, 'ALLOW')

  // The same clock still binds an equity order, which is what the setting was for.
  const equity = evaluateAction({
    surface: 'trade', policy, now: AT, snapshot,
    intent: { kind: 'order', side: 'buy', symbol: 'AAPL', assetClass: 'equity', notionalUsd: 50 },
  })
  assert.ok(equity.codes.includes('OUTSIDE_HOURS'))
})

test('every other trade rule still applies to a crypto order', () => {
  const base = defaultActionPolicy('p', AT.toISOString())
  const policy = { ...base, perActionCapUsd: 100, trade: { ...base.trade, denySymbols: ['DOGE'] } }
  const snapshot: AccountSnapshot = { todayNotionalUsd: 0, positions: [], cashAvailableUsd: 5000, marginUsedUsd: 0 }

  const over = rh.normalizeAction({ symbol: 'BTC-USD', side: 'buy', type: 'limit', limit_order_config: { quote_amount: 900 } })
  assert.ok(over.ok)
  assert.ok(evaluateAction({ surface: 'trade', policy, intent: over.value, snapshot, now: AT }).codes.includes('PER_ACTION_CAP'))

  const denied = rh.normalizeAction({ symbol: 'DOGE-USD', side: 'buy', type: 'limit', limit_order_config: { quote_amount: 10 } })
  assert.ok(denied.ok)
  assert.ok(evaluateAction({ surface: 'trade', policy, intent: denied.value, snapshot, now: AT }).codes.includes('SYMBOL_DENIED'))
})

// ── the account snapshot ──────────────────────────────────────────────────────────

test('holdings become positions, and totals are carried through', () => {
  const r = rh.normalizeAccount({
    buying_power: '1200.00',
    cash_available: '900.00',
    total_value_usd: '5000',
    today_notional_usd: '150',
    holdings: [
      { symbol: 'BTC-USD', quantity: '0.05', value_usd: '3000' },
      { symbol: 'ETH-USD', quantity: '0.4', value_usd: '1200' },
    ],
  })
  assert.ok(r.ok)
  const s = r.value
  assert.equal(s.buyingPowerUsd, 1200)
  assert.equal(s.cashAvailableUsd, 900)
  assert.equal(s.portfolioValueUsd, 5000)
  assert.equal(s.todayNotionalUsd, 150)
  assert.deepEqual(s.positions.map((p) => p.symbol), ['BTC', 'ETH'])
  assert.equal(s.marginUsedUsd, 0)
})

test('an unusable holding row is dropped rather than counted as zero', () => {
  const r = rh.normalizeAccount({ holdings: [{ symbol: 'BTC-USD' }, { value_usd: '10' }, { symbol: 'ETH-USD', value_usd: '5' }] })
  assert.ok(r.ok && r.value.positions.length === 1)
  assert.equal(r.ok && r.value.positions[0].symbol, 'ETH')
})

test('with no total, the portfolio falls back to the sum of positions, which understates it', () => {
  // Understating the portfolio makes any concentration percentage look HIGHER, so the
  // fallback errs toward the stricter verdict rather than the looser one.
  const r = rh.normalizeAccount({ holdings: [{ symbol: 'BTC-USD', value_usd: '100' }, { symbol: 'ETH-USD', value_usd: '50' }] })
  assert.equal(r.ok && r.value.portfolioValueUsd, 150)
})

test('a missing today-notional reads as zero rather than unknown', () => {
  const r = rh.normalizeAccount({ buying_power: 10 })
  assert.equal(r.ok && r.value.todayNotionalUsd, 0)
})

test('a malformed account payload is refused', () => {
  assert.equal(rh.normalizeAccount(null as never).ok, false)
})

// ── the seam itself ───────────────────────────────────────────────────────────────

test('the adapter declares which surface it feeds and decides nothing', () => {
  assert.equal(rh.surface, 'trade')
  assert.equal(rh.id, 'robinhood-crypto-api')
  // An adapter that returned verdicts would have stopped being an adapter.
  assert.equal('evaluate' in rh, false)
  assert.equal('decide' in rh, false)
})

test('the adapter needs no network, no credentials and no clock', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../../src/callers/robinhood-crypto.ts', import.meta.url), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  for (const bad of ['fetch(', 'process.env', 'Date.now', 'new Date', 'require(']) {
    assert.equal(code.includes(bad), false, `the adapter uses ${bad}, which makes it untestable before the venue exists`)
  }
})
