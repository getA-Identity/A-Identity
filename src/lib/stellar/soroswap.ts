/**
 * Soroswap, read only, from the browser: what converting WOULD cost.
 *
 * The whole surface is one public GET (/api/stellar/soroswap/quote). No key, no signature,
 * no write, and nothing here can move money: the backend simulates a read against a third
 * party's router and returns a price. This module shapes that call and parses the answer.
 *
 * WHY THE PAIR IS LEARNED RATHER THAN TYPED. The backend defaults `sell` to the chain's
 * native SAC and `buy` to its settlement token, so one direction needs no addresses at all.
 * The reverse has to name both legs, and the only honest source for those contract ids is
 * an answer the router already gave us: the generated chain registry in lib/chains.ts does
 * not carry token addresses, and typing one here is exactly the kind of hardcoding the
 * registry exists to prevent. So `quoteDirection` reads the pair off a live quote and
 * reverses it, and no contract id appears in this file.
 *
 * NOTHING HERE IS A SWAP. A-Identity does not execute one, the vault has no swap
 * entrypoint, and the API says so in `integration.executes`. That fact is carried through
 * to the caller rather than dropped, because it is the most important thing on the screen.
 */
import { apiFetch, explainError, readJson } from '../api'
import { CHAINS, CHAIN_BY_ID, type Chain } from '../chains'

/**
 * Stellar's fixed scale. A classic asset carries 7 decimals (a stroop is 1e-7 XLM) and a
 * Stellar Asset Contract wrapping one keeps that scale, so both legs of a quote use it.
 * The rate divides one leg by the other and is therefore scale-free either way round.
 */
export const SAC_DECIMALS = 7

/** One whole unit in base units. The amount the backend itself defaults to. */
export const ONE_UNIT = '1'.padEnd(SAC_DECIMALS + 1, '0')

/** What the backend says about its own role here, returned whether or not a quote came. */
export type SoroswapIntegration = {
  partner: string
  role: string
  howRead: string
  /** False today, and the panel must say so out loud rather than imply otherwise. */
  executes: boolean
  whyNot: string
}

export type SoroswapQuote =
  | { available: false; reason: string; integration: SoroswapIntegration | null }
  | {
      available: true
      /** 'live': the router answered now. Still only a quote; see `kind`. */
      status: string
      /** 'quote': no route is held and nothing is bound to this price. */
      kind: string
      /** CAIP-2 id of the network that answered. */
      network: string
      router: string
      factory: string | null
      pair: string | null
      sell: { asset: string; amount: string }
      buy: { asset: string; amount: string }
      readAt: string
      caveats: string[]
      integration: SoroswapIntegration | null
    }

/** Both legs of the default pair, as a live answer named them. Never typed by hand. */
export type SoroswapPair = { native: string; settlement: string }

/**
 * Which way round the quote runs. The default is the direction the product's problem runs
 * in: a vault holding the gas token owes an invoice in the settlement token.
 */
export type SoroswapDirection = 'native-to-settlement' | 'settlement-to-native'

type QuoteRequest = {
  /** Registry id or CAIP-2. Omitted means the only chain the backend serves. */
  chain?: string
  sell?: string
  buy?: string
  /** Base units, as a string: an i128 on chain does not fit a JavaScript number. */
  sellAmount: string
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

function parseIntegration(v: unknown): SoroswapIntegration | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const partner = str(o.partner)
  if (!partner) return null
  return {
    partner,
    role: str(o.role) ?? '',
    howRead: str(o.howRead) ?? '',
    executes: o.executes === true,
    whyNot: str(o.whyNot) ?? '',
  }
}

/**
 * The response, checked rather than cast. A body we do not recognise returns null so the
 * caller can say the backend did not answer, instead of rendering `undefined` at a reader.
 */
function parseQuote(body: unknown): SoroswapQuote | null {
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  const integration = parseIntegration(o.integration)
  if (o.available !== true) {
    const reason = str(o.reason)
    return reason ? { available: false, reason, integration } : null
  }
  const sell = o.sell as Record<string, unknown> | undefined
  const buy = o.buy as Record<string, unknown> | undefined
  const sellAsset = str(sell?.asset)
  const sellAmount = str(sell?.amount)
  const buyAsset = str(buy?.asset)
  const buyAmount = str(buy?.amount)
  const router = str(o.router)
  const network = str(o.network)
  if (!sellAsset || !sellAmount || !buyAsset || !buyAmount || !router || !network) return null
  return {
    available: true,
    status: str(o.status) ?? 'live',
    kind: str(o.kind) ?? 'quote',
    network,
    router,
    factory: str(o.factory),
    pair: str(o.pair),
    sell: { asset: sellAsset, amount: sellAmount },
    buy: { asset: buyAsset, amount: buyAmount },
    readAt: str(o.readAt) ?? new Date().toISOString(),
    // Every caveat the API returned, in its order. Never trimmed: a caveat list that a
    // client is free to shorten is a caveat list that stops meaning anything.
    caveats: Array.isArray(o.caveats) ? o.caveats.filter((c): c is string => typeof c === 'string') : [],
    integration,
  }
}

/**
 * One quote. Throws only when the backend could not be reached or answered something this
 * client cannot read; an unavailable pool is a returned answer, not an exception, because
 * that is what the route itself does (200 either way).
 */
export async function fetchSoroswapQuote(req: QuoteRequest): Promise<SoroswapQuote> {
  const q = new URLSearchParams()
  if (req.chain) q.set('chain', req.chain)
  if (req.sell) q.set('sell', req.sell)
  if (req.buy) q.set('buy', req.buy)
  q.set('sellAmount', req.sellAmount)
  const res = await apiFetch(`/api/stellar/soroswap/quote?${q.toString()}`)
  const parsed = parseQuote(await readJson<unknown>(res))
  if (!parsed) throw new Error(explainError(res.status))
  return parsed
}

/**
 * A quote in either direction, plus the pair it learned on the way.
 *
 * The forward direction is the bare call, so it names no addresses. The reverse needs both
 * legs, and when the caller has not got them yet this asks for the default pair first and
 * reads them off that answer. If even that comes back unavailable, its reason is returned
 * as the answer rather than swallowed, so the panel has something honest to show.
 */
export async function quoteDirection(input: {
  direction: SoroswapDirection
  /** Base units, as a string. */
  sellAmount: string
  /** Both legs, if an earlier live answer already named them. */
  pair?: SoroswapPair | null
  chain?: string
}): Promise<{ quote: SoroswapQuote; pair: SoroswapPair | null }> {
  const { direction, sellAmount, chain } = input
  const known = input.pair ?? null

  if (direction === 'native-to-settlement') {
    const quote = await fetchSoroswapQuote({ chain, sellAmount })
    return { quote, pair: quote.available ? { native: quote.sell.asset, settlement: quote.buy.asset } : known }
  }

  let pair = known
  if (!pair) {
    const seed = await fetchSoroswapQuote({ chain, sellAmount: ONE_UNIT })
    if (!seed.available) return { quote: seed, pair: null }
    pair = { native: seed.sell.asset, settlement: seed.buy.asset }
  }
  const quote = await fetchSoroswapQuote({ chain, sellAmount, sell: pair.settlement, buy: pair.native })
  return { quote, pair }
}

/**
 * Whole units to base units, as strings on both sides so no float ever touches an i128.
 * Null for anything that is not a positive amount at Stellar's scale, which the caller
 * turns into a sentence rather than sending and letting the router refuse it.
 */
export function toBaseUnits(whole: string, decimals = SAC_DECIMALS): string | null {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(whole.trim())
  if (!m) return null
  const frac = m[2] ?? ''
  if (frac.length > decimals) return null
  const base = `${m[1]}${frac.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '')
  return base === '0' ? null : base
}

/** Base units back to a readable whole amount. String math, so nothing rounds on the way. */
export function formatBaseUnits(base: string, decimals = SAC_DECIMALS): string {
  const digits = base.replace(/\D/g, '') || '0'
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/**
 * How much of the buy asset one unit of the sell asset fetches, to 7 places.
 *
 * Safe as a float because it is a ratio of two amounts at the same scale: the scale
 * cancels, and the result is a display number, never an amount sent anywhere.
 */
export function quoteRate(sellAmount: string, buyAmount: string): string {
  const sell = Number(sellAmount)
  const buy = Number(buyAmount)
  if (!Number.isFinite(sell) || !Number.isFinite(buy) || sell <= 0) return '-'
  return (buy / sell).toLocaleString('en-US', { maximumFractionDigits: SAC_DECIMALS })
}

/** The Stellar chain a CAIP-2 id names, falling back to the one the backend serves today. */
export function soroswapChain(network?: string | null): Chain {
  return CHAINS.find((c) => c.caip2 === network) ?? CHAIN_BY_ID['stellar-testnet']
}

/**
 * A contract's page on that chain's explorer, DERIVED from the registry's explorer base
 * rather than typed here, so a chain that repoints its explorer takes these links with it.
 */
export function contractUrl(network: string | null | undefined, contractId: string): string | null {
  const explorer = soroswapChain(network).explorer
  return explorer ? `${explorer}/contract/${contractId}` : null
}
