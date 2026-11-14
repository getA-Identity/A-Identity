/**
 * x402 `exact` on near:testnet, sold at GET /api/near/x402/check.
 *
 * What is sold: the verdict GET /api/near/check gives for free, from the same engine, as the same
 * JSON, plus a `payment` object and a `labels.settlement` line that say how this copy was paid
 * for. The free route stays free; this one exists so an agent can pay for a NEAR answer over
 * x402 on NEAR itself, and so the payment can be checked on chain by anyone.
 *
 * The scheme is x402-foundation/x402's
 * (https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_near.md), v2 only:
 * the 402 names Circle's testnet USDC on near:testnet, an exact amount and payTo; the buyer signs
 * a NEP-366 SignedDelegate holding exactly one ft_transfer with 1 yoctoNEAR attached, with a
 * FULL-ACCESS key (nearcore refuses any deposit under a function-call key in a delegate), and
 * sends it base64 in PAYMENT-SIGNATURE. The facilitator is this process: @x402/near 2.18.0's own
 * verification logic (ExactNearScheme.verify) runs here against this backend's NEAR reads, and
 * our relayer puts the delegate on chain (relay.ts).
 *
 * The rules, the x402-3009 engine's, applied to NEAR:
 *
 *  - No relayer, no challenge. Without NEAR_X402_RELAYER_ACCOUNT and NEAR_X402_RELAYER_KEY the
 *    route answers 503 "rail off" and serves no 402. With them, a 402 is served only once the
 *    rail can settle: the host is on testnet, the asset is the registry's Circle USDC with the
 *    metadata the registry documents, payTo holds a storage registration on it (else every
 *    transfer would fail), and the relayer exists, holds gas money and holds the configured key
 *    as a full-access key. Anything else is 503 with the reason, and no challenge.
 *  - A request that cannot be answered is never charged. The verdict is computed before the
 *    payment is verified and broadcast; a refused account is 400 before any of it.
 *  - Refused before broadcast: a payment for another network, asset, payTo, amount or scheme
 *    (checked against requirements built here, never taken from the buyer), and anything
 *    @x402/near's verify refuses (signature, one ft_transfer, deposit, gas, window, nonce,
 *    full-access key, balance, payTo storage).
 *  - The transaction hash is computed and recorded before the send (relay.ts).
 *  - Nothing counts as paid without proof.ts: the FINAL outcome must show the token's own
 *    ft_transfer receipt succeeding with a nep141 event from the payer to payTo for exactly the
 *    amount. Only then is the verdict served, with the transaction in PAYMENT-RESPONSE.
 *  - Replay: one signed delegate pays for one answer. Its key (payer, delegate key, nonce) is
 *    checked against the payments in hand and against the durable spent set the x402 rails share
 *    (storage.ts spent_payments, its own `near:testnet/...` namespace), and written there once
 *    proven. Under both sits the chain: a delegate nonce executes at most once.
 *  - A payment that settled and was not delivered (the answer never reached the socket) stays
 *    redeemable by the same request; one sent for a different request is 409. A broadcast with no
 *    FINAL answer yet is 502 with its hash: the same payment sent again is looked up by that hash,
 *    nothing new is broadcast, and the answer is served if the transaction proves the payment.
 *
 * One limit, stated: the payments in hand live in this process. A restart between a broadcast
 * and its FINAL answer forgets that broadcast; a retry is then refused (the delegate's nonce is
 * spent on chain if it landed) rather than served, and the transaction stays readable by the hash
 * the server logged when it sent it.
 */
import { createHash } from 'node:crypto'
import { PublicKey } from '@near-js/crypto'
import { decodeSignedDelegateB64, fromBase64 } from '@x402/near'
import { ExactNearScheme } from '@x402/near/exact/facilitator'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import { getChainById } from '../chains/registry.js'
import { txUrl } from '../chains/explorer.js'
import type { ChainDescriptor } from '../chains/types.js'
import { nearStatus, nearViewAccessKey, nearViewAccount, nearViewFunction } from '../chains/near/client.js'
import { nearCheck, nearCheckTarget, type NearCheckAnswer, type NearCheckResult } from '../near-check/check.js'
import { loadSpentPayments, persistSpentPayment } from '../storage.js'
import { proveNearPayment, type NearPaymentProof } from './proof.js'
import { lookupFinal, nearVerifyReads, relayerFromEnv, relaySignedDelegate, type NearRelayer, type NearTxResult, type RelayDeps } from './relay.js'

export const NEAR_X402_PATH = '/api/near/x402/check'
/** The registry id of the one network this rail settles on. */
export const NEAR_X402_CHAIN = 'near-testnet'
export const NEAR_X402_NETWORK = 'near:testnet'
/** Who is paid: A-Identity's testnet account, registered for storage on the token. */
export const NEAR_X402_PAY_TO = 'a-identity.testnet'
/** One cent of test USDC. A testnet price: a mainnet price is the founders' decision. */
export const NEAR_X402_PRICE_USD = '0.01'
/** The spec's 1-block-per-second mapping makes this a 120-block delegate window (about 75 s on testnet). */
export const NEAR_X402_MAX_TIMEOUT_SECONDS = 120
/** The relayer must hold at least this much before a challenge is served: 0.05 NEAR, against a
 *  settlement that burns about 0.0004 NEAR and prepays about 0.0034 (refunded). */
export const NEAR_X402_MIN_RELAYER_YOCTO = 50_000_000_000_000_000_000_000n

const READY_TTL_MS = 5 * 60_000
const NOT_READY_TTL_MS = 30_000
const MAX_RECORDS = 2_000
/** A 200 handed to a socket holds the payment this long before a retry may take it again. */
const CLAIM_LEASE_MS = 60_000
/** How long a proven payment that was never delivered can still be redeemed by its request. */
const REDEEM_WINDOW_MS = 24 * 3_600_000
/** How long a retry of an unresolved broadcast reads its hash before answering. */
const RETRY_LOOKUP_MS = 8_000

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export type NearX402Deps = RelayDeps & {
  /** The verdict. Production: nearCheck, the engine behind GET /api/near/check. */
  check?: (account: string, vault: string | null) => Promise<NearCheckResult>
  loadSpent?: () => Promise<string[]>
  persistSpent?: (key: string) => Promise<void>
  /** Where operator lines go (production: stderr). Never handed a key. */
  log?: (line: string) => void
  clock?: () => Date
}

export type NearX402Answer = {
  httpStatus: number
  body: Record<string, unknown>
  headers?: Record<string, string>
  /** True for a 402: the route sends it with PAYMENT-REQUIRED. */
  challenge?: boolean
  /** Present on a 200. Call it once it is known whether the response reached the socket. */
  onDelivery?: (delivered: boolean) => void
}

// -- the asset, the price, the requirements -----------------------------------------------------

/** Circle's testnet USDC, from the registry (documentedTokens): never usdc.testnet, a lookalike. */
export function nearX402Asset(chain: ChainDescriptor): { address: string; decimals: number } | null {
  const t = (chain.documentedTokens ?? []).find((x) => x.symbol === 'USDC' && x.issuer === 'Circle')
  return t ? { address: t.address, decimals: t.decimals } : null
}

/** 0.01 of a token with `decimals` decimals, in atomic units: 10000 for USDC's 6. */
export function nearX402Amount(decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 2) throw new Error('a cent needs at least 2 decimals')
  return (10n ** BigInt(decimals - 2)).toString()
}

type Ready = { ok: true; asset: string; decimals: number; amount: string; payTo: string } | { ok: false; reason: string }

/** The one requirements object this rail verifies against, built here and never from the buyer. */
export function nearX402Requirements(r: Extract<Ready, { ok: true }>): PaymentRequirements {
  return {
    scheme: 'exact',
    network: NEAR_X402_NETWORK,
    asset: r.asset,
    amount: r.amount,
    payTo: r.payTo,
    maxTimeoutSeconds: NEAR_X402_MAX_TIMEOUT_SECONDS,
    // The spec defines no NEAR `extra`, and FastNEAR's facilitator refuses an assetTransferMethod.
    extra: {},
  }
}

// -- can the rail settle right now? -------------------------------------------------------------

const readyCache = new Map<string, { at: number; value: Ready }>()

async function readyNow(chain: ChainDescriptor, relayer: NearRelayer, deps: NearX402Deps): Promise<Ready> {
  const env = deps.env ?? process.env
  const token = nearX402Asset(chain)
  if (!token) return { ok: false, reason: `the registry documents no Circle USDC on ${chain.id}` }
  // Throws when a host (an env override included) answers for a network other than testnet.
  await nearStatus(chain, env, deps)
  const [code, meta, storage, account, key] = await Promise.all([
    nearViewAccount(chain, token.address, env, deps),
    nearViewFunction(chain, token.address, 'ft_metadata', {}, env, deps),
    nearViewFunction(chain, token.address, 'storage_balance_of', { account_id: NEAR_X402_PAY_TO }, env, deps),
    nearViewAccount(chain, relayer.accountId, env, deps),
    nearViewAccessKey(chain, relayer.accountId, relayer.publicKey, env, deps),
  ])
  if (!code.exists || !code.hasContract) return { ok: false, reason: `the USDC account ${token.address} carries no contract` }
  const m = (meta.ok ? meta.value : null) as { spec?: unknown; symbol?: unknown; decimals?: unknown } | null
  if (!m || m.spec !== 'ft-1.0.0' || m.symbol !== 'USDC' || m.decimals !== token.decimals) {
    return { ok: false, reason: `the token at ${token.address} does not report the NEP-141 metadata the registry documents (ft-1.0.0, USDC, ${token.decimals} decimals)` }
  }
  if (!storage.ok) return { ok: false, reason: `storage_balance_of(${NEAR_X402_PAY_TO}) could not be read: ${storage.reason}` }
  if (storage.value == null) return { ok: false, reason: `${NEAR_X402_PAY_TO} holds no storage registration on the token (NEP-145), so a transfer to it would fail` }
  if (!account.exists) return { ok: false, reason: `the relayer account ${relayer.accountId} does not exist on NEAR testnet` }
  if (BigInt(account.amountYocto) < NEAR_X402_MIN_RELAYER_YOCTO) return { ok: false, reason: `the relayer ${relayer.accountId} holds less than 0.05 NEAR, too little to pay for settlements` }
  if (!key.exists || key.permission !== 'FullAccess') {
    return { ok: false, reason: `the configured relayer key (${relayer.publicKey}) is not a full-access key of ${relayer.accountId}` }
  }
  return { ok: true, asset: token.address, decimals: token.decimals, amount: nearX402Amount(token.decimals), payTo: NEAR_X402_PAY_TO }
}

async function railReady(chain: ChainDescriptor, relayer: NearRelayer, deps: NearX402Deps): Promise<Ready> {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const key = `${relayer.accountId}|${relayer.publicKey}|${chain.rpcEnvVar ? (env[chain.rpcEnvVar] ?? '') : ''}`
  const hit = readyCache.get(key)
  if (hit && now() - hit.at < (hit.value.ok ? READY_TTL_MS : NOT_READY_TTL_MS)) return hit.value
  const value: Ready = await readyNow(chain, relayer, deps).catch((e: unknown) => ({ ok: false as const, reason: `NEAR testnet could not be read: ${msg(e)}` }))
  readyCache.set(key, { at: now(), value })
  return value
}

// -- the 402 ------------------------------------------------------------------------------------

const DESCRIPTION =
  "A-Identity's ALLOW, WARN or DENY on a NEAR testnet account: the same verdict and JSON as the free GET /api/near/check, paid over x402 exact on near:testnet."

function resourceOf(account: string, vault: string | null): string {
  return `${NEAR_X402_PATH}?account=${encodeURIComponent(account)}${vault ? `&vault=${encodeURIComponent(vault)}` : ''}`
}

type Refusal = { code: string; reason: string }

function challenge(req: PaymentRequirements, resource: string, relayerId: string, account: string, refusal?: Refusal): NearX402Answer {
  return {
    httpStatus: 402,
    challenge: true,
    body: {
      x402Version: 2,
      error: 'payment required',
      resource: { url: resource, description: DESCRIPTION, mimeType: 'application/json' },
      accepts: [req],
      ...(refusal ? { refused: refusal } : {}),
      notes: {
        network: 'NEAR testnet only: Circle testnet USDC on near:testnet. No mainnet account or money is involved.',
        sells: `The same verdict GET /api/near/check?account=${encodeURIComponent(account)} gives for free, from the same engine, as the same JSON plus a payment object. This route exists to settle a real x402 payment on NEAR testnet before it answers.`,
        sign:
          'One NEP-366 SignedDelegate holding exactly one ft_transfer of `amount` to `payTo` on `asset`, with 1 yoctoNEAR attached and max_block_height at most maxTimeoutSeconds blocks past the final block, signed with a full-access key of the paying account (a function-call key cannot attach the yoctoNEAR). ' +
          'Send it in the PAYMENT-SIGNATURE header as base64 of the x402 v2 payment payload { x402Version: 2, accepted: <the entry above>, payload: { signedDelegateAction: <base64 Borsh> } }.',
        relayer: `${relayerId} puts it on chain and pays the gas and the yoctoNEAR. Named here for transparency; it is not part of the requirements.`,
        served_after:
          "Nothing is served until the transaction is FINAL and the token's own ft_transfer receipt succeeded with a nep141 ft_transfer event from the payer to payTo for exactly amount. The PAYMENT-RESPONSE header then names the transaction.",
      },
    },
  }
}

/** PAYMENT-SIGNATURE (x402 v2), else X-PAYMENT (v1's name). node:http lower-cases header names. */
export function nearX402PaymentHeader(headers: Record<string, string | string[] | undefined>): string {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
  return (one(headers['payment-signature']) || one(headers['x-payment'])).trim()
}

function parsePayment(header: string): PaymentPayload | null {
  try {
    const p = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as unknown
    if (!p || typeof p !== 'object') return null
    const o = p as Record<string, unknown>
    if (!o.accepted || typeof o.accepted !== 'object' || !o.payload || typeof o.payload !== 'object') return null
    return o as unknown as PaymentPayload
  } catch {
    return null
  }
}

/** Refused before any read: what the buyer accepted must be exactly what this resource asks for. */
function acceptedMismatch(p: PaymentPayload, req: PaymentRequirements): Refusal | null {
  if (p.x402Version !== 2) return { code: 'unsupported_version', reason: 'this rail speaks x402 v2 only' }
  const a = p.accepted as unknown as Record<string, unknown>
  const fields: [keyof PaymentRequirements, string][] = [
    ['scheme', 'unsupported_scheme'],
    ['network', 'wrong_network'],
    ['asset', 'wrong_asset'],
    ['payTo', 'wrong_recipient'],
    ['amount', 'wrong_amount'],
    ['maxTimeoutSeconds', 'wrong_timeout'],
  ]
  for (const [field, code] of fields) {
    if (a[field] !== req[field]) return { code, reason: `accepted.${field} is ${JSON.stringify(a[field] ?? null)}, and this resource asks for exactly ${JSON.stringify(req[field])}` }
  }
  const sda = (p.payload as Record<string, unknown>).signedDelegateAction
  if (typeof sda !== 'string' || !sda) return { code: 'malformed_payload', reason: 'payload.signedDelegateAction must be a base64 Borsh SignedDelegate (NEP-366)' }
  return null
}

// -- replay ---------------------------------------------------------------------------------------

/**
 * The durable replay key: what nearcore itself makes single-use (the delegate's sender, its key
 * and its nonce), qualified by network and asset. It starts with the CAIP-2 id like the EIP-3009
 * keys, so it shares spent_payments with them without colliding (storage.ts), and it is all
 * lower case, which that table stores. The key is hex, not base58, for that reason.
 */
export function nearPaymentKey(asset: string, payer: string, publicKey: string, nonce: bigint): string {
  const pk = PublicKey.fromString(publicKey)
  const curve = pk.keyType === 0 ? 'ed25519' : 'secp256k1'
  return `${NEAR_X402_NETWORK}/nep141:${asset}/nep366/${payer}/${curve}-${Buffer.from(pk.data).toString('hex')}/${nonce}`
}

const requestHashOf = (account: string, vault: string | null) => createHash('sha256').update(JSON.stringify({ account, vault })).digest('hex')

type PaidRecord = {
  key: string
  requestHash: string
  payer: string
  delegate: { publicKey: string; nonce: bigint }
  state: 'broadcast' | 'settled' | 'served' | 'failed'
  txHash: string
  at: number
  proof?: Extract<NearPaymentProof, { ok: true }>
  settledAt?: string
  claimedAt?: number
  reason?: string
}

/** Payments in hand, by replay key. In this process only: see the header for the limit. */
const records = new Map<string, PaidRecord>()
/** Replay keys being worked on right now, so one payment is never settled or served twice at once. */
const inFlight = new Set<string>()

function remember(rec: PaidRecord): void {
  if (!records.has(rec.key) && records.size >= MAX_RECORDS) {
    const old = [...records.values()].find((r) => r.state !== 'broadcast') ?? records.values().next().value
    if (old) records.delete(old.key)
  }
  records.set(rec.key, rec)
}

/** Forget every payment in hand and every readiness answer. Tests only. */
export function __resetNearX402ForTests(): void {
  records.clear()
  inFlight.clear()
  readyCache.clear()
}

// -- the paid answer ------------------------------------------------------------------------------

type Ctx = {
  chain: ChainDescriptor
  relayer: NearRelayer
  req: PaymentRequirements
  account: string
  vault: string | null
  requestHash: string
  deps: NearX402Deps
  ask: (refusal?: Refusal) => NearX402Answer
  log: (line: string) => void
}

const check = (ctx: Ctx) => (ctx.deps.check ?? ((a: string, v: string | null) => nearCheck(a, { vault: v })))(ctx.account, ctx.vault)

function noVerdict(answer: Exclude<NearCheckResult, NearCheckAnswer>, paidAlready: PaidRecord | null): NearX402Answer {
  return {
    httpStatus: answer.httpStatus,
    ...(answer.httpStatus === 503 ? { headers: { 'Retry-After': '30' } } : {}),
    body: {
      error: answer.error,
      code: answer.code,
      ...(paidAlready
        ? {
            transaction: paidAlready.txHash,
            note: 'Your payment is proven and recorded, and the verdict could not be computed now. Send this same payment again with this same request: the answer is still yours, with no second charge.',
          }
        : {
            charged: false,
            note: 'Nothing was charged: the payment was not broadcast. The same signed payment can be sent again while its delegate window lasts.',
          }),
    },
  }
}

function pending(ctx: Ctx, rec: PaidRecord, reason: string): NearX402Answer {
  ctx.log(`[near-x402] ${rec.txHash} has no FINAL answer yet (${reason}); recorded as unresolved`)
  return {
    httpStatus: 502,
    body: {
      error: 'settlement unresolved',
      code: 'settlement_pending',
      ambiguous: true,
      transaction: rec.txHash,
      explorer: txUrl(ctx.chain, rec.txHash),
      reason,
      note: 'The transaction may still land, and nothing was served. Send this same payment again with this same request: it is read by this hash, nothing new is broadcast while it is unresolved, and the answer is served if the transaction proves the payment.',
    },
  }
}

function paymentResponseHeader(rec: PaidRecord, req: PaymentRequirements): string {
  // Only the fields @x402/core's SettleResponse defines.
  return Buffer.from(JSON.stringify({ success: true, transaction: rec.txHash, network: req.network, payer: rec.payer, amount: req.amount })).toString('base64')
}

function serve(ctx: Ctx, rec: PaidRecord, answer: NearCheckAnswer, reconciled: boolean): NearX402Answer {
  const now = ctx.deps.now ?? Date.now
  const proof = rec.proof!
  const archival = ctx.chain.archivalRpcUrls?.[0] ?? ctx.chain.rpcUrls[0]
  rec.claimedAt = now()
  const body = {
    ...answer,
    labels: {
      ...answer.labels,
      settlement: `paid over x402 on NEAR testnet: ${ctx.req.amount} base units of Circle's testnet USDC (${NEAR_X402_PRICE_USD} USDC) moved from ${rec.payer} to ${ctx.req.payTo} in ${rec.txHash}, proven by the token's own ft_transfer receipt before this answer was served. The verdict is the one GET /api/near/check gives for free.`,
    },
    payment: {
      x402Version: 2,
      scheme: 'exact',
      network: ctx.req.network,
      asset: ctx.req.asset,
      amount: ctx.req.amount,
      price_usd: NEAR_X402_PRICE_USD,
      pay_to: ctx.req.payTo,
      payer: rec.payer,
      relayer: ctx.relayer.accountId,
      transaction: rec.txHash,
      explorer: txUrl(ctx.chain, rec.txHash),
      ft_transfer_receipt: proof.receiptId,
      ft_transfer_block_hash: proof.receiptBlockHash,
      event: proof.eventLog,
      settled_at: rec.settledAt,
      reconciled,
      proven:
        'Read at FINAL: the transaction we signed, one Delegate action from the payer holding one ft_transfer of exactly this amount to pay_to with 1 yoctoNEAR, no failed receipt, and the token contract\'s own receipt ended in SuccessValue with the nep141 ft_transfer event above.',
      recheck: `curl -s ${archival} -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"${rec.txHash}","sender_account_id":"${ctx.relayer.accountId}","wait_until":"NONE"}}'`,
    },
  }
  return {
    httpStatus: 200,
    body,
    headers: { 'PAYMENT-RESPONSE': paymentResponseHeader(rec, ctx.req) },
    onDelivery: (delivered) => {
      // Only a response that reached the socket ends the claim; otherwise the same request can
      // send the same payment again and be served without a second charge.
      if (delivered) rec.state = 'served'
      rec.claimedAt = undefined
    },
  }
}

/** Decide a FINAL outcome. Proven: record it, write the replay key, serve. Not proven: nothing is served. */
async function settleFinal(ctx: Ctx, rec: PaidRecord, result: NearTxResult, answer: NearCheckAnswer | null, reconciled: boolean): Promise<NearX402Answer> {
  const proof = proveNearPayment(result, {
    txHash: rec.txHash,
    relayer: ctx.relayer.accountId,
    payer: rec.payer,
    asset: ctx.req.asset,
    payTo: ctx.req.payTo,
    amount: ctx.req.amount,
    delegate: rec.delegate,
  })
  if (!proof.ok) {
    rec.state = 'failed'
    rec.reason = proof.reason
    ctx.log(`[near-x402] ${rec.txHash} is FINAL and does not prove the payment: ${proof.reason}`)
    return {
      httpStatus: 502,
      body: {
        error: 'payment not proven',
        code: 'not_paid',
        transaction: rec.txHash,
        explorer: txUrl(ctx.chain, rec.txHash),
        reason: proof.reason,
        note: 'The transaction is final and does not prove the payment, so nothing was served and nothing is counted as paid. If its delegate executed, that nonce is spent: sign a new payment.',
      },
    }
  }
  rec.state = 'settled'
  rec.proof = proof
  rec.settledAt = (ctx.deps.clock ?? (() => new Date()))().toISOString()
  ctx.log(`[near-x402] ${rec.txHash} proven: ${proof.event.amount} from ${proof.event.old_owner_id} to ${proof.event.new_owner_id} (receipt ${proof.receiptId})`)
  try {
    await (ctx.deps.persistSpent ?? persistSpentPayment)(rec.key)
  } catch (e) {
    // The money moved and is recorded in hand. A replay stays refused by the chain: the delegate's
    // nonce is spent there.
    ctx.log(`[near-x402] the replay key for ${rec.txHash} could not be written: ${msg(e)}`)
  }
  const verdict = answer ?? (await check(ctx))
  if ('error' in verdict) return noVerdict(verdict, rec)
  return serve(ctx, rec, verdict, reconciled)
}

/** A payment already in hand: serve it once, settle an unresolved one by its hash, or refuse. */
async function fromRecord(ctx: Ctx, rec: PaidRecord): Promise<NearX402Answer> {
  const now = ctx.deps.now ?? Date.now
  if (inFlight.has(rec.key)) {
    return { httpStatus: 409, body: { error: 'payment in flight', code: 'in_flight', transaction: rec.txHash, reason: 'This payment is being settled or delivered right now. Do not sign a new one; send this one again shortly.' } }
  }
  if (rec.state === 'served') return ctx.ask({ code: 'already_redeemed', reason: `this payment already paid for an answer that was delivered (tx ${rec.txHash}); sign a new payment` })
  if (rec.state === 'failed') {
    return ctx.ask({ code: 'not_paid', reason: `this payment's transaction ${rec.txHash} is final and does not prove the transfer (${rec.reason ?? 'no reason recorded'}); nothing is counted as paid. Sign a new payment.` })
  }
  if (rec.requestHash !== ctx.requestHash) {
    return {
      httpStatus: 409,
      body: { error: 'payment made for a different request', code: 'request_mismatch', transaction: rec.txHash, reason: 'This signed payment was sent for another account or vault. It is still redeemable by that request; it does not pay for this one.' },
    }
  }
  if (rec.state === 'settled') {
    if (rec.claimedAt !== undefined && now() - rec.claimedAt < CLAIM_LEASE_MS) {
      return { httpStatus: 409, body: { error: 'payment in flight', code: 'in_flight', transaction: rec.txHash, reason: 'The answer this payment bought is being delivered right now.' } }
    }
    if (now() - rec.at > REDEEM_WINDOW_MS) return ctx.ask({ code: 'already_redeemed', reason: `this payment (tx ${rec.txHash}) is past its redeem window; sign a new payment` })
  }
  inFlight.add(rec.key)
  try {
    if (rec.state === 'settled') {
      const verdict = await check(ctx)
      if ('error' in verdict) return noVerdict(verdict, rec)
      return serve(ctx, rec, verdict, true)
    }
    // broadcast, and no FINAL answer seen yet: read the hash, broadcast nothing.
    const found = await lookupFinal(ctx.chain, rec.txHash, ctx.relayer.accountId, now() + (ctx.deps.lookupMs ?? RETRY_LOOKUP_MS), ctx.deps)
    if (!found) return pending(ctx, rec, 'still no FINAL answer for this transaction')
    return await settleFinal(ctx, rec, found.result, null, true)
  } finally {
    inFlight.delete(rec.key)
  }
}

/**
 * GET /api/near/x402/check: the whole paid path, from "is the rail on" to the 200 with
 * PAYMENT-RESPONSE. Never throws.
 */
export async function nearX402Check(input: { account: string; vault?: string | null; paymentHeader?: string }, deps: NearX402Deps = {}): Promise<NearX402Answer> {
  const env = deps.env ?? process.env
  const log = deps.log ?? ((line: string) => console.error(line))
  const now = deps.now ?? Date.now
  const off = (reason: string): NearX402Answer => ({
    httpStatus: 503,
    headers: { 'Retry-After': '30' },
    body: {
      error: 'rail off',
      code: 'rail_off',
      network: NEAR_X402_NETWORK,
      reason,
      note: 'No payment challenge is served while the rail is off: a challenge nobody can settle would cost the buyer a signature for nothing. The same verdict is free at GET /api/near/check?account=<account>.',
    },
  })
  const configured = relayerFromEnv(env)
  if (!configured.ok) return off(`the NEAR x402 rail is off: ${configured.reason}`)
  const relayer = configured.relayer
  const chain = getChainById(NEAR_X402_CHAIN)
  if (!chain) return off('the chain registry declares no near-testnet')

  const target = nearCheckTarget(input.account)
  if ('error' in target) return { httpStatus: 400, body: { error: target.error, code: target.code } }
  let vault: string | null = null
  if (typeof input.vault === 'string' && input.vault.trim() !== '') {
    const v = nearCheckTarget(input.vault)
    if ('error' in v) return { httpStatus: 400, body: { error: `vault: ${v.error}`, code: v.code } }
    vault = v.account
  }

  const ready = await railReady(chain, relayer, deps)
  if (!ready.ok) {
    return {
      httpStatus: 503,
      headers: { 'Retry-After': '30' },
      body: {
        error: 'rail not ready',
        code: 'not_ready',
        network: NEAR_X402_NETWORK,
        reason: ready.reason,
        note: `No payment challenge is served until the rail can settle. The same verdict is free at GET /api/near/check?account=${encodeURIComponent(target.account)}.`,
      },
    }
  }
  const req = nearX402Requirements(ready)
  const resource = resourceOf(target.account, vault)
  const ctx: Ctx = {
    chain,
    relayer,
    req,
    account: target.account,
    vault,
    requestHash: requestHashOf(target.account, vault),
    deps,
    ask: (refusal) => challenge(req, resource, relayer.accountId, target.account, refusal),
    log,
  }

  const header = (input.paymentHeader ?? '').trim()
  if (!header) return ctx.ask()
  const payload = parsePayment(header)
  if (!payload) return ctx.ask({ code: 'malformed_payload', reason: 'PAYMENT-SIGNATURE is not base64 of an x402 v2 payment payload ({ x402Version, accepted, payload })' })
  const mismatch = acceptedMismatch(payload, req)
  if (mismatch) return ctx.ask(mismatch)
  const signedDelegateAction = (payload.payload as { signedDelegateAction: string }).signedDelegateAction
  let delegate: ReturnType<typeof decodeSignedDelegateB64>['delegate']
  let key: string
  try {
    delegate = decodeSignedDelegateB64(signedDelegateAction).delegate
    key = nearPaymentKey(req.asset, delegate.senderId, delegate.publicKey, delegate.nonce)
  } catch {
    return ctx.ask({ code: 'malformed_payload', reason: 'payload.signedDelegateAction is not a base64 Borsh SignedDelegate (NEP-366)' })
  }

  const earlier = records.get(key)
  if (earlier) return fromRecord(ctx, earlier)
  let spent: string[]
  try {
    spent = await (deps.loadSpent ?? loadSpentPayments)()
  } catch (e) {
    log(`[near-x402] the replay guard could not be read: ${msg(e)}`)
    return {
      httpStatus: 503,
      headers: { 'Retry-After': '30' },
      body: { error: 'replay guard unavailable', code: 'replay_guard_unavailable', charged: false, reason: 'The record of redeemed payments could not be read, so this payment is refused rather than risk serving it twice. Nothing was broadcast.' },
    }
  }
  if (spent.includes(key)) return ctx.ask({ code: 'already_redeemed', reason: 'this signed delegate already paid for an answer here; sign a new payment' })
  if (inFlight.has(key)) {
    return { httpStatus: 409, body: { error: 'payment in flight', code: 'in_flight', reason: 'This payment is being settled right now. Do not sign a new one; send this one again shortly.' } }
  }

  inFlight.add(key)
  const rec: PaidRecord = { key, requestHash: ctx.requestHash, payer: delegate.senderId, delegate: { publicKey: delegate.publicKey, nonce: delegate.nonce }, state: 'broadcast', txHash: '', at: now() }
  try {
    // The answer first, so a request that cannot be answered is never charged.
    const answer = await check(ctx)
    if ('error' in answer) return noVerdict(answer, null)

    // @x402/near's own facilitator verification, in this process, every read fresh at final.
    const verified = await new ExactNearScheme(nearVerifyReads(chain, relayer.accountId, deps)).verify(payload, req)
    if (!verified.isValid) {
      return ctx.ask({ code: verified.invalidReason ?? 'invalid', reason: `@x402/near verify refused the payment: ${verified.invalidReason ?? 'invalid'}${verified.invalidMessage ? ` (${verified.invalidMessage})` : ''}. Nothing was broadcast.` })
    }

    const relayed = await relaySignedDelegate(
      {
        chain,
        relayer,
        payer: delegate.senderId,
        signedDelegate: fromBase64(signedDelegateAction),
        beforeSend: (txHash) => {
          rec.txHash = txHash
          remember(rec)
          log(`[near-x402] broadcasting ${txHash}: ${req.amount} of ${req.asset} from ${delegate.senderId} to ${req.payTo}, relayed by ${relayer.accountId}`)
        },
      },
      deps,
    )
    if (relayed.kind === 'refused') {
      // Never included: the delegate was not executed, so it is still the buyer's to send again.
      if (records.get(key) === rec) records.delete(key)
      return {
        httpStatus: 502,
        body: {
          error: 'settlement refused',
          code: 'broadcast_refused',
          charged: false,
          reason: relayed.reason,
          ...(relayed.txHash ? { transaction: relayed.txHash } : {}),
          note: 'The node refused the transaction, so it was never included and nothing moved. The same signed payment can be sent again while its delegate window lasts.',
        },
      }
    }
    if (relayed.kind === 'unknown') return pending(ctx, rec, relayed.reason)
    return await settleFinal(ctx, rec, relayed.result, answer, false)
  } catch (e) {
    log(`[near-x402] the settlement path failed: ${msg(e)}`)
    return {
      httpStatus: 502,
      body: {
        error: 'settlement failed',
        code: 'unexpected',
        reason: msg(e),
        ...(rec.txHash ? { transaction: rec.txHash, note: 'Nothing was served. Send this same payment again with this same request: the transaction is read by its hash before anything else happens.' } : { charged: false, note: 'Nothing was broadcast.' }),
      },
    }
  } finally {
    inFlight.delete(key)
  }
}
