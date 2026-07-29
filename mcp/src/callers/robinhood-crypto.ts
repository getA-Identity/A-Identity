/**
 * Robinhood Crypto Trading API adapter (Phase 6.2).
 *
 * Written BEFORE the venue is reachable, on purpose. Robinhood's agentic surface covers
 * brokerage and card today; crypto has a REST API with its own credentials but no agent MCP
 * yet. Rather than wait and then rush it, the translation is here and unit-tested, so when
 * the crypto agent surface ships this plugs into `pre_action_check` without touching the
 * engine.
 *
 * ── Provenance, because it decides how much to trust each field ──────────────────────
 *
 * OFFICIAL (robinhood.com support + newsroom, read 2026-07-29):
 *  - Separate from the agentic MCP: credentials come from the "Robinhood API Credentials
 *    Portal", desktop web only, and only customers with an active Robinhood Crypto account
 *    in the US can use it.
 *  - Documented operations, v1 and v2: read crypto accounts, read crypto holdings, read
 *    crypto orders, read crypto products, read crypto quotes; place crypto orders (v2 with
 *    fee tiers, v1 without).
 *  - "round-the-clock trading", which is why the engine's market-hours window does not apply
 *    to a crypto order. A session window written for equities is not a limit the user meant
 *    to place on a 24/7 market.
 *
 * COMMUNITY-SOURCED, treat as inferred until a live call confirms it: the order payload
 * shape below (`market_order_config.asset_quantity`, `limit_order_config` with
 * `quote_amount` / `asset_quantity` / `limit_price` / `time_in_force`, and
 * `type: market | limit | stop_limit | stop_loss`). The docs site is JavaScript-rendered and
 * did not yield field names to a fetch, so these came from third-party references. The
 * normalizer is deliberately tolerant about WHERE the numbers live and strict about whether
 * it can compute a real USD amount.
 *
 * NOT KNOWN: exact endpoint paths, header names, the signing scheme, rate limits, and
 * whether the symbol is always `BASE-QUOTE`. None of those are needed to translate, and
 * guessing them would put invented values in the codebase.
 */
import type { AccountSnapshot, NormalizedIntent } from '../policy/index.js'
import { fail, ok, type CallerAdapter, type NormalizeResult } from './types.js'

/** The order payload as the venue takes it. Every numeric field arrives as a string or a
 *  number depending on the client, so both are accepted. */
export type RobinhoodCryptoOrder = {
  symbol?: string
  side?: string
  type?: string
  market_order_config?: { asset_quantity?: string | number }
  limit_order_config?: {
    asset_quantity?: string | number
    quote_amount?: string | number
    limit_price?: string | number
    time_in_force?: string
  }
  stop_loss_order_config?: { asset_quantity?: string | number; stop_price?: string | number }
  stop_limit_order_config?: {
    asset_quantity?: string | number
    limit_price?: string | number
    stop_price?: string | number
  }
  /** Not part of the venue payload: the caller's own mark for the pair, used only when the
   *  order specifies a quantity but no price (a market order). Without it the USD value of a
   *  market order is unknowable and the adapter fails instead of estimating. */
  markPriceUsd?: string | number
}

/** Holdings and account state as the read endpoints return them. */
export type RobinhoodCryptoAccount = {
  /** Buying power in USD, from the crypto account read. */
  buying_power?: string | number
  /** Settled cash, when the venue distinguishes it. */
  cash_available?: string | number
  holdings?: { symbol?: string; quantity?: string | number; value_usd?: string | number }[]
  /** USD notional already traded today, if the caller tracked it across orders. */
  today_notional_usd?: string | number
  total_value_usd?: string | number
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** `BTC-USD` -> `BTC`. The engine's symbol lists hold assets, not pairs, so "only trade BTC"
 *  should not have to be written as "only trade BTC-USD" and then silently miss `BTC-USDC`. */
export function baseAsset(symbol: string): string {
  const s = symbol.trim().toUpperCase()
  const dash = s.indexOf('-')
  return dash > 0 ? s.slice(0, dash) : s
}

/** Every documented order type maps to an action kind the engine already understands. */
function kindFor(type: string): NormalizedIntent['kind'] | null {
  switch (type.trim().toLowerCase()) {
    case 'market':
    case 'limit':
    case 'stop_limit':
    case 'stop_loss':
      return 'order'
    default:
      return null
  }
}

/**
 * USD value of the order, from the venue's own numbers.
 *
 * Three honest cases:
 *  - `quote_amount` IS the USD amount, so it wins outright.
 *  - quantity x a price the payload carries (limit or stop price) is exact enough to check.
 *  - quantity with no price at all cannot be valued, so this fails. A market order without a
 *    mark is precisely where an estimate would be most tempting and least defensible.
 */
function notionalUsd(order: RobinhoodCryptoOrder): number | null {
  const limit = order.limit_order_config
  const quoteAmount = num(limit?.quote_amount)
  if (quoteAmount !== null) return Math.abs(quoteAmount)

  const qty =
    num(order.market_order_config?.asset_quantity) ??
    num(limit?.asset_quantity) ??
    num(order.stop_limit_order_config?.asset_quantity) ??
    num(order.stop_loss_order_config?.asset_quantity)
  if (qty === null) return null

  const price =
    num(limit?.limit_price) ??
    num(order.stop_limit_order_config?.limit_price) ??
    num(order.stop_limit_order_config?.stop_price) ??
    num(order.stop_loss_order_config?.stop_price) ??
    num(order.markPriceUsd)
  if (price === null) return null
  return Math.abs(qty * price)
}

export const robinhoodCryptoAdapter: CallerAdapter<RobinhoodCryptoOrder, RobinhoodCryptoAccount> = {
  id: 'robinhood-crypto-api',
  venue: 'Robinhood Crypto',
  // Crypto orders are brokerage actions, so they reuse the trade surface and every rule on
  // it. No new surface, no new rules: that reuse is the seam paying off.
  surface: 'trade',

  normalizeAction(order): NormalizeResult<NormalizedIntent> {
    if (!order || typeof order !== 'object') return fail('No order payload.')

    const symbol = typeof order.symbol === 'string' ? order.symbol.trim() : ''
    if (!symbol) return fail('The order names no symbol.')

    const side = typeof order.side === 'string' ? order.side.trim().toLowerCase() : ''
    if (side !== 'buy' && side !== 'sell') return fail(`Unrecognized side: ${JSON.stringify(order.side)}.`)

    const type = typeof order.type === 'string' ? order.type : ''
    const kind = kindFor(type)
    if (!kind) return fail(`Unrecognized order type: ${JSON.stringify(order.type)}.`)

    const notional = notionalUsd(order)
    if (notional === null) {
      return fail(
        'Could not value this order from the payload. A quantity with no price and no mark cannot be checked, and an estimate is not good enough to authorize money.',
      )
    }

    return ok({
      kind,
      side,
      // The base asset, so a symbol list matches BTC whichever quote currency is paired.
      symbol: baseAsset(symbol),
      assetClass: 'crypto',
      notionalUsd: notional,
      label: symbol.toUpperCase(),
    })
  },

  normalizeAccount(account): NormalizeResult<AccountSnapshot> {
    if (!account || typeof account !== 'object') return fail('No account payload.')

    const positions = (account.holdings ?? [])
      .map((h) => {
        const sym = typeof h?.symbol === 'string' ? baseAsset(h.symbol) : ''
        const valueUsd = num(h?.value_usd)
        if (!sym || valueUsd === null) return null
        const shares = num(h?.quantity)
        return { symbol: sym, ...(shares !== null ? { shares } : {}), valueUsd }
      })
      .filter((p): p is { symbol: string; shares?: number; valueUsd: number } => p !== null)

    const snapshot: AccountSnapshot = {
      // Absent means zero traded so far today, which is the only reading that does not
      // overstate headroom.
      todayNotionalUsd: num(account.today_notional_usd) ?? 0,
      positions,
    }
    const buying = num(account.buying_power)
    if (buying !== null) snapshot.buyingPowerUsd = buying
    const cash = num(account.cash_available)
    if (cash !== null) snapshot.cashAvailableUsd = cash
    const total = num(account.total_value_usd)
    if (total !== null) {
      snapshot.portfolioValueUsd = total
    } else if (positions.length) {
      // Falling back to the sum of positions UNDERSTATES the portfolio (it ignores cash),
      // which makes any concentration percentage look higher, not lower. Erring toward the
      // stricter reading is the right direction for a guardrail.
      snapshot.portfolioValueUsd = positions.reduce((a, p) => a + p.valueUsd, 0)
    }
    // Crypto accounts are not margin accounts here, and the venue does not report margin on
    // this surface, so this is stated rather than left unknown: leaving it undefined would
    // make the no-margin rule fail closed on every crypto buy.
    snapshot.marginUsedUsd = 0
    return ok(snapshot)
  },
}
