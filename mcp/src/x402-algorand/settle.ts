/**
 * Settlement for the Algorand x402 rail: local verification first, the
 * facilitator second, our own indexer read last. The order is the point.
 *
 *  1. LOCAL: decode every transaction in the paymentGroup with algosdk and
 *     check the things that decide where money goes - asset id, recipient,
 *     amount, transaction type, and that nothing in the group rekeys an
 *     account or closes one out. A facilitator bug (or a hostile buyer
 *     betting on one) must be caught before anything leaves this process.
 *  2. FACILITATOR: POST /verify then /settle at the configured facilitator,
 *     which signs the fee-payer transaction and submits the atomic group.
 *  3. CONFIRM: read the payment transaction back from an indexer and match
 *     asset, receiver, amount and sender. Only then is anything served or
 *     recorded as a sale. "The facilitator said success" is a claim about
 *     their process; the indexer read is a fact about the ledger.
 *
 * Replay: Algorand itself deduplicates transaction ids inside the validity
 * window, so the same signed group cannot LAND twice. What it cannot prevent
 * is the same header being presented to US twice for two servings of one
 * payment, which is what the durable settlement log guards: a transaction id
 * that already has a settled row is refused, and that check uses the
 * fail-closed loader because it decides whether work is given away.
 */
import algosdk from 'algosdk'
import type { ChainDescriptor, SettlementToken } from '../chains/types.js'
import { txUrl } from '../chains/index.js'
import {
  loadAlgorandSettlementsResult,
  persistAlgorandSettlement,
  type AlgorandSettlementRecord,
} from '../storage.js'
import { confirmAlgorandTransfer, type AlgorandConfirmDeps } from './confirm.js'

export type AlgorandRequirements = {
  /** Registry CAIP-2 id. */
  network: string
  /** The facilitator's spelling of the same network. */
  facilitatorNetwork: string
  /** ASA id, decimal string. */
  asset: string
  payTo: string
  /** Base units required. */
  amount: string
  resource: string
}

export type AlgorandSettleCode =
  | 'malformed_payload'
  | 'unsupported_network'
  | 'unsupported_asset'
  | 'wrong_transaction_type'
  | 'wrong_recipient'
  | 'wrong_amount'
  | 'unsafe_group'
  | 'unsigned_payment'
  | 'already_redeemed'
  | 'replay_guard_unavailable'
  | 'facilitator_rejected'
  | 'facilitator_unreachable'
  | 'not_confirmed'
  | 'unexpected'

export type AlgorandSettleResult =
  | {
      success: true
      transaction: string
      network: string
      payer: string
      amount: string
      amountUsd: number
      round?: number
      explorerUrl?: string
    }
  | { success: false; code: AlgorandSettleCode; errorReason: string; ambiguous?: boolean; transaction?: string }

export type AlgorandSettleDeps = AlgorandConfirmDeps & {
  env?: NodeJS.ProcessEnv
  fetcher?: typeof fetch
  meta?: { tool: string; baseUsd: number }
  persist?: (rec: AlgorandSettlementRecord) => Promise<void>
  loadResult?: typeof loadAlgorandSettlementsResult
}

type DecodedEntry = {
  txn: algosdk.Transaction
  signed: boolean
  raw: string
}

/** Decode one base64 msgpack entry, signed or unsigned. Returns null if neither decodes. */
function decodeEntry(b64: string): DecodedEntry | null {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
  try {
    const s = algosdk.decodeSignedTransaction(bytes)
    return { txn: s.txn, signed: true, raw: b64 }
  } catch {
    /* fall through to unsigned */
  }
  try {
    return { txn: algosdk.decodeUnsignedTransaction(bytes), signed: false, raw: b64 }
  } catch {
    return null
  }
}

const b64 = (u?: Uint8Array) => (u && u.length ? Buffer.from(u).toString('base64') : null)

/**
 * The local checks: everything about this group we can decide without the
 * network. Returns the payment transaction's decoded form on success.
 */
export function verifyAlgorandGroup(
  payload: unknown,
  requirements: AlgorandRequirements,
):
  | { ok: true; payment: DecodedEntry; txId: string; payer: string; amount: bigint; group: DecodedEntry[] }
  | { ok: false; code: AlgorandSettleCode; reason: string } {
  const outer = payload as Record<string, unknown> | null
  const inner = (outer?.payload ?? null) as Record<string, unknown> | null
  const groupB64 = inner?.paymentGroup
  const paymentIndex = Number(inner?.paymentIndex ?? NaN)
  if (!Array.isArray(groupB64) || groupB64.length < 1 || groupB64.length > 16) {
    return { ok: false, code: 'malformed_payload', reason: 'payload.paymentGroup must be an array of 1 to 16 base64 transactions' }
  }
  if (!Number.isInteger(paymentIndex) || paymentIndex < 0 || paymentIndex >= groupB64.length) {
    return { ok: false, code: 'malformed_payload', reason: 'payload.paymentIndex does not point inside paymentGroup' }
  }
  const entries: DecodedEntry[] = []
  for (const item of groupB64) {
    const e = typeof item === 'string' ? decodeEntry(item) : null
    if (!e) return { ok: false, code: 'malformed_payload', reason: 'a paymentGroup entry is not a decodable Algorand transaction' }
    entries.push(e)
  }
  // Group-id consistency: with more than one transaction, every entry must
  // carry the SAME non-empty group id, or the "group" is not actually atomic.
  if (entries.length > 1) {
    const gids = entries.map((e) => b64(e.txn.group ?? undefined))
    if (gids.some((g) => !g) || new Set(gids).size !== 1) {
      return { ok: false, code: 'unsafe_group', reason: 'transactions do not share one atomic group id' }
    }
  }
  // Nothing in the group may rekey an account, close one out, or register
  // keys. Any of those inside an "innocent payment group" is an attack.
  for (const e of entries) {
    if (e.txn.rekeyTo) return { ok: false, code: 'unsafe_group', reason: 'a group transaction rekeys an account' }
    if (e.txn.type === algosdk.TransactionType.keyreg) {
      return { ok: false, code: 'unsafe_group', reason: 'a group transaction is a key registration' }
    }
    if (e.txn.payment?.closeRemainderTo) {
      return { ok: false, code: 'unsafe_group', reason: 'a group transaction closes an account out' }
    }
    if (e.txn.assetTransfer?.closeRemainderTo) {
      return { ok: false, code: 'unsafe_group', reason: 'a group transaction closes an asset position out' }
    }
  }
  const payment = entries[paymentIndex]
  if (!payment.signed) {
    return { ok: false, code: 'unsigned_payment', reason: 'the transaction at paymentIndex is not signed by the buyer' }
  }
  if (payment.txn.type !== algosdk.TransactionType.axfer || !payment.txn.assetTransfer) {
    return { ok: false, code: 'wrong_transaction_type', reason: 'the payment transaction is not an ASA transfer' }
  }
  const at = payment.txn.assetTransfer
  if (String(at.assetIndex) !== requirements.asset) {
    return { ok: false, code: 'unsupported_asset', reason: `the transfer moves ASA ${at.assetIndex}, not ${requirements.asset}` }
  }
  if (at.receiver.toString() !== requirements.payTo) {
    return { ok: false, code: 'wrong_recipient', reason: 'the transfer does not pay the payTo this challenge named' }
  }
  const amount = BigInt(at.amount)
  if (amount < BigInt(requirements.amount)) {
    return { ok: false, code: 'wrong_amount', reason: `the transfer moves ${amount} base units; the price is ${requirements.amount}` }
  }
  return {
    ok: true,
    payment,
    txId: payment.txn.txID(),
    payer: payment.txn.sender.toString(),
    amount,
    group: entries,
  }
}

async function facilitatorCall(
  facilitator: string,
  path: '/verify' | '/settle',
  body: unknown,
  fetcher: typeof fetch,
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; reason: string }> {
  try {
    const res = await fetcher(`${facilitator.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!json) return { ok: false, reason: `facilitator ${path} answered HTTP ${res.status} with a non-JSON body` }
    return { ok: true, json }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function settleAlgorandPayment(args: {
  chain: ChainDescriptor
  token: SettlementToken
  requirements: AlgorandRequirements
  payload: unknown
  facilitator: string
  deps?: AlgorandSettleDeps
}): Promise<AlgorandSettleResult> {
  const { chain, token, requirements, payload, facilitator } = args
  const deps = args.deps ?? {}
  const fetcher = deps.fetcher ?? fetch
  const persist = deps.persist ?? persistAlgorandSettlement
  const loadResult = deps.loadResult ?? loadAlgorandSettlementsResult

  // Network agreement, accepting either spelling of the same chain.
  const paidNetwork = String((payload as Record<string, unknown> | null)?.network ?? '').trim()
  if (paidNetwork && paidNetwork !== requirements.network && paidNetwork !== requirements.facilitatorNetwork) {
    return { success: false, code: 'unsupported_network', errorReason: `the payment names network '${paidNetwork}'; this challenge settles on ${requirements.network}` }
  }

  const verified = verifyAlgorandGroup(payload, requirements)
  if (!verified.ok) return { success: false, code: verified.code, errorReason: verified.reason }

  // Replay guard BEFORE any external call, fail-closed: deciding whether to
  // give work away on an unreadable log is how a sale gets served twice.
  const log = await loadResult()
  if (!log.ok) {
    return { success: false, code: 'replay_guard_unavailable', errorReason: 'the settlement log is unreadable, and serving without the replay guard is not on the menu' }
  }
  if (log.rows.some((r) => r.tx === verified.txId && r.outcome === 'settled')) {
    return { success: false, code: 'already_redeemed', errorReason: `transaction ${verified.txId} already paid for a serving` }
  }

  const facilitatorBody = {
    paymentPayload: payload,
    paymentRequirements: {
      scheme: 'exact',
      network: requirements.facilitatorNetwork,
      amount: requirements.amount,
      maxAmountRequired: requirements.amount,
      asset: requirements.asset,
      payTo: requirements.payTo,
      maxTimeoutSeconds: 120,
      resource: requirements.resource,
      extra: { decimals: token.decimals },
    },
  }

  const verifyRes = await facilitatorCall(facilitator, '/verify', facilitatorBody, fetcher)
  if (!verifyRes.ok) return { success: false, code: 'facilitator_unreachable', errorReason: verifyRes.reason }
  if (verifyRes.json.isValid !== true) {
    return {
      success: false,
      code: 'facilitator_rejected',
      errorReason: String(verifyRes.json.invalidReason ?? 'the facilitator rejected the payment without a reason'),
    }
  }

  const settleRes = await facilitatorCall(facilitator, '/settle', facilitatorBody, fetcher)
  if (!settleRes.ok) {
    // The group may or may not have been submitted; nothing is recorded as a
    // sale, and the ambiguity is stated rather than resolved by optimism.
    return { success: false, code: 'facilitator_unreachable', errorReason: settleRes.reason, ambiguous: true, transaction: verified.txId }
  }
  if (settleRes.json.success !== true) {
    return {
      success: false,
      code: 'facilitator_rejected',
      errorReason: String(settleRes.json.errorReason ?? 'the facilitator could not settle the group'),
    }
  }
  const reportedTx = String(settleRes.json.transaction ?? verified.txId)

  // OUR read of the ledger. The facilitator's success is not the record.
  const confirmed = await confirmAlgorandTransfer(chain, {
    txId: reportedTx,
    asset: requirements.asset,
    payTo: requirements.payTo,
    minAmount: BigInt(requirements.amount),
    payer: verified.payer,
  }, deps)
  const amountUsd = Number(verified.amount) / 10 ** token.decimals
  if (!confirmed.ok) {
    await persist({
      ts: new Date().toISOString(),
      outcome: 'ambiguous',
      tool: deps.meta?.tool ?? 'unknown',
      resource: requirements.resource,
      network: requirements.network,
      asset: requirements.asset,
      assetSymbol: token.symbol,
      assetDecimals: token.decimals,
      value: verified.amount.toString(),
      amountUsd,
      baseUsd: deps.meta?.baseUsd ?? amountUsd,
      payer: verified.payer,
      payTo: requirements.payTo,
      tx: reportedTx,
      facilitator,
      confirmedBy: 'none',
    })
    return { success: false, code: 'not_confirmed', errorReason: confirmed.reason, ambiguous: true, transaction: reportedTx }
  }

  const record: AlgorandSettlementRecord = {
    ts: new Date().toISOString(),
    outcome: 'settled',
    tool: deps.meta?.tool ?? 'unknown',
    resource: requirements.resource,
    network: requirements.network,
    asset: requirements.asset,
    assetSymbol: token.symbol,
    assetDecimals: token.decimals,
    value: verified.amount.toString(),
    amountUsd,
    baseUsd: deps.meta?.baseUsd ?? amountUsd,
    payer: verified.payer,
    payTo: requirements.payTo,
    tx: confirmed.txId,
    round: confirmed.round,
    explorerUrl: txUrl(chain, confirmed.txId),
    facilitator,
    confirmedBy: 'algod-indexer',
  }
  await persist(record)
  return {
    success: true,
    transaction: confirmed.txId,
    network: requirements.network,
    payer: verified.payer,
    amount: verified.amount.toString(),
    amountUsd,
    round: confirmed.round,
    explorerUrl: record.explorerUrl,
  }
}
