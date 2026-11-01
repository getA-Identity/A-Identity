/**
 * @a-identity/trust-guard/arc
 *
 * Verify a payee before a vault pays it, on Arc Mainnet, from keys only you hold.
 *
 *   import { verifyThenPay, fromViemWallet, usdcUnits } from '@a-identity/trust-guard/arc'
 *
 *   const out = await verifyThenPay({
 *     vault,                          // your AgentSpendPolicy vault
 *     payee,                          // the 0x address to pay
 *     amountUnits: usdcUnits('0.25'), // USDC base units, never a float
 *     signer: fromViemWallet(wallet), // the vault's operator; also pays the check by default
 *   })
 *
 * The order, and what each step can cost you:
 *   A  Free, nothing signed: the asset is the registry's USDC and the vault's, the payee holds
 *      an ERC-8004 agent on Arc Mainnet, and the vault's policy and a simulated pay() accept
 *      the payment. A refusal here costs nothing: no check is bought for a payment the vault
 *      would refuse anyway.
 *   B  The verdict: risk_check at the price in the offer (0.005 USDC), through Circle Gateway,
 *      signed once by the payer from its Gateway balance. The payer spends no gas.
 *   C  The decision. DENY throws TrustDenyError and never calls the operator. WARN returns
 *      `awaiting_human` with a prepared ownerPay for the owner, unless payOnWarn is set. A
 *      Gateway error, a settlement echo that does not match what was signed, an unknown
 *      decision, a reputation that is not a finite number, an ALLOW below the reputation ALLOW
 *      needs and a verdict about another agent or amount are never ALLOW: each throws.
 *   D  The payment: exactly one sendTransaction of pay(payee, amountUnits), encoded from YOUR
 *      inputs and compared byte for byte with what the server prepared. Server calldata is
 *      never executed. The transaction is read back, and its receipt is looked for on every
 *      RPC. Nothing is ever retried with a new nonce: a retry could pay twice.
 *   E  The record: the hash is posted to the public flow, the server reads the receipt from
 *      the chain itself, and `record.recorded` says whether it did. A failure here changes
 *      nothing about the payment and never causes a second one.
 *
 * Every error class below says how far the flow got. An error thrown before the check is
 * bought means nothing was paid; GatewayCheckError.paid says what is known about the check;
 * VaultPaymentError carries the hash when one exists, and the hash is the thing to look up
 * rather than sending again.
 *
 * Node only. Needs the optional peers `viem` and `@circle-fin/x402-batching`, loaded when they
 * are first used. No key ever leaves your process: A-Identity holds neither key of a vault
 * paid through this entry point.
 */
import { ALLOW_MIN_REPUTATION, requireSecureBaseUrl, TrustDenyError, UnusableVerdictError, type Decision, type FetchLike, type GatewayCheckReference, type RiskVerdict, type TrustGuardOptions, type UnusableVerdictCode } from './index.js'
import { ARC_MAINNET, ARC_VAULT_ABI } from './arc-mainnet.generated.js'
import { arcChainReader, ArcCallRevert, type Address, type ArcChainReader, type ArcReceipt, type ArcTransaction, type Hex } from './arc-reader.js'

export { ARC_MAINNET } from './arc-mainnet.generated.js'
export { arcChainReader, ArcCallRevert, ArcRpcUnreachableError } from './arc-reader.js'
export type { Address, ArcChainReader, ArcChainReaderOptions, ArcLog, ArcReceipt, ArcTransaction, Hex } from './arc-reader.js'
export { UnusableVerdictError } from './index.js'
export type { GatewayCheckReference, UnusableVerdictCode } from './index.js'

// ── signers ───────────────────────────────────────────────────────────────────────

export interface TypedDataRequest {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address }
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>
  primaryType: string
  message: Record<string, unknown>
}

/** Pays the check from its Gateway balance on Arc Mainnet. Any {address, signTypedData}. */
export interface GatewayPayerSigner {
  readonly address: Address
  signTypedData(r: TypedDataRequest): Promise<Hex>
}

export interface ArcPreparedTx {
  chainId: number
  from: Address
  /** The vault. */
  to: Address
  /** pay(payee, amountUnits), encoded from your inputs. */
  data: Hex
  /** Always 0n: the vault moves USDC, the transaction carries no value. */
  value: bigint
  gas: bigint
  /** Wei per gas, at least ARC_MAINNET.minMaxFeePerGasWei. */
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/** The vault's operator. Called at most once per verifyThenPay, only after ALLOW or WARN with payOnWarn. */
export interface ArcOperatorSigner {
  readonly address: Address
  sendTransaction(tx: ArcPreparedTx): Promise<Hex>
}

/** Structurally a viem WalletClient with an account and a chain. */
export interface ViemWalletLike {
  account?: { address: string }
  chain?: { id: number } | null
  sendTransaction(args: never): Promise<Hex>
  signTypedData(args: never): Promise<Hex>
}

/** A viem chain object for Arc Mainnet, for createWalletClient({ chain: arcViemChain, ... }). */
export const arcViemChain = {
  id: ARC_MAINNET.chainId,
  name: 'Arc Mainnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: ARC_MAINNET.nativeDecimals },
  rpcUrls: { default: { http: [...ARC_MAINNET.rpcUrls] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: ARC_MAINNET.explorer } },
}

/**
 * Wrap a viem wallet (with its account and chain set) as both an operator and a payer. A wallet
 * on any other chain is refused here, so a payment can never be signed for the wrong chain id.
 */
export function fromViemWallet(wallet: ViemWalletLike): ArcOperatorSigner & GatewayPayerSigner {
  const account = wallet.account
  if (!account?.address) throw new TypeError('fromViemWallet needs a wallet with an account')
  if (wallet.chain?.id !== ARC_MAINNET.chainId) {
    throw new TypeError(`fromViemWallet needs a wallet on Arc Mainnet (chain id ${ARC_MAINNET.chainId}, for example arcViemChain); this one is on ${wallet.chain?.id ?? 'no chain'}`)
  }
  return {
    address: account.address as Address,
    signTypedData: (r) => wallet.signTypedData({ account, ...r } as never),
    sendTransaction: (tx) =>
      wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      } as never),
  }
}

// ── errors ────────────────────────────────────────────────────────────────────────

/** A peer dependency is missing. Nothing was signed or paid. */
export class ArcDependencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArcDependencyError'
  }
}

/** The money is not the registry's USDC. Thrown before anything is bought or signed. */
export class ArcAssetError extends Error {
  readonly code: 'WRONG_ASSET' | 'VAULT_TOKEN_MISMATCH'
  readonly expected: Address
  readonly got: string | null
  constructor(code: ArcAssetError['code'], message: string, got: string | null) {
    super(message)
    this.name = 'ArcAssetError'
    this.code = code
    this.expected = ARC_MAINNET.usdc
    this.got = got
  }
}

/** The payee is not an agent on Arc Mainnet, or the registry could not say. */
export class PayeeNotRegisteredError extends Error {
  readonly code: 'PAYEE_UNREGISTERED' | 'PAYEE_AGENT_MISMATCH' | 'REGISTRY_UNREADABLE'
  readonly payee: Address
  constructor(code: PayeeNotRegisteredError['code'], message: string, payee: Address) {
    super(message)
    this.name = 'PayeeNotRegisteredError'
    this.code = code
    this.payee = payee
  }
}

export type VaultRefusalCode =
  | 'NotOperator'
  | 'IsFrozen'
  | 'SessionKeyExpired'
  | 'PayeeNotAllowed'
  | 'AboveAutoApprove'
  | 'DailyCapExceeded'
  | 'InvalidPayee'
  | 'ZeroAddress'
  | 'TransferFailed'
  | 'InsufficientVaultBalance'
  | 'InsufficientGas'
  | 'GasPriceAboveCap'
  | 'VaultUnreadable'
  | 'NOT_A_VAULT'
  | 'SimulationReverted'

/** The vault would refuse this payment, or could not be read. Nothing was sent to it. */
export class VaultPolicyError extends Error {
  readonly code: VaultRefusalCode
  /** preflight: before the check, nothing paid. simulation: after the check, which was paid. */
  readonly stage: 'preflight' | 'simulation'
  readonly vault: Address
  readonly flowId?: Hex
  readonly recordUrl?: string
  constructor(code: VaultRefusalCode, message: string, o: { stage: 'preflight' | 'simulation'; vault: Address; flowId?: Hex; recordUrl?: string }) {
    super(message)
    this.name = 'VaultPolicyError'
    this.code = code
    this.stage = o.stage
    this.vault = o.vault
    if (o.flowId) this.flowId = o.flowId
    if (o.recordUrl) this.recordUrl = o.recordUrl
  }
}

export type GatewayCheckCode =
  | 'NO_ARC_OFFER'
  | 'OFFER_MISMATCH'
  | 'DOMAIN_UNPROVEN'
  | 'PRICE_ABOVE_CAP'
  | 'INSUFFICIENT_GATEWAY_BALANCE'
  | 'SIGNING_FAILED'
  | 'REFUSED'
  | 'UNCONFIRMED'
  | 'TOOL_FAILED_AFTER_SETTLEMENT'
  | 'VERDICT_BLOCK_UNREADABLE'
  | 'FLOW_NOT_RECORDED'
  | 'NETWORK'

/** No usable verdict came back. The operator was not called. */
export class GatewayCheckError extends Error {
  readonly code: GatewayCheckCode
  readonly status?: number
  /** Was the check paid for? null: a signed authorization left this process and the answer
   *  does not say. Look the nonce up on GET /api/x402/gateway/proof. */
  readonly paid: boolean | null
  readonly authNonce?: Hex
  /** The server's own refusal code, when it named one. */
  readonly serverCode?: string
  readonly recordUrl?: string
  constructor(code: GatewayCheckCode, message: string, o: { paid: boolean | null; status?: number; authNonce?: Hex; serverCode?: string; recordUrl?: string }) {
    super(message)
    this.name = 'GatewayCheckError'
    this.code = code
    this.paid = o.paid
    if (o.status !== undefined) this.status = o.status
    if (o.authNonce) this.authNonce = o.authNonce
    if (o.serverCode) this.serverCode = o.serverCode
    if (o.recordUrl) this.recordUrl = o.recordUrl
  }
}

export type VaultPaymentCode = 'PREPARED_MISMATCH' | 'BROADCAST_FAILED' | 'TX_MISMATCH' | 'UNDERPRICED' | 'DROPPED' | 'UNCONFIRMED' | 'REVERTED' | 'LOGS_MISMATCH'

/** The payment step failed. With a txHash, look that hash up: never send again with a new
 *  nonce, because a transaction reported as missing can still land. */
export class VaultPaymentError extends Error {
  readonly code: VaultPaymentCode
  readonly flowId: Hex
  readonly txHash?: Hex
  readonly recordUrl?: string
  /** On REVERTED: whether the server recorded the revert. */
  readonly record?: FlowRecordReport
  constructor(code: VaultPaymentCode, message: string, o: { flowId: Hex; txHash?: Hex; recordUrl?: string; record?: FlowRecordReport }) {
    super(message)
    this.name = 'VaultPaymentError'
    this.code = code
    this.flowId = o.flowId
    if (o.txHash) this.txHash = o.txHash
    if (o.recordUrl) this.recordUrl = o.recordUrl
    if (o.record) this.record = o.record
  }
}

// ── public shapes ─────────────────────────────────────────────────────────────────

export interface ArcClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export interface VerifyThenPayOptions {
  vault: Address
  /** The address to pay. It is what risk_check scores: a CAIP id is never sent. */
  payee: Address
  /** USDC base units, 6 decimals, as a bigint. See usdcUnits(). */
  amountUnits: bigint
  /** Refused unless it is ARC_MAINNET.usdc. */
  asset?: Address
  /** 'eip155:<arc chain id>:8004/<n>' or '#<n>'. When given, ownerOf(n) must be the payee. */
  payeeAgentId?: string
  /** The vault's operator. Must be the address vault.operator() returns. */
  signer: ArcOperatorSigner
  /** Pays the check. Default: `signer`, when it can also sign typed data. It holds the
   *  Gateway balance, and must not be the offer's payTo (Gateway rejects a self-transfer). */
  payer?: GatewayPayerSigner
  /** On WARN, pay anyway. Default false: WARN hands the payment to the owner. */
  payOnWarn?: boolean
  /** The most to pay for the check. Default 5000n (0.005 USDC). */
  maxCheckUnits?: bigint
  /** Refuse above this fee. Default 200 gwei. */
  maxFeePerGasCapWei?: bigint
  /** The tip. Default 1 gwei. */
  maxPriorityFeePerGasWei?: bigint
  /** How long to look for the receipt. Default 60000. */
  receiptTimeoutMs?: number
  /** How long a transaction no RPC knows may stay unknown before it is reported DROPPED. Default 10000. */
  droppedAfterMs?: number
  /** Pause between receipt rounds. Default 1500. */
  receiptPollMs?: number
  /** Deadline for one call to the A-Identity API. Default 60000. */
  requestTimeoutMs?: number
  /** Re-read Gateway's own /v1/x402/supported before signing. Default true. */
  proveDomain?: boolean
  /** Default ARC_MAINNET.rpcUrls. */
  rpcUrls?: readonly string[]
  /** Default 'https://a-identity.xyz'. Https, or http on this machine. */
  baseUrl?: string
  /** Used for the A-Identity API and Gateway, and for the RPCs unless `chain` is given. */
  fetch?: FetchLike
  chain?: ArcChainReader
  /** Inject time (tests). */
  clock?: ArcClock
  /** Inject the scheme that signs the check (tests). Default Circle's BatchEvmScheme. */
  gatewayScheme?: GatewaySchemeFactory
}

/** What signs the Gateway authorization. What it returns is compared with the offer before use. */
export type GatewaySchemeFactory = (payer: GatewayPayerSigner) => { createPaymentPayload(version: number, offer: unknown): Promise<unknown> }

export interface VaultPreflight {
  vault: Address
  payee: Address
  amountUnits: bigint
  owner: Address
  operator: Address
  operatorIsContract: boolean
  frozen: boolean
  /** Unix seconds; 0n means no time bound. */
  sessionKeyExpiry: bigint
  allowlistEnabled: boolean
  payeeAllowed: boolean
  autoApproveMax: bigint
  dailyCap: bigint
  spentToday: bigint
  /** The vault's USDC, 6 decimals. */
  balance: bigint
  agentsHeld: number | null
  blockNumber: bigint
  blockTimestamp: bigint
  /** Wei, 18 decimals. */
  gasPriceWei: bigint
  /** The operator's native balance, wei, 18 decimals; null for a contract operator. */
  operatorGasWei: bigint | null
  gasEstimate: bigint
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/** What the server's public flow record says after a hash was posted to it. */
export interface FlowRecordReport {
  url: string
  /** True only when the server read the receipt from the chain and wrote it down. */
  recorded: boolean
  outcome?: string
  detail?: string
  code?: string
  reason?: string
  /** A payment answers the latest check before it: the flow this one was linked to instead. */
  answersFlow?: string
}

export interface PaymentProof {
  txHash: Hex
  blockNumber: bigint
  vault: Address
  payee: Address
  amountUnits: bigint
  gasUsed: bigint
  /** Wei per gas, 18 decimals. */
  effectiveGasPrice: bigint
  /** The host whose receipt was used. */
  readBackFrom: string | null
  /** False when no RPC returned the transaction itself, so only its receipt was compared. */
  transactionReadBack: boolean
  explorerUrl: string
}

export interface OwnerPayHandoff {
  chainId: number
  to: Address
  from: Address
  value: '0'
  data: Hex
  function: 'ownerPay(address,uint256)'
  args: [Address, string]
  /** Wei per gas to send it with, at least ARC_MAINNET.minMaxFeePerGasWei. */
  maxFeePerGas: string
  gas: string | null
  /** The server's simulation from the owner, at the latest block after the verdict. */
  simulation: { ok: true } | { ok: false; error: string }
}

export type VerifyThenPayResult =
  | { outcome: 'executed'; flowId: Hex; verdict: RiskVerdict; check: GatewayCheckReference; payment: PaymentProof; record: FlowRecordReport }
  | { outcome: 'awaiting_human'; flowId: Hex; verdict: RiskVerdict; check: GatewayCheckReference; ownerPay: OwnerPayHandoff; record: FlowRecordReport }

export interface ArcGatewayPayerOptions {
  /** The most this payer pays for one call. Default 10000n (0.01 USDC, the dearest single-agent tool). */
  maxUnitsPerCall?: bigint
  /** Re-read Gateway's own /v1/x402/supported before signing. Default true. */
  proveDomain?: boolean
  fetch?: FetchLike
}

// ── small helpers ─────────────────────────────────────────────────────────────────

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEFAULT_BASE_URL = 'https://a-identity.xyz'
const DEFAULT_MAX_CHECK_UNITS = 5000n
const DEFAULT_MAX_UNITS_PER_CALL = 10_000n
const GWEI = 1_000_000_000n
const DEFAULT_FEE_CAP_WEI = 200n * GWEI
const DEFAULT_TIP_WEI = GWEI
const GAS_HEADROOM_PCT = 20n
/** The server's own margin: the call is sent after the check, not now. */
const EXPIRY_MARGIN_SEC = 60n
const DEFAULT_RECEIPT_TIMEOUT_MS = 60_000
const DEFAULT_DROPPED_AFTER_MS = 10_000
const DEFAULT_POLL_MS = 1500
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const RECEIPT_POST_ATTEMPTS = 3
const RECEIPT_POST_PAUSE_MS = 2000
const VTP_PATH = '/api/x402/gateway/verify-then-pay'
const FLOWS_PATH = '/api/x402/gateway/flows'

const realClock: ArcClock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const lc = (v: unknown): string | null => (typeof v === 'string' ? v.toLowerCase() : null)
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const flowUrl = (baseUrl: string, flowId: string): string => `${baseUrl}${FLOWS_PATH}/${flowId}`

/** '0.25' -> 250000n. String math only: a float cannot be passed in by accident. */
export function usdcUnits(decimal: string): bigint {
  if (typeof decimal !== 'string') throw new TypeError('usdcUnits takes a decimal string, for example "0.25", never a number')
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(decimal)
  if (!m) throw new RangeError(`not a plain non-negative decimal: ${JSON.stringify(decimal)}`)
  const places = ARC_MAINNET.usdcDecimals
  const frac = m[2] ?? ''
  if (frac.length > places) throw new RangeError(`USDC has ${places} decimals; ${decimal} has ${frac.length}`)
  return BigInt(m[1] + frac.padEnd(places, '0'))
}

function requireAddress(v: unknown, what: string): Address {
  if (typeof v !== 'string' || !ADDRESS.test(v)) throw new TypeError(`${what} must be a 0x address`)
  return v.toLowerCase() as Address
}

/** The part of viem used here, loosely typed: the ABIs are data and the calls are by name. */
type Viem = {
  encodeFunctionData(a: { abi: unknown; functionName: string; args?: readonly unknown[] }): Hex
  decodeFunctionResult(a: { abi: unknown; functionName: string; data: Hex }): unknown
  decodeErrorResult(a: { abi: unknown; data: Hex }): { errorName: string }
  decodeEventLog(a: { abi: unknown; topics: readonly Hex[]; data: Hex; strict: boolean }): { eventName?: string; args?: Record<string, unknown> }
}
type Batching = typeof import('@circle-fin/x402-batching/client')

async function loadViem(): Promise<Viem> {
  try {
    return (await import('viem')) as unknown as Viem
  } catch {
    throw new ArcDependencyError("@a-identity/trust-guard/arc needs the 'viem' package: npm install viem")
  }
}

async function loadBatching(): Promise<Batching> {
  try {
    return await import('@circle-fin/x402-batching/client')
  } catch {
    throw new ArcDependencyError("@a-identity/trust-guard/arc needs the '@circle-fin/x402-batching' package: npm install @circle-fin/x402-batching")
  }
}

/** One call to an HTTP API, cut off at its deadline however the fetch behaves. */
async function httpCall(doFetch: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; headers: Headers; body: unknown }> {
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort()
      reject(new Error(`no answer from ${url} within ${timeoutMs} ms`))
    }, timeoutMs)
  })
  const ask = async () => {
    const res = await doFetch(url, { ...init, signal: ctl.signal })
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { status: res.status, headers: res.headers, body }
  }
  try {
    return await Promise.race([ask(), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── the free checks ───────────────────────────────────────────────────────────────

type Got<T> = { ok: true; value: T } | { ok: false; reverted: boolean; error: string; data?: Hex }

async function got<T>(p: Promise<T>): Promise<Got<T>> {
  try {
    return { ok: true, value: await p }
  } catch (e) {
    if (e instanceof ArcCallRevert) return { ok: false, reverted: true, error: e.message, ...(e.data ? { data: e.data } : {}) }
    return { ok: false, reverted: false, error: msg(e) }
  }
}

const hasCode = (c: string): boolean => c !== '0x' && c.length > 2

const REGISTRY_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
] as const

const TRANSFER_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

type Ctx = {
  v: Viem
  chain: ArcChainReader
  capWei: bigint
  tipWei: bigint
}

/** Read a view function. Bytes a contract returned that do not decode (a contract without this
 *  function answers empty) count as a revert: the contract answered, and not as a vault would. */
async function view<T>(ctx: Ctx, to: Address, abi: unknown, functionName: string, args: readonly unknown[] = []): Promise<Got<T>> {
  const data = ctx.v.encodeFunctionData({ abi, functionName, args })
  const raw = await got(ctx.chain.call({ to, data }))
  if (!raw.ok) return raw
  try {
    return { ok: true, value: ctx.v.decodeFunctionResult({ abi, functionName, data: raw.value }) as T }
  } catch (e) {
    return { ok: false, reverted: true, error: `undecodable answer: ${msg(e)}` }
  }
}

function payCalldata(v: Viem, kind: 'pay' | 'ownerPay', payee: Address, amount: bigint): Hex {
  return v.encodeFunctionData({ abi: ARC_VAULT_ABI, functionName: kind, args: [payee, amount] }).toLowerCase() as Hex
}

/** The fee, the same rule the server uses: 2 x gas price + tip, floored where Arc would drop
 *  the transaction, clamped to the cap, and refused when even the price plus the tip is above it. */
function feesFor(gasPriceWei: bigint, capWei: bigint, tipWei: bigint): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null {
  if (gasPriceWei + tipWei > capWei) return null
  const wanted = 2n * gasPriceWei + tipWei
  const floored = wanted > ARC_MAINNET.minMaxFeePerGasWei ? wanted : ARC_MAINNET.minMaxFeePerGasWei
  const maxFeePerGas = floored > capWei ? capWei : floored
  return { maxFeePerGas, maxPriorityFeePerGas: tipWei < maxFeePerGas ? tipWei : maxFeePerGas }
}

function gasLimitFor(estimate: bigint): bigint {
  return (estimate * (100n + GAS_HEADROOM_PCT) + 99n) / 100n
}

/** The vault's own error name from a revert's bytes; null when there are none to decode. */
function vaultErrorName(v: Viem, data: Hex | undefined): string | null {
  if (!data || data === '0x') return null
  try {
    return v.decodeErrorResult({ abi: ARC_VAULT_ABI, data }).errorName
  } catch {
    return null
  }
}

const VAULT_REVERTS: readonly VaultRefusalCode[] = ['ZeroAddress', 'InvalidPayee', 'IsFrozen', 'SessionKeyExpired', 'PayeeNotAllowed', 'AboveAutoApprove', 'DailyCapExceeded', 'NotOperator', 'TransferFailed']

type PreflightInput = { vault: Address; payee: Address; amountUnits: bigint; tokenId: bigint | null; operator: Address; stage: 'preflight' | 'simulation'; flowId?: Hex; recordUrl?: string; checkPayee: boolean }

/**
 * Everything that can be known for free, in the order the server uses: the asset, the payee,
 * the policy (the contract's own order, against the block's clock rather than ours), the fee,
 * the simulation, the gas. Each failure throws the error that names it.
 */
async function runPreflight(ctx: Ctx, p: PreflightInput): Promise<VaultPreflight> {
  const { v, chain } = ctx
  const { vault, payee, amountUnits } = p
  const where = { stage: p.stage, vault, ...(p.flowId ? { flowId: p.flowId } : {}), ...(p.recordUrl ? { recordUrl: p.recordUrl } : {}) }
  const refuse = (code: VaultRefusalCode, message: string) => new VaultPolicyError(code, message, where)
  const getter = <T>(name: string, args: readonly unknown[] = []) => view<T>(ctx, vault, ARC_VAULT_ABI, name, args)

  const [code, usdc, owner, operator, frozen, expiry, allowlist, allowed, ceiling, cap, spent, balance, block, gasPrice] = await Promise.all([
    got(chain.code(vault)),
    getter<string>('usdc'),
    getter<string>('owner'),
    getter<string>('operator'),
    getter<boolean>('frozen'),
    getter<bigint>('sessionKeyExpiry'),
    getter<boolean>('allowlistEnabled'),
    getter<boolean>('allowed', [payee]),
    getter<bigint>('autoApproveMax'),
    getter<bigint>('dailyCap'),
    getter<bigint>('spentToday'),
    getter<bigint>('balance'),
    got(chain.latestBlock()),
    got(chain.gasPrice()),
  ])

  // The asset.
  if (!code.ok) throw refuse('VaultUnreadable', `Arc Mainnet did not answer for the vault's code: ${code.error}`)
  if (!hasCode(code.value)) throw refuse('NOT_A_VAULT', `there is no contract at ${vault} on Arc Mainnet`)
  if (!usdc.ok) {
    if (usdc.reverted) throw refuse('NOT_A_VAULT', 'the contract does not answer usdc(), so it is not an AgentSpendPolicy vault')
    throw refuse('VaultUnreadable', `Arc Mainnet did not answer usdc(): ${usdc.error}`)
  }
  if (lc(usdc.value) !== ARC_MAINNET.usdc.toLowerCase()) {
    throw new ArcAssetError('VAULT_TOKEN_MISMATCH', `the vault's usdc() is ${usdc.value}, not Arc Mainnet's USDC ${ARC_MAINNET.usdc}`, usdc.value)
  }

  // The payee.
  let agentsHeld: number | null = null
  if (p.checkPayee) agentsHeld = await readPayee(ctx, payee, p.tokenId)

  // The policy.
  const named: [string, Got<unknown>][] = [
    ['owner', owner],
    ['operator', operator],
    ['frozen', frozen],
    ['allowlistEnabled', allowlist],
    ['allowed', allowed],
    ['autoApproveMax', ceiling],
    ['dailyCap', cap],
    ['spentToday', spent],
    ['balance', balance],
  ]
  const reverted = named.filter(([, r]) => !r.ok && r.reverted).map(([n]) => n)
  if (reverted.length) throw refuse('NOT_A_VAULT', `the contract does not answer ${reverted.join(', ')}, so it is not an AgentSpendPolicy vault`)
  const missing = named.filter(([, r]) => !r.ok).map(([n]) => n)
  // A vault built before the session-key getter existed answers it with a revert: no time bound.
  if (!expiry.ok && !expiry.reverted) missing.push('sessionKeyExpiry')
  if (!block.ok) missing.push('latest block')
  if (!gasPrice.ok) missing.push('eth_gasPrice')
  if (missing.length) throw refuse('VaultUnreadable', `Arc Mainnet did not answer: ${missing.join(', ')}`)
  // Narrowed by the two checks above; the compiler cannot see through the list.
  const value = <T>(r: Got<T>): T => (r as { value: T }).value
  const sessionKeyExpiry = expiry.ok ? expiry.value : 0n
  const facts = {
    owner: value(owner).toLowerCase() as Address,
    operator: value(operator).toLowerCase() as Address,
    frozen: value(frozen),
    allowlistEnabled: value(allowlist),
    payeeAllowed: value(allowed),
    autoApproveMax: value(ceiling),
    dailyCap: value(cap),
    spentToday: value(spent),
    balance: value(balance),
  }
  const { number: blockNumber, timestamp: blockTimestamp } = value(block)
  const gasPriceWei = value(gasPrice)

  if (facts.operator === ZERO_ADDRESS) throw refuse('NotOperator', 'the vault has no operator, so no key can call pay()')
  if (facts.operator !== p.operator) throw refuse('NotOperator', `the vault's operator is ${facts.operator}, not the signer ${p.operator}`)
  if (facts.frozen) throw refuse('IsFrozen', 'the vault is frozen by its owner')
  if (sessionKeyExpiry !== 0n && blockTimestamp + EXPIRY_MARGIN_SEC > sessionKeyExpiry) {
    throw refuse('SessionKeyExpired', `the operator's session key expires at ${sessionKeyExpiry} (unix), within ${EXPIRY_MARGIN_SEC} s of the latest block or before it`)
  }
  if (facts.allowlistEnabled && !facts.payeeAllowed) throw refuse('PayeeNotAllowed', 'the vault has its allowlist on and the payee is not on it')
  if (facts.autoApproveMax !== 0n && amountUnits > facts.autoApproveMax) {
    throw refuse('AboveAutoApprove', `${amountUnits} units is above the vault's per-payment ceiling of ${facts.autoApproveMax}; only the owner can pay it (ownerPay)`)
  }
  if (facts.dailyCap !== 0n && facts.spentToday + amountUnits > facts.dailyCap) {
    throw refuse('DailyCapExceeded', `the vault has spent ${facts.spentToday} of its ${facts.dailyCap} units today, so ${amountUnits} more would pass the cap`)
  }
  if (facts.balance < amountUnits) throw refuse('InsufficientVaultBalance', `the vault holds ${facts.balance} units, less than the ${amountUnits} to pay`)

  // The fee.
  const fees = feesFor(gasPriceWei, ctx.capWei, ctx.tipWei)
  if (!fees) throw refuse('GasPriceAboveCap', `the gas price is ${gasPriceWei} wei, so even the price plus the tip is above the ${ctx.capWei} wei cap`)

  // The simulation, from the operator, with the call the payment will be.
  const data = payCalldata(v, 'pay', payee, amountUnits)
  const sim = await got(chain.call({ to: vault, data, from: facts.operator }))
  const est = sim.ok ? await got(chain.estimateGas({ from: facts.operator, to: vault, data })) : sim
  if (!est.ok) {
    if (!est.reverted) throw refuse('VaultUnreadable', `pay() could not be simulated: ${est.error}`)
    const name = vaultErrorName(v, est.data)
    const code = VAULT_REVERTS.find((c) => c === name) ?? 'SimulationReverted'
    throw refuse(code, `pay() from the operator reverts at the latest block: ${name ?? est.error}`)
  }
  const gasEstimate = est.value as bigint
  const gasLimit = gasLimitFor(gasEstimate)

  // The gas. A contract operator's gas is paid by whoever relays its call, so its own balance
  // proves nothing; an EOA operator holds it itself, in native USDC at 18 decimals.
  const [opCode, opGas] = await Promise.all([got(chain.code(facts.operator)), got(chain.nativeBalance(facts.operator))])
  if (!opCode.ok) throw refuse('VaultUnreadable', `Arc Mainnet did not answer for the operator's code: ${opCode.error}`)
  const operatorIsContract = hasCode(opCode.value)
  let operatorGasWei: bigint | null = null
  if (!operatorIsContract) {
    if (!opGas.ok) throw refuse('VaultUnreadable', `Arc Mainnet did not answer for the operator's gas balance: ${opGas.error}`)
    operatorGasWei = opGas.value
    const need = gasLimit * fees.maxFeePerGas
    if (operatorGasWei < need) throw refuse('InsufficientGas', `the operator holds ${operatorGasWei} wei of gas and pay() can cost up to ${need} wei`)
  }

  return {
    vault,
    payee,
    amountUnits,
    ...facts,
    operatorIsContract,
    sessionKeyExpiry,
    agentsHeld,
    blockNumber,
    blockTimestamp,
    gasPriceWei,
    operatorGasWei,
    gasEstimate,
    gasLimit,
    ...fees,
  }
}

/** Is the payee an agent on Arc Mainnet's own registry? A contract that said no and a chain
 *  that did not answer are different errors. */
async function readPayee(ctx: Ctx, payee: Address, tokenId: bigint | null): Promise<number | null> {
  const registry = ARC_MAINNET.identityRegistry as Address
  const unreadable = (e: string) => new PayeeNotRegisteredError('REGISTRY_UNREADABLE', `Arc Mainnet's IdentityRegistry could not be read: ${e}`, payee)
  if (tokenId !== null) {
    const own = await view<string>(ctx, registry, REGISTRY_ABI, 'ownerOf', [tokenId])
    if (!own.ok) {
      if (own.reverted) throw new PayeeNotRegisteredError('PAYEE_UNREGISTERED', `Arc Mainnet's IdentityRegistry has no agent #${tokenId} (ownerOf reverted)`, payee)
      throw unreadable(own.error)
    }
    if (lc(own.value) !== payee) throw new PayeeNotRegisteredError('PAYEE_AGENT_MISMATCH', `agent #${tokenId} on Arc Mainnet is owned by ${own.value}, not by the payee`, payee)
    return null
  }
  const bal = await view<bigint>(ctx, registry, REGISTRY_ABI, 'balanceOf', [payee])
  if (!bal.ok) throw unreadable(bal.error)
  if (bal.value <= 0n) throw new PayeeNotRegisteredError('PAYEE_UNREGISTERED', "the payee holds no ERC-8004 agent on Arc Mainnet's IdentityRegistry", payee)
  return Number(bal.value)
}

function parseAgentId(id: string | undefined, payee: Address): bigint | null {
  if (id === undefined) return null
  if (typeof id !== 'string') throw new TypeError('payeeAgentId must be a string')
  const s = id.trim()
  const caip = /^(eip155:[0-9]{1,12}):8004\/([0-9]{1,30})$/i.exec(s)
  const bare = /^#?([0-9]{1,30})$/.exec(s)
  if (caip && caip[1].toLowerCase() !== ARC_MAINNET.caip2) {
    throw new PayeeNotRegisteredError('PAYEE_AGENT_MISMATCH', `payeeAgentId names ${caip[1]}; this flow pays on Arc Mainnet (${ARC_MAINNET.caip2})`, payee)
  }
  const digits = caip?.[2] ?? bare?.[1]
  if (!digits) throw new TypeError(`payeeAgentId must be "${ARC_MAINNET.caip2}:8004/<n>" or "#<n>"`)
  return BigInt(digits)
}

function feeCaps(o: { maxFeePerGasCapWei?: bigint; maxPriorityFeePerGasWei?: bigint }): { capWei: bigint; tipWei: bigint } {
  const capWei = o.maxFeePerGasCapWei ?? DEFAULT_FEE_CAP_WEI
  const tipWei = o.maxPriorityFeePerGasWei ?? DEFAULT_TIP_WEI
  if (typeof capWei !== 'bigint' || capWei < ARC_MAINNET.minMaxFeePerGasWei) throw new RangeError(`a fee cap below ${ARC_MAINNET.minMaxFeePerGasWei} wei could never be included on Arc`)
  if (typeof tipWei !== 'bigint' || tipWei < 0n) throw new RangeError('the tip must be a non-negative bigint')
  return { capWei, tipWei }
}

type CheckedPayment = { vault: Address; payee: Address; amountUnits: bigint; tokenId: bigint | null }

/** The inputs, with nothing read: wrong shapes, a wrong asset and payees the vault refuses. */
function checkPaymentInput(o: Pick<VerifyThenPayOptions, 'vault' | 'payee' | 'amountUnits' | 'asset' | 'payeeAgentId'>): CheckedPayment {
  const vault = requireAddress(o.vault, 'vault')
  const payee = requireAddress(o.payee, 'payee')
  if (typeof o.amountUnits !== 'bigint') throw new TypeError('amountUnits must be a bigint of USDC base units (see usdcUnits), never a float')
  if (o.amountUnits <= 0n) throw new RangeError('amountUnits must be above zero')
  const usdc = ARC_MAINNET.usdc.toLowerCase()
  if (o.asset !== undefined && lc(requireAddress(o.asset, 'asset')) !== usdc) {
    throw new ArcAssetError('WRONG_ASSET', `the asset must be Arc Mainnet's USDC ${ARC_MAINNET.usdc}, not ${o.asset}`, o.asset)
  }
  const where = { stage: 'preflight' as const, vault }
  if (payee === ZERO_ADDRESS) throw new VaultPolicyError('ZeroAddress', 'the payee is the zero address', where)
  if (payee === vault || payee === usdc) throw new VaultPolicyError('InvalidPayee', 'the payee is the vault itself or the USDC contract; the vault refuses both', where)
  return { vault, payee, amountUnits: o.amountUnits, tokenId: parseAgentId(o.payeeAgentId, payee) }
}

/** The free checks alone: nothing is signed and nothing is bought. Throws what verifyThenPay
 *  would throw before the check; returns the vault's facts when it would pay. */
export async function preflightVault(
  o: Pick<VerifyThenPayOptions, 'vault' | 'payee' | 'amountUnits' | 'asset' | 'payeeAgentId' | 'rpcUrls' | 'chain' | 'fetch' | 'maxFeePerGasCapWei' | 'maxPriorityFeePerGasWei'> & { operator: Address },
): Promise<VaultPreflight> {
  const input = checkPaymentInput(o)
  const operator = requireAddress(o.operator, 'operator')
  const chain = o.chain ?? arcChainReader(o.rpcUrls, o.fetch ? { fetch: o.fetch } : {})
  const ctx: Ctx = { v: await loadViem(), chain, ...feeCaps(o) }
  return runPreflight(ctx, { ...input, operator, stage: 'preflight', checkPayee: true })
}

// ── the offer ─────────────────────────────────────────────────────────────────────

type Offer = Record<string, unknown> & { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number; extra: Record<string, unknown> }

/** The Arc Mainnet offer in a challenge, checked before anything is signed. Every field the
 *  authorization would be bound to has to be the one this package knows, not the one it was shown. */
function readOffer(challenge: unknown, payer: Address, maxUnits: bigint, status?: number): Offer {
  const unpaid = { paid: false as const, ...(status !== undefined ? { status } : {}) }
  const accepts = isObject(challenge) && Array.isArray(challenge.accepts) ? (challenge.accepts as unknown[]) : []
  const offer = accepts.find((a): a is Record<string, unknown> => isObject(a) && a.network === ARC_MAINNET.caip2)
  if (!offer) throw new GatewayCheckError('NO_ARC_OFFER', `the challenge offers nothing on Arc Mainnet (${ARC_MAINNET.caip2})`, unpaid)
  const bad = (why: string) => new GatewayCheckError('OFFER_MISMATCH', `refused to sign: ${why}`, unpaid)
  const extra = isObject(offer.extra) ? offer.extra : {}
  if (offer.scheme !== 'exact') throw bad(`the scheme is ${String(offer.scheme)}, not exact`)
  if (extra.name !== 'GatewayWalletBatched') throw bad(`extra.name is ${String(extra.name)}, not GatewayWalletBatched`)
  if (extra.version !== '1') throw bad(`extra.version is ${String(extra.version)}, not 1`)
  if (lc(extra.verifyingContract) !== ARC_MAINNET.gatewayWallet.toLowerCase()) throw bad(`the verifyingContract is ${String(extra.verifyingContract)}, not Arc Mainnet's GatewayWallet ${ARC_MAINNET.gatewayWallet}`)
  if (lc(offer.asset) !== ARC_MAINNET.usdc.toLowerCase()) throw bad(`the asset is ${String(offer.asset)}, not Arc Mainnet's USDC ${ARC_MAINNET.usdc}`)
  if (typeof offer.amount !== 'string' || !/^[1-9][0-9]*$/.test(offer.amount)) throw bad(`the amount ${String(offer.amount)} is not a positive integer of base units`)
  if (typeof offer.payTo !== 'string' || !ADDRESS.test(offer.payTo)) throw bad('the offer names no payTo address')
  if (offer.payTo.toLowerCase() === payer) throw bad(`the payer ${payer} is the offer's payTo; Gateway rejects a self-transfer, so use a separate payer`)
  if (typeof offer.maxTimeoutSeconds !== 'number' || !Number.isFinite(offer.maxTimeoutSeconds) || offer.maxTimeoutSeconds <= 0) throw bad('the offer carries no usable maxTimeoutSeconds')
  if (BigInt(offer.amount) > maxUnits) throw new GatewayCheckError('PRICE_ABOVE_CAP', `refused to sign: the check costs ${offer.amount} units, above the ${maxUnits} cap`, unpaid)
  return offer as Offer
}

/** Gateway's own word on the domain, read live. The offer already matches the constants this
 *  package was built with, so what this catches is the constants having gone stale. */
async function proveOffer(doFetch: FetchLike, offer: Offer, timeoutMs: number): Promise<void> {
  const unproven = (why: string) => new GatewayCheckError('DOMAIN_UNPROVEN', `refused to sign: ${why}`, { paid: false })
  let body: unknown
  try {
    const res = await httpCall(doFetch, `${ARC_MAINNET.gatewayFacilitator}/v1/x402/supported`, { method: 'GET' }, timeoutMs)
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    body = res.body
  } catch (e) {
    throw unproven(`Gateway's supported kinds could not be read (${msg(e)})`)
  }
  const kinds = isObject(body) && Array.isArray(body.kinds) ? (body.kinds as unknown[]) : []
  const live = kinds.find((k): k is Record<string, unknown> => isObject(k) && k.network === offer.network && k.scheme === 'exact')
  if (!live) throw unproven(`Gateway does not advertise ${offer.network} right now`)
  const extra = isObject(live.extra) ? live.extra : {}
  if (lc(extra.verifyingContract) !== lc(offer.extra.verifyingContract)) throw unproven(`Gateway says the verifyingContract is ${String(extra.verifyingContract)}, the offer says ${String(offer.extra.verifyingContract)}`)
  const assets = Array.isArray(extra.assets) ? (extra.assets as unknown[]) : []
  if (!assets.some((a) => isObject(a) && lc(a.address) === lc(offer.asset))) throw unproven(`Gateway does not settle ${offer.asset} on ${offer.network}`)
}

/** Refuse before signing when Gateway says the balance cannot pay. A balance that cannot be read
 *  refuses nothing: Gateway itself enforces it at settlement, and then no money moves. */
async function checkGatewayBalance(doFetch: FetchLike, payer: Address, amount: bigint, timeoutMs: number): Promise<void> {
  let available: bigint | null = null
  try {
    const res = await httpCall(
      doFetch,
      `${ARC_MAINNET.gatewayFacilitator}/v1/balances`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'USDC', sources: [{ domain: ARC_MAINNET.gatewayDomain, depositor: payer }] }) },
      timeoutMs,
    )
    const rows = isObject(res.body) && Array.isArray(res.body.balances) ? (res.body.balances as unknown[]) : []
    const row = rows[0]
    if (res.status === 200 && isObject(row) && typeof row.balance === 'string') available = usdcUnits(row.balance)
  } catch {
    available = null
  }
  if (available !== null && available < amount) {
    throw new GatewayCheckError('INSUFFICIENT_GATEWAY_BALANCE', `the payer ${payer} holds ${available} units on Gateway on Arc Mainnet, less than the ${amount} the check costs; deposit first`, { paid: false })
  }
}

/** One signature over the offer, returned as the PAYMENT-SIGNATURE value. */
async function signOffer(offer: Offer, payer: GatewayPayerSigner, makeScheme?: GatewaySchemeFactory): Promise<{ header: string; nonce: Hex }> {
  let scheme: ReturnType<GatewaySchemeFactory>
  if (makeScheme) scheme = makeScheme(payer)
  else {
    const { BatchEvmScheme } = await loadBatching()
    scheme = new BatchEvmScheme({ address: payer.address, signTypedData: (r: unknown) => payer.signTypedData(r as TypedDataRequest) } as never) as unknown as ReturnType<GatewaySchemeFactory>
  }
  let created: { payload: { authorization: { from: string; to: string; value: unknown; nonce: string }; signature: string } }
  try {
    created = (await scheme.createPaymentPayload(2, offer)) as typeof created
  } catch (e) {
    throw new GatewayCheckError('SIGNING_FAILED', `the payer could not sign the Gateway authorization: ${msg(e)}`, { paid: false })
  }
  const auth = created?.payload?.authorization
  const nonce = lc(auth?.nonce)
  if (!nonce || !HASH.test(nonce) || lc(auth.from) !== payer.address.toLowerCase() || lc(auth.to) !== offer.payTo.toLowerCase() || String(auth.value) !== offer.amount) {
    throw new GatewayCheckError('SIGNING_FAILED', 'the signed authorization does not match the offer, so it was not sent', { paid: false })
  }
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: offer, payload: created.payload })).toString('base64')
  return { header, nonce: nonce as Hex }
}

/**
 * `onPaymentRequired` for `new TrustGuard({ rail: 'arc' })`: a verdict paid through Circle
 * Gateway on Arc Mainnet, with no vault involved. For risk_check, send the payee's ADDRESS as
 * the agent id: the scorer matches platform agents by address, so a CAIP id always comes out
 * off-platform and DENY.
 */
export function arcGatewayPayer(payer: GatewayPayerSigner, opts: ArcGatewayPayerOptions = {}): NonNullable<TrustGuardOptions['onPaymentRequired']> {
  if (!payer || typeof payer.signTypedData !== 'function') throw new TypeError('arcGatewayPayer needs a signer with an address and signTypedData')
  const address = requireAddress(payer.address, 'payer.address')
  const cap = opts.maxUnitsPerCall ?? DEFAULT_MAX_UNITS_PER_CALL
  return async (challenge) => {
    const offer = readOffer(challenge, address, cap)
    if (opts.proveDomain !== false) {
      const doFetch = opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch
      if (!doFetch) throw new TypeError('No fetch available; pass opts.fetch.')
      await proveOffer(doFetch, offer, DEFAULT_REQUEST_TIMEOUT_MS)
    }
    const { header } = await signOffer(offer, payer)
    return { 'PAYMENT-SIGNATURE': header }
  }
}

// ── reading the server's answer ───────────────────────────────────────────────────

function decodeChallengeHeader(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
  } catch {
    throw new GatewayCheckError('OFFER_MISMATCH', 'the PAYMENT-REQUIRED header is not base64 JSON', { paid: false, status: 402 })
  }
}

/** A refusal the server answered with, as the error the same refusal raises locally. */
function refusalError(body: Record<string, unknown>, status: number, o: { vault: Address; payee: Address; authNonce?: Hex }): Error {
  const code = typeof body.code === 'string' ? body.code : undefined
  const reason = typeof body.reason === 'string' ? body.reason : `the server refused (HTTP ${status})`
  if (code === 'WRONG_ASSET' || code === 'VAULT_TOKEN_MISMATCH') {
    const checks = isObject(body.checks) && isObject(body.checks.asset) ? body.checks.asset : {}
    return new ArcAssetError(code, reason, typeof checks.vaultToken === 'string' ? checks.vaultToken : null)
  }
  if (code === 'PAYEE_UNREGISTERED' || code === 'PAYEE_AGENT_MISMATCH' || code === 'REGISTRY_UNREADABLE') return new PayeeNotRegisteredError(code, reason, o.payee)
  const vaultCodes: readonly string[] = [...VAULT_REVERTS, 'InsufficientVaultBalance', 'InsufficientGas', 'GasPriceAboveCap', 'VaultUnreadable', 'NOT_A_VAULT', 'SimulationReverted']
  if (code && vaultCodes.includes(code)) return new VaultPolicyError(code as VaultRefusalCode, reason, { stage: 'preflight', vault: o.vault })
  return new GatewayCheckError('REFUSED', reason, { paid: false, status, ...(code ? { serverCode: code } : {}), ...(o.authNonce ? { authNonce: o.authNonce } : {}) })
}

/** The check the answer says it settled must be the one this process signed. */
function readCheck(body: Record<string, unknown>, nonce: Hex, payer: Address, offer: Offer, fail: (why: string) => UnusableVerdictError): GatewayCheckReference {
  const c = body.check
  if (!isObject(c)) throw fail('the answer carries no check')
  if (c.network !== ARC_MAINNET.caip2) throw fail(`the check settled on ${String(c.network)}, not ${ARC_MAINNET.caip2}`)
  if (lc(c.authNonce) !== nonce) throw fail('the check names another authorization nonce than the one signed')
  if (lc(c.payer) !== payer) throw fail('the check names another payer than the one that signed')
  if (c.gatewayOutcome !== 'credited' && c.gatewayOutcome !== 'completed') throw fail(`the check's outcome is ${String(c.gatewayOutcome)}, not credited or completed`)
  if (String(c.amountUnits) !== offer.amount) throw fail(`the check settled ${String(c.amountUnits)} units, not the ${offer.amount} signed`)
  if (typeof c.resource !== 'string' || !c.resource.endsWith('/risk_check')) throw fail(`the check is for ${String(c.resource)}, not risk_check`)
  if (body.flowId !== null && lc(body.flowId) !== nonce) throw fail('the answer names another flow than the nonce signed')
  return {
    network: c.network,
    authNonce: nonce,
    transferId: typeof c.transferId === 'string' ? c.transferId : null,
    gatewayOutcome: c.gatewayOutcome,
    payer,
    amountUnits: offer.amount,
    resource: c.resource,
    ...(typeof c.checkedAt === 'string' ? { checkedAt: c.checkedAt } : {}),
  }
}

const UNUSABLE_CODES: readonly string[] = ['DECISION_UNKNOWN', 'REPUTATION_NOT_FINITE', 'TENURE_NOT_FINITE', 'SIGNALS_MISSING', 'SIGNALS_INCONSISTENT', 'SETTLEMENT_MISMATCH', 'TOOL_MISMATCH', 'CONTEXT_MISMATCH']

type Answer = { kind: 'prepared'; prepared: Record<string, unknown> } | { kind: 'awaiting_human'; handoff: Record<string, unknown> }
type Verdicted = Answer & { verdict: RiskVerdict; check: GatewayCheckReference; recordUrl: string }

/** What a paid answer decides. Throws for everything that is not a usable ALLOW or WARN. */
function readPaidAnswer(res: { status: number; body: unknown }, o: { vault: Address; payee: Address; amountUnits: bigint; nonce: Hex; payer: Address; offer: Offer; payOnWarn: boolean; baseUrl: string }): Verdicted {
  const { status, body } = res
  const { nonce } = o
  if (!isObject(body) || typeof body.stage !== 'string') {
    throw new GatewayCheckError('NETWORK', `the server answered HTTP ${status} with no readable result, and a signed authorization was sent`, { paid: null, status, authNonce: nonce })
  }
  const stage = body.stage
  const reason = typeof body.reason === 'string' ? body.reason : `the server answered ${stage} (HTTP ${status})`
  const serverCode = typeof body.code === 'string' ? body.code : undefined
  const charged = body.charged === true || body.charged === false ? body.charged : null
  const record = isObject(body.record) ? body.record : null
  // A record the server wrote, at OUR base URL: a server's word never chooses where we post.
  const recordUrl = record?.recorded === true ? flowUrl(o.baseUrl, nonce) : undefined
  const tail = { ...(recordUrl ? { recordUrl } : {}) }

  if (stage === 'refused') throw refusalError(body, status, { vault: o.vault, payee: o.payee, authNonce: nonce })
  if (stage === 'unavailable' || stage === 'payment_required') throw new GatewayCheckError('REFUSED', reason, { paid: false, status, authNonce: nonce, ...(serverCode ? { serverCode } : {}) })
  if (stage === 'check_failed') {
    const code: GatewayCheckCode =
      serverCode === 'VERDICT_BLOCK_UNREADABLE' || serverCode === 'FLOW_NOT_RECORDED' ? serverCode : status === 500 ? 'TOOL_FAILED_AFTER_SETTLEMENT' : charged === null ? 'UNCONFIRMED' : 'REFUSED'
    throw new GatewayCheckError(code, reason, { paid: charged, status, authNonce: nonce, ...(serverCode ? { serverCode } : {}), ...tail })
  }
  const v = isObject(body.verdict) ? body.verdict : null
  const unusable = { verdict: body.verdict ?? null, flowId: nonce, ...tail }
  if (stage === 'verdict_unusable') {
    const code = UNUSABLE_CODES.includes(serverCode ?? '') ? (serverCode as UnusableVerdictCode) : 'SIGNALS_INCONSISTENT'
    throw new UnusableVerdictError(code, `the check was paid and its answer cannot be used: ${reason}`, unusable)
  }
  if (stage !== 'deny' && stage !== 'awaiting_human' && stage !== 'prepared') {
    throw new GatewayCheckError('REFUSED', `the server answered an unknown stage ${JSON.stringify(stage)}`, { paid: charged, status, authNonce: nonce })
  }

  // A verdict. Nothing about it counts until the settlement is shown to be the one signed.
  const check = readCheck(body, nonce, o.payer, o.offer, (why) => new UnusableVerdictError('SETTLEMENT_MISMATCH', `the check was paid and its settlement does not match: ${why}`, unusable))
  const decision = v?.decision
  if (decision !== 'ALLOW' && decision !== 'WARN' && decision !== 'DENY') {
    throw new UnusableVerdictError('DECISION_UNKNOWN', `the decision is ${JSON.stringify(decision ?? null)}, not ALLOW, WARN or DENY`, unusable)
  }
  if (v?.effective !== decision) throw new UnusableVerdictError('DECISION_UNKNOWN', `the decision is ${decision} and its effective decision is ${JSON.stringify(v?.effective ?? null)}`, unusable)
  const reasons = Array.isArray(v.reasons) ? v.reasons.filter((r): r is string => typeof r === 'string') : []
  const verdict: RiskVerdict = {
    tool: 'risk_check',
    // What the server says it is about. An ALLOW or a WARN is compared with the payee below; a
    // DENY about someone else is reported as that, and pays nobody either way.
    agentId: typeof v.agentId === 'string' ? v.agentId : o.payee,
    decision: decision as Decision,
    risk: typeof v.risk === 'string' ? v.risk : 'unknown',
    reasons,
    signals: { reputationScore: v.reputationScore ?? null },
    ...(check.checkedAt ? { checkedAt: check.checkedAt } : {}),
  }
  // A DENY stops here, whatever else the answer says. It needs nothing further to be believed.
  if (decision === 'DENY') throw new TrustDenyError(verdict, { flowId: nonce, check, ...(recordUrl ? { recordUrl } : {}) })
  if (stage === 'deny') throw new UnusableVerdictError('STAGE_MISMATCH', `the stage is deny and the decision is ${decision}`, unusable)
  const rep = v.reputationScore
  if (typeof rep !== 'number' || !Number.isFinite(rep) || rep < 0 || rep > 1000) {
    throw new UnusableVerdictError('REPUTATION_NOT_FINITE', `the reputation is ${JSON.stringify(rep ?? null)}, not a finite number in [0, 1000]; the scorer can turn that into ALLOW`, unusable)
  }
  if (decision === 'ALLOW' && rep < ALLOW_MIN_REPUTATION) {
    throw new UnusableVerdictError('SIGNALS_INCONSISTENT', `ALLOW needs a reputation of at least ${ALLOW_MIN_REPUTATION}, and this one is ${rep}`, unusable)
  }
  // The same arithmetic the server uses for what it sends the scorer.
  const amountUsd = Number(o.amountUnits) / 10 ** ARC_MAINNET.usdcDecimals
  const context = isObject(v.txContext) ? v.txContext : null
  if (lc(v.agentId) !== o.payee || lc(context?.payee) !== o.payee || context?.amountUsd !== amountUsd) {
    throw new UnusableVerdictError('CONTEXT_MISMATCH', `the verdict is about agent ${String(v.agentId)} and context ${JSON.stringify(v.txContext ?? null)}, not this payee and ${amountUsd} USD`, unusable)
  }
  // The decision, the stage and the caller's own payOnWarn have to agree.
  const wanted = decision === 'WARN' && !o.payOnWarn ? 'awaiting_human' : 'prepared'
  if (stage !== wanted) throw new UnusableVerdictError('STAGE_MISMATCH', `a ${decision} with payOnWarn ${o.payOnWarn} must come back as ${wanted}, and it came back as ${stage}`, unusable)
  if (status !== 200 || !recordUrl) {
    throw new GatewayCheckError('FLOW_NOT_RECORDED', `the check was answered and its flow was not recorded (HTTP ${status}), so no payment on it could ever be receipted`, { paid: true, status, authNonce: nonce })
  }
  if (stage === 'prepared') {
    if (!isObject(body.prepared)) throw new UnusableVerdictError('STAGE_MISMATCH', 'the stage is prepared and the answer prepared nothing', unusable)
    return { kind: 'prepared', prepared: body.prepared, verdict, check, recordUrl }
  }
  if (!isObject(body.ownerHandoff)) throw new UnusableVerdictError('STAGE_MISMATCH', 'the stage is awaiting_human and the answer holds no owner hand-off', unusable)
  return { kind: 'awaiting_human', handoff: body.ownerHandoff, verdict, check, recordUrl }
}

/** A wei amount as the server wrote it: digits, or a tampered answer. */
function weiField(v: unknown): bigint | null {
  return typeof v === 'string' && /^[0-9]{1,40}$/.test(v) ? BigInt(v) : null
}

/** The call the server prepared has to be, byte for byte, the call built here from the caller's
 *  own inputs. The server's bytes are compared and never used. */
function compareCall(call: Record<string, unknown>, want: { fn: string; to: Address; from: Address; data: Hex; payee: Address; amountUnits: bigint }): string | null {
  if (call.chainId !== ARC_MAINNET.chainId) return `chainId is ${String(call.chainId)}`
  if (lc(call.to) !== want.to) return `to is ${String(call.to)}, not the vault`
  if (lc(call.from) !== want.from) return `from is ${String(call.from)}, not ${want.from}`
  if (call.value !== '0') return `value is ${String(call.value)}, not 0`
  if (call.function !== want.fn) return `the function is ${String(call.function)}`
  if (lc(call.data) !== want.data) return 'the calldata differs from the call built from your own inputs'
  const args = call.args
  if (!Array.isArray(args) || lc(args[0]) !== want.payee || String(args[1]) !== want.amountUnits.toString()) return 'the arguments differ from your own inputs'
  return null
}

// ── the payment ───────────────────────────────────────────────────────────────────

const decodeLog = (v: Viem, abi: unknown, log: { topics: readonly Hex[]; data: Hex }): { eventName?: string; args?: Record<string, unknown> } | null => {
  try {
    return v.decodeEventLog({ abi, topics: log.topics, data: log.data, strict: true })
  } catch {
    return null
  }
}

/** Did this receipt move exactly this money? The vault's own Paid, and USDC's own Transfer. On
 *  Arc the receipt also carries the same payment's native-balance Transfer, from a system
 *  address in 18 decimals; that one is not USDC's and never counts. */
function receiptProvesPayment(v: Viem, r: ArcReceipt, p: CheckedPayment): boolean {
  const usdc = ARC_MAINNET.usdc.toLowerCase()
  const paid = r.logs.some((l) => {
    if (lc(l.address) !== p.vault) return false
    const d = decodeLog(v, ARC_VAULT_ABI, l)
    return d?.eventName === 'Paid' && lc(d.args?.to) === p.payee && d.args?.amount === p.amountUnits && d.args?.byOwner === false
  })
  const moved = r.logs.some((l) => {
    if (lc(l.address) !== usdc) return false
    const d = decodeLog(v, TRANSFER_ABI, l)
    return d?.eventName === 'Transfer' && lc(d.args?.from) === p.vault && lc(d.args?.to) === p.payee && d.args?.value === p.amountUnits
  })
  return paid && moved
}

/** POST a hash to a flow's receipt route. The server reads the chain itself. Posting the same
 *  hash again is safe and only happens when the server said to or did not answer, a bounded
 *  number of times. No transaction is ever sent from here. */
export async function recordFlowReceipt(o: { flowId: string; txHash: string; baseUrl?: string; fetch?: FetchLike; requestTimeoutMs?: number; clock?: ArcClock }): Promise<FlowRecordReport> {
  if (typeof o.flowId !== 'string' || !HASH.test(o.flowId)) throw new TypeError('flowId must be the 32-byte authorization nonce')
  if (typeof o.txHash !== 'string' || !HASH.test(o.txHash)) throw new TypeError('txHash must be a 32-byte transaction hash')
  const baseUrl = requireSecureBaseUrl(o.baseUrl ?? DEFAULT_BASE_URL)
  const doFetch = o.fetch ?? (globalThis as { fetch?: FetchLike }).fetch
  if (!doFetch) throw new TypeError('No fetch available; pass o.fetch.')
  const clock = o.clock ?? realClock
  const url = flowUrl(baseUrl, o.flowId)
  let last: FlowRecordReport = { url, recorded: false, reason: 'the receipt route was not reached' }
  for (let attempt = 1; attempt <= RECEIPT_POST_ATTEMPTS; attempt++) {
    let again = true
    try {
      const res = await httpCall(doFetch, `${url}/receipt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash: o.txHash }) }, o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      const b = isObject(res.body) ? res.body : {}
      last = {
        url,
        recorded: b.verified === true,
        ...(typeof b.outcome === 'string' ? { outcome: b.outcome } : {}),
        ...(typeof b.detail === 'string' ? { detail: b.detail } : {}),
        ...(typeof b.code === 'string' ? { code: b.code } : {}),
        ...(typeof b.answersFlow === 'string' ? { answersFlow: b.answersFlow } : {}),
        ...(b.verified === true ? {} : { reason: typeof b.reason === 'string' ? b.reason : `the receipt route answered HTTP ${res.status}` }),
      }
      again = b.verified !== true && b.retry === true
    } catch (e) {
      last = { url, recorded: false, reason: `the receipt route did not answer: ${msg(e)}` }
    }
    if (!again) break
    if (attempt < RECEIPT_POST_ATTEMPTS) await clock.sleep(RECEIPT_POST_PAUSE_MS)
  }
  return last
}

type Inputs = CheckedPayment & {
  signer: ArcOperatorSigner
  operator: Address
  payer: GatewayPayerSigner
  payerAddress: Address
  payOnWarn: boolean
  maxCheckUnits: bigint
  gatewayScheme?: GatewaySchemeFactory
  receiptTimeoutMs: number
  droppedAfterMs: number
  receiptPollMs: number
  requestTimeoutMs: number
  proveDomain: boolean
  baseUrl: string
  doFetch: FetchLike
  chain: ArcChainReader
  clock: ArcClock
  capWei: bigint
  tipWei: bigint
  asset?: Address
  payeeAgentId?: string
}

/** Wait for the receipt, with the transaction read back on the way. Never sends anything. */
async function awaitPayment(i: Inputs, hash: Hex, want: { data: Hex; operatorIsContract: boolean; flowId: Hex; recordUrl: string }): Promise<{ receipt: ArcReceipt; tx: ArcTransaction | null }> {
  const { chain, clock } = i
  const fail = (code: VaultPaymentCode, message: string) => new VaultPaymentError(code, message, { flowId: want.flowId, txHash: hash, recordUrl: want.recordUrl })
  const start = clock.now()
  let tx: ArcTransaction | null = null
  for (;;) {
    let receipt: ArcReceipt | null = null
    let receiptAnswered = false
    let txAnswered = false
    try {
      receipt = await chain.receipt(hash)
      receiptAnswered = true
    } catch {
      /* no host answered: neither found nor missing */
    }
    if (!tx) {
      try {
        tx = await chain.transaction(hash)
        txAnswered = true
      } catch {
        /* no host answered */
      }
      if (tx && !want.operatorIsContract) {
        // A contract operator's transaction is its relayer's, sent to its own entry point, so
        // for one of those only the receipt's logs can say what happened.
        if (lc(tx.from) !== i.operator) throw fail('TX_MISMATCH', `the signer sent ${hash} from ${tx.from}, not from the operator ${i.operator}`)
        if (lc(tx.to) !== i.vault) throw fail('TX_MISMATCH', `the signer sent ${hash} to ${String(tx.to)}, not to the vault`)
        if (lc(tx.input) !== want.data) throw fail('TX_MISMATCH', `the signer sent ${hash} with other calldata than pay(payee, amountUnits)`)
        if (!receipt && tx.maxFeePerGas !== null && tx.maxFeePerGas < ARC_MAINNET.minMaxFeePerGasWei) {
          throw fail('UNDERPRICED', `the wallet sent ${hash} with maxFeePerGas ${tx.maxFeePerGas}, below the ${ARC_MAINNET.minMaxFeePerGasWei} wei where Arc drops a transaction without an error`)
        }
      }
    }
    if (receipt) return { receipt, tx }
    const elapsed = clock.now() - start
    if (!tx && receiptAnswered && txAnswered && elapsed >= i.droppedAfterMs) {
      throw fail('DROPPED', `after ${elapsed} ms no RPC knows ${hash}. It may still land: look that hash up, and do not send again with a new nonce`)
    }
    if (elapsed >= i.receiptTimeoutMs) {
      throw fail('UNCONFIRMED', `no RPC returned a receipt for ${hash} within ${i.receiptTimeoutMs} ms. It may still land: look that hash up, and do not send again with a new nonce`)
    }
    await clock.sleep(i.receiptPollMs)
  }
}

async function pay(i: Inputs, ctx: Ctx, a: Verdicted & { kind: 'prepared' }, flowId: Hex, free: VaultPreflight): Promise<VerifyThenPayResult> {
  const { v } = ctx
  const { vault, payee, amountUnits } = i
  const { recordUrl } = a
  const data = payCalldata(v, 'pay', payee, amountUnits)
  const refusedPrepared = (why: string) => new VaultPaymentError('PREPARED_MISMATCH', `the server's prepared call was not sent: ${why}`, { flowId, recordUrl })

  const mismatch = compareCall(a.prepared, { fn: 'pay(address,uint256)', to: vault, from: free.operator, data, payee, amountUnits })
  if (mismatch) throw refusedPrepared(mismatch)
  const sim = a.prepared.simulation
  if (!isObject(sim) || sim.ok !== true) {
    const error = isObject(sim) && typeof sim.error === 'string' ? sim.error : 'no simulation in the answer'
    const code = VAULT_REVERTS.find((c) => c === error) ?? 'SimulationReverted'
    throw new VaultPolicyError(code, `the server's simulation of pay() did not pass: ${error}`, { stage: 'simulation', vault, flowId, recordUrl })
  }
  const fees = isObject(a.prepared.fees) ? a.prepared.fees : {}
  const preparedFee = weiField(fees.maxFeePerGas)
  if (preparedFee === null) throw refusedPrepared(`maxFeePerGas is ${String(fees.maxFeePerGas)}`)

  // The chain again: the check took seconds, and the vault may have moved.
  const now = await runPreflight(ctx, { vault, payee, amountUnits, tokenId: null, operator: i.operator, stage: 'simulation', flowId, recordUrl, checkPayee: false })
  const wantedFee = [now.maxFeePerGas, preparedFee, ARC_MAINNET.minMaxFeePerGasWei].reduce((a, b) => (a > b ? a : b))
  // The cap binds the server's number too: a server cannot price this payment above it, and its
  // own higher cap must not burn a check that was already bought. Clamping keeps the fee above
  // the price plus the tip, because runPreflight just refused otherwise.
  const maxFeePerGas = wantedFee > ctx.capWei ? ctx.capWei : wantedFee
  if (now.operatorGasWei !== null && now.operatorGasWei < now.gasLimit * maxFeePerGas) {
    throw new VaultPolicyError('InsufficientGas', `the operator holds ${now.operatorGasWei} wei of gas and pay() can cost up to ${now.gasLimit * maxFeePerGas} wei`, { stage: 'simulation', vault, flowId, recordUrl })
  }
  const tx: ArcPreparedTx = {
    chainId: ARC_MAINNET.chainId,
    from: i.operator,
    to: vault,
    data,
    value: 0n,
    gas: now.gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: now.maxPriorityFeePerGas,
  }

  // The one send. Nothing below this line sends anything, whatever happens.
  let txHash: Hex
  try {
    const sent = await i.signer.sendTransaction(tx)
    if (typeof sent !== 'string' || !HASH.test(sent)) throw new Error(`the signer returned ${String(sent)}, not a transaction hash`)
    txHash = sent.toLowerCase() as Hex
  } catch (e) {
    throw new VaultPaymentError('BROADCAST_FAILED', `the operator's sendTransaction failed: ${msg(e)}. Check the operator's nonce before trying again: it may have reached the network`, { flowId, recordUrl })
  }

  const { receipt, tx: readBack } = await awaitPayment(i, txHash, { data, operatorIsContract: now.operatorIsContract, flowId, recordUrl })
  const fail = (code: VaultPaymentCode, message: string, record?: FlowRecordReport) => new VaultPaymentError(code, message, { flowId, txHash, recordUrl, ...(record ? { record } : {}) })
  const post = () => recordFlowReceipt({ flowId, txHash, baseUrl: i.baseUrl, fetch: i.doFetch, requestTimeoutMs: i.requestTimeoutMs, clock: i.clock })

  if (!now.operatorIsContract && (lc(receipt.from) !== i.operator || lc(receipt.to) !== vault)) {
    throw fail('TX_MISMATCH', `the receipt of ${txHash} is from ${receipt.from} to ${String(receipt.to)}, not the operator's call to the vault`)
  }
  if (receipt.status !== 'success') {
    throw fail('REVERTED', `pay() reverted on chain in block ${receipt.blockNumber} (${txHash}); nothing moved`, await post())
  }
  if (!receiptProvesPayment(v, receipt, i)) {
    throw fail('LOGS_MISMATCH', `${txHash} succeeded and its receipt carries no Paid and USDC Transfer from the vault to the payee for ${amountUnits} units`)
  }
  const record = await post()
  return {
    outcome: 'executed',
    flowId,
    verdict: a.verdict,
    check: a.check,
    payment: {
      txHash,
      blockNumber: receipt.blockNumber,
      vault,
      payee,
      amountUnits,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      readBackFrom: receipt.source ?? null,
      transactionReadBack: readBack !== null,
      explorerUrl: `${ARC_MAINNET.explorer}/tx/${txHash}`,
    },
    record,
  }
}

function handOff(i: Inputs, ctx: Ctx, a: Verdicted & { kind: 'awaiting_human' }, flowId: Hex, free: VaultPreflight): VerifyThenPayResult {
  const { vault, payee, amountUnits } = i
  const { recordUrl } = a
  const data = payCalldata(ctx.v, 'ownerPay', payee, amountUnits)
  const refused = (why: string) => new VaultPaymentError('PREPARED_MISMATCH', `the server's prepared ownerPay was not handed on: ${why}`, { flowId, recordUrl })
  const call = a.handoff.ownerPay
  if (!isObject(call)) throw refused('the hand-off holds no ownerPay')
  const mismatch = compareCall(call, { fn: 'ownerPay(address,uint256)', to: vault, from: free.owner, data, payee, amountUnits })
  if (mismatch) throw refused(mismatch)
  const fees = isObject(call.fees) ? call.fees : {}
  const fee = weiField(fees.maxFeePerGas)
  if (fee === null) throw refused(`maxFeePerGas is ${String(fees.maxFeePerGas)}`)
  const sim = isObject(call.simulation) ? call.simulation : {}
  return {
    outcome: 'awaiting_human',
    flowId,
    verdict: a.verdict,
    check: a.check,
    ownerPay: {
      chainId: ARC_MAINNET.chainId,
      to: vault,
      from: free.owner,
      value: '0',
      data,
      function: 'ownerPay(address,uint256)',
      args: [payee, amountUnits.toString()],
      maxFeePerGas: (fee > ARC_MAINNET.minMaxFeePerGasWei ? fee : ARC_MAINNET.minMaxFeePerGasWei).toString(),
      gas: typeof fees.gas === 'string' ? fees.gas : null,
      simulation: sim.ok === true ? { ok: true } : { ok: false, error: typeof sim.error === 'string' ? sim.error : 'no simulation in the answer' },
    },
    // The owner's transaction is not sent yet; recordFlowReceipt closes this flow once it is.
    record: { url: recordUrl, recorded: true, outcome: 'awaiting_human', detail: 'warn_handoff' },
  }
}

async function run(i: Inputs): Promise<VerifyThenPayResult> {
  const ctx: Ctx = { v: await loadViem(), chain: i.chain, capWei: i.capWei, tipWei: i.tipWei }
  const { vault, payee, amountUnits, doFetch, baseUrl } = i

  // A. Free, nothing signed.
  const free = await runPreflight(ctx, { vault, payee, amountUnits, tokenId: i.tokenId, operator: i.operator, stage: 'preflight', checkPayee: true })

  // B. The offer. The server runs its own free checks first, so a refusal here costs nothing too.
  const url = `${baseUrl}${VTP_PATH}`
  const request = JSON.stringify({
    vault,
    payee,
    amount: amountUnits.toString(),
    ...(i.asset ? { asset: i.asset } : {}),
    ...(i.payeeAgentId !== undefined ? { payeeAgentId: i.payeeAgentId } : {}),
    payOnWarn: i.payOnWarn,
  })
  const headers = { 'content-type': 'application/json' }
  let first: Awaited<ReturnType<typeof httpCall>>
  try {
    first = await httpCall(doFetch, url, { method: 'POST', headers, body: request }, i.requestTimeoutMs)
  } catch (e) {
    throw new GatewayCheckError('NETWORK', `the verify-then-pay route did not answer: ${msg(e)}`, { paid: false })
  }
  const b = isObject(first.body) ? first.body : null
  if (first.status !== 402) {
    if (b?.stage === 'refused') throw refusalError(b, first.status, { vault, payee })
    if (b?.stage === 'unavailable') throw new GatewayCheckError('NO_ARC_OFFER', String(b.reason ?? 'the rail cannot sell the check on Arc Mainnet right now'), { paid: false, status: first.status })
    throw new GatewayCheckError(b ? 'REFUSED' : 'NETWORK', `the verify-then-pay route answered HTTP ${first.status} to a request with no payment`, { paid: false, status: first.status })
  }
  const inHeader = decodeChallengeHeader(first.headers.get('payment-required'))
  const challenge = b && isObject(b.challenge) ? b.challenge : inHeader
  if (inHeader && isObject(inHeader) && isObject(challenge) && JSON.stringify(inHeader.accepts) !== JSON.stringify(challenge.accepts)) {
    throw new GatewayCheckError('OFFER_MISMATCH', 'the 402 header and body disagree on what is being sold', { paid: false, status: 402 })
  }
  const offer = readOffer(challenge, i.payerAddress, i.maxCheckUnits, 402)
  if (i.proveDomain) await proveOffer(doFetch, offer, i.requestTimeoutMs)
  await checkGatewayBalance(doFetch, i.payerAddress, BigInt(offer.amount), i.requestTimeoutMs)

  // The one signature.
  const { header, nonce } = await signOffer(offer, i.payer, i.gatewayScheme)
  let paid: Awaited<ReturnType<typeof httpCall>>
  try {
    paid = await httpCall(doFetch, url, { method: 'POST', headers: { ...headers, 'PAYMENT-SIGNATURE': header }, body: request }, i.requestTimeoutMs)
  } catch (e) {
    throw new GatewayCheckError('NETWORK', `no answer after the signed authorization was sent, so whether the check was paid is not known here: ${msg(e)}`, { paid: null, authNonce: nonce })
  }

  // C. The decision. Everything that is not a usable ALLOW or WARN throws in here.
  const answer = readPaidAnswer(paid, { vault, payee, amountUnits, nonce, payer: i.payerAddress, offer, payOnWarn: i.payOnWarn, baseUrl })

  // D and E, or the hand-off.
  return answer.kind === 'prepared' ? pay(i, ctx, answer, nonce, free) : handOff(i, ctx, answer, nonce, free)
}

/** One flow per vault at a time in this process, so two concurrent calls cannot both pass the
 *  same spentToday, and a payment cannot land between another flow's check and its payment. */
const vaultQueues = new Map<string, Promise<unknown>>()

async function inVaultQueue<T>(vault: string, work: () => Promise<T>): Promise<T> {
  const before = vaultQueues.get(vault) ?? Promise.resolve()
  const mine = before.then(work, work)
  const tail = mine.catch(() => undefined)
  vaultQueues.set(vault, tail)
  try {
    return await mine
  } finally {
    if (vaultQueues.get(vault) === tail) vaultQueues.delete(vault)
  }
}

/**
 * Buy a verdict on the payee, then pay it from the vault if the verdict allows it. See the top
 * of this file for the order. Resolves with `executed` or `awaiting_human`; everything else
 * throws one of the typed errors above.
 */
export async function verifyThenPay(opts: VerifyThenPayOptions): Promise<VerifyThenPayResult> {
  const input = checkPaymentInput(opts)
  const signer = opts.signer
  if (!signer || typeof signer.sendTransaction !== 'function') throw new TypeError('signer must be the vault operator: an address and sendTransaction')
  const operator = requireAddress(signer.address, 'signer.address')
  const candidate = opts.payer ?? (signer as unknown as GatewayPayerSigner)
  if (typeof candidate.signTypedData !== 'function') throw new TypeError('the signer cannot sign typed data, so pass a separate payer for the Gateway check')
  const payerAddress = requireAddress(candidate.address, 'payer.address')
  if (opts.maxCheckUnits !== undefined && (typeof opts.maxCheckUnits !== 'bigint' || opts.maxCheckUnits <= 0n)) throw new RangeError('maxCheckUnits must be a positive bigint')
  const doFetch = opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch
  if (!doFetch) throw new TypeError('No fetch available; pass opts.fetch.')
  const inputs: Inputs = {
    ...input,
    signer,
    operator,
    payer: candidate,
    payerAddress,
    payOnWarn: opts.payOnWarn === true,
    maxCheckUnits: opts.maxCheckUnits ?? DEFAULT_MAX_CHECK_UNITS,
    receiptTimeoutMs: opts.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS,
    droppedAfterMs: opts.droppedAfterMs ?? DEFAULT_DROPPED_AFTER_MS,
    receiptPollMs: opts.receiptPollMs ?? DEFAULT_POLL_MS,
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    proveDomain: opts.proveDomain !== false,
    baseUrl: requireSecureBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL),
    doFetch,
    chain: opts.chain ?? arcChainReader(opts.rpcUrls, opts.fetch ? { fetch: opts.fetch } : {}),
    clock: opts.clock ?? realClock,
    ...feeCaps(opts),
    ...(opts.asset ? { asset: opts.asset } : {}),
    ...(opts.payeeAgentId !== undefined ? { payeeAgentId: opts.payeeAgentId } : {}),
    ...(opts.gatewayScheme ? { gatewayScheme: opts.gatewayScheme } : {}),
  }
  return inVaultQueue(input.vault, () => run(inputs))
}
