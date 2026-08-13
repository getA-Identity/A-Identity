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
 * Robinhood Chain has no third-party facilitator at all, so we became one. The buyer
 * signs a transferWithAuthorization (no gas, no broadcast), we submit it from our own
 * signer, and we only call it settled when the receipt succeeded AND that receipt
 * contains a Transfer log of the right value, on the right asset, to the right payee.
 * Success is evidence we hold, not a claim we relay.
 *
 * Chain-generic on purpose: everything comes from a ChainDescriptor plus one
 * SettlementToken, so any registry chain with an EIP-3009 token inherits the rail.
 */
import { parseSignature, parseEventLogs, verifyTypedData, isAddress } from 'viem'
import type { ChainDescriptor, SettlementToken } from '../chains/index.js'
import { EIP3009_ABI, evmPublicClient, evmWalletClientFromKey, txUrl } from '../chains/index.js'
import {
  persistX402Settlement,
  loadSpentPayments,
  persistSpentPayment,
  gasSpentOnDay,
  type X402SettlementRecord,
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
  timeoutMs?: number
}

/** The slice of a viem public client this engine uses. Structural so tests can inject. */
type PublicClientLike = {
  readContract: (args: Record<string, unknown>) => Promise<unknown>
  simulateContract: (args: Record<string, unknown>) => Promise<{ request: unknown }>
  estimateContractGas?: (args: Record<string, unknown>) => Promise<bigint>
  getGasPrice: () => Promise<bigint>
  waitForTransactionReceipt: (args: Record<string, unknown>) => Promise<{
    status: string
    blockNumber: bigint
    gasUsed: bigint
    effectiveGasPrice?: bigint
    logs: unknown[]
  }>
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
  const spent = await (deps.loadSpent ?? loadSpentPayments)()
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

  // Signature check against the PROVEN domain, through a public client so an EIP-1271
  // contract wallet verifies too.
  let signatureValid = false
  try {
    signatureValid = await verifyTypedData({
      address: a.from,
      domain: domain.proven.domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: a.from, to: a.to, value: a.value,
        validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce,
      },
      signature,
      // viem needs a client only for the ERC-1271 path; a plain EOA signature verifies
      // without one, so a missing client must not fail an otherwise valid signature.
      ...(hasPublicActions(client) ? { publicClient: client } : {}),
    } as never)
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

/**
 * Verify, broadcast, and prove. Returns success only when a receipt succeeded AND that
 * receipt carries a matching Transfer log.
 */
export async function settlePayment(input: {
  chain: ChainDescriptor
  token: SettlementToken
  requirements: Requirements
  payload: unknown
  limits: Limits
  deps?: EngineDeps
}): Promise<SettleResult> {
  const { chain, token, requirements, limits } = input
  const deps = input.deps ?? {}
  const now = deps.now ?? (() => new Date())
  const persist = deps.persist ?? persistX402Settlement
  const env = deps.env ?? process.env

  const verified = await verifyPayment(input)
  if (!verified.isValid) return { success: false, code: verified.code, errorReason: verified.invalidReason }

  const { authorization: a, signature, proven, key } = verified
  if (inFlight.has(key)) {
    return { success: false, code: 'in_flight', errorReason: 'this authorization is already being settled' }
  }
  inFlight.add(key)
  try {
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
    const spentToday = await (deps.gasSpentTodayWei ?? (() => gasSpentOnDay(now().toISOString().slice(0, 10))))()
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

    let receipt: Awaited<ReturnType<PublicClientLike['waitForTransactionReceipt']>>
    try {
      receipt = await client.waitForTransactionReceipt({
        hash, confirmations: chain.confirmations, timeout: deps.timeoutMs ?? 60_000,
      })
    } catch (e) {
      // The transaction may still land. Record it as ambiguous with the nonce, so a later
      // retry can resolve it from the chain instead of charging twice or serving nothing.
      await safePersist(persist, record({
        chain, token, requirements, a, proven, now, outcome: 'ambiguous', meta: deps.meta, tx: hash,
      }))
      return {
        success: false, code: 'receipt_timeout', transaction: hash, ambiguous: true,
        errorReason: `broadcast, but no receipt within the timeout: ${msg(e)}. Recorded as ambiguous; the transaction may still land.`,
      }
    }

    const gasWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice)
    if (receipt.status !== 'success') {
      await safePersist(persist, record({
        chain, token, requirements, a, proven, now, outcome: 'reverted', meta: deps.meta,
        tx: hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, gasWei,
      }))
      return { success: false, code: 'receipt_reverted', transaction: hash, errorReason: `settlement reverted on-chain (tx ${hash})` }
    }

    // Status success is not proof the money moved to US. The Transfer log is.
    const transfers = parseEventLogs({ abi: EIP3009_ABI, eventName: 'Transfer', logs: receipt.logs as never })
    const paid = transfers.find((l) => {
      const args_ = l.args as { from?: string; to?: string; value?: bigint }
      return (
        String(l.address).toLowerCase() === token.address.toLowerCase() &&
        (args_.from ?? '').toLowerCase() === a.from.toLowerCase() &&
        (args_.to ?? '').toLowerCase() === requirements.payTo.toLowerCase() &&
        (args_.value ?? 0n) >= a.value
      )
    })
    if (!paid) {
      await safePersist(persist, record({
        chain, token, requirements, a, proven, now, outcome: 'reverted', meta: deps.meta,
        tx: hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, gasWei,
      }))
      return {
        success: false, code: 'no_transfer_log', transaction: hash,
        errorReason: `tx ${hash} succeeded but carries no matching ${token.symbol} Transfer to ${requirements.payTo}`,
      }
    }

    await (deps.persistSpent ?? persistSpentPayment)(key)
    await safePersist(persist, record({
      chain, token, requirements, a, proven, now, outcome: 'settled', meta: deps.meta,
      tx: hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, gasWei,
    }))

    return {
      success: true,
      transaction: hash,
      payer: a.from,
      network: chain.caip2,
      asset: token.address,
      assetSymbol: proven.symbol,
      value: a.value.toString(),
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      gasWei: gasWei.toString(),
      explorerUrl: txUrl(chain, hash),
      settledAt: now().toISOString(),
    }
  } finally {
    inFlight.delete(key)
  }
}

// ── internals ─────────────────────────────────────────────────────────────────────

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
