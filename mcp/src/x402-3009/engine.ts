/**
 * The settlement engine: verify an EIP-3009 authorization, then broadcast it ourselves
 * and prove on-chain that the money moved.
 *
 * This is a THIRD settlement shape in this codebase, and it exists because the other two
 * each give up something we do not have to give up here:
 *
 *   - x402.ts (Arc) is receipt-verified, which is the strong part, but the buyer has to
 *     broadcast their own ERC-20 transfer, so the buyer needs native gas on the chain.
 *   - celo-x402.ts delegates to a third-party facilitator, so the buyer pays no gas, but
 *     "settled" is that facilitator's word: nothing reads the chain to confirm it.
 *
 * We run our own facilitator so one code path and one receipt standard cover every chain we
 * sell on, rather than trusting a different service's word on each. The buyer
 * signs a transferWithAuthorization (no gas, no broadcast), we submit it from our own
 * signer, and we only call it settled when the receipt succeeded AND that receipt
 * contains a Transfer log of the right value, on the right asset, to the right payee.
 * Success is evidence we hold, not a claim we relay.
 *
 * The receipt is read from every RPC the chain lists, not through the fallback client: a host
 * that does not have it answers null, and a fallback takes that as the answer. A broadcast
 * with no receipt inside the window is recorded as ambiguous, and that row is read again when
 * a retry of the same authorization arrives and when the proof is read (see
 * reconcileSettlementRow): the buyer who paid is served, and nothing is broadcast twice.
 *
 * Chain-generic on purpose: everything comes from a ChainDescriptor plus one
 * SettlementToken, so any registry chain with an EIP-3009 token inherits the rail.
 */
import { parseSignature, parseEventLogs, verifyTypedData, isAddress, type TransactionReceipt } from 'viem'
// The ACTION, not the util of the same name. viem exports both: the top-level one only
// recovers a signer address and compares it, while this one goes through verifyHash and so
// falls back to an ERC-1271 `isValidSignature` call when the address holds code. The two
// have different signatures, which is the only reason the wrong one type-checked here.
import { verifyTypedData as verifyTypedDataOnChain } from 'viem/actions'
import type { ChainDescriptor, EveryRpcOptions, SettlementToken } from '../chains/index.js'
import {
  EIP3009_ABI,
  describeReceiptWait,
  evmPublicClient,
  evmWalletClientFromKey,
  getChain,
  txUrl,
  waitForReceiptOnEveryRpc,
} from '../chains/index.js'
import {
  persistX402Settlement,
  loadSpentPayments,
  loadX402SettlementsResult,
  persistSpentPayment,
  redeemX402Settlement,
  resolveX402Settlement,
  gasSpentOnDay,
  GAS_BUDGET_UNKNOWN,
  type X402SettlementRecord,
  type X402SettlementResolution,
  type X402SettlementsRead,
  type X402SettlementUpdate,
} from '../storage.js'
import { provenDomainCached, type ProvenDomain, type DomainDeps } from './domain.js'

type Hex = `0x${string}`

export type Authorization = {
  from: Hex
  to: Hex
  value: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
}

/** What the buyer must pay, as the 402 challenge stated it. */
export type Requirements = {
  scheme: 'exact'
  network: string
  asset: Hex
  payTo: Hex
  maxAmountRequired: string
  resource: string
}

export type Limits = {
  minValue: bigint
  maxValue: bigint
  /** Refuse an authorization that expires within this many seconds. It would revert while
   *  we are mining it, burning our gas for nothing, and the buyer would see a failure
   *  they cannot distinguish from a bad signature. */
  expiryHeadroomSec: number
  /** Hard native-unit ceiling on one settlement's gas. Native units only, so no price
   *  oracle is invented; a gas spike fails closed rather than quietly costing more. */
  maxGasWei: bigint
  /** Daily native-unit budget across all settlement attempts, summed from the durable log. */
  dailyGasWei: bigint
}

export type VerifyCode =
  | 'malformed_payload'
  | 'requirements_mismatch'
  | 'unsupported_network'
  | 'unsupported_asset'
  | 'wrong_recipient'
  | 'wrong_amount'
  | 'below_minimum'
  | 'above_maximum'
  | 'not_yet_valid'
  | 'expired'
  | 'expiring_too_soon'
  | 'nonce_used'
  | 'already_redeemed'
  | 'bad_signature'
  | 'insufficient_funds'
  | 'domain_unproven'
  | 'rpc_error'

export type VerifyResult =
  | { isValid: true; payer: Hex; authorization: Authorization; signature: Hex; proven: ProvenDomain; key: string }
  | { isValid: false; invalidReason: string; code: VerifyCode }

export type SettleCode =
  | VerifyCode
  | 'no_signer'
  | 'in_flight'
  | 'simulation_reverted'
  | 'gas_ceiling'
  | 'gas_budget_exhausted'
  | 'broadcast_failed'
  | 'receipt_reverted'
  | 'no_transfer_log'
  | 'receipt_timeout'
  /** An earlier broadcast of this authorization is still unresolved, so nothing was broadcast. */
  | 'settlement_pending'

export type SettleSuccess = {
  success: true
  transaction: Hex
  payer: string
  network: string
  asset: string
  assetSymbol: string
  value: string
  blockNumber: string
  gasUsed: string
  gasWei: string
  explorerUrl: string
  settledAt: string
  /** True when this answers a retry: the transaction came from an earlier broadcast whose
   *  receipt arrived late, and this call broadcast nothing. */
  reconciled?: boolean
  /** The money moved and the settlement is recorded, but the replay key could not be written.
   *  A replay is still refused, by the token's own authorizationState. */
  replayKeyWarning?: string
}

export type SettleResult =
  | SettleSuccess
  | { success: false; errorReason: string; code: SettleCode; transaction?: Hex; ambiguous?: boolean }

export type EngineDeps = DomainDeps & {
  publicClient?: PublicClientLike
  walletClient?: WalletClientLike
  signerAddress?: Hex
  persist?: (rec: X402SettlementRecord) => Promise<void>
  loadSpent?: () => Promise<string[]>
  persistSpent?: (key: string) => Promise<void>
  gasSpentTodayWei?: () => Promise<bigint>
  /** Settlement metadata for the durable record. Absent on a bare /settle call. */
  meta?: { tool: string; baseUsd: number; feeUsd: number; facilitatedFor?: string }
  /** How long to wait for a fresh broadcast's receipt, in ms. */
  timeoutMs?: number
  /** Options for the every-RPC receipt reads. Injected by tests; the hosts default to the chain's. */
  receipts?: EveryRpcOptions
  /** The settlement log, with "empty" and "unreadable" told apart. */
  loadSettlements?: () => Promise<X402SettlementsRead>
  resolveSettlement?: (tx: string, resolution: X402SettlementResolution) => Promise<X402SettlementUpdate>
  redeemSettlement?: (tx: string, at: string) => Promise<X402SettlementUpdate>
}

/** The slice of a viem public client this engine uses. Structural so tests can inject. */
type PublicClientLike = {
  readContract: (args: Record<string, unknown>) => Promise<unknown>
  simulateContract: (args: Record<string, unknown>) => Promise<{ request: unknown }>
  estimateContractGas?: (args: Record<string, unknown>) => Promise<bigint>
  getGasPrice: () => Promise<bigint>
}

type WalletClientLike = {
  writeContract: (args: Record<string, unknown>) => Promise<Hex>
}

/**
 * The durable replay key. Chain-qualified and structured, so it cannot be confused with
 * the Arc rail's 66-character tx hashes in the shared spent_payments table (see the
 * comment there: namespacing instead of a schema migration).
 */
export function paymentKey(caip2: string, asset: string, from: string, nonce: string): string {
  return `${caip2}/erc20:${asset.toLowerCase()}/3009/${from.toLowerCase()}/${nonce.toLowerCase()}`
}

/**
 * Parse an x402 `exact` payment payload into an authorization plus its signature.
 * Deliberately tolerant about numeric encoding (string or number) and strict about
 * shape: anything it cannot vouch for comes back as a reason, never as a throw.
 */
export function parseAuthorizationPayload(
  payload: unknown,
): { ok: true; authorization: Authorization; signature: Hex } | { ok: false; reason: string } {
  const p = payload as Record<string, unknown> | null
  const inner = (p?.payload ?? p) as Record<string, unknown> | undefined
  const auth = inner?.authorization as Record<string, unknown> | undefined
  const signature = inner?.signature
  if (!auth || typeof signature !== 'string') return { ok: false, reason: 'payload needs { authorization, signature }' }
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, reason: 'signature must be a 65-byte hex string' }
  const from = String(auth.from ?? '')
  const to = String(auth.to ?? '')
  if (!isAddress(from) || !isAddress(to)) return { ok: false, reason: 'authorization.from and .to must be addresses' }
  const nonce = String(auth.nonce ?? '')
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) return { ok: false, reason: 'authorization.nonce must be 32 bytes of hex' }
  let value: bigint
  let validAfter: bigint
  let validBefore: bigint
  try {
    value = BigInt(String(auth.value))
    validAfter = BigInt(String(auth.validAfter ?? '0'))
    validBefore = BigInt(String(auth.validBefore))
  } catch {
    return { ok: false, reason: 'authorization value/validAfter/validBefore must be integers' }
  }
  return {
    ok: true,
    signature: signature as Hex,
    authorization: { from: from as Hex, to: to as Hex, value, validAfter, validBefore, nonce: nonce as Hex },
  }
}

/**
 * Read-only validation. Never broadcasts, never persists, so it is safe to expose to
 * anyone: this is what the public /verify endpoint runs.
 */
export async function verifyPayment(input: {
  chain: ChainDescriptor
  token: SettlementToken
  requirements: Requirements
  payload: unknown
  limits: Limits
  deps?: EngineDeps
}): Promise<VerifyResult> {
  const { chain, token, requirements, limits } = input
  const deps = input.deps ?? {}
  const now = deps.now ?? (() => new Date())

  const parsed = parseAuthorizationPayload(input.payload)
  if (!parsed.ok) return { isValid: false, code: 'malformed_payload', invalidReason: parsed.reason }
  const { authorization: a, signature } = parsed

  if (requirements.asset.toLowerCase() !== token.address.toLowerCase()) {
    return { isValid: false, code: 'unsupported_asset', invalidReason: `this rail settles ${token.symbol} at ${token.address}` }
  }
  if (a.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return { isValid: false, code: 'wrong_recipient', invalidReason: `authorization pays ${a.to}, this resource is paid to ${requirements.payTo}` }
  }
  // `exact` means exact. Accepting more would let a buyer silently overpay and would make
  // the recorded amount disagree with the quoted price.
  let required: bigint
  try {
    required = BigInt(requirements.maxAmountRequired)
  } catch {
    return { isValid: false, code: 'requirements_mismatch', invalidReason: 'maxAmountRequired is not an integer' }
  }
  if (a.value !== required) {
    return { isValid: false, code: 'wrong_amount', invalidReason: `authorization is for ${a.value}, the resource costs exactly ${required}` }
  }
  if (a.value < limits.minValue) {
    return { isValid: false, code: 'below_minimum', invalidReason: `below this rail's minimum of ${limits.minValue} base units` }
  }
  if (a.value > limits.maxValue) {
    return { isValid: false, code: 'above_maximum', invalidReason: `above this rail's maximum of ${limits.maxValue} base units` }
  }

  const nowSec = BigInt(Math.floor(now().getTime() / 1000))
  if (a.validAfter > nowSec) {
    return { isValid: false, code: 'not_yet_valid', invalidReason: `authorization is not valid until ${a.validAfter}` }
  }
  if (a.validBefore <= nowSec) {
    return { isValid: false, code: 'expired', invalidReason: `authorization expired at ${a.validBefore}` }
  }
  if (a.validBefore - nowSec < BigInt(limits.expiryHeadroomSec)) {
    return {
      isValid: false,
      code: 'expiring_too_soon',
      invalidReason: `authorization expires in under ${limits.expiryHeadroomSec}s, which is inside the window we need to mine it`,
    }
  }

  const domain = await provenDomainCached(chain, token, deps)
  if (!domain.ok) return { isValid: false, code: 'domain_unproven', invalidReason: domain.reason }

  const key = paymentKey(chain.caip2, token.address, a.from, a.nonce)
  let spent: string[]
  try {
    spent = await (deps.loadSpent ?? loadSpentPayments)()
  } catch (e) {
    // The spent set is the replay guard, so an unreadable one is a refusal rather than a
    // pass. Fail CLOSED: the alternative is redeeming a payment twice.
    return { isValid: false, code: 'rpc_error', invalidReason: `could not read the replay guard, refusing rather than risking a replay: ${msg(e)}` }
  }
  if (spent.includes(key)) {
    return { isValid: false, code: 'already_redeemed', invalidReason: 'this authorization has already been redeemed here' }
  }

  const client = deps.publicClient ?? ((await evmPublicClient(chain, deps.env ?? process.env)) as unknown as PublicClientLike)

  // The token's own replay ground truth. Reading it first means a replay costs us zero
  // gas rather than a reverted broadcast.
  try {
    const used = await client.readContract({
      address: token.address, abi: EIP3009_ABI, functionName: 'authorizationState', args: [a.from, a.nonce],
    })
    if (used === true) return { isValid: false, code: 'nonce_used', invalidReason: 'the token reports this authorization nonce as already used' }
  } catch (e) {
    return { isValid: false, code: 'rpc_error', invalidReason: `could not read authorizationState: ${msg(e)}` }
  }

  // Signature check against the PROVEN domain.
  //
  // This used to call viem's top-level `verifyTypedData` and pass `publicClient` into it,
  // with a comment saying that was how an EIP-1271 contract wallet verified too. It was
  // not. That function destructures exactly { address, domain, message, primaryType,
  // signature, types } and does a plain recover-and-compare; `publicClient` was silently
  // dropped, and the `as never` cast on the call is what let an unknown property through
  // without the compiler objecting. So a Safe or any other smart-contract wallet was
  // refused with `bad_signature`, while the code documented support for it.
  //
  // The ACTION form is the one that reaches the chain: it hashes the typed data and goes
  // through verifyHash, which calls the account's ERC-1271 `isValidSignature` when the
  // address holds code. It needs a real client, so when we do not have one we fall back to
  // the recover-only util. That fallback is honest for an EOA, which is the overwhelming
  // majority of payers, and it is why a missing client must not fail a valid signature.
  let signatureValid = false
  try {
    signatureValid = await authorizationSigned(client, a, signature, domain.proven)
  } catch (e) {
    return { isValid: false, code: 'bad_signature', invalidReason: `signature did not verify: ${msg(e)}` }
  }
  if (!signatureValid) {
    return {
      isValid: false,
      code: 'bad_signature',
      invalidReason: `signature does not recover to ${a.from} over the proven domain (name "${domain.proven.domain.name}", version "${domain.proven.domain.version}")`,
    }
  }

  try {
    const balance = (await client.readContract({
      address: token.address, abi: EIP3009_ABI, functionName: 'balanceOf', args: [a.from],
    })) as bigint
    if (balance < a.value) {
      return { isValid: false, code: 'insufficient_funds', invalidReason: `payer holds ${balance} base units, needs ${a.value}` }
    }
  } catch (e) {
    return { isValid: false, code: 'rpc_error', invalidReason: `could not read balanceOf: ${msg(e)}` }
  }

  return { isValid: true, payer: a.from, authorization: a, signature, proven: domain.proven, key }
}

/** Keys currently being settled by this process. Guards the window between verify and
 *  the durable spent-write, which is the same TOCTOU the Arc rail guards. */
const inFlight = new Set<string>()

type SettleInput = {
  chain: ChainDescriptor
  token: SettlementToken
  requirements: Requirements
  payload: unknown
  limits: Limits
  deps?: EngineDeps
}

/**
 * Verify, broadcast, and prove. Returns success only when a receipt succeeded AND that
 * receipt carries a matching Transfer log. A retry of an authorization already broadcast
 * answers from that broadcast's receipt and broadcasts nothing.
 */
export async function settlePayment(input: SettleInput): Promise<SettleResult> {
  const { chain, token, requirements, limits } = input
  const deps = input.deps ?? {}
  const now = deps.now ?? (() => new Date())
  const persist = deps.persist ?? persistX402Settlement
  const env = deps.env ?? process.env

  const verified = await verifyPayment(input)
  if (!verified.isValid) {
    const refused: SettleResult = { success: false, code: verified.code, errorReason: verified.invalidReason }
    return RETRY_REFUSALS.includes(verified.code) ? ((await retryOfEarlierBroadcast(input, verified.code)) ?? refused) : refused
  }

  const { authorization: a, signature, proven, key } = verified
  if (inFlight.has(key)) {
    return { success: false, code: 'in_flight', errorReason: 'this authorization is already being settled' }
  }
  inFlight.add(key)
  try {
    // The same authorization may already be on its way. Broadcasting it again could only
    // revert at our cost, and the host that said its nonce was unused may simply lag.
    const earlier = await settleFromEarlierBroadcast(input, a, key)
    if (earlier) return earlier

    // Resolved once: building a wallet client derives an account from the key, and doing
    // it twice would do that work twice for the same answer.
    const signer = deps.walletClient
      ? null
      : ((await evmWalletClientFromKey(chain, signerKey(chain, env), env)) as unknown as
          | { client: WalletClientLike; account: { address: Hex } }
          | null)
    const wallet = deps.walletClient ?? signer?.client
    const signerAddress = deps.signerAddress ?? signer?.account?.address
    if (!wallet) {
      return {
        success: false,
        code: 'no_signer',
        errorReason: `No settlement signer configured for ${chain.id}. This rail broadcasts on the buyer's behalf, so it cannot run without one.`,
      }
    }

    const client = deps.publicClient ?? ((await evmPublicClient(chain, env)) as unknown as PublicClientLike)
    const args = [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, ...splitSignature(signature)] as const

    // Simulation is the primary drain guard: a bad signature, an expired authorization, a
    // blacklisted payer or an insufficient balance all revert here at zero gas cost.
    try {
      await client.simulateContract({
        address: token.address, abi: EIP3009_ABI, functionName: 'transferWithAuthorization',
        args, ...(signerAddress ? { account: signerAddress } : {}),
      })
    } catch (e) {
      return { success: false, code: 'simulation_reverted', errorReason: `settlement would revert: ${msg(e)}` }
    }

    let gasPrice = 0n
    let gasEstimate = 0n
    try {
      gasPrice = await client.getGasPrice()
      gasEstimate = client.estimateContractGas
        ? await client.estimateContractGas({
            address: token.address, abi: EIP3009_ABI, functionName: 'transferWithAuthorization',
            args, ...(signerAddress ? { account: signerAddress } : {}),
          })
        : 120_000n
    } catch (e) {
      return { success: false, code: 'rpc_error', errorReason: `could not estimate settlement gas: ${msg(e)}` }
    }
    const projected = gasPrice * gasEstimate
    if (projected > limits.maxGasWei) {
      return {
        success: false,
        code: 'gas_ceiling',
        errorReason: `settlement would cost ${projected} wei of gas, above this rail's ceiling of ${limits.maxGasWei}`,
      }
    }
    const spentToday = await (deps.gasSpentTodayWei ?? (() => gasSpentOnDay(now().toISOString().slice(0, 10), undefined, chain.caip2)))()
    // An unreadable gas ledger is not zero spend. It is reported as its own reason so an
    // operator reading the logs can tell a real exhausted budget from a database outage,
    // and so this never reads to a buyer as "you spent our budget".
    if (spentToday === GAS_BUDGET_UNKNOWN) {
      return {
        success: false,
        code: 'gas_budget_exhausted',
        errorReason: `the settlement gas ledger could not be read, so today's spend is unknown and the daily budget is treated as spent. Nothing was broadcast and nothing was charged.`,
      }
    }
    if (spentToday + projected > limits.dailyGasWei) {
      return {
        success: false,
        code: 'gas_budget_exhausted',
        errorReason: `today's settlement gas budget is spent (${spentToday} of ${limits.dailyGasWei} wei). Nothing was broadcast and nothing was charged.`,
      }
    }

    let hash: Hex
    try {
      hash = await wallet.writeContract({
        address: token.address, abi: EIP3009_ABI, functionName: 'transferWithAuthorization', args,
      })
    } catch (e) {
      return { success: false, code: 'broadcast_failed', errorReason: `could not broadcast the settlement: ${msg(e)}` }
    }

    let missing: string
    let receipt: TransactionReceipt | null = null
    try {
      const wait = await waitForReceiptOnEveryRpc(chain, hash, {
        env, confirmations: chain.confirmations, timeoutMs: deps.timeoutMs ?? 60_000, ...deps.receipts,
      })
      if (wait.status === 'found') receipt = wait.value
      missing = wait.status === 'found' ? '' : describeReceiptWait(wait)
    } catch (e) {
      missing = msg(e)
    }
    if (!receipt) {
      // The transaction may still land. Record it as ambiguous with the hash and the nonce: a
      // retry of this authorization finds this row and reads the hash from every RPC again
      // (settleFromEarlierBroadcast), and so does a read of the proof, so it ends as settled
      // only on a receipt with a matching Transfer log, and until then nothing is rebroadcast.
      await safePersist(persist, record({
        chain, token, requirements, a, proven, now, outcome: 'ambiguous', meta: deps.meta, tx: hash,
      }))
      return {
        success: false, code: 'receipt_timeout', transaction: hash, ambiguous: true,
        errorReason: `broadcast, but ${missing}. Recorded as ambiguous; the transaction may still land.`,
      }
    }

    const gasUsed = receipt.gasUsed ?? 0n
    const gasWei = gasUsed * (receipt.effectiveGasPrice ?? gasPrice)
    if (receipt.status !== 'success') {
      await safePersist(persist, record({
        chain, token, requirements, a, proven, now, outcome: 'reverted', meta: deps.meta,
        tx: hash, blockNumber: receipt.blockNumber, gasUsed, gasWei,
      }))
      return { success: false, code: 'receipt_reverted', transaction: hash, errorReason: `settlement reverted on-chain (tx ${hash})` }
    }

    // Status success is not proof the money moved to US. The Transfer log is.
    if (!carriesPayment(receipt, { asset: token.address, from: a.from, to: requirements.payTo, value: a.value })) {
      await safePersist(persist, record({
        chain, token, requirements, a, proven, now, outcome: 'reverted', meta: deps.meta,
        tx: hash, blockNumber: receipt.blockNumber, gasUsed, gasWei,
      }))
      return {
        success: false, code: 'no_transfer_log', transaction: hash,
        errorReason: `tx ${hash} succeeded but carries no matching ${token.symbol} Transfer to ${requirements.payTo}`,
      }
    }

    // The record first: the money has moved, and a replay key that cannot be written must not
    // cost us the record that says so. A replay stays blocked either way, because the token
    // itself refuses a used nonce and verifyPayment reads that before anything else happens.
    await safePersist(persist, record({
      chain, token, requirements, a, proven, now, outcome: 'settled', meta: deps.meta,
      tx: hash, blockNumber: receipt.blockNumber, gasUsed, gasWei,
    }))
    const replayKeyWarning = await writeSpentKey(key, deps)

    return {
      success: true,
      transaction: hash,
      payer: a.from,
      network: chain.caip2,
      asset: token.address,
      assetSymbol: proven.symbol,
      value: a.value.toString(),
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: gasUsed.toString(),
      gasWei: gasWei.toString(),
      explorerUrl: txUrl(chain, hash),
      settledAt: now().toISOString(),
      ...(replayKeyWarning ? { replayKeyWarning } : {}),
    }
  } finally {
    inFlight.delete(key)
  }
}

// ── reconciling a broadcast whose receipt came late ───────────────────────────────

/** One retry or one proof read asks each host once, and never waits longer than this. */
const RECONCILE_PER_CALL_MS = 4_000
const RECONCILE_TOTAL_MS = 12_000

export type ReconcileResult =
  | { outcome: 'settled' | 'reverted'; row: X402SettlementRecord }
  /** Still no answer, or the answer could not be recorded; the row is as it was. */
  | { outcome: 'ambiguous'; row: X402SettlementRecord; reason: string }

/**
 * Read an ambiguous row's hash from every RPC and resolve the row from what the chain says.
 *
 * Settled only on the rule a fresh broadcast meets: a successful receipt with a matching
 * Transfer log. A mined transaction without one is reverted, as it is on the first attempt.
 * No receipt anywhere leaves the row ambiguous, because a host that has no receipt proves
 * nothing, and an authorization that has since expired still leaves it there: this record
 * does not hold the deadline, and a transaction mined before it would still count.
 *
 * It never writes the replay key and never counts as serving anything. That is the retry's to
 * do: a proof read that resolves a row must not use up the call the buyer paid for.
 */
export async function reconcileSettlementRow(chain: ChainDescriptor, row: X402SettlementRecord, deps: EngineDeps = {}): Promise<ReconcileResult> {
  if (!row.tx) return { outcome: 'ambiguous', row, reason: 'the row carries no transaction hash' }
  const now = deps.now ?? (() => new Date())
  let receipt: TransactionReceipt
  let paid: boolean
  try {
    const wait = await waitForReceiptOnEveryRpc(chain, row.tx, {
      env: deps.env ?? process.env,
      confirmations: chain.confirmations,
      perCallTimeoutMs: RECONCILE_PER_CALL_MS,
      hardTimeoutMs: RECONCILE_TOTAL_MS,
      ...deps.receipts,
      timeoutMs: 0,
    })
    if (wait.status !== 'found') return { outcome: 'ambiguous', row, reason: describeReceiptWait(wait) }
    receipt = wait.value
    paid = receipt.status === 'success' && carriesPayment(receipt, { asset: row.asset, from: row.payer, to: row.payTo, value: BigInt(row.value) })
  } catch (e) {
    return { outcome: 'ambiguous', row, reason: msg(e) }
  }

  const gasUsed = receipt.gasUsed ?? 0n
  const resolution: X402SettlementResolution = {
    outcome: paid ? 'settled' : 'reverted',
    reconciledAt: now().toISOString(),
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: gasUsed.toString(),
    // A host may leave the price out, and viem then reports null. No price is no figure.
    ...(receipt.effectiveGasPrice != null ? { gasWei: (gasUsed * receipt.effectiveGasPrice).toString() } : {}),
  }
  const written = await (deps.resolveSettlement ?? resolveX402Settlement)(row.tx, resolution)
  if (!written.ok) return { outcome: 'ambiguous', row, reason: 'the receipt was read but the settlement log could not be written' }
  return { outcome: resolution.outcome as 'settled' | 'reverted', row: { ...row, ...resolution } }
}

/**
 * Sweep the newest ambiguous rows: the read path behind GET /api/facilitator/proof, the way
 * refreshCreditedRows is for the Gateway log. Bounded by `limit`, and reads the chain only.
 * A row that never resolves (its transaction was dropped) stays ambiguous and stays counted.
 */
export async function reconcileAmbiguousSettlements(
  deps: EngineDeps = {},
  limit = 10,
): Promise<{ checked: number; settled: number; reverted: number; ambiguous: number }> {
  const totals = { checked: 0, settled: 0, reverted: 0, ambiguous: 0 }
  const read = await (deps.loadSettlements ?? loadX402SettlementsResult)()
  if (!read.ok) return totals
  const rows = read.rows.filter((r) => r.outcome === 'ambiguous' && r.tx).slice(-Math.max(0, limit))
  totals.checked = rows.length
  await Promise.all(
    rows.map(async (row) => {
      const chain = getChain(row.network)
      // A proof read reports what it could learn, and a row it could not read stays as it was.
      const out = chain?.ecosystem === 'evm'
        ? await reconcileSettlementRow(chain, row, deps).catch(() => ({ outcome: 'ambiguous' as const }))
        : { outcome: 'ambiguous' as const }
      totals[out.outcome] += 1
    }),
  )
  return totals
}

/**
 * The refusals a retry of a landed broadcast can draw. A used nonce with no replay key is what
 * a retry looks like when the first attempt's receipt came late, and the authorization's clock
 * keeps running while the buyer waits, so a late retry is refused as expired before the nonce
 * is even read. Neither may send a buyer who paid back to pay again.
 */
const RETRY_REFUSALS: VerifyCode[] = ['nonce_used', 'expired', 'expiring_too_soon']

/**
 * Answer a refused authorization from the log, if the log has broadcast it. Null means this is
 * no retry of ours, and the refusal stands.
 *
 * verifyPayment refuses these before it looks at the signature, and the proof page lists every
 * payer and nonce, so the signature is checked here. Without it anyone could claim the call
 * another buyer paid for by naming the buyer's address and nonce.
 */
async function retryOfEarlierBroadcast(input: SettleInput, refusedAs: VerifyCode): Promise<SettleResult | null> {
  const { chain, token } = input
  const deps = input.deps ?? {}
  const parsed = parseAuthorizationPayload(input.payload)
  if (!parsed.ok) return null
  const { authorization: a, signature } = parsed
  const key = paymentKey(chain.caip2, token.address, a.from, a.nonce)
  if (inFlight.has(key)) {
    return { success: false, code: 'in_flight', errorReason: 'this authorization is already being settled. Do not sign a new one; retry this one shortly.' }
  }
  inFlight.add(key)
  try {
    const domain = await provenDomainCached(chain, token, deps)
    if (!domain.ok) return null
    const client = deps.publicClient ?? ((await evmPublicClient(chain, deps.env ?? process.env)) as unknown as PublicClientLike)
    try {
      if (!(await authorizationSigned(client, a, signature, domain.proven))) return null
    } catch {
      return null
    }
    const out = await settleFromEarlierBroadcast(input, a, key)
    // An expired authorization with its nonce unused and no receipt anywhere moved nothing and
    // can no longer move anything, because the token refuses it past validBefore. Telling this
    // buyer to keep waiting would hold them forever on a dropped transaction. The refusal
    // stands, so they get a fresh challenge; the row stays ambiguous, as no receipt resolved it.
    if (refusedAs === 'expired' && out && !out.success && out.code === 'settlement_pending' && out.ambiguous) {
      const used = await client
        .readContract({ address: token.address, abi: EIP3009_ABI, functionName: 'authorizationState', args: [a.from, a.nonce] })
        .catch(() => null)
      if (used === false) return null
    }
    return out
  } finally {
    inFlight.delete(key)
  }
}

/**
 * What the log says about this authorization, or null when it has no broadcast to answer for.
 * Every ambiguous row is read from the chain first. A settled row answers the call, a row that
 * is still ambiguous means nothing may be broadcast, and a reverted row moved nothing, so it
 * leaves the authorization free to be tried again. The caller holds this key in `inFlight`.
 */
async function settleFromEarlierBroadcast(input: SettleInput, a: Authorization, key: string): Promise<SettleResult | null> {
  const { chain, token } = input
  const deps = input.deps ?? {}
  let read: X402SettlementsRead
  try {
    read = await (deps.loadSettlements ?? loadX402SettlementsResult)()
  } catch (e) {
    read = { ok: false, reason: msg(e) }
  }
  if (!read.ok) {
    return {
      success: false,
      code: 'rpc_error',
      errorReason: 'the settlement log could not be read, so an earlier broadcast of this authorization cannot be ruled out. Nothing was broadcast by this call and nothing was charged by it. Retry this authorization rather than signing a new one.',
    }
  }
  const same = (x: unknown, y: string) => String(x).toLowerCase() === y.toLowerCase()
  const rows = read.rows
    .filter((r) => r.network === chain.caip2 && same(r.asset, token.address) && same(r.payer, a.from) && same(r.authNonce, a.nonce))
    .reverse()
  if (!rows.length) return null

  let unresolved: X402SettlementRecord | null = null
  let settled = rows.find((r) => r.outcome === 'settled') ?? null
  if (!settled) {
    for (const row of rows.filter((r) => r.outcome === 'ambiguous')) {
      const out = await reconcileSettlementRow(chain, row, deps)
      if (out.outcome === 'settled') {
        settled = out.row
        break
      }
      if (out.outcome === 'ambiguous') unresolved ??= row
    }
  }
  if (settled) return redeem(input, settled, key)
  if (!unresolved) return null
  return {
    success: false,
    code: 'settlement_pending',
    ambiguous: true,
    ...(unresolved.tx ? { transaction: unresolved.tx as Hex } : {}),
    errorReason: `an earlier broadcast of this authorization (tx ${unresolved.tx}) has no receipt on any RPC yet. Nothing new was broadcast. It may still land, so retry this authorization rather than signing a new one.`,
  }
}

/** Serve the one call a reconciled settlement pays for. */
async function redeem(input: SettleInput, row: X402SettlementRecord, key: string): Promise<SettleResult> {
  const { chain, requirements } = input
  const deps = input.deps ?? {}
  const now = deps.now ?? (() => new Date())
  const refused = (errorReason: string): SettleResult => ({ success: false, code: 'already_redeemed', errorReason })
  // A settlement that went through on its first attempt was served then, and one that was
  // redeemed was served then. Neither is owed anything, whatever the replay key says.
  if (!row.tx || !row.reconciledAt || row.redeemedAt) return refused('this authorization has already been redeemed here')
  if (row.resource !== requirements.resource || row.payTo.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return refused(`this authorization paid for ${row.resource}, not for ${requirements.resource}`)
  }
  const claim = await (deps.redeemSettlement ?? redeemX402Settlement)(row.tx, now().toISOString())
  if (!claim.ok) {
    return {
      success: false,
      code: 'settlement_pending',
      transaction: row.tx as Hex,
      errorReason: `the settlement landed (tx ${row.tx}) but the log could not be written, so this call cannot be claimed yet. Retry this authorization; it will not be charged again.`,
    }
  }
  if (!claim.updated) return refused('this authorization has already been redeemed here')
  const replayKeyWarning = await writeSpentKey(key, deps)
  return {
    success: true,
    transaction: row.tx as Hex,
    payer: row.payer,
    network: row.network,
    asset: row.asset,
    assetSymbol: row.assetSymbol,
    value: row.value,
    blockNumber: row.blockNumber ?? '',
    gasUsed: row.gasUsed ?? '',
    gasWei: row.gasWei ?? '',
    explorerUrl: txUrl(chain, row.tx),
    settledAt: now().toISOString(),
    reconciled: true,
    ...(replayKeyWarning ? { replayKeyWarning } : {}),
  }
}

// ── internals ─────────────────────────────────────────────────────────────────────

/** Write the replay key, and report a failure rather than throw: by now the money has moved. */
async function writeSpentKey(key: string, deps: EngineDeps): Promise<string | undefined> {
  try {
    await (deps.persistSpent ?? persistSpentPayment)(key)
    return undefined
  } catch (e) {
    console.error('[x402-3009] replay key could not be written after a settlement:', msg(e))
    return "the replay key could not be written; a replay is still refused by the token's authorizationState"
  }
}

/** Whether a receipt carries the Transfer this payment promised: this asset, this payer, this
 *  payee, at least this value. */
function carriesPayment(receipt: TransactionReceipt, want: { asset: string; from: string; to: string; value: bigint }): boolean {
  const transfers = parseEventLogs({ abi: EIP3009_ABI, eventName: 'Transfer', logs: receipt.logs as never })
  return transfers.some((l) => {
    const args_ = l.args as { from?: string; to?: string; value?: bigint }
    return (
      String(l.address).toLowerCase() === want.asset.toLowerCase() &&
      (args_.from ?? '').toLowerCase() === want.from.toLowerCase() &&
      (args_.to ?? '').toLowerCase() === want.to.toLowerCase() &&
      (args_.value ?? 0n) >= want.value
    )
  })
}

/** Whether `signature` is this authorization, signed by its `from` over the proven domain. */
async function authorizationSigned(client: unknown, a: Authorization, signature: Hex, proven: ProvenDomain): Promise<boolean> {
  const params = {
    address: a.from,
    domain: proven.domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: a.from, to: a.to, value: a.value,
      validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce,
    },
    signature,
  }
  return hasPublicActions(client)
    ? verifyTypedDataOnChain(client as never, params as never)
    : verifyTypedData(params as never)
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

function splitSignature(signature: Hex): [number, Hex, Hex] {
  const { v, r, s, yParity } = parseSignature(signature)
  const vv = v !== undefined ? Number(v) : yParity + 27
  return [vv, r, s]
}

function signerKey(chain: ChainDescriptor, env: NodeJS.ProcessEnv): string | undefined {
  // A dedicated thin gas wallet when set, else the chain's own signer. Separate by
  // default so a drained facilitator cannot also break identity writes.
  return env.X402_3009_SIGNER_KEY || (chain.signerEnvVar ? env[chain.signerEnvVar] : undefined)
}

/** Whether this client can actually make a call, which is what ERC-1271 verification needs.
 *  `getChainId` is the cheapest public action to probe for, and a stub injected by a test
 *  that only implements readContract correctly reports false here. */
function hasPublicActions(c: unknown): boolean {
  return Boolean(c && typeof (c as { getChainId?: unknown }).getChainId === 'function')
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function safePersist(persist: (r: X402SettlementRecord) => Promise<void>, rec: X402SettlementRecord): Promise<void> {
  try {
    await persist(rec)
  } catch (e) {
    console.error('[x402-3009] settlement record failed:', msg(e))
  }
}

function record(input: {
  chain: ChainDescriptor
  token: SettlementToken
  requirements: Requirements
  a: Authorization
  proven: ProvenDomain
  now: () => Date
  outcome: X402SettlementRecord['outcome']
  meta?: { tool: string; baseUsd: number; feeUsd: number; facilitatedFor?: string }
  tx?: Hex
  blockNumber?: bigint
  gasUsed?: bigint
  gasWei?: bigint
}): X402SettlementRecord {
  const { chain, token, requirements, a, proven, meta } = input
  const baseUsd = meta?.baseUsd ?? 0
  const feeUsd = meta?.feeUsd ?? 0
  return {
    ts: input.now().toISOString(),
    outcome: input.outcome,
    tool: meta?.tool ?? 'facilitator',
    resource: requirements.resource,
    network: chain.caip2,
    asset: token.address,
    assetSymbol: proven.symbol,
    assetDecimals: proven.decimals,
    value: a.value.toString(),
    amountUsd: Number((baseUsd + feeUsd).toFixed(6)),
    baseUsd,
    feeUsd,
    payer: a.from,
    payTo: requirements.payTo,
    authNonce: a.nonce,
    ...(input.tx ? { tx: input.tx, explorerUrl: txUrl(chain, input.tx) } : {}),
    ...(input.blockNumber !== undefined ? { blockNumber: input.blockNumber.toString() } : {}),
    ...(input.gasUsed !== undefined ? { gasUsed: input.gasUsed.toString() } : {}),
    ...(input.gasWei !== undefined ? { gasWei: input.gasWei.toString() } : {}),
    ...(meta?.facilitatedFor ? { facilitatedFor: meta.facilitatedFor } : {}),
  }
}
