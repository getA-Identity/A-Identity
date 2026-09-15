/**
 * What one Stellar settlement costs us, priced off the ledger it settles on.
 *
 * This file exists because the arithmetic was already in the codebase and only in prose.
 * x402-stellar/rail.ts carries a paragraph that an adversarial review had to correct twice:
 * a settlement is NOT negligible against a $0.001 tool, the break-even is XLM at $0.4353,
 * and there IS a price feed we can verify because the XLM/USDC order book sits on the very
 * ledger the rail settles on. All of that was true on the day it was written and none of it
 * was observable afterwards. A number a reader has to take on trust is a number that goes
 * stale silently, and "XLM at 0.4353 USD" is exactly the kind that does.
 *
 * So the same sum runs here against live inputs instead:
 *
 *   settlement cost USD  =  charged stroops / stroops per XLM * (USDC per XLM)
 *   break-even XLM USD   =  cheapest tool USD / (charged stroops / stroops per XLM)
 *
 * Three honesty properties, each of which is a decision rather than an implementation
 * detail:
 *
 * **The price is a LIVE read or it is nothing.** `live: false` with a reason when Horizon
 * cannot be reached, never a remembered price wearing a live label. Repo law is that a
 * missing input is a clean labeled no-op, and a cached exchange rate presented as current
 * is the worst version of the opposite.
 *
 * **The fee is a MEASUREMENT, and `basis` says which one.** First choice is the most recent
 * fee the ledger actually charged us on this network, read out of our own settlement log.
 * Only when the log holds none does it fall back to the documented measurement, and then it
 * says so in the same breath rather than letting a constant pass for an observation.
 *
 * **It never throws.** It is read by GET /api/x402/stellar/status, and a status endpoint
 * that 500s because a third-party API is slow is a worse outage than the one it is
 * reporting on.
 *
 * Nothing here is hardcoded about a chain: the Horizon host comes from the descriptor's
 * `horizonUrls`, the asset from `settlementTokens[].classicAsset`, and the stroop scale
 * from `nativeCurrency.decimals`. mcp/src/chains/no-hardcoded-chains.test.ts fails the build
 * if a registry constant is restated outside chains/, and that guard is the reason this file
 * takes a ChainDescriptor rather than a network name.
 */
import type { ChainDescriptor } from '../chains/types.js'
import { loadStellarSettlements, type StellarSettlementRecord } from '../storage.js'
import { RAIL_BASE_PRICES_USD } from './rail.js'

/**
 * The fee a settlement has been measured to cost, per network, when our own log holds none.
 *
 * Both are `fee_charged` read from Horizon on 2026-09-15, not envelope bids:
 *
 *   pubnet   23479  our first mainnet sale f213371c..., ledger 64155370 (it bid 34035)
 *   testnet  22973  the gasless sale 6d877992... (it bid 33153)
 *
 * Keyed by testnet-or-not rather than by chain id, because the chain id belongs to the
 * registry and restating one here would fail the build, correctly.
 */
const MEASURED_FEE_STROOPS = { pubnet: 23479n, testnet: 22973n } as const

const MEASURED_BASIS = {
  pubnet:
    'the documented measurement: Horizon fee_charged 23479 for our first mainnet sale ' +
    'f213371c1241968ee78170923d8c5a3bd9b32950e73bb9c563d800ab2c70ec9e at ledger 64155370, read ' +
    '2026-09-15. Used because no settlement in our own log on this network has recorded a ' +
    'charged fee yet.',
  testnet:
    'the documented measurement: Horizon fee_charged 22973 for the gasless sale ' +
    '6d87799242b9fb36a26ac6f2d2fb11c5e7fb8bdd52bc6cf0471dcc8a8caba09c, read 2026-09-15. Used ' +
    'because no settlement in our own log on this network has recorded a charged fee yet.',
} as const

export type StellarFeeEconomics =
  | {
      live: true
      /** The exact Horizon URL the price came off, so the read is reproducible. */
      source: string
      readAt: string
      /** Best BID on the XLM/USDC book: USDC per XLM, what a seller of XLM gets right now. */
      xlmUsdcBid: number
      /** Stroops one settlement was measured to cost. A charge, never a bid. */
      measuredFeeStroops: string
      /** Where that number came from: our own log, or the documented measurement. */
      basis: string
      /** measuredFeeStroops priced at xlmUsdcBid. */
      settlementCostUsd: number
      /** The cheapest thing this rail sells, read from the price table rather than typed. */
      cheapestToolUsd: number
      /** settlementCostUsd / cheapestToolUsd. 1 means the cheapest sale pays for its own
       *  settlement and nothing else. */
      costShareOfCheapestSale: number
      /** The XLM price at which one settlement costs exactly the cheapest sale. Above it,
       *  selling the cheapest tool loses money on every call. */
      breakEvenXlmUsd: number
      note: string
    }
  | { live: false; reason: string }

export type StellarFeeEconomicsDeps = {
  /** The one network call, injected so the arithmetic is testable without Horizon. */
  fetchJson?: (url: string, timeoutMs: number) => Promise<unknown>
  /** The settlement log, for the most recent charged fee on this network. */
  load?: () => Promise<StellarSettlementRecord[]>
  now?: () => Date
  timeoutMs?: number
}

/** Horizon is a public API and a slow one is not worth holding a status response for. */
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * The most recent fee the LEDGER charged us on this network, in stroops.
 *
 * Rows are appended oldest first, so the last one carrying a charge is the newest
 * measurement. Only `feeChargedStroops` counts: `feeStroops` is the bid and using it here
 * would rebuild the overstatement this whole change exists to remove.
 */
function lastChargedFee(rows: StellarSettlementRecord[], caip2: string): bigint | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]
    if (r.network !== caip2 || !r.feeChargedStroops) continue
    try {
      const v = BigInt(r.feeChargedStroops)
      if (v > 0n) return v
    } catch {
      /* a malformed row is skipped, never guessed at */
    }
  }
  return null
}

/** `CODE:ISSUER` split, the form the registry records a SAC's classic asset in. */
function classicParts(asset: string): { code: string; issuer: string } | null {
  const [code, issuer] = asset.split(':')
  if (!code || !issuer) return null
  return { code, issuer }
}

async function defaultFetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * What a settlement on this chain costs, in USD, right now.
 *
 * Reads the XLM/USDC order book from the chain's own Horizon and prices the measured fee
 * against the best bid. Returns `{live:false, reason}` rather than throwing for every
 * failure, including a Horizon that is down, a chain with no Horizon configured, and a book
 * with no bids on it: an empty book is a real state of the market and not an error, and
 * calling it one would put a stack trace where a sentence belongs.
 */
export async function stellarFeeEconomics(
  chain: ChainDescriptor,
  deps: StellarFeeEconomicsDeps = {},
): Promise<StellarFeeEconomics> {
  const now = deps.now ?? (() => new Date())
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchJson = deps.fetchJson ?? defaultFetchJson

  const horizon = chain.horizonUrls?.[0]
  if (!horizon) {
    return { live: false, reason: `${chain.id} declares no Horizon endpoint, so there is no order book to price against` }
  }
  const token = (chain.settlementTokens ?? [])[0]
  const classic = token?.classicAsset ? classicParts(token.classicAsset) : null
  if (!token || !classic) {
    return {
      live: false,
      reason: `${chain.id} declares no settlement token with a classicAsset, and a SAC cannot be looked up on the classic order book without one`,
    }
  }

  // credit_alphanum4 up to four characters, credit_alphanum12 beyond. Derived from the code
  // rather than assumed, because a 12-character asset asked for under the wrong type is a
  // 400 from Horizon and would read here as "the market is empty".
  const buyingType = classic.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'
  const url =
    `${horizon.replace(/\/+$/, '')}/order_book?selling_asset_type=native` +
    `&buying_asset_type=${buyingType}` +
    `&buying_asset_code=${encodeURIComponent(classic.code)}` +
    `&buying_asset_issuer=${encodeURIComponent(classic.issuer)}` +
    `&limit=1`

  let book: unknown
  try {
    book = await fetchJson(url, timeoutMs)
  } catch (e) {
    return {
      live: false,
      reason: `could not read the ${chain.name} order book at ${url}: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // The base asset is what we are selling (XLM) and the counter is what we are buying
  // (USDC), so a BID is somebody offering USDC for XLM and its price is USDC per XLM. That
  // is the side that matters: we hold XLM and spend it, so the bid is what our fee is worth.
  const bids = (book as { bids?: { price?: unknown }[] } | null)?.bids
  const price = Array.isArray(bids) && bids.length ? Number(bids[0]?.price) : NaN
  if (!Number.isFinite(price) || price <= 0) {
    return {
      live: false,
      reason: `the ${chain.name} XLM/${classic.code} order book carried no usable bid, so there is no live price to quote`,
    }
  }

  let rows: StellarSettlementRecord[] = []
  try {
    rows = await (deps.load ?? loadStellarSettlements)()
  } catch {
    // The log is an improvement on the fallback, not a requirement for it.
    rows = []
  }
  const key = chain.testnet ? 'testnet' : 'pubnet'
  const observed = lastChargedFee(rows, chain.caip2)
  const feeStroops = observed ?? MEASURED_FEE_STROOPS[key]
  const basis = observed
    ? `the most recent fee the ledger charged us on ${chain.caip2}, read back from our own settlement log`
    : MEASURED_BASIS[key]

  // 10 ** decimals stroops to one XLM, from the descriptor. Hardcoding 10_000_000 would be
  // a chain constant restated outside the registry, which is exactly what the guard forbids.
  const perUnit = 10 ** chain.nativeCurrency.decimals
  const feeXlm = Number(feeStroops) / perUnit
  const settlementCostUsd = feeXlm * price
  const cheapestToolUsd = Math.min(...Object.values(RAIL_BASE_PRICES_USD))
  const round = (n: number, places: number) => Number(n.toFixed(places))

  return {
    live: true,
    source: url,
    readAt: now().toISOString(),
    xlmUsdcBid: price,
    measuredFeeStroops: feeStroops.toString(),
    basis,
    settlementCostUsd: round(settlementCostUsd, 9),
    cheapestToolUsd,
    costShareOfCheapestSale: round(settlementCostUsd / cheapestToolUsd, 6),
    breakEvenXlmUsd: round(cheapestToolUsd / feeXlm, 6),
    note:
      'Live read, priced on the ledger this rail settles on rather than from an off-chain ' +
      'quote we cannot show you. The buyer pays no network fee here and we add no settlement ' +
      'fee on top of the base price, so this cost comes out of the sale: costShareOfCheapestSale ' +
      'is the fraction of the cheapest tool one settlement eats, and breakEvenXlmUsd is the XLM ' +
      'price at which it eats all of it. Absorbing the fee is a decision to revisit at that ' +
      'price, not a fact about the chain. One order-book bid, so it is a spot price and not a ' +
      'depth-weighted one: a large sale would not clear at it.',
  }
}
