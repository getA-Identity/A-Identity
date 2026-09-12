/**
 * @a-identity/trust-guard/algorand
 *
 * Pay the A-Identity Trust Oracle in USDC on Algorand, from your agent's own account, under
 * a spending cap it cannot exceed.
 *
 *   import { TrustGuard } from '@a-identity/trust-guard'
 *   import { algorandPayer } from '@a-identity/trust-guard/algorand'
 *
 *   const oracle = new TrustGuard({
 *     rail: 'algorand',
 *     onPaymentRequired: algorandPayer({ mnemonic: process.env.AGENT_MNEMONIC!, maxUsdPerCall: 0.1 }),
 *   })
 *   await oracle.guard(counterpartyId)   // pays 0.05 USDC for the risk_check, throws on DENY
 *
 * What it signs, and nothing more: one USDC transfer of exactly the challenge's amount to the
 * challenge's payTo, with fee ZERO, grouped with an unsigned fee-payer transaction that the
 * GoPlausible facilitator signs and pays for. The agent needs USDC (opted in to the ASA) and
 * no ALGO for fees. The key never leaves this process.
 *
 * Refusals happen before anything is signed: a challenge above `maxUsdPerCall`, one asking for
 * any asset other than native Circle USDC, or one on a network this module does not know.
 *
 * Needs the `algosdk` package (an optional peer dependency): `npm install algosdk`.
 */
import type { FetchLike, TrustGuardOptions } from './index.js'

/** Thrown before signing when a challenge costs more than the payer may spend per call. */
export class SpendCapError extends Error {
  readonly resource: string
  readonly amountUsd: number
  readonly capUsd: number
  constructor(resource: string, amountUsd: number, capUsd: number) {
    super(`Refused to pay ${amountUsd} USDC for ${resource}: above the ${capUsd} USDC per-call cap.`)
    this.name = 'SpendCapError'
    this.resource = resource
    this.amountUsd = amountUsd
    this.capUsd = capUsd
  }
}

/** Thrown when a challenge cannot be paid safely on Algorand (wrong asset, network, shape). */
export class AlgorandPaymentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AlgorandPaymentError'
  }
}

/** Native Circle USDC per Algorand network, keyed by the x402 network string. */
export const ALGORAND_USDC: Record<string, { asset: string; algod: string; label: string }> = {
  'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=': { asset: '31566704', algod: 'https://mainnet-api.4160.nodely.dev', label: 'Algorand mainnet' },
  'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=': { asset: '10458941', algod: 'https://testnet-api.4160.nodely.dev', label: 'Algorand testnet' },
}

export const DEFAULT_ALGORAND_FACILITATOR = 'https://facilitator.goplausible.xyz'
export const DEFAULT_MAX_USD_PER_CALL = 0.25

export interface AlgorandPayerOptions {
  /** The paying account's 25-word mnemonic. */
  mnemonic: string
  /** The most this payer will pay for a single call, in USD. Default 0.25. */
  maxUsdPerCall?: number
  /** algod endpoint; defaults to the public Nodely endpoint for the challenge's network. */
  algodUrl?: string
  /** The facilitator whose fee payer joins the group. Default: GoPlausible. */
  facilitatorUrl?: string
  /** Inject a fetch implementation (tests, custom runtimes). */
  fetch?: FetchLike
}

type Accept = {
  scheme?: string
  network?: string
  amount?: string
  maxAmountRequired?: string
  asset?: string
  payTo?: string
  extra?: { decimals?: number; [k: string]: unknown }
}

type Challenge = { accepts?: Accept[]; resource?: unknown; extensions?: unknown }

type Algosdk = typeof import('algosdk')

async function loadAlgosdk(): Promise<Algosdk> {
  try {
    const mod = (await import('algosdk')) as Algosdk & { default?: Algosdk }
    return mod.default ?? mod
  } catch {
    throw new AlgorandPaymentError("algorandPayer needs the 'algosdk' package: npm install algosdk")
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

async function getJson(doFetch: FetchLike, url: string): Promise<Record<string, unknown>> {
  const res = await doFetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new AlgorandPaymentError(`${url} answered HTTP ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

/**
 * Choose the payable Algorand entry in a challenge and check it before anything is signed.
 * Exported for callers that want the quote without paying.
 */
export function readAlgorandQuote(
  challenge: unknown,
): { accept: Accept & { network: string; payTo: string }; amount: bigint; amountUsd: number; label: string } {
  const c = (challenge ?? {}) as Challenge
  const accept = (c.accepts ?? []).find((a) => a.scheme === 'exact' && typeof a.network === 'string' && ALGORAND_USDC[a.network])
  if (!accept || !accept.network) throw new AlgorandPaymentError('the challenge offers no Algorand USDC payment')
  const known = ALGORAND_USDC[accept.network]
  if (String(accept.asset) !== known.asset) {
    throw new AlgorandPaymentError(`the challenge asks for ASA ${String(accept.asset)}, not native USDC (${known.asset}) on ${known.label}`)
  }
  const decimals = accept.extra?.decimals ?? 6
  if (decimals !== 6) throw new AlgorandPaymentError(`USDC has 6 decimals; the challenge claims ${decimals}`)
  let amount: bigint
  try {
    amount = BigInt(accept.amount ?? accept.maxAmountRequired ?? '0')
  } catch {
    throw new AlgorandPaymentError('the challenge amount is not an integer number of base units')
  }
  if (amount <= 0n) throw new AlgorandPaymentError('the challenge amount is not positive')
  if (!accept.payTo) throw new AlgorandPaymentError('the challenge names no payTo account')
  return { accept: accept as Accept & { network: string; payTo: string }, amount, amountUsd: Number(amount) / 1e6, label: known.label }
}

/**
 * An `onPaymentRequired` handler for `TrustGuard` that pays Algorand x402 challenges from the
 * given account and returns the PAYMENT-SIGNATURE header to retry with.
 */
export function algorandPayer(opts: AlgorandPayerOptions): NonNullable<TrustGuardOptions['onPaymentRequired']> {
  if (!opts || typeof opts.mnemonic !== 'string' || opts.mnemonic.trim().split(/\s+/).length !== 25) {
    throw new AlgorandPaymentError('algorandPayer needs the paying account as a 25-word Algorand mnemonic')
  }
  const cap = opts.maxUsdPerCall ?? DEFAULT_MAX_USD_PER_CALL
  if (!Number.isFinite(cap) || cap <= 0) throw new AlgorandPaymentError('maxUsdPerCall must be a positive number of USD')
  const mnemonic = opts.mnemonic.trim()
  const facilitator = (opts.facilitatorUrl ?? DEFAULT_ALGORAND_FACILITATOR).replace(/\/+$/, '')

  return async (challenge, { resource }) => {
    const quote = readAlgorandQuote(challenge)
    // The cap is checked before the SDK loads, before any network call, before any signature.
    if (quote.amountUsd > cap) throw new SpendCapError(resource, quote.amountUsd, cap)

    const doFetch = opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch
    if (!doFetch) throw new AlgorandPaymentError('No fetch available; pass opts.fetch.')
    const algosdk = await loadAlgosdk()
    const account = algosdk.mnemonicToSecretKey(mnemonic)
    const { accept, amount } = quote

    const supported = (await getJson(doFetch, `${facilitator}/supported`)) as {
      kinds?: { network?: string; extra?: { feePayer?: string } }[]
    }
    const feePayer = (supported.kinds ?? []).find((k) => k.network === accept.network)?.extra?.feePayer
    if (!feePayer) throw new AlgorandPaymentError(`the facilitator lists no fee payer for ${quote.label}`)

    const algod = (opts.algodUrl ?? ALGORAND_USDC[accept.network].algod).replace(/\/+$/, '')
    const p = await getJson(doFetch, `${algod}/v2/transactions/params`)
    const lastRound = Number(p['last-round'])
    const minFee = Number(p['min-fee'] ?? 1000)
    if (!Number.isFinite(lastRound) || typeof p['genesis-hash'] !== 'string') {
      throw new AlgorandPaymentError('algod returned unusable transaction params')
    }
    const suggested = {
      fee: 0,
      flatFee: true,
      minFee,
      firstValid: lastRound + 1,
      lastValid: lastRound + 1000,
      genesisID: String(p['genesis-id']),
      genesisHash: base64ToBytes(p['genesis-hash']),
    } as unknown as Parameters<Algosdk['makePaymentTxnWithSuggestedParamsFromObject']>[0]['suggestedParams']

    // The fee payer covers the whole group's pooled fee; the agent's transfer carries none.
    const feeTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: feePayer,
      receiver: feePayer,
      amount: 0,
      suggestedParams: { ...suggested, fee: Math.max(2000, 2 * minFee) },
    })
    const payTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: account.addr,
      receiver: accept.payTo,
      assetIndex: BigInt(String(accept.asset)),
      amount,
      suggestedParams: { ...suggested, fee: 0 },
    })
    const [unsignedFee, payment] = algosdk.assignGroupID([feeTxn, payTxn])
    const c = (challenge ?? {}) as Challenge
    const payload = {
      x402Version: 2,
      scheme: 'exact',
      network: accept.network,
      resource: c.resource,
      accepted: accept,
      extensions: c.extensions ?? {},
      payload: {
        paymentGroup: [bytesToBase64(algosdk.encodeUnsignedTransaction(unsignedFee)), bytesToBase64(payment.signTxn(account.sk))],
        paymentIndex: 1,
      },
    }
    return { 'PAYMENT-SIGNATURE': textToBase64(JSON.stringify(payload)) }
  }
}
