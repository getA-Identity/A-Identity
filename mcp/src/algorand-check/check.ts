/**
 * "Before you pay": is it safe to pay this Algorand address?
 *
 * The question an agent (or a person) has before an x402 payment on Algorand, answered from
 * public data only: the Algorand ledger, read through the indexer the registry already knows,
 * and the x402 facilitator's public records. The trust tools on this rail answer "who is this
 * ERC-8004 agent"; an Algorand seller has no such registration, so it gets DENY from them for
 * a reason that says nothing about the seller. This answers the question an Algorand payer
 * actually has: does this address look like a real seller that real wallets pay?
 *
 * Deterministic rules, stated in RULES below and on the /check page in the same words. Every
 * reason a caller sees comes from one of them. Heuristics, not a judgement: the verdict says
 * what the public record shows, and "not enough history" is an answer, not a failure.
 *
 * The one expensive signal is who pays a seller. A wallet that the seller created, or that
 * created the seller, is the seller paying itself, which is the pattern the challenge's own
 * rules exclude and the one its public integrity debate is about. We read the creating payment
 * of the top payers (the first payment an Algorand account ever receives is the one that
 * brought it into existence) and compare it with the seller's own.
 */
import { getChainById } from '../chains/registry.js'
import type { ChainDescriptor } from '../chains/types.js'
import { addressUrl } from '../chains/explorer.js'
import { isAlgorandAddress } from '../chains/algorand/ids.js'
import { indexerBase } from '../x402-algorand/confirm.js'

export type PayCheckVerdict = 'safe' | 'careful' | 'dont_pay' | 'unknown'
export type ReasonTone = 'good' | 'warn' | 'bad' | 'neutral'
export type PayCheckReason = { tone: ReasonTone; code: string; text: string }

export type SellerFacts = {
  known: boolean
  settlements: number
  firstSeen: string | null
  lastSeen: string | null
  domain: string | null
  challengeRank: number | null
  volumeUsd: number | null
  blocked: { reason: string; since: string } | null
}

export type PayerFacts = {
  /** Inbound USDC transfers read (the most recent ones, capped). */
  sampled: number
  distinct: number
  /** Share of the sampled USDC that came from the single largest payer. */
  topPayerShare: number | null
  /** Share of the sampled USDC that came from wallets linked to the seller (see linkOf). */
  sellerFundedShare: number | null
}

export type PayerDetail = { address: string; payments: number; usdc: number; share: number; linked: boolean; funder: string | null }
export type PaymentDetail = { payer: string; usdc: number; at: string | null; txId: string | null; linked: boolean }

export type PayCheckResult = {
  query: string
  address: string | null
  resolvedFrom: 'address' | 'domain' | 'url' | null
  name: string | null
  verdict: PayCheckVerdict
  headline: string
  reasons: PayCheckReason[]
  facts: {
    accountAgeDays: number | null
    canReceiveUsdc: boolean | null
    seller: SellerFacts | null
    payers: PayerFacts | null
  }
  explorerUrl: string | null
  checkedAt: string
  fullReport: { tool: 'pay_check'; priceUsd: number; url: string }
  /** Only in the paid report. */
  details?: {
    /** The ten largest payers in the sample, with the wallet that created each of the traced ones. */
    topPayers: PayerDetail[]
    /** The ten most recent USDC payments it received. */
    recentPayments: PaymentDetail[]
    /** The wallet whose payment created this account, and when. */
    createdBy: string | null
    createdAt: string | null
    totalUsdcSampled: number
    sources: string[]
  }
}

export type PayCheckError = { error: string; httpStatus: 400 | 404 | 502 }

export type PayCheckDeps = {
  fetcher?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Include the per-payer breakdown (the paid report). */
  detailed?: boolean
  /** The x402 facilitator whose public records are read. Callers pass the rail's own. */
  facilitator?: string
}

/**
 * The paid report, per call. Deliberately priced as a report a person decides to buy, not a
 * fraction of a cent an agent spends without noticing: the free answer on /check stays free,
 * and X402_ALGORAND_PAY_CHECK_USD can move this without a deploy of new code.
 */
export const PAY_CHECK_PRICE_USD = 5

export function payCheckPriceUsd(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.X402_ALGORAND_PAY_CHECK_USD)
  return Number.isFinite(v) && v >= 0.001 && v <= 100 ? Math.round(v * 1e6) / 1e6 : PAY_CHECK_PRICE_USD
}

/** The rules, in the words the page shows. The engine below implements exactly these. */
export const RULES = {
  dont_pay: [
    'the x402 facilitator has blocked this seller',
    'the address cannot receive USDC, so a payment would fail',
    'the address has never been used on Algorand',
  ],
  careful: [
    'the account is less than 7 days old',
    'most of the USDC it received came from wallets linked to it',
    'a single wallet made most of its payments',
  ],
  safe: ['none of the above, the account is at least 30 days old, and at least 3 different wallets have paid it'],
} as const

const NEW_ACCOUNT_DAYS = 7
const ESTABLISHED_DAYS = 30
const MIN_DISTINCT_PAYERS = 3
const TOP_PAYER_LIMIT = 0.8
const LINKED_LIMIT = 0.5
const SAMPLE_LIMIT = 500
const TRACE_TOP_PAYERS = 5
const TIMEOUT_MS = 6000
const NFD_API = 'https://api.nf.domains'

const HEADLINES: Record<PayCheckVerdict, string> = {
  safe: 'Looks safe to pay',
  careful: 'Be careful',
  dont_pay: "Don't pay",
  unknown: 'Not enough history yet',
}

// ── small helpers ──────────────────────────────────────────────────────────────────────

function mainnet(): ChainDescriptor {
  const chain = getChainById('algorand')
  if (!chain) throw new Error('the registry has no algorand descriptor')
  return chain
}

function usdcAsset(chain: ChainDescriptor): { id: number; decimals: number } {
  const token = chain.settlementTokens?.[0]
  if (!token) throw new Error(`${chain.id} declares no settlement token`)
  return { id: Number(token.address), decimals: token.decimals }
}

async function getJson(fetcher: typeof fetch, url: string): Promise<{ status: number; json: unknown }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetcher(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    const json = res.status === 204 ? null : await res.json().catch(() => null)
    return { status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

const days = (ms: number) => Math.floor(ms / 86_400_000)
const pct = (x: number) => `${Math.round(x * 100)}%`
const monthYear = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const dayMonth = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** A host from a pasted link or bare domain, lower-cased, without www. Null when it is not one. */
export function hostOf(q: string): string | null {
  const raw = q.trim()
  if (!raw || /\s/.test(raw)) return null
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null
  } catch {
    return null
  }
}

// ── the facilitator's public records (cached: they change by the minute, not the call) ───

type LeaderboardRow = {
  rank?: number
  address?: string
  sub?: string | null
  label?: string | null
  volume?: number
  settles?: number
  blocked?: { reason?: string; since?: string } | null
}
type MerchantRow = { addresses?: { avm?: string }; totalSettlements?: number; firstSeen?: string; lastSeen?: string }

const CACHE_MS = 5 * 60_000
const cache = new Map<string, { at: number; value: unknown }>()

async function cached<T>(key: string, now: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_MS) return hit.value as T
  const value = await load()
  cache.set(key, { at: now, value })
  return value
}

/** For tests: forget the cached facilitator lists. */
export function clearPayCheckCache(): void {
  cache.clear()
}

async function leaderboard(fetcher: typeof fetch, base: string, src: string | null, now: number): Promise<LeaderboardRow[]> {
  return cached(`lb:${base}:${src ?? 'all'}`, now, async () => {
    const rows: LeaderboardRow[] = []
    // The endpoint pages at 50 whatever limit says, so walk offsets.
    for (let offset = 0; offset < 400; offset += 50) {
      const qs = new URLSearchParams({ cat: 'merchants', limit: '50', offset: String(offset), range: 'all', env: 'mainnet' })
      if (src) qs.set('src', src)
      const { status, json } = await getJson(fetcher, `${base}/data/leaderboards?${qs}`)
      const items = status === 200 ? ((json as { items?: LeaderboardRow[] })?.items ?? []) : []
      rows.push(...items)
      if (items.length < 50) break
    }
    return rows
  })
}

async function merchants(fetcher: typeof fetch, base: string, now: number): Promise<MerchantRow[]> {
  return cached(`merchants:${base}`, now, async () => {
    const rows: MerchantRow[] = []
    for (let offset = 0; offset < 1000; offset += 100) {
      const { status, json } = await getJson(fetcher, `${base}/discovery/merchants?limit=100&offset=${offset}`)
      const items = status === 200 ? ((json as { items?: MerchantRow[] })?.items ?? []) : []
      rows.push(...items)
      if (items.length < 100) break
    }
    return rows
  })
}

// ── the ledger ─────────────────────────────────────────────────────────────────────────

type IndexerAccount = {
  address?: string
  amount?: number
  deleted?: boolean
  'created-at-round'?: number
  assets?: { 'asset-id'?: number; amount?: number; 'is-frozen'?: boolean }[]
}
type IndexerTxn = {
  id?: string
  sender?: string
  'round-time'?: number
  'confirmed-round'?: number
  'tx-type'?: string
  'payment-transaction'?: { receiver?: string; amount?: number }
  'asset-transfer-transaction'?: { receiver?: string; amount?: number; 'asset-id'?: number }
}

/**
 * The payment that brought an account into existence, read at the account's own
 * created-at-round. Asking for "its first inbound transaction" without the round is not
 * the same question: the indexer does not promise oldest-first there, and a busy seller came
 * back as created today.
 */
async function creation(
  fetcher: typeof fetch,
  idx: string,
  address: string,
  createdAtRound?: number,
): Promise<{ funder: string | null; at: string | null }> {
  let round = createdAtRound
  if (round === undefined) {
    const acct = await getJson(fetcher, `${idx}/v2/accounts/${address}?exclude=all`)
    round = (acct.json as { account?: IndexerAccount })?.account?.['created-at-round']
  }
  if (typeof round !== 'number') return { funder: null, at: null }
  const qs = new URLSearchParams({ address, 'address-role': 'receiver', 'min-round': String(round), 'max-round': String(round), limit: '5' })
  const { status, json } = await getJson(fetcher, `${idx}/v2/transactions?${qs}`)
  const txns = status === 200 ? ((json as { transactions?: IndexerTxn[] })?.transactions ?? []) : []
  const txn = txns.find((t) => t.sender && t.sender !== address)
  let at = typeof txn?.['round-time'] === 'number' ? new Date(txn['round-time'] * 1000).toISOString() : null
  if (!at) {
    const block = await getJson(fetcher, `${idx}/v2/blocks/${round}?header-only=true`)
    const ts = (block.json as { timestamp?: number })?.timestamp
    at = typeof ts === 'number' ? new Date(ts * 1000).toISOString() : null
  }
  return { funder: txn?.sender ?? null, at }
}

async function inboundUsdc(
  fetcher: typeof fetch,
  idx: string,
  address: string,
  assetId: number,
): Promise<{ payer: string; amount: number; at: string | null; txId: string | null }[]> {
  const qs = new URLSearchParams({ 'asset-id': String(assetId), 'tx-type': 'axfer', limit: String(SAMPLE_LIMIT) })
  const { status, json } = await getJson(fetcher, `${idx}/v2/accounts/${address}/transactions?${qs}`)
  if (status !== 200) throw new Error(`indexer answered ${status} for the transfer history`)
  const txns = (json as { transactions?: IndexerTxn[] })?.transactions ?? []
  const out: { payer: string; amount: number; at: string | null; txId: string | null }[] = []
  for (const t of txns) {
    const x = t['asset-transfer-transaction']
    if (!x || x['asset-id'] !== assetId || x.receiver !== address || !t.sender || t.sender === address) continue
    if (!x.amount || x.amount <= 0) continue
    out.push({
      payer: t.sender,
      amount: x.amount,
      at: typeof t['round-time'] === 'number' ? new Date(t['round-time'] * 1000).toISOString() : null,
      txId: t.id ?? null,
    })
  }
  return out
}

async function nfdName(fetcher: typeof fetch, address: string): Promise<string | null> {
  try {
    const { status, json } = await getJson(fetcher, `${NFD_API}/nfd/lookup?address=${address}&view=tiny`)
    if (status !== 200 || !json || typeof json !== 'object') return null
    const entry = (json as Record<string, { name?: unknown }>)[address]
    return typeof entry?.name === 'string' ? entry.name : null
  } catch {
    return null
  }
}

// ── resolving what was pasted ──────────────────────────────────────────────────────────

async function resolveQuery(
  q: string,
  fetcher: typeof fetch,
  facilitator: string,
  now: number,
): Promise<{ address: string; resolvedFrom: 'address' | 'domain' | 'url' } | PayCheckError> {
  const query = q.trim()
  if (isAlgorandAddress(query)) return { address: query, resolvedFrom: 'address' }
  const host = hostOf(query)
  if (!host) return { error: 'That does not look like an Algorand address or a service link.', httpStatus: 400 }
  if (!facilitator) return { error: 'Links cannot be looked up here. Paste the Algorand address instead.', httpStatus: 400 }
  let rows: LeaderboardRow[] = []
  try {
    rows = await leaderboard(fetcher, facilitator, null, now)
  } catch {
    return { error: 'The x402 facilitator could not be reached to look that link up. Paste the Algorand address instead.', httpStatus: 502 }
  }
  const hit = rows.find((r) => typeof r.address === 'string' && isAlgorandAddress(r.address) && (r.sub ?? '').toLowerCase().replace(/^www\./, '') === host)
  if (!hit?.address) {
    return { error: `No Algorand x402 seller is listed for ${host}. Paste the Algorand address it asks you to pay instead.`, httpStatus: 404 }
  }
  return { address: hit.address, resolvedFrom: /^[a-z]+:\/\//i.test(query) || query.includes('/') ? 'url' : 'domain' }
}

// ── the check ──────────────────────────────────────────────────────────────────────────

export async function runPayCheck(q: string, deps: PayCheckDeps = {}): Promise<PayCheckResult | PayCheckError> {
  const fetcher = deps.fetcher ?? fetch
  const env = deps.env ?? process.env
  const now = deps.now ? deps.now() : Date.now()
  const chain = mainnet()
  const idx = indexerBase(chain, env)
  const facilitator = (deps.facilitator ?? env.X402_ALGORAND_FACILITATOR ?? '').replace(/\/$/, '')
  const usdc = usdcAsset(chain)

  const resolved = await resolveQuery(q, fetcher, facilitator, now)
  if ('error' in resolved) return resolved
  const { address } = resolved

  // The ledger reads are required; the facilitator and the name service only add context,
  // so their failure costs a fact, never the verdict.
  let account: IndexerAccount | null
  let inbound: { payer: string; amount: number; at: string | null; txId: string | null }[]
  let born: { funder: string | null; at: string | null }
  try {
    const acct = await getJson(fetcher, `${idx}/v2/accounts/${address}?exclude=created-apps,created-assets,apps-local-state`)
    if (acct.status === 404) account = null
    else if (acct.status !== 200) throw new Error(`indexer answered ${acct.status} for the account`)
    else account = (acct.json as { account?: IndexerAccount })?.account ?? null
    ;[inbound, born] = account
      ? await Promise.all([inboundUsdc(fetcher, idx, address, usdc.id), creation(fetcher, idx, address, account['created-at-round'])])
      : [[], { funder: null, at: null }]
  } catch (e) {
    return { error: `The Algorand ledger could not be read right now (${e instanceof Error ? e.message : String(e)}). Try again in a minute.`, httpStatus: 502 }
  }

  const none = async <T,>(): Promise<T[]> => []
  const [lbAll, lbChallenge, merchantRows, name] = await Promise.all([
    facilitator ? leaderboard(fetcher, facilitator, null, now).catch(() => [] as LeaderboardRow[]) : none<LeaderboardRow>(),
    facilitator ? leaderboard(fetcher, facilitator, 'x402-global-challenge', now).catch(() => [] as LeaderboardRow[]) : none<LeaderboardRow>(),
    facilitator ? merchants(fetcher, facilitator, now).catch(() => [] as MerchantRow[]) : none<MerchantRow>(),
    nfdName(fetcher, address),
  ])

  // ── facts ──
  const exists = !!account && !account.deleted
  const canReceiveUsdc = exists ? (account!.assets ?? []).some((a) => a['asset-id'] === usdc.id && !a['is-frozen']) : null
  const accountAgeDays = born.at ? Math.max(0, days(now - Date.parse(born.at))) : null

  const lbRow = lbAll.find((r) => r.address === address)
  const challengeRow = lbChallenge.find((r) => r.address === address)
  const merchant = merchantRows.find((m) => m.addresses?.avm === address)
  const blockedRaw = lbRow?.blocked ?? challengeRow?.blocked ?? null
  const seller: SellerFacts | null =
    lbRow || challengeRow || merchant
      ? {
          known: true,
          settlements: merchant?.totalSettlements ?? lbRow?.settles ?? challengeRow?.settles ?? 0,
          firstSeen: merchant?.firstSeen ?? null,
          lastSeen: merchant?.lastSeen ?? null,
          domain: lbRow?.sub ?? challengeRow?.sub ?? null,
          challengeRank: challengeRow?.rank ?? null,
          volumeUsd: challengeRow?.volume ?? lbRow?.volume ?? null,
          blocked: blockedRaw ? { reason: blockedRaw.reason ?? 'blocked by the facilitator', since: blockedRaw.since ?? '' } : null,
        }
      : null

  // Who pays it.
  const byPayer = new Map<string, { payments: number; amount: number }>()
  for (const t of inbound) {
    const e = byPayer.get(t.payer) ?? { payments: 0, amount: 0 }
    e.payments += 1
    e.amount += t.amount
    byPayer.set(t.payer, e)
  }
  const total = inbound.reduce((s, t) => s + t.amount, 0)
  const ranked = [...byPayer.entries()].sort((a, b) => b[1].amount - a[1].amount)
  const topPayerShare = total > 0 && ranked.length ? ranked[0][1].amount / total : null

  // Linked payers: created by the seller, or the wallet that created the seller. Traced for
  // the largest payers only, which is where the volume that matters sits.
  const traced = await Promise.all(
    ranked.slice(0, TRACE_TOP_PAYERS).map(async ([payer]) => {
      const c = await creation(fetcher, idx, payer).catch(() => ({ funder: null, at: null }))
      const linked = c.funder === address || (born.funder !== null && payer === born.funder)
      return { payer, funder: c.funder, linked }
    }),
  )
  const linkedVolume = traced.filter((t) => t.linked).reduce((s, t) => s + (byPayer.get(t.payer)?.amount ?? 0), 0)
  const sellerFundedShare = total > 0 ? linkedVolume / total : null
  const payers: PayerFacts | null = exists
    ? { sampled: inbound.length, distinct: byPayer.size, topPayerShare, sellerFundedShare }
    : null

  // ── rules ──
  const bad: PayCheckReason[] = []
  const warn: PayCheckReason[] = []
  const good: PayCheckReason[] = []
  const neutral: PayCheckReason[] = []

  if (seller?.blocked) {
    const since = seller.blocked.since ? ` since ${dayMonth(seller.blocked.since)}` : ''
    bad.push({ tone: 'bad', code: 'blocked', text: `Blocked by the x402 facilitator${since}: ${seller.blocked.reason}.` })
  }
  if (!exists) bad.push({ tone: 'bad', code: 'no_account', text: 'This address has never been used on Algorand.' })
  else if (canReceiveUsdc === false) bad.push({ tone: 'bad', code: 'no_usdc', text: 'It cannot receive USDC yet, so a USDC payment would fail.' })

  if (exists && accountAgeDays !== null && accountAgeDays < NEW_ACCOUNT_DAYS) {
    warn.push({ tone: 'warn', code: 'new', text: accountAgeDays === 0 ? 'Brand-new account: created today.' : `Brand-new account: created ${accountAgeDays} day${accountAgeDays === 1 ? '' : 's'} ago.` })
  }
  if (sellerFundedShare !== null && sellerFundedShare > LINKED_LIMIT) {
    warn.push({ tone: 'warn', code: 'self_funded', text: `${pct(sellerFundedShare)} of the USDC it received came from wallets linked to it, so its payments may be its own.` })
  }
  if (topPayerShare !== null && inbound.length >= 3 && topPayerShare > TOP_PAYER_LIMIT) {
    warn.push({
      tone: 'warn',
      code: 'one_payer',
      text: byPayer.size === 1 ? 'All of its payments came from a single wallet.' : `One wallet made ${pct(topPayerShare)} of its payments.`,
    })
  }

  if (exists && accountAgeDays !== null && accountAgeDays >= NEW_ACCOUNT_DAYS && born.at) {
    good.push({ tone: accountAgeDays >= ESTABLISHED_DAYS ? 'good' : 'neutral', code: 'age', text: `On Algorand since ${monthYear(born.at)} (${accountAgeDays} days).` })
  }
  if (exists && byPayer.size >= MIN_DISTINCT_PAYERS) {
    const atLeast = inbound.length >= SAMPLE_LIMIT ? 'at least ' : ''
    good.push({ tone: 'good', code: 'payers', text: `Paid by ${atLeast}${byPayer.size} different wallets.` })
  } else if (exists && byPayer.size > 0) {
    // One payer with enough payments already has its own warning above; say it once.
    if (!warn.some((w) => w.code === 'one_payer')) {
      neutral.push({ tone: 'neutral', code: 'few_payers', text: `Only ${byPayer.size} wallet${byPayer.size === 1 ? ' has' : 's have'} paid it so far.` })
    }
  } else if (exists) {
    neutral.push({ tone: 'neutral', code: 'no_payments', text: 'It has not received any USDC payments yet.' })
  }
  if (seller && !seller.blocked && seller.settlements > 0) {
    const since = seller.firstSeen ? ` since ${dayMonth(seller.firstSeen)}` : ''
    good.push({ tone: 'neutral', code: 'x402_seller', text: `A known x402 seller${seller.domain ? ` (${seller.domain})` : ''}: ${seller.settlements.toLocaleString('en-US')} payments${since}.` })
  }

  let verdict: PayCheckVerdict
  if (bad.length) verdict = 'dont_pay'
  else if (warn.length) verdict = 'careful'
  else if (accountAgeDays !== null && accountAgeDays >= ESTABLISHED_DAYS && byPayer.size >= MIN_DISTINCT_PAYERS) verdict = 'safe'
  else verdict = 'unknown'

  const reasons = [...bad, ...warn, ...good, ...neutral].slice(0, 5)

  const result: PayCheckResult = {
    query: q.trim(),
    address,
    resolvedFrom: resolved.resolvedFrom,
    name,
    verdict,
    headline: HEADLINES[verdict],
    reasons,
    facts: { accountAgeDays, canReceiveUsdc, seller, payers },
    explorerUrl: addressUrl(chain, address),
    checkedAt: new Date(now).toISOString(),
    fullReport: { tool: 'pay_check', priceUsd: payCheckPriceUsd(env), url: '/api/x402/algorand/tools/pay_check' },
  }
  if (deps.detailed) {
    const linkOf = new Map(traced.map((t) => [t.payer, t]))
    const unit = 10 ** usdc.decimals
    result.details = {
      topPayers: ranked.slice(0, 10).map(([payer, v]) => ({
        address: payer,
        payments: v.payments,
        usdc: v.amount / unit,
        share: total > 0 ? v.amount / total : 0,
        linked: linkOf.get(payer)?.linked ?? false,
        funder: linkOf.get(payer)?.funder ?? null,
      })),
      recentPayments: inbound.slice(0, 10).map((t) => ({
        payer: t.payer,
        usdc: t.amount / unit,
        at: t.at,
        txId: t.txId,
        linked: linkOf.get(t.payer)?.linked ?? false,
      })),
      createdBy: born.funder,
      createdAt: born.at,
      totalUsdcSampled: total / unit,
      sources: [`${idx} (Algorand indexer)`, `${facilitator || 'no facilitator'} (x402 facilitator public records)`, `${NFD_API} (NFD names)`],
    }
  }
  return result
}
