/**
 * Owner-signed writes to a Stellar (Soroban) policy vault.
 *
 * Three steps, always in this order: the backend PREPARES the exact call and simulates it,
 * the owner's wallet SIGNS the envelope, the backend SUBMITS it and reads the receipt back.
 * The server never holds the owner's key, and nothing is reported as settled without a
 * transaction hash from a ledger.
 *
 * Every failure becomes one sentence a person can act on. A wallet's own message is never
 * swallowed: kits reject with plain { code, message } objects rather than Errors, so the
 * message is read off whatever was thrown and surfaced as-is.
 */
import { apiFetch, readJson, explainError } from '../api'
import { authHeaders } from '../../store/auth'
import { getSigner } from '../../store/wallets'
import { shortAddress } from '../wallet/types'
import { readStellarNetwork, signStellarTransaction, stellarNetworkMismatch, stellarPassphraseFor } from './kit'

/** The vault entry points an owner can call from the console. */
export type StellarVaultAction =
  | 'set_policy'
  | 'set_frozen'
  | 'set_allowed'
  | 'set_session_key_expiry'
  | 'withdraw'
  | 'owner_pay'

export type StellarVaultArgs = {
  dailyCapUsd?: number
  autoApproveUsd?: number
  allowlistEnabled?: boolean
  frozen?: boolean
  payee?: string
  allowed?: boolean
  expiryUnix?: number
  to?: string
  amountUsd?: number
}

/** Where the flow is, so a button can say it out loud instead of just spinning. */
export type OwnerActionStep = 'preparing' | 'signing' | 'submitting'

export type OwnerActionInput = {
  /** CAIP-2, e.g. 'stellar:testnet'. */
  network: string
  /** The vault contract id. */
  contract: string
  /** The owner account the wallet must be showing (G...). */
  source: string
  action: StellarVaultAction
  args?: StellarVaultArgs
  onStep?: (step: OwnerActionStep) => void
}

export type OwnerActionResult = {
  outcome: 'settled' | 'pending'
  txHash?: string
  ledger?: number
  explorerUrl?: string
  /** What the backend said it was signing, worth showing next to the receipt. */
  summary?: string
  /** Set for 'pending': submitted, no ledger yet. */
  reason?: string
}

type PrepareOk = {
  ok: true
  xdr: string
  networkPassphrase?: string
  network?: string
  contract?: string
  action?: string
  summary?: string
  /** Null in the ordinary case: an owner who is the transaction source signs with source-account
   *  credentials, so there is no separate signature-expiry ledger. `validUntil` governs. */
  expiresAtLedger?: number | null
  validUntil?: string
  feeStroops?: string | number
  note?: string
}
type PrepareFail = { ok?: false; code?: string; reason?: string; contractErrorName?: string; error?: string }
type SubmitBody = {
  outcome?: 'settled' | 'pending' | 'refused' | 'failed'
  txHash?: string
  ledger?: number
  explorerUrl?: string
  reason?: string
  contractErrorName?: string
  error?: string
}

/**
 * One sentence from whatever a wallet threw. Wallet kits reject with plain objects
 * ({ code, message }), not Error instances, so the message is read from either.
 */
export function walletErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string')
    return (e as { message: string }).message
  return ''
}

/** A prepare refusal, in words. The backend's own reason wins when it has one. */
function prepareMessage(status: number, body: PrepareFail): string {
  if (body.code === 'not_owner')
    return "This vault's owner is a different account than the one you signed in with."
  if (body.contractErrorName) return `The vault refused it: ${body.contractErrorName}`
  if (body.reason) return body.reason
  return explainError(status, body.error)
}

/**
 * Prepare, sign, submit. Returns the submit outcome, or throws one sentence.
 *
 * The wallet's network is read, never set: a wallet pointed at another network is told
 * which one it is on and which one the vault lives on, before any signature is asked for.
 */
export async function ownerAction(input: OwnerActionInput): Promise<OwnerActionResult> {
  const signer = getSigner('stellar')
  if (!signer)
    throw new Error(
      'Connect your Stellar wallet in this tab first: sign in with it, or link it from the Profile page.',
    )
  if (signer.address !== input.source)
    throw new Error(
      `This vault's owner is ${shortAddress(input.source)} and the Stellar wallet connected here is ${shortAddress(signer.address)}. Pick the owner account inside the wallet, then try again.`,
    )

  const walletNetwork = (await readStellarNetwork()) ?? signer.network ?? null
  const mismatch = stellarNetworkMismatch(signer.walletName || 'Your wallet', walletNetwork, input.network)
  if (mismatch) throw new Error(mismatch)

  input.onStep?.('preparing')
  const pres = await apiFetch('/api/stellar/vault/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      network: input.network,
      contract: input.contract,
      source: input.source,
      action: input.action,
      args: input.args ?? {},
    }),
    timeoutMs: 60_000,
  })
  const prep = await readJson<PrepareOk | PrepareFail>(pres)
  if (!pres.ok || !('ok' in prep) || prep.ok !== true) throw new Error(prepareMessage(pres.status, prep as PrepareFail))
  const ready = prep as PrepareOk
  if (!ready.xdr) throw new Error('The server prepared no transaction to sign.')

  const passphrase = ready.networkPassphrase ?? stellarPassphraseFor(input.network)
  if (!passphrase) throw new Error(`No signing passphrase for ${input.network}, so nothing was sent to the wallet.`)

  input.onStep?.('signing')
  let signed: string
  try {
    signed = signer.signTransaction
      ? await signer.signTransaction(ready.xdr, { networkPassphrase: passphrase })
      : await signStellarTransaction(ready.xdr, { networkPassphrase: passphrase, address: signer.address })
  } catch (e) {
    throw new Error(walletErrorMessage(e) || 'The wallet returned no signature.')
  }

  input.onStep?.('submitting')
  const sres = await apiFetch('/api/stellar/vault/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ network: input.network, xdr: signed }),
    timeoutMs: 90_000,
  })
  const out = await readJson<SubmitBody>(sres)

  if (out.outcome === 'settled')
    return {
      outcome: 'settled',
      txHash: out.txHash,
      ledger: out.ledger,
      explorerUrl: out.explorerUrl,
      summary: ready.summary,
    }
  if (out.outcome === 'pending')
    return {
      outcome: 'pending',
      txHash: out.txHash,
      explorerUrl: out.explorerUrl,
      summary: ready.summary,
      reason: 'Submitted, not in a ledger yet. Read the vault again in a moment.',
    }
  if (out.contractErrorName) throw new Error(`The vault refused it: ${out.contractErrorName}`)
  if (out.reason) throw new Error(out.reason)
  throw new Error(explainError(sres.status, out.error))
}

/** The progress sentence for a step, so every caller says the same three things. */
export const STEP_LABEL: Record<OwnerActionStep, string> = {
  preparing: 'Preparing',
  signing: 'Waiting for your wallet',
  submitting: 'Submitting',
}
