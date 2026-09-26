/**
 * One purchase from the Algorand x402 rail, step by step, for any paid tool: the terms, the
 * wallet, the USDC check, the signature, the paid call. This is the flow the detailed report
 * shipped with, lifted out of the page so every paid check on /check runs the same steps and
 * ends in the same honest sentences.
 *
 * The caller owns the screen: it is told each step, and says through `alive()` whether it
 * still wants the result. Until the signed payment leaves the page, a caller that moved on
 * (cancelled, closed, left) gets null back and nothing is sent. After it leaves, the outcome
 * is always returned, because from then on it may carry a payment.
 */
import { algorandWalletError, signAlgorandGroup, type AlgorandWalletId } from './wallet'
import {
  PayRefusal,
  buildGroup,
  buildHeader,
  fetchFeePayer,
  fetchParams,
  fetchQuoteFor,
  fetchUsdcHolding,
  formatUsd,
  fundsProblem,
  submitPaid,
  type Poster,
} from './x402pay'

/** The wallet a payment comes from: connected at the top of the page, or picked for this payment. */
export type PayWallet = { id: AlgorandWalletId; name: string; address: string }

/** How a purchase stopped short of an answer, each with what happened to the money. */
export type Stop =
  | { kind: 'cancelled' }
  | { kind: 'refusal'; text: string }
  | { kind: 'wallet'; wallet: string; text: string }
  | { kind: 'before' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unavailable' }
  | { kind: 'pending'; tx: string }
  | { kind: 'unknown'; tx: string }
  | { kind: 'paid_unreadable'; tx: string; raw?: unknown }

/** Where a purchase is. `wallet` means the wallet list is open for this payment. */
export type PayStep = { s: 'quoting' } | { s: 'wallet' } | { s: 'checking' | 'signing' | 'confirming'; from: string; wallet: string }

export type PurchaseEnd<T> =
  | { kind: 'paid'; answer: T; raw: Record<string, unknown>; tx: string; amountUsd: number }
  | { kind: 'stopped'; stop: Stop }
  /** The wallet list was closed before anything was signed: back to where it started. */
  | { kind: 'closed' }

/**
 * Stops after which this screen does not offer the same payment again: it is out, or it went
 * through. An unknown ending already tells the person to check their wallet before retrying.
 */
export const paymentIsOut = (stop: Stop) => stop.kind === 'pending' || stop.kind === 'paid_unreadable'

export async function purchase<T>(a: {
  /** The POST to this tool's endpoint on our backend. */
  post: Poster
  /** The call's JSON body, sent with the quote request and again with the payment. */
  body: string
  /** The price the page showed; the 402 must ask for exactly this. */
  expectedUsd: number
  /** Names the thing bought in the not-enough-USDC sentence. */
  what: string
  read: (json: Record<string, unknown>) => T | null
  /** The connected wallet, or null to ask for one after the terms are in. */
  wallet: PayWallet | null
  /** Open the wallet list for this payment: a wallet, 'cancelled' in the wallet, or null when closed. */
  askWallet: (price: string) => Promise<PayWallet | 'cancelled' | null>
  alive: () => boolean
  step: (s: PayStep) => void
}): Promise<PurchaseEnd<T> | null> {
  const stopped = (stop: Stop): PurchaseEnd<T> => ({ kind: 'stopped', stop })

  a.step({ s: 'quoting' })
  let quote: Awaited<ReturnType<typeof fetchQuoteFor>>
  try {
    quote = await fetchQuoteFor(a.post, a.body, a.expectedUsd)
  } catch (e) {
    if (!a.alive()) return null
    return stopped(e instanceof PayRefusal ? { kind: 'refusal', text: e.message } : { kind: 'before' })
  }
  if (!a.alive()) return null

  let w = a.wallet
  if (!w) {
    a.step({ s: 'wallet' })
    const got = await a.askWallet(formatUsd(quote.amountUsd))
    if (!a.alive()) return null
    if (got === null) return { kind: 'closed' }
    if (got === 'cancelled') return stopped({ kind: 'cancelled' })
    w = got
  }
  const from = w.address
  const wallet = w.name

  // Everything that can refuse does so here, before the wallet is asked to sign.
  a.step({ s: 'checking', from, wallet })
  let sdk: typeof import('algosdk')
  let group: ReturnType<typeof buildGroup>
  try {
    sdk = await import('algosdk')
    const [holding, feePayer, params] = await Promise.all([
      fetchUsdcHolding(from),
      fetchFeePayer(quote.facilitator, quote.accept.network),
      fetchParams(),
    ])
    const problem = fundsProblem(holding, quote.amount, a.what)
    if (problem) throw new PayRefusal(problem)
    group = buildGroup(sdk, { quote, sender: from, feePayer, params })
  } catch (e) {
    if (!a.alive()) return null
    return stopped(e instanceof PayRefusal ? { kind: 'refusal', text: e.message } : { kind: 'before' })
  }
  if (!a.alive()) return null

  a.step({ s: 'signing', from, wallet })
  let header: string
  try {
    const signedPayTxn = await signAlgorandGroup(w.id, from, [group.feeTxn, group.payTxn], 1)
    if (!a.alive()) return null
    header = buildHeader(sdk, { quote, feeTxn: group.feeTxn, payTxn: group.payTxn, signedPayTxn })
  } catch (e) {
    if (!a.alive()) return null
    if (e instanceof PayRefusal) return stopped({ kind: 'refusal', text: e.message })
    const we = algorandWalletError(e)
    return stopped(we.cancelled ? { kind: 'cancelled' } : we.message ? { kind: 'wallet', wallet, text: we.message } : { kind: 'before' })
  }

  // From here the signed payment has left the page. No cancel, and every answer is kept.
  a.step({ s: 'confirming', from, wallet })
  const out = await submitPaid(a.post, a.body, header, group.payTxn.txID(), a.read)
  switch (out.kind) {
    case 'paid':
      return { kind: 'paid', answer: out.answer, raw: out.raw, tx: out.tx, amountUsd: out.amountUsd ?? quote.amountUsd }
    case 'not_charged':
      return stopped({ kind: 'before' })
    default:
      return stopped(out)
  }
}
