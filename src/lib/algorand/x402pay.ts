/**
 * Buying from the Algorand x402 rail with the visitor's own wallet: the detailed /check
 * report (pay_check) and the other paid tools, all through the same steps.
 *
 * A browser port of trust-guard's algorandPayer (trust-guard/src/algorand.ts), which is the
 * proven way to pay this rail, with the mnemonic replaced by the person's wallet. What the
 * wallet is asked to sign, and nothing more: one USDC transfer of exactly the quoted amount
 * to the quoted payTo with fee zero, grouped with an unsigned fee-payer transaction that the
 * x402 facilitator signs and pays for. The buyer needs USDC and no ALGO for fees.
 *
 * Every refusal here happens before the wallet is asked to sign: terms on another network or
 * asset, an amount that is not the price the page showed, a wallet without enough USDC.
 *
 * The functions take their I/O as arguments (algosdk, fetch, the POST to our backend), so a
 * Node script can drive the same code the page runs. Nothing here holds a key.
 */
import type { Transaction } from 'algosdk'
import { CHAIN_BY_ID } from '../chains'

type Algosdk = typeof import('algosdk')

/**
 * The facilitator's spelling of Algorand mainnet (the full genesis hash; the registry's CAIP-2
 * id is its 32-character prefix) and native Circle USDC on it. The generated frontend registry
 * carries neither ASA ids nor the facilitator spelling, so these two are pinned here, the same
 * two values trust-guard pins. buildGroup also checks the algod node's own genesis hash
 * against the network, so a node on another network cannot slip through.
 */
export const ALGORAND_MAINNET_X402 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
export const USDC_ASSET_ID = '31566704'
const USDC_DECIMALS = 6
const USDC_UNIT = 10 ** USDC_DECIMALS

/** Used only when a 402 names no facilitator; the rail's own default. */
export const DEFAULT_FACILITATOR = 'https://facilitator.goplausible.xyz'

const ALGORAND = CHAIN_BY_ID.algorand
/** Mainnet algod, from the generated registry mirror: the same node the backend reads. */
export const ALGOD_URL = (ALGORAND.rpcUrl ?? '').replace(/\/+$/, '')

/** The tools this rail sells; each one answers at /api/x402/algorand/tools/<tool>. */
export type PaidTool = 'pay_check' | 'verify_agent' | 'reputation_score' | 'risk_check' | 'agent_passport' | 'agent_batch_audit'

export const toolPath = (tool: PaidTool) => `/api/x402/algorand/tools/${tool}`

export const PAY_CHECK_PATH = toolPath('pay_check')

// ---- small helpers ----

/** "$5", "$0.01", "$2.50". */
export function formatUsd(v: number): string {
  const whole = Number.isInteger(v)
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 6 })}`
}

/** "5.00", "0.05", "1,234.50", "0.001". */
export function formatUsdc(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 0.01 ? 6 : 2 })
}

export const accountUrl = (address: string) => `${ALGORAND.explorer}/account/${address}`
export const txUrl = (txId: string) => `${ALGORAND.explorer}/tx/${txId}`

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

/**
 * A refusal made before anything was signed. The message is a sentence for the person: what
 * did not add up. The page adds what happened to the money.
 */
export class PayRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayRefusal'
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

async function getJson(fetchImpl: FetchLike, url: string, what: string): Promise<{ status: number; json: unknown }> {
  let res: Response
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  } catch {
    throw new Error(`${what} could not be reached.`)
  }
  return { status: res.status, json: await res.json().catch(() => null) }
}

// ---- 1. the quote ----

export type Accept = {
  scheme?: string
  network?: string
  amount?: string
  maxAmountRequired?: string
  asset?: string
  payTo?: string
  maxTimeoutSeconds?: number
  extra?: { decimals?: number; [k: string]: unknown }
}

export type Challenge = {
  x402Version?: number
  resource?: unknown
  accepts?: Accept[]
  extensions?: unknown
  facilitator?: unknown
  reason?: unknown
}

export type Quote = {
  accept: Accept & { network: string; payTo: string; asset: string }
  amount: bigint
  amountUsd: number
  facilitator: string
  resource: unknown
  extensions: unknown
}

/**
 * Pick the USDC-on-Algorand-mainnet entry from a 402 and check it against the price the page
 * showed. Throws PayRefusal on anything that does not match; nothing has been signed then.
 */
export function readQuote(challenge: unknown, expectedUsd: number): Quote {
  const c = (challenge ?? {}) as Challenge
  const accepts = Array.isArray(c.accepts) ? c.accepts : []
  const accept = accepts.find((a) => a?.scheme === 'exact' && a.network === ALGORAND_MAINNET_X402)
  if (!accept) throw new PayRefusal('The server did not offer a USDC payment on Algorand mainnet.')
  if (String(accept.asset) !== USDC_ASSET_ID) {
    throw new PayRefusal(`The server asked for asset ${String(accept.asset)} instead of USDC (${USDC_ASSET_ID}).`)
  }
  const decimals = accept.extra?.decimals ?? USDC_DECIMALS
  if (decimals !== USDC_DECIMALS) throw new PayRefusal(`The server said USDC has ${String(decimals)} decimals; it has ${USDC_DECIMALS}.`)
  const raw = String(accept.amount ?? accept.maxAmountRequired ?? '')
  if (!/^[0-9]{1,15}$/.test(raw) || BigInt(raw) <= 0n) {
    throw new PayRefusal('The server asked for an amount that is not a whole, positive number of USDC units.')
  }
  const amount = BigInt(raw)
  const amountUsd = Number(amount) / USDC_UNIT
  if (!Number.isFinite(expectedUsd) || expectedUsd <= 0) throw new PayRefusal('This page does not know the price, so it will not pay.')
  if (amount !== BigInt(Math.round(expectedUsd * USDC_UNIT))) {
    throw new PayRefusal(`The server asked for ${formatUsd(amountUsd)}, but this page showed ${formatUsd(expectedUsd)}.`)
  }
  if (typeof accept.payTo !== 'string' || !/^[A-Z2-7]{58}$/.test(accept.payTo)) {
    throw new PayRefusal('The server named no valid Algorand address to pay.')
  }
  const facilitator =
    typeof c.facilitator === 'string' && /^https:\/\/[^\s/]+/.test(c.facilitator) ? c.facilitator.replace(/\/+$/, '') : DEFAULT_FACILITATOR
  return {
    accept: accept as Quote['accept'],
    amount,
    amountUsd,
    facilitator,
    resource: c.resource,
    extensions: c.extensions ?? {},
  }
}

/** A POST to the paid endpoint: our backend, however the caller reaches it. */
export type Poster = (body: string, headers: Record<string, string>) => Promise<Response>

export const reportBody = (address: string) => JSON.stringify({ address })

/** The detailed report's terms: fetchQuoteFor with the pay_check body. */
export function fetchQuote(post: Poster, address: string, expectedUsd: number): Promise<Quote> {
  return fetchQuoteFor(post, reportBody(address), expectedUsd)
}

/**
 * Ask a paid endpoint for its terms: a POST of the call's own body without a payment header
 * answers 402 with them. The body matters for the batch audit, whose 402 is quoted for the
 * number of distinct agents it names. Nothing is signed or charged by this call.
 */
export async function fetchQuoteFor(post: Poster, body: string, expectedUsd: number): Promise<Quote> {
  let res: Response
  try {
    res = await post(body, { 'content-type': 'application/json' })
  } catch {
    throw new Error('The payment terms could not be fetched.')
  }
  const json = (await res.json().catch(() => null)) as (Challenge & { error?: unknown }) | null
  if (res.status === 402 && json) return readQuote(json, expectedUsd)
  if (res.status === 400 && typeof json?.error === 'string') throw new PayRefusal(json.error)
  throw new Error(`The payment terms could not be fetched (HTTP ${res.status}).`)
}

// ---- 2. can this wallet pay, and the pieces of the group ----

export type UsdcHolding = { optedIn: false } | { optedIn: true; amount: bigint; frozen: boolean }

/** The account's USDC position, read from algod. 404 means no opt-in (or no account at all). */
export async function fetchUsdcHolding(address: string, fetchImpl: FetchLike = fetch, algod: string = ALGOD_URL): Promise<UsdcHolding> {
  const { status, json } = await getJson(fetchImpl, `${algod}/v2/accounts/${address}/assets/${USDC_ASSET_ID}`, 'The Algorand node')
  if (status === 404) return { optedIn: false }
  const h = (json as { 'asset-holding'?: { amount?: number | string; 'is-frozen'?: boolean } } | null)?.['asset-holding']
  if (status !== 200 || !h || h.amount === undefined) throw new Error(`The Algorand node could not read this wallet's USDC (HTTP ${status}).`)
  return { optedIn: true, amount: BigInt(h.amount), frozen: h['is-frozen'] === true }
}

/**
 * The sentence that stops a payment this wallet cannot make, or null when it can pay. `what`
 * names the thing being bought in that sentence ("the report", "this check").
 */
export function fundsProblem(holding: UsdcHolding, amount: bigint, what = 'the report'): string | null {
  if (!holding.optedIn || holding.amount === 0n) return 'This wallet has no USDC on Algorand.'
  if (holding.frozen) return "This wallet's USDC is frozen, so it cannot pay."
  if (holding.amount < amount) {
    return `This wallet holds ${formatUsdc(Number(holding.amount) / USDC_UNIT)} USDC; ${what} costs ${formatUsdc(Number(amount) / USDC_UNIT)} USDC.`
  }
  return null
}

/** A USDC holding in dollars, for showing a balance. */
export const holdingUsdc = (holding: UsdcHolding): number => (holding.optedIn ? Number(holding.amount) / USDC_UNIT : 0)

/** The facilitator's fee payer for the network: it signs and pays the group's pooled fee. */
export async function fetchFeePayer(facilitator: string, network: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const { status, json } = await getJson(fetchImpl, `${facilitator}/supported`, 'The payment facilitator')
  const kinds = (json as { kinds?: { scheme?: string; network?: string; extra?: { feePayer?: unknown } }[] } | null)?.kinds ?? []
  const feePayer = kinds.find((k) => k.network === network && (k.scheme ?? 'exact') === 'exact')?.extra?.feePayer
  if (status !== 200 || typeof feePayer !== 'string' || !/^[A-Z2-7]{58}$/.test(feePayer)) {
    throw new Error('The payment facilitator lists no fee payer for Algorand mainnet.')
  }
  return feePayer
}

export type AlgodParams = { 'last-round'?: unknown; 'min-fee'?: unknown; 'genesis-id'?: unknown; 'genesis-hash'?: unknown }

export async function fetchParams(fetchImpl: FetchLike = fetch, algod: string = ALGOD_URL): Promise<AlgodParams> {
  const { status, json } = await getJson(fetchImpl, `${algod}/v2/transactions/params`, 'The Algorand node')
  if (status !== 200 || !json || typeof json !== 'object') throw new Error(`The Algorand node returned no transaction parameters (HTTP ${status}).`)
  return json as AlgodParams
}

/**
 * The two-transaction group, exactly as trust-guard builds it: the fee payer's zero payment to
 * itself carrying the whole group's fee, then the buyer's fee-zero USDC transfer. Valid for
 * 1000 rounds from the next one.
 */
export function buildGroup(
  sdk: Algosdk,
  a: { quote: Quote; sender: string; feePayer: string; params: AlgodParams },
): { feeTxn: Transaction; payTxn: Transaction } {
  const { quote, sender, feePayer, params } = a
  if (!sdk.isValidAddress(sender)) throw new PayRefusal('The wallet gave an address that is not a valid Algorand address.')
  if (!sdk.isValidAddress(feePayer)) throw new PayRefusal('The payment facilitator named an invalid fee payer.')
  if (!sdk.isValidAddress(quote.accept.payTo)) throw new PayRefusal('The server named no valid Algorand address to pay.')
  const lastRound = Number(params['last-round'])
  const minFee = Number(params['min-fee'] ?? 1000)
  const genesisHash = params['genesis-hash']
  if (!Number.isSafeInteger(lastRound) || lastRound <= 0 || !Number.isSafeInteger(minFee) || typeof genesisHash !== 'string') {
    throw new Error('The Algorand node returned unusable transaction parameters.')
  }
  if (`algorand:${genesisHash}` !== quote.accept.network) {
    throw new PayRefusal('The Algorand node is on a different network than the payment.')
  }
  const suggested = {
    fee: 0,
    flatFee: true,
    minFee,
    firstValid: lastRound + 1,
    lastValid: lastRound + 1000,
    genesisID: String(params['genesis-id']),
    genesisHash: base64ToBytes(genesisHash),
  }
  // The fee payer covers the whole group's pooled fee; the buyer's transfer carries none.
  const feeTxn = sdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: feePayer,
    receiver: feePayer,
    amount: 0,
    suggestedParams: { ...suggested, fee: Math.max(2000, 2 * minFee) },
  })
  const payTxn = sdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender,
    receiver: quote.accept.payTo,
    assetIndex: BigInt(quote.accept.asset),
    amount: quote.amount,
    suggestedParams: suggested,
  })
  const [fee, pay] = sdk.assignGroupID([feeTxn, payTxn])
  return { feeTxn: fee, payTxn: pay }
}

// ---- 3. the header ----

/** The x402 payment payload, field for field what trust-guard sends. */
export function buildPayload(
  sdk: Algosdk,
  a: { quote: Quote; feeTxn: Transaction; payTxn: Transaction; signedPayTxn: Uint8Array },
): Record<string, unknown> {
  // What the wallet returned must be OUR payment, signed: same transaction id, a signature on it.
  let signed: ReturnType<Algosdk['decodeSignedTransaction']>
  try {
    signed = sdk.decodeSignedTransaction(a.signedPayTxn)
  } catch {
    throw new PayRefusal('The wallet returned something that is not a signed Algorand transaction.')
  }
  if (signed.txn.txID() !== a.payTxn.txID() || !(signed.sig || signed.msig || signed.lsig)) {
    throw new PayRefusal('The wallet signed something other than this payment.')
  }
  return {
    x402Version: 2,
    scheme: 'exact',
    network: a.quote.accept.network,
    resource: a.quote.resource,
    accepted: a.quote.accept,
    extensions: a.quote.extensions ?? {},
    payload: {
      paymentGroup: [bytesToBase64(sdk.encodeUnsignedTransaction(a.feeTxn)), bytesToBase64(a.signedPayTxn)],
      paymentIndex: 1,
    },
  }
}

/** The PAYMENT-SIGNATURE header value: base64 of the payload's UTF-8 JSON. */
export function buildHeader(
  sdk: Algosdk,
  a: { quote: Quote; feeTxn: Transaction; payTxn: Transaction; signedPayTxn: Uint8Array },
): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(buildPayload(sdk, a))))
}

// ---- 4. sending it, and what each answer means for the money ----

export type PayerRow = { address: string; payments: number; usdc: number; share: number; linked: boolean; funder: string | null }
export type PaymentRow = { payer: string; usdc: number; at: string | null; txId: string | null; linked: boolean }
export type ReportDetails = {
  topPayers: PayerRow[]
  recentPayments: PaymentRow[]
  createdBy: string | null
  createdAt: string | null
  totalUsdcSampled: number
  sources: string[]
}

/** The paid answer: the free result's fields plus `details`. Typed loosely; the page owns the free shape. */
export type PaidReport = { address: string | null; details: ReportDetails; facts?: { payers?: { sampled?: number } | null } }

export type SubmitOutcome =
  /** 200: the transfer was read back from the ledger and the report is attached. */
  | { kind: 'paid'; report: PaidReport; tx: string; amountUsd: number | null }
  /** 200, but the body is not a report we can show. The money moved. */
  | { kind: 'paid_unreadable'; tx: string }
  /** 402 with a reason: refused before settlement, nothing charged. */
  | { kind: 'refused'; reason: string }
  /** 503 from the rail: the report could not be produced, so nothing was settled. */
  | { kind: 'unavailable' }
  /** 202: submitted, not confirmed in time. */
  | { kind: 'pending'; tx: string }
  /** Refused by our backend before any settlement (bad input, rail off, facilitator unreachable at verify). */
  | { kind: 'not_charged' }
  /** The header left this page and we cannot say what happened. */
  | { kind: 'unknown'; tx: string }

function isDetails(x: unknown): x is ReportDetails {
  const d = x as Partial<ReportDetails> | null
  return !!d && Array.isArray(d.topPayers) && Array.isArray(d.recentPayments)
}

/** The detailed report out of a paid pay_check answer, or null when it is not one. */
export const readReport = (json: Record<string, unknown>): PaidReport | null =>
  isDetails(json.details) ? (json as unknown as PaidReport) : null

/**
 * What a paid call came back as, for any tool. Same classification as SubmitOutcome; the
 * answer is whatever `read` made of the 200 body, and an unreadable 200 keeps the raw body so
 * the person can still see what they paid for.
 */
export type PaidOutcome<T> =
  | { kind: 'paid'; answer: T; raw: Record<string, unknown>; tx: string; amountUsd: number | null }
  | { kind: 'paid_unreadable'; tx: string; raw: unknown }
  | Exclude<SubmitOutcome, { kind: 'paid' } | { kind: 'paid_unreadable' }>

/** The detailed report's paid call: submitPaid with the pay_check body and reader. */
export async function submitPayment(post: Poster, address: string, header: string, payTxId: string): Promise<SubmitOutcome> {
  const out = await submitPaid(post, reportBody(address), header, payTxId, readReport)
  if (out.kind === 'paid') return { kind: 'paid', report: out.answer, tx: out.tx, amountUsd: out.amountUsd }
  if (out.kind === 'paid_unreadable') return { kind: 'paid_unreadable', tx: out.tx }
  return out
}

/**
 * Send the signed payment with the call's body and classify the answer. A status only counts
 * as "nothing charged" when the body is our rail's own JSON for that status; a bare 5xx from a
 * proxy in between could have cut off a call that went on to settle, so it reads as unknown.
 * A 200 counts as paid only with a successful settlement AND an answer `read` recognises.
 */
export async function submitPaid<T>(
  post: Poster,
  body: string,
  header: string,
  payTxId: string,
  read: (json: Record<string, unknown>) => T | null,
): Promise<PaidOutcome<T>> {
  let res: Response
  try {
    res = await post(body, { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': header })
  } catch {
    return { kind: 'unknown', tx: payTxId }
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const settlement = (json?.settlement ?? null) as { success?: unknown; transaction?: unknown; amountUsd?: unknown } | null
  switch (res.status) {
    case 200: {
      const tx = typeof settlement?.transaction === 'string' ? settlement.transaction : payTxId
      let answer: T | null = null
      try {
        answer = json && settlement?.success === true ? read(json) : null
      } catch {
        /* a reader that trips on the shape means "not an answer we can show", nothing more */
      }
      if (json && answer !== null) {
        return { kind: 'paid', answer, raw: json, tx, amountUsd: typeof settlement?.amountUsd === 'number' ? settlement.amountUsd : null }
      }
      return { kind: 'paid_unreadable', tx, raw: json }
    }
    case 402:
      if (json && Array.isArray(json.accepts)) {
        const reason = typeof json.reason === 'string' && json.reason.trim() ? json.reason.trim().replace(/\.+$/, '') : 'no reason was given'
        return { kind: 'refused', reason: reason.length > 280 ? `${reason.slice(0, 277)}...` : reason }
      }
      return { kind: 'unknown', tx: payTxId }
    case 503:
      return json?.code === 'service_unavailable' ? { kind: 'unavailable' } : { kind: 'unknown', tx: payTxId }
    case 202:
      return json?.ambiguous === true
        ? { kind: 'pending', tx: typeof json.transaction === 'string' ? json.transaction : payTxId }
        : { kind: 'unknown', tx: payTxId }
    case 502:
      // Only these two codes are refusals before anything was submitted (see settle.ts): the
      // replay log unreadable, or the facilitator unreachable at /verify. Anything else is not.
      return json && json.ambiguous !== true && (json.code === 'replay_guard_unavailable' || json.code === 'facilitator_unreachable')
        ? { kind: 'not_charged' }
        : { kind: 'unknown', tx: payTxId }
    case 400:
    case 501:
      return json && typeof json.error === 'string' ? { kind: 'not_charged' } : { kind: 'unknown', tx: payTxId }
    default:
      return { kind: 'unknown', tx: payTxId }
  }
}
