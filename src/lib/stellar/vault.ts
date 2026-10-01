/**
 * Owner-signed writes to a Stellar (Soroban) policy vault.
 *
 * Three steps, always in this order: the backend PREPARES the exact call and simulates it,
 * the owner's wallet SIGNS the envelope, the backend SUBMITS it and reads the receipt back.
 * The owner's account is the transaction's source, so it pays the fee and its signature on
 * the whole envelope is the authorization: there is no separate auth entry, and nothing the
 * backend holds can produce one. Nothing is reported as settled without a transaction hash
 * from a ledger.
 *
 * Prepare and sign are separate calls on purpose. A withdrawal shows a review screen
 * between them (amount, destination, the fee the prepare quoted), and only the Confirm on
 * that screen asks the wallet for a signature.
 *
 * Every failure is an OwnerActionError carrying a typed VaultFailure, so a screen can pick
 * a specific message and a next step for it instead of printing whatever text came back.
 * A wallet's own message is never swallowed: kits reject with plain { code, message }
 * objects rather than Errors, so the message is read off whatever was thrown.
 */
import { apiFetch, readJson } from '../api'
import { authHeaders } from '../../store/auth'
import { getSigner } from '../../store/wallets'
import { shortAddress } from '../wallet/types'
import { readWalletNetwork, signStellarTransaction, stellarNetworkLabel, stellarPassphraseFor } from './kit'

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
  /** The network the transaction went to, CAIP-2. */
  network?: string
}

/**
 * Every way an owner action can stop, by name. The backend's codes (from the prepare and
 * submit endpoints) and the ones only the browser can see (no wallet, a rejected prompt, a
 * wallet that will not say which network it is on) share one list so one component can
 * explain all of them.
 */
export type FailureCode =
  | 'no_wallet'
  | 'no_signer'
  | 'wallet_network_unknown'
  | 'wrong_network'
  | 'not_owner'
  | 'no_session'
  | 'rejected'
  | 'insufficient_xlm'
  | 'no_trustline'
  | 'refused'
  | 'restore_needed'
  | 'pending'
  | 'not_accepted'
  | 'failed'
  | 'bad_request'
  | 'unknown_vault'
  | 'unreachable'
  | 'wallet_error'

export type VaultFailure = {
  code: FailureCode
  /** The most specific sentence available: the backend's reason, or one of ours. */
  message: string
  /** refused: the contract's typed error, by name and number. */
  errorName?: string
  errorCode?: number
  /** insufficient_xlm: what the source account has free, and what the call needs. */
  availableXlm?: string
  neededXlm?: string
  /** no_trustline: who lacks the trustline, and for which asset (CODE:ISSUER). */
  destination?: string
  asset?: string
  /** failed: the network's result code, e.g. txBadSeq. */
  resultCode?: string
  /** pending / not_accepted: the transaction hash. */
  hash?: string
  /** wrong_network: what the wallet said and what the vault needs. */
  walletNetwork?: string | null
  targetNetwork?: string
  /** not_owner: who owns it and who is connected. */
  owner?: string
  connected?: string
}

export class OwnerActionError extends Error {
  failure: VaultFailure
  constructor(failure: VaultFailure) {
    super(failure.message)
    this.name = 'OwnerActionError'
    this.failure = failure
  }
}

/** The failure inside anything a flow threw. */
export function failureOf(e: unknown): VaultFailure {
  if (e instanceof OwnerActionError) return e.failure
  if (isWalletRejection(e))
    return { code: 'rejected', message: walletErrorMessage(e) || 'The request was rejected in the wallet.' }
  return { code: 'wallet_error', message: walletErrorMessage(e) || 'That did not go through.' }
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

/**
 * Whether a wallet error is the person saying no. Freighter rejects with code -4 and
 * "The user rejected this request."; other kit modules use their own words, so the
 * message is matched as well.
 */
export function isWalletRejection(e: unknown): boolean {
  if (e && typeof e === 'object' && 'code' in e && (e as { code: unknown }).code === -4) return true
  return /reject|declin|denied|cancel|dismiss/i.test(walletErrorMessage(e))
}

type PrepareOk = {
  ok: true
  xdr: string
  networkPassphrase?: string
  network?: string
  caip2?: string
  contract?: string
  action?: string
  summary?: string
  /** Null in the ordinary case: an owner who is the transaction source signs with source-account
   *  credentials, so there is no separate signature-expiry ledger. `validUntil` governs. */
  expiresAtLedger?: number | null
  validUntil?: string
  feeStroops?: string | number
  feeXlm?: string
  restoreNeeded?: boolean
  note?: string
}

/** Any non-2xx body from prepare or submit. Old and new field names are both read, so a
 *  backend one deploy behind still produces a specific message. */
type FailBody = {
  ok?: boolean
  code?: string
  reason?: string
  error?: string
  errorName?: string
  errorCode?: number
  contractErrorName?: string
  contractErrorCode?: number
  availableXlm?: string
  neededXlm?: string
  destination?: string
  asset?: string
  resultCode?: string
  hash?: string
  txHash?: string
  outcome?: string
  status?: string
}

type SubmitBody = FailBody & {
  outcome?: 'settled' | 'pending' | 'refused' | 'failed' | 'prepared'
  status?: string
  txHash?: string
  hash?: string
  ledger?: number
  explorerUrl?: string
}

const KNOWN_CODES: ReadonlySet<string> = new Set<FailureCode>([
  'bad_request',
  'unknown_vault',
  'not_owner',
  'wrong_network',
  'insufficient_xlm',
  'no_trustline',
  'refused',
  'restore_needed',
  'pending',
  'not_accepted',
  'failed',
])

/** A backend refusal as a typed failure. */
function failureFromBody(status: number, body: FailBody, network: string): VaultFailure {
  const reason = body.reason || body.error || ''
  // 401 is no session at all; a 403 with no code of ours is the gate in http.ts refusing a
  // guest (browse-only) session. Both are fixed the same way: sign in with the wallet.
  if (status === 401 || (status === 403 && !body.code))
    return { code: 'no_session', message: 'Owner actions are prepared by our backend, and it needs a signed-in session for this wallet first.' }
  const raw = body.code ?? (body.outcome === 'refused' ? 'refused' : body.outcome === 'failed' ? 'failed' : undefined)
  const code: FailureCode = raw && KNOWN_CODES.has(raw) ? (raw as FailureCode) : status >= 500 ? 'unreachable' : 'failed'
  const f: VaultFailure = { code, message: reason || defaultMessage(code, status) }
  const errorName = body.errorName ?? body.contractErrorName
  const errorCode = body.errorCode ?? body.contractErrorCode
  if (errorName) f.errorName = errorName
  if (typeof errorCode === 'number') f.errorCode = errorCode
  if (body.availableXlm) f.availableXlm = body.availableXlm
  if (body.neededXlm) f.neededXlm = body.neededXlm
  if (body.destination) f.destination = body.destination
  if (body.asset) f.asset = body.asset
  if (body.resultCode) f.resultCode = body.resultCode
  const hash = body.hash ?? body.txHash
  if (hash) f.hash = hash
  if (code === 'wrong_network') f.targetNetwork = network
  return f
}

function defaultMessage(code: FailureCode, status: number): string {
  if (code === 'unreachable') return 'The backend is waking up or briefly unavailable (free tier).'
  return `The request was refused (HTTP ${status}).`
}

/** "0.0012345" XLM from stroops, trailing zeros trimmed. */
function stroopsToXlm(stroops: string | number | undefined): string | null {
  if (stroops === undefined || stroops === null || stroops === '') return null
  try {
    const n = BigInt(String(stroops))
    const whole = n / 10_000_000n
    const frac = (n % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '')
    return frac ? `${whole}.${frac}` : whole.toString()
  } catch {
    return null
  }
}

/**
 * Everything that must be true in the browser before a signature is asked for: a wallet
 * connected in this tab, showing the owner account, on the vault's network, and able to SAY
 * which network it is on. A wallet that cannot report its network is refused rather than
 * trusted, because the one mistake this must never make is a testnet envelope signed on
 * pubnet or the reverse.
 */
async function walletPreflight(input: { network: string; source: string }) {
  const signer = getSigner('stellar')
  if (!signer)
    throw new OwnerActionError({
      code: 'no_signer',
      message: 'No Stellar wallet is connected in this tab.',
    })
  if (signer.address !== input.source)
    throw new OwnerActionError({
      code: 'not_owner',
      message: `This vault's owner is ${shortAddress(input.source)} and the wallet connected here is ${shortAddress(signer.address)}.`,
      owner: input.source,
      connected: signer.address,
    })
  const reading = await readWalletNetwork()
  if (!reading.reported)
    throw new OwnerActionError({
      code: 'wallet_network_unknown',
      message:
        'This wallet does not report which network it is on, so we cannot confirm it is on testnet. Use Freighter, or a wallet that reports its network.',
    })
  if (reading.network !== input.network)
    throw new OwnerActionError({
      code: 'wrong_network',
      message: `${signer.walletName || 'Your wallet'} is on ${reading.network ? stellarNetworkLabel(reading.network) : 'a network that is neither testnet nor pubnet'}; this vault is on ${stellarNetworkLabel(input.network)}.`,
      walletNetwork: reading.network,
      targetNetwork: input.network,
    })
  return signer
}

/** A prepared, unsigned owner call, with what the review screen needs to restate. */
export type PreparedOwnerAction = {
  input: OwnerActionInput
  xdr: string
  networkPassphrase: string
  summary?: string
  /** The fee the source account will pay, in XLM; null when the backend did not say. */
  feeXlm: string | null
  /** True when the simulation found archived state, so the call carries a restore. */
  restoreNeeded: boolean
  /** When the envelope's time bound runs out, ISO. */
  validUntil?: string
  preparedAt: number
}

/** Step one: check the wallet, then have the backend build and simulate the exact call. */
export async function prepareOwnerAction(input: OwnerActionInput): Promise<PreparedOwnerAction> {
  await walletPreflight(input)
  input.onStep?.('preparing')
  let pres: Response
  try {
    pres = await apiFetch('/api/stellar/vault/prepare', {
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
  } catch {
    throw new OwnerActionError({ code: 'unreachable', message: 'The backend did not answer the prepare request. Nothing was signed.' })
  }
  const prep = await readJson<PrepareOk | FailBody>(pres)
  if (!pres.ok || (prep as PrepareOk).ok !== true) throw new OwnerActionError(failureFromBody(pres.status, prep as FailBody, input.network))
  const ready = prep as PrepareOk
  if (!ready.xdr) throw new OwnerActionError({ code: 'failed', message: 'The server prepared no transaction to sign.' })
  const passphrase = ready.networkPassphrase ?? stellarPassphraseFor(input.network)
  if (!passphrase || passphrase !== stellarPassphraseFor(input.network))
    throw new OwnerActionError({
      code: 'wrong_network',
      message: `The prepared transaction is not for ${stellarNetworkLabel(input.network)}, so nothing was sent to the wallet.`,
      targetNetwork: input.network,
    })
  return {
    input,
    xdr: ready.xdr,
    networkPassphrase: passphrase,
    summary: ready.summary,
    feeXlm: ready.feeXlm ?? stroopsToXlm(ready.feeStroops),
    restoreNeeded: ready.restoreNeeded === true,
    validUntil: ready.validUntil,
    preparedAt: Date.now(),
  }
}

/** True when a prepared envelope's time bound has passed or is about to. */
export function preparedExpired(p: PreparedOwnerAction, marginMs = 15_000): boolean {
  if (!p.validUntil) return false
  const t = Date.parse(p.validUntil)
  return Number.isFinite(t) && t - marginMs <= Date.now()
}

/**
 * Step two: the wallet signs the whole envelope, the backend broadcasts it. The wallet and
 * its network are checked again first, because a review screen can sit open while the
 * person switches accounts or networks in the extension.
 */
export async function signAndSubmit(
  prepared: PreparedOwnerAction,
  onStep?: (step: OwnerActionStep) => void,
): Promise<OwnerActionResult> {
  const { input } = prepared
  const signer = await walletPreflight(input)

  onStep?.('signing')
  let signed: string
  try {
    signed = signer.signTransaction
      ? await signer.signTransaction(prepared.xdr, { networkPassphrase: prepared.networkPassphrase })
      : await signStellarTransaction(prepared.xdr, { networkPassphrase: prepared.networkPassphrase, address: signer.address })
  } catch (e) {
    if (isWalletRejection(e))
      throw new OwnerActionError({ code: 'rejected', message: walletErrorMessage(e) || 'The request was rejected in the wallet.' })
    throw new OwnerActionError({ code: 'wallet_error', message: walletErrorMessage(e) || 'The wallet returned no signature.' })
  }

  onStep?.('submitting')
  let sres: Response
  try {
    sres = await apiFetch('/api/stellar/vault/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ network: input.network, xdr: signed }),
      timeoutMs: 90_000,
    })
  } catch {
    // The request may or may not have reached the network. Saying "failed" here could
    // make someone sign a second payment for one that already landed.
    throw new OwnerActionError({
      code: 'unreachable',
      message: 'The submit request did not come back, so we cannot tell whether the transaction was broadcast. Read the vault again before you retry.',
    })
  }
  const out = await readJson<SubmitBody>(sres)
  const state = out.outcome ?? out.status
  const hash = out.txHash ?? out.hash

  if (sres.ok && state === 'settled')
    return { outcome: 'settled', txHash: hash, ledger: out.ledger, explorerUrl: out.explorerUrl, summary: prepared.summary, network: input.network }
  if (sres.status === 202 || state === 'pending' || out.code === 'pending')
    return {
      outcome: 'pending',
      txHash: hash,
      explorerUrl: out.explorerUrl,
      summary: prepared.summary,
      reason: 'Submitted, not in a ledger yet.',
      network: input.network,
    }
  throw new OwnerActionError(failureFromBody(sres.status, out, input.network))
}

/** Prepare, sign, submit in one go, for the one-click actions (freeze, unfreeze). */
export async function ownerAction(input: OwnerActionInput): Promise<OwnerActionResult> {
  const prepared = await prepareOwnerAction(input)
  return signAndSubmit(prepared, input.onStep)
}

/** The progress sentence for a step, so every caller says the same three things. */
export const STEP_LABEL: Record<OwnerActionStep, string> = {
  preparing: 'Preparing',
  signing: 'Waiting for your wallet',
  submitting: 'Submitting',
}
