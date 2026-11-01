/**
 * verify-then-pay, the hosted half: one request in, one stage out, and the hosted server
 * never signs anything.
 *
 * The order, and what each step can cost the caller:
 *   1. Input. Refused (400 or 422) before anything is read.
 *   2. The rail. Unless the Circle Gateway rail sells on Arc Mainnet right now, nothing can
 *      be bought (501), so nothing is read either.
 *   3. A presented payment is pinned before it is settled: a payload that names another
 *      network is refused, because the rail settles on whatever network a payload names; and
 *      a nonce that already opened a flow is refused, because a flow is keyed by it.
 *   4. The free preflight, read from Arc Mainnet: the vault holds the registry's USDC, the
 *      payee holds an ERC-8004 agent there, the vault's policy and a simulated pay() from its
 *      operator accept the payment, and the operator can pay the gas. A refusal here costs
 *      nothing: the check is never bought for a payment the vault would refuse anyway. It
 *      runs again when the payment arrives, because the vault may have moved since the 402.
 *   5. No payment yet: the 402, carrying the Arc Mainnet Gateway offer and nothing else.
 *   6. The check, bought in process through the rail exactly as /api/x402/gateway/tools/
 *      risk_check sells it (same price, same settlement row, same read-back), with the payee
 *      ADDRESS as agentId and txContext {amountUsd, payee}. A CAIP agent id is never sent:
 *      the scorer matches platform agents by address, not by CAIP id, so one would always be
 *      scored off-platform.
 *   7. The block the verdict came back in, read at once. A payment answers this check only
 *      when it lands in a later block (receipt.ts), so a pay() sent while the check was still
 *      running never counts as its result. If the chain does not answer for it, nothing is
 *      prepared, because no payment could be shown to come after this check.
 *   8. The decision, only from a verdict that passed verdict.ts. DENY stops. WARN prepares
 *      ownerPay() for the owner unless the caller opted into payOnWarn. ALLOW prepares pay()
 *      for the operator. Every paid check writes one flow row, insert-only. An answer whose row
 *      was not written says so and links no record (never another request's flow under the same
 *      nonce), and hands back nothing to send: a payment on it could never be receipted.
 *
 * The answer is always executed: false. What it hands back is the exact call, built from the
 * request's own inputs, for the caller's own key to send. The flow moves to executed only when
 * a receipt is posted to .../flows/:flowId/receipt and the server reads it from the chain
 * itself (receipt.ts).
 */
import type { ChainDescriptor } from '../chains/index.js'
import { railChallenge, railPaidNetwork, railPaywallGate, railServeTool, railStatus, toolPriceUsd, type GatewayRailStatus, type RailDeps } from '../x402-gateway/index.js'
import type { VtpDecision, VtpFlowDetail, VtpFlowOutcome, VtpFlowRecord } from '../storage.js'
import { flowPath, flowUrl, storageVtpStore, vtpChain, vtpReadClient, VTP_PUBLIC_ORIGIN, type VtpDeps, type VtpStore } from './context.js'
import {
  assessVaultAsset,
  assessVaultPolicy,
  readPayeeRegistration,
  readVaultFacts,
  simulateVaultCall,
  ZERO_ADDRESS,
  type PayeeRegistration,
  type VaultRead,
  type VtpReadClient,
} from './reads.js'
import { evaluateVerdict, readSettlement, type ExpectedCheck, type VerdictEvaluation } from './verdict.js'
import { feesFor, gasLimitFor, prepareOwnerPay, preparePay, type Fees, type PreparedCall } from './prepare.js'

export type VtpStage = 'refused' | 'unavailable' | 'payment_required' | 'check_failed' | 'verdict_unusable' | 'deny' | 'awaiting_human' | 'prepared'

/** Why a request was refused before anything was charged. The vault codes are the vault
 *  contract's own error names, so a refusal here reads like the revert it prevented. */
export type VtpRefusalCode =
  | 'INVALID_INPUT'
  | 'ZeroAddress'
  | 'InvalidPayee'
  | 'WRONG_ASSET'
  | 'NOT_A_VAULT'
  | 'VAULT_TOKEN_MISMATCH'
  | 'PAYEE_UNREGISTERED'
  | 'PAYEE_AGENT_MISMATCH'
  | 'REGISTRY_UNREADABLE'
  | 'VaultUnreadable'
  | 'NotOperator'
  | 'IsFrozen'
  | 'SessionKeyExpired'
  | 'PayeeNotAllowed'
  | 'AboveAutoApprove'
  | 'DailyCapExceeded'
  | 'InsufficientVaultBalance'
  | 'TransferFailed'
  | 'GasPriceAboveCap'
  | 'InsufficientGas'
  | 'SimulationReverted'
  | 'PAYMENT_WRONG_NETWORK'
  | 'NONCE_ALREADY_USED'
  | 'FLOW_STORE_UNREADABLE'
  | 'RATE_LIMITED'

/** Why a paid check handed back nothing to send although its verdict was not a refusal. */
export type VtpCheckFailedCode = 'VERDICT_BLOCK_UNREADABLE' | 'FLOW_NOT_RECORDED'

export type VtpChecks = {
  asset: { ok: boolean | null; registryUsdc: string; vaultToken: string | null; requested: string | null; code?: string }
  payee: { ok: boolean | null; agentsHeld: number | null; payeeAgentId: string | null; agentOwner: string | null; code?: string }
  vault: {
    ok: boolean | null
    owner: string | null
    operator: string | null
    frozen: boolean | null
    sessionKeyExpiry: string | null
    allowlistEnabled: boolean | null
    payeeAllowed: boolean | null
    autoApproveMax: string | null
    dailyCap: string | null
    spentToday: string | null
    balance: string | null
    block: string | null
    blockTimestamp: string | null
    gasPriceWei: string | null
    operatorGasWei: string | null
    operatorIsContract: boolean | null
    simulation: null | { ok: true; gas: string } | { ok: false; error: string }
    code?: string
  }
}

export type GatewayCheckReference = {
  network: string
  /** = flowId. */
  authNonce: string
  transferId: string | null
  gatewayOutcome: 'credited' | 'completed'
  payer: string
  /** The price in USDC base units. */
  amountUnits: string
  resource: string
  checkedAt: string
}

export type VtpVerdictView = {
  decision: VtpDecision | null
  effective: VtpDecision
  risk: string | null
  reasons: string[]
  reputationScore: number | null
  overriddenBecause?: string
}

export type OwnerHandoff = { auditOutcome: 'awaiting_human'; owner: string; ownerPay: PreparedCall }

export type VerifyThenPayToolResult = {
  tool: 'verify_then_pay'
  /** CAIP-2 of Arc Mainnet, from the registry. */
  network: string
  stage: VtpStage
  /** Always false: the hosted server never signs for the operator or the owner. */
  executed: false
  /** Whether the check was paid for. null only when Gateway answered success and its
   *  transfer could not be read back, so whether money moved is not known here. */
  charged: boolean | null
  flowId: string | null
  code?: string
  reason?: string
  checks: VtpChecks | null
  /** The x402 v2 challenge, Arc Mainnet's Gateway offer only. */
  challenge?: Record<string, unknown>
  price?: { usd: number; units: string }
  check: GatewayCheckReference | null
  verdict: VtpVerdictView | null
  prepared: PreparedCall | null
  ownerHandoff: OwnerHandoff | null
  /** The public flow record. url is null whenever recorded is false: there is nothing to open. */
  record: { url: string | null; outcome: VtpFlowOutcome; detail: VtpFlowDetail; recorded: boolean; reason?: string } | null
  /** What the rail answered, when it did not return a verdict. */
  rail?: { httpStatus: number; body: unknown }
  next: string
}

export type VtpResponse = { httpStatus: number; body: VerifyThenPayToolResult; headers?: Record<string, string> }

export type VtpInput = { vault?: unknown; payee?: unknown; amount?: unknown; asset?: unknown; payeeAgentId?: unknown; payOnWarn?: unknown }

export type ParsedVtpInput = {
  vault: string
  payee: string
  /** USDC base units. */
  amount: bigint
  /** The same amount in USD, a finite JSON number, exactly what risk_check is sent. */
  amountUsd: number
  asset: string | null
  /** As the caller named it, normalized to the CAIP form. */
  payeeAgentId: string | null
  tokenId: bigint | null
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const NONCE = /^0x[0-9a-fA-F]{64}$/
const DEFAULT_EXPIRY_MARGIN_SEC = 60
const VAULT_ERRORS = new Set(['ZeroAddress', 'InvalidPayee', 'IsFrozen', 'SessionKeyExpired', 'PayeeNotAllowed', 'AboveAutoApprove', 'DailyCapExceeded', 'NotOperator', 'TransferFailed'])

type InputRefusal = { ok: false; httpStatus: 400 | 422; code: VtpRefusalCode; reason: string }

/** Validate and normalize the request. Pure. Amounts are integer base units, never floats. */
export function parseVtpInput(chain: ChainDescriptor, input: VtpInput): { ok: true; value: ParsedVtpInput; payOnWarn: boolean } | InputRefusal {
  const bad = (reason: string): InputRefusal => ({ ok: false, httpStatus: 400, code: 'INVALID_INPUT', reason })
  const usdc = (chain.contracts.usdc as string).toLowerCase()
  if (typeof input.vault !== 'string' || !ADDRESS.test(input.vault)) return bad('vault must be a 0x address')
  if (typeof input.payee !== 'string' || !ADDRESS.test(input.payee)) return bad('payee must be a 0x address')
  if (typeof input.amount !== 'string' || !/^[1-9][0-9]*$/.test(input.amount)) {
    return bad(`amount must be USDC base units (${chain.usdcDecimals} decimals) as a string of digits above 0, for example "250000" for 0.25 USDC`)
  }
  const amount = BigInt(input.amount)
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return bad('amount is too large to be sent to risk_check as an exact number')
  if (input.payOnWarn !== undefined && typeof input.payOnWarn !== 'boolean') return bad('payOnWarn must be true or false')
  const vault = input.vault.toLowerCase()
  const payee = input.payee.toLowerCase()
  let asset: string | null = null
  if (input.asset !== undefined && input.asset !== null) {
    if (typeof input.asset !== 'string' || !ADDRESS.test(input.asset)) return bad('asset must be a 0x address')
    asset = input.asset.toLowerCase()
    if (asset !== usdc) return { ok: false, httpStatus: 422, code: 'WRONG_ASSET', reason: `the asset must be ${chain.name}'s USDC ${chain.contracts.usdc}, not ${input.asset}` }
  }
  let payeeAgentId: string | null = null
  let tokenId: bigint | null = null
  if (input.payeeAgentId !== undefined && input.payeeAgentId !== null) {
    if (typeof input.payeeAgentId !== 'string') return bad('payeeAgentId must be a string')
    const s = input.payeeAgentId.trim()
    const caip = s.match(/^(eip155:\d{1,12}):8004\/(\d{1,30})$/i)
    const bare = s.match(/^#?(\d{1,30})$/)
    if (caip && caip[1].toLowerCase() !== chain.caip2) return bad(`payeeAgentId names ${caip[1]}; this flow pays on ${chain.name} (${chain.caip2}), so the agent must be on its registry`)
    const digits = caip?.[2] ?? bare?.[1]
    if (!digits) return bad(`payeeAgentId must be "${chain.caip2}:8004/<n>" or "#<n>"`)
    tokenId = BigInt(digits)
    payeeAgentId = `${chain.caip2}:8004/${tokenId}`
  }
  if (payee === ZERO_ADDRESS) return { ok: false, httpStatus: 422, code: 'ZeroAddress', reason: 'the payee is the zero address' }
  if (payee === vault || payee === usdc) {
    return { ok: false, httpStatus: 422, code: 'InvalidPayee', reason: 'the payee is the vault itself or the USDC contract; the vault refuses both because nothing would move' }
  }
  const amountUsd = Number(amount) / 10 ** chain.usdcDecimals
  return { ok: true, value: { vault, payee, amount, amountUsd, asset, payeeAgentId, tokenId }, payOnWarn: input.payOnWarn === true }
}

type DecodedPayment = { ok: true; networks: string[]; nonce: string | null; from: string | null } | { ok: false; reason: string }

/** Read what a PAYMENT-SIGNATURE says before it is settled. Nothing here verifies a
 *  signature: that is Gateway's job when the rail settles it. Both places a payload can name
 *  its network are collected, because the rail settles on the first and Gateway is handed
 *  the second. */
export function decodePayment(header: string): DecodedPayment {
  let p: unknown
  try {
    p = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
  } catch {
    return { ok: false, reason: 'PAYMENT-SIGNATURE is not base64-encoded JSON' }
  }
  if (typeof p !== 'object' || p === null) return { ok: false, reason: 'PAYMENT-SIGNATURE is not a JSON object' }
  const o = p as { network?: unknown; accepted?: { network?: unknown } | null; payload?: { authorization?: { nonce?: unknown; from?: unknown } } }
  const auth = o.payload?.authorization
  const nonce = typeof auth?.nonce === 'string' && NONCE.test(auth.nonce) ? auth.nonce.toLowerCase() : null
  const from = typeof auth?.from === 'string' && ADDRESS.test(auth.from) ? auth.from.toLowerCase() : null
  const networks = [railPaidNetwork(p), typeof o.accepted?.network === 'string' ? o.accepted.network.trim() : undefined].filter(
    (n): n is string => typeof n === 'string' && n.length > 0,
  )
  return { ok: true, networks: [...new Set(networks)], nonce, from }
}

function emptyChecks(chain: ChainDescriptor, p: ParsedVtpInput): VtpChecks {
  return {
    asset: { ok: null, registryUsdc: (chain.contracts.usdc as string).toLowerCase(), vaultToken: null, requested: p.asset },
    payee: { ok: null, agentsHeld: null, payeeAgentId: p.payeeAgentId, agentOwner: null },
    vault: {
      ok: null,
      owner: null,
      operator: null,
      frozen: null,
      sessionKeyExpiry: null,
      allowlistEnabled: null,
      payeeAllowed: null,
      autoApproveMax: null,
      dailyCap: null,
      spentToday: null,
      balance: null,
      block: null,
      blockTimestamp: null,
      gasPriceWei: null,
      operatorGasWei: null,
      operatorIsContract: null,
      simulation: null,
    },
  }
}

const str = (v: bigint | null) => (v === null ? null : v.toString())

function fillVault(checks: VtpChecks, read: VaultRead): void {
  const f = read.facts
  checks.asset.vaultToken = f.usdc
  Object.assign(checks.vault, {
    owner: f.owner,
    operator: f.operator,
    frozen: f.frozen,
    sessionKeyExpiry: str(f.sessionKeyExpiry),
    allowlistEnabled: f.allowlistEnabled,
    payeeAllowed: f.payeeAllowed,
    autoApproveMax: str(f.autoApproveMax),
    dailyCap: str(f.dailyCap),
    spentToday: str(f.spentToday),
    balance: str(f.balance),
    block: str(f.blockNumber),
    blockTimestamp: str(f.blockTimestamp),
    gasPriceWei: str(f.gasPrice),
    operatorGasWei: str(f.operatorGas),
    operatorIsContract: f.operatorHasCode,
  })
}

function fillPayee(checks: VtpChecks, reg: PayeeRegistration): void {
  Object.assign(checks.payee, { ok: reg.ok, agentsHeld: reg.agentsHeld, agentOwner: reg.agentOwner, ...(reg.code ? { code: reg.code } : {}) })
}

type PreflightOk = { ok: true; read: VaultRead; fees: Fees; gas: bigint; checks: VtpChecks; owner: string; operator: string; block: bigint }
type PreflightRefused = { ok: false; httpStatus: 422 | 503; code: VtpRefusalCode; reason: string; checks: VtpChecks }

/** Everything that can be known for free, in the order the plan fixes: the asset, the payee,
 *  the vault's policy, the fee, the simulation, the operator's gas. */
async function preflight(client: VtpReadClient, chain: ChainDescriptor, p: ParsedVtpInput, deps: VtpDeps): Promise<PreflightOk | PreflightRefused> {
  const checks = emptyChecks(chain, p)
  const [read, reg] = await Promise.all([readVaultFacts(client, p.vault, p.payee), readPayeeRegistration(client, chain, p.payee, p.tokenId)])
  fillVault(checks, read)
  const refuse = (where: 'asset' | 'payee' | 'vault', httpStatus: 422 | 503, code: VtpRefusalCode, reason: string): PreflightRefused => {
    checks[where].ok = false
    checks[where].code = code
    return { ok: false, httpStatus, code, reason, checks }
  }

  const asset = assessVaultAsset(read, chain.contracts.usdc as string, chain.name)
  if (!asset.ok) return refuse('asset', asset.httpStatus, asset.code, asset.reason)
  checks.asset.ok = true

  fillPayee(checks, reg)
  if (!reg.ok) return refuse('payee', reg.code === 'REGISTRY_UNREADABLE' ? 503 : 422, reg.code ?? 'PAYEE_UNREGISTERED', reg.reason ?? 'the payee is not registered')

  const policy = assessVaultPolicy(read, p.amount, { expiryMarginSec: deps.expiryMarginSec ?? DEFAULT_EXPIRY_MARGIN_SEC })
  if (!policy.ok) return refuse('vault', policy.httpStatus, policy.code, policy.reason)
  const f = read.facts
  const owner = f.owner as string
  const operator = f.operator as string

  if (f.gasPrice === null) return refuse('vault', 503, 'VaultUnreadable', 'the chain did not answer eth_gasPrice')
  const fees = feesFor(f.gasPrice, { capWei: deps.feeCapWei })
  if (!fees.ok) return refuse('vault', 422, 'GasPriceAboveCap', fees.reason)

  const sim = await simulateVaultCall(client, 'pay', { vault: p.vault, from: operator, payee: p.payee, amount: p.amount })
  if (!sim.ok) {
    checks.vault.simulation = { ok: false, error: sim.error }
    if (!sim.reverted) return refuse('vault', 503, 'VaultUnreadable', `pay() could not be simulated: ${sim.error}`)
    const code: VtpRefusalCode = VAULT_ERRORS.has(sim.error) ? (sim.error as VtpRefusalCode) : 'SimulationReverted'
    return refuse('vault', 422, code, `pay() from the operator reverts at the latest block: ${sim.error}`)
  }
  checks.vault.simulation = { ok: true, gas: sim.gas.toString() }

  // A contract operator's gas is paid by whoever relays its call, so its own balance proves
  // nothing; an EOA operator has to hold the gas itself, in native USDC.
  if (f.operatorHasCode === null) return refuse('vault', 503, 'VaultUnreadable', "the chain did not answer for the operator's code")
  if (!f.operatorHasCode) {
    if (f.operatorGas === null) return refuse('vault', 503, 'VaultUnreadable', "the chain did not answer for the operator's gas balance")
    const need = gasLimitFor(sim.gas) * fees.fees.maxFeePerGas
    if (f.operatorGas < need) {
      return refuse('vault', 422, 'InsufficientGas', `the operator holds ${f.operatorGas} wei of gas and pay() can cost up to ${need} wei at the prepared fee`)
    }
  }
  checks.vault.ok = true
  return { ok: true, read, fees: fees.fees, gas: sim.gas, checks, owner, operator, block: f.blockNumber as bigint }
}

function result(chain: ChainDescriptor, over: Partial<VerifyThenPayToolResult> & Pick<VerifyThenPayToolResult, 'stage' | 'next'>): VerifyThenPayToolResult {
  return {
    tool: 'verify_then_pay',
    network: chain.caip2,
    executed: false,
    charged: false,
    flowId: null,
    checks: null,
    check: null,
    verdict: null,
    prepared: null,
    ownerHandoff: null,
    record: null,
    ...over,
  }
}

function refused(chain: ChainDescriptor, httpStatus: number, code: VtpRefusalCode, reason: string, checks: VtpChecks | null): VtpResponse {
  return {
    httpStatus,
    body: result(chain, {
      stage: 'refused',
      code,
      reason,
      checks,
      next:
        httpStatus === 503
          ? `Nothing was charged: ${chain.name} or the flow log did not answer, so nothing could be decided. Ask again shortly.`
          : `Nothing was charged and no check was bought: ${reason}.`,
    }),
  }
}

/** The answer for a caller over the verify-then-pay budget: nothing was read, nothing was
 *  charged, and the same request can be sent again once the window has passed. */
export function vtpRateLimited(windowMs: number): VtpResponse {
  const chain = vtpChain()
  const s = Math.ceil(windowMs / 1000)
  return {
    httpStatus: 429,
    headers: { 'Retry-After': String(s) },
    body: result(chain, {
      stage: 'refused',
      code: 'RATE_LIMITED',
      reason: `too many verify_then_pay calls from this address in the last ${s} s`,
      next: `Nothing was read and nothing was charged. Ask again in ${s} s.`,
    }),
  }
}

type Insert = Awaited<ReturnType<VtpStore['insert']>>

/** What the answer may say about its record. A record that was not written has no url: the
 *  url would 404, or open another request's flow written under the same nonce. */
function recordView(ins: Insert, url: string, outcome: VtpFlowOutcome, detail: VtpFlowDetail): NonNullable<VerifyThenPayToolResult['record']> {
  if (!ins.ok) return { url: null, outcome, detail, recorded: false, reason: `the flow log refused the write (${ins.reason})` }
  if (!ins.inserted) return { url: null, outcome, detail, recorded: false, reason: 'a flow under this nonce was already written by another request, so this answer was not recorded' }
  return { url, outcome, detail, recorded: true }
}

/** The rail's challenge, cut to Arc Mainnet's offer. Any other network the rail sells on is
 *  removed: this flow pays from an Arc Mainnet vault, and the check has to be bought there. */
function arcOnly(chain: ChainDescriptor, body: Record<string, unknown>): Record<string, unknown> | null {
  const accepts = Array.isArray(body.accepts) ? (body.accepts as Record<string, unknown>[]).filter((a) => a?.network === chain.caip2) : []
  return accepts.length ? { ...body, accepts } : null
}

function challengeHeaders(challenge: Record<string, unknown>): Record<string, string> {
  return { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64') }
}

async function paymentRequired(
  chain: ChainDescriptor,
  status: GatewayRailStatus,
  railDeps: RailDeps,
  checks: VtpChecks | null,
  verifyError?: string,
): Promise<VtpResponse> {
  const c = await railChallenge('risk_check', status, railDeps, verifyError)
  const challenge = c.httpStatus === 402 ? arcOnly(chain, c.body) : null
  if (!challenge) {
    const body = c.httpStatus === 402 ? { error: 'Gateway kind unproven', reason: `no ${chain.name} offer could be proven right now` } : c.body
    return {
      httpStatus: c.httpStatus === 402 ? 503 : c.httpStatus,
      body: result(chain, { stage: 'unavailable', checks, rail: { httpStatus: c.httpStatus, body }, reason: String((body as { reason?: unknown }).reason ?? (body as { error?: unknown }).error ?? 'unavailable'), next: `Nothing was charged: the Circle Gateway rail cannot sell the check on ${chain.name} right now.` }),
    }
  }
  const offer = (challenge.accepts as Record<string, unknown>[])[0]
  const usd = toolPriceUsd('risk_check')
  return {
    httpStatus: 402,
    headers: challengeHeaders(challenge),
    body: result(chain, {
      stage: 'payment_required',
      checks,
      challenge,
      price: { usd, units: String(offer.amount ?? '') },
      ...(verifyError ? { reason: verifyError } : {}),
      next: `Nothing is charged yet, and the free checks passed. Sign the ${chain.name} offer in challenge.accepts from your Circle Gateway balance (x402 v2, GatewayWalletBatched, ${usd} USDC for risk_check), then send the same request again with the base64 PAYMENT-SIGNATURE: as that header on POST /api/x402/gateway/verify-then-pay, or as the payment argument of the verify_then_pay MCP tool.`,
    }),
  }
}

type RecordInput = {
  chain: ChainDescriptor
  flowId: string
  now: string
  p: ParsedVtpInput
  payOnWarn: boolean
  owner: string
  operator: string
  settlement: { transferId: string | null; outcome: 'credited' | 'completed'; payer: string; value: string; ts: string }
  block: bigint
  verdictBlock: bigint | null
  verdict: VtpFlowRecord['verdict']
  prepared: PreparedCall | null
  outcome: VtpFlowOutcome
  detail: VtpFlowDetail
}

function flowRecord(r: RecordInput): VtpFlowRecord {
  return {
    v: 1,
    flowId: r.flowId,
    network: r.chain.caip2,
    createdAt: r.now,
    updatedAt: r.now,
    vault: r.p.vault,
    owner: r.owner,
    operator: r.operator,
    payee: r.p.payee,
    payeeAgentId: r.p.payeeAgentId,
    asset: (r.chain.contracts.usdc as string).toLowerCase(),
    amount: r.p.amount.toString(),
    amountUsd: r.p.amountUsd,
    check: {
      authNonce: r.flowId,
      transferId: r.settlement.transferId,
      gatewayOutcome: r.settlement.outcome,
      payer: r.settlement.payer,
      value: r.settlement.value,
      tool: 'risk_check',
      checkedAt: r.settlement.ts,
      checkedAtBlock: r.block.toString(),
      verdictBlock: r.verdictBlock === null ? null : r.verdictBlock.toString(),
    },
    verdict: r.verdict,
    payOnWarn: r.payOnWarn,
    prepared: r.prepared ? { from: r.prepared.from, to: r.prepared.to, data: r.prepared.data, function: r.prepared.function, args: r.prepared.args } : null,
    outcome: r.outcome,
    detail: r.detail,
  }
}

function verdictView(v: VerdictEvaluation): VtpVerdictView {
  return {
    decision: v.decision,
    effective: v.effective,
    risk: v.risk,
    reasons: v.reasons,
    reputationScore: v.reputationScore,
    ...(v.usable ? {} : { overriddenBecause: v.code }),
  }
}

/** The latest block once the verdict is back, never below the preflight's (a host that lags
 *  could answer with less), or null when the chain did not answer. */
async function blockAfterVerdict(client: VtpReadClient, floor: bigint): Promise<bigint | null> {
  try {
    const b = await client.getBlock()
    if (typeof b.number !== 'bigint') return null
    return b.number > floor ? b.number : floor
  } catch {
    return null
  }
}

/** The settlement record the rail attached, for a 500: paid, but the tool failed. */
function settledOn500(body: unknown, expected: ExpectedCheck) {
  const s = readSettlement(body, expected)
  return s.ok ? s.settlement : null
}

export async function runVerifyThenPay(input: VtpInput, paymentHeader: string | null | undefined, deps: VtpDeps = {}): Promise<VtpResponse> {
  const chain = vtpChain()
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => Date.now())
  const store: VtpStore = deps.store ?? storageVtpStore()
  const origin = deps.origin ?? VTP_PUBLIC_ORIGIN
  const railDeps: RailDeps = { ...(deps.rail ?? {}), env, ...(deps.origin ? { origin: deps.origin } : {}) }

  // 1. input
  const parsed = parseVtpInput(chain, input)
  if (!parsed.ok) return refused(chain, parsed.httpStatus, parsed.code, parsed.reason, null)
  const p = parsed.value

  // 2. can the check be bought on Arc Mainnet at all
  const status = railStatus(env, chain.caip2)
  const gate = railPaywallGate(status)
  if (!gate.ok) {
    return {
      httpStatus: gate.httpStatus,
      body: result(chain, { stage: 'unavailable', reason: gate.body.reason ?? gate.body.error, rail: { httpStatus: gate.httpStatus, body: gate.body }, next: `Nothing was charged: the Circle Gateway rail is not configured to sell on ${chain.name} on this server.` }),
    }
  }

  // 3. pin a presented payment before anything can settle it
  const header = paymentHeader?.trim() ?? ''
  const payment = header ? decodePayment(header) : null
  if (payment?.ok) {
    const elsewhere = payment.networks.find((n) => n !== chain.caip2)
    if (elsewhere) {
      return refused(chain, 422, 'PAYMENT_WRONG_NETWORK', `the payment names ${elsewhere}; this flow buys its check on ${chain.name} (${chain.caip2}) and on nothing else, so it was not settled`, null)
    }
    if (payment.nonce) {
      const existing = await store.load(payment.nonce)
      if (!existing.ok) return refused(chain, 503, 'FLOW_STORE_UNREADABLE', `the flow log could not be read (${existing.reason}), so a flow for this payment could not be recorded`, null)
      if (existing.row) return refused(chain, 409, 'NONCE_ALREADY_USED', `this authorization nonce already opened flow ${payment.nonce}; sign a new authorization`, null)
    }
  }

  // 4. the free preflight
  const client = deps.client ?? (await vtpReadClient(chain, env))
  const pre = await preflight(client, chain, p, deps)
  if (!pre.ok) return refused(chain, pre.httpStatus, pre.code, pre.reason, pre.checks)

  // 5. no usable payment yet: the challenge
  if (!payment || !payment.ok) return paymentRequired(chain, status, railDeps, pre.checks, payment && !payment.ok ? payment.reason : undefined)

  // 6. the check, through the rail, in process
  const out = await railServeTool('risk_check', { agentId: p.payee, txContext: { amountUsd: p.amountUsd, payee: p.payee } }, header, status, railDeps)
  const expected: ExpectedCheck = { network: chain.caip2, authNonce: payment.nonce ?? '', payer: payment.from ?? '', payee: p.payee, amountUsd: p.amountUsd }
  const flowId = payment.nonce
  const ts = new Date(now()).toISOString()
  const receiptUrl = `${flowUrl(flowId ?? '', origin)}/receipt`

  if (out.httpStatus === 200 && !flowId) {
    // The rail refuses a payload without a 32-byte nonce before settling, so this cannot
    // happen; if it ever does, the check was paid and there is no key to record it under.
    return {
      httpStatus: 502,
      body: result(chain, {
        stage: 'check_failed',
        charged: true,
        checks: pre.checks,
        rail: { httpStatus: out.httpStatus, body: out.body },
        reason: 'the rail served a verdict for a payment whose nonce could not be read, so no flow could be keyed to it',
        next: 'Do not pay on this answer: it is not recorded anywhere a reviewer could open.',
      }),
    }
  }
  if (out.httpStatus !== 200 || !flowId) {
    const paid500 = out.httpStatus === 500 && flowId ? settledOn500(out.body, expected) : null
    if (paid500 && flowId) {
      // Paid, and the tool failed after settlement: the record says what was bought and that
      // no verdict came back, so the flow is blocked, never pending.
      const rec = flowRecord({ chain, flowId, now: ts, p, payOnWarn: parsed.payOnWarn, owner: pre.owner, operator: pre.operator, settlement: paid500, block: pre.block, verdictBlock: null, verdict: null, prepared: null, outcome: 'blocked', detail: 'verdict_unavailable' })
      const record = recordView(await store.insert(rec), flowUrl(flowId, origin), rec.outcome, rec.detail)
      return {
        httpStatus: 500,
        body: result(chain, {
          stage: 'check_failed',
          charged: true,
          flowId: record.recorded ? flowId : null,
          checks: pre.checks,
          check: checkRef(chain, paid500, flowId),
          rail: { httpStatus: out.httpStatus, body: out.body },
          record,
          reason: 'the check was paid and credited, and the tool failed after settlement, so there is no verdict',
          next: record.recorded
            ? `Do not pay: there is no verdict to pay on. The paid check and the failure are recorded at ${record.url}.`
            : `Do not pay: there is no verdict to pay on. The paid check and the failure are not recorded as a flow: ${record.reason}.`,
        }),
      }
    }
    const railBody = out.body as Record<string, unknown>
    const challenge = out.httpStatus === 402 && railBody && typeof railBody === 'object' ? arcOnly(chain, railBody) : null
    const unconfirmed = out.httpStatus === 502 && (railBody as { error?: unknown })?.error === 'settlement unconfirmed'
    return {
      httpStatus: out.httpStatus,
      ...(challenge ? { headers: challengeHeaders(challenge) } : {}),
      body: result(chain, {
        stage: 'check_failed',
        charged: unconfirmed ? null : false,
        checks: pre.checks,
        ...(challenge ? { challenge } : {}),
        rail: { httpStatus: out.httpStatus, body: challenge ?? out.body },
        reason: String((railBody as { verifyError?: unknown })?.verifyError ?? (railBody as { reason?: unknown })?.reason ?? (railBody as { error?: unknown })?.error ?? `the rail answered ${out.httpStatus}`),
        next: unconfirmed
          ? 'Gateway answered success but its transfer could not be read back, so no verdict was served and no flow was recorded. Do not pay; the settlement is recorded as unconfirmed on GET /api/x402/gateway/proof.'
          : 'No verdict, so do not pay. Nothing was recorded as a flow. Read rail.body for what the Gateway rail refused.',
      }),
    }
  }

  // 7. the block the verdict came back in, before anything is done with it
  const verdictBlock = await blockAfterVerdict(client, pre.block)

  // 8. a verdict, if it is one
  const v = evaluateVerdict(out.body, expected)
  const raw = (out.body as { settlement?: Record<string, unknown> }).settlement ?? {}
  const settlement = v.settlement ?? {
    transferId: typeof raw.transferId === 'string' ? raw.transferId : null,
    outcome: raw.outcome === 'completed' ? ('completed' as const) : ('credited' as const),
    payer: payment.from ?? String(raw.payer ?? ''),
    value: String(raw.value ?? ''),
    ts: String(raw.ts ?? ts),
  }
  const verdict: VtpFlowRecord['verdict'] = {
    decision: v.decision,
    effective: v.effective,
    risk: v.risk,
    reasons: v.reasons,
    reputationScore: v.reputationScore,
    agentId: v.agentId,
    checkedAt: v.checkedAt,
    ...(v.usable ? {} : { overriddenBecause: v.code }),
  }

  let stage: VtpStage
  let outcome: VtpFlowOutcome
  let detail: VtpFlowDetail
  let prepared: PreparedCall | null = null
  let ownerHandoff: OwnerHandoff | null = null
  if (!v.usable) {
    stage = 'verdict_unusable'
    outcome = 'blocked'
    detail = 'verdict_unusable'
  } else if (v.effective === 'DENY') {
    stage = 'deny'
    outcome = 'blocked'
    detail = 'deny'
  } else if (verdictBlock === null) {
    // Nothing to send: without the block the verdict came back in, no payment could be shown
    // to come after this check, so a receipt could never close the flow.
    stage = 'check_failed'
    outcome = 'blocked'
    detail = 'verdict_block_unreadable'
  } else if (v.effective === 'WARN' && !parsed.payOnWarn) {
    stage = 'awaiting_human'
    outcome = 'awaiting_human'
    detail = 'warn_handoff'
    const sim = await simulateVaultCall(client, 'ownerPay', { vault: p.vault, from: pre.owner, payee: p.payee, amount: p.amount })
    const call = prepareOwnerPay(chain, {
      vault: p.vault,
      owner: pre.owner,
      payee: p.payee,
      amount: p.amount,
      gasEstimate: sim.ok ? sim.gas : null,
      fees: pre.fees,
      simulation: sim.ok ? { ok: true } : { ok: false, error: sim.error },
    })
    ownerHandoff = { auditOutcome: 'awaiting_human', owner: pre.owner, ownerPay: call }
    prepared = null
  } else {
    stage = 'prepared'
    outcome = 'pending'
    detail = 'agent_will_pay'
    // Simulated again after the verdict: the check took seconds, and the vault may have moved.
    const sim = await simulateVaultCall(client, 'pay', { vault: p.vault, from: pre.operator, payee: p.payee, amount: p.amount })
    prepared = preparePay(chain, {
      vault: p.vault,
      operator: pre.operator,
      payee: p.payee,
      amount: p.amount,
      gasEstimate: sim.ok ? sim.gas : pre.gas,
      fees: pre.fees,
      simulation: sim.ok ? { ok: true } : { ok: false, error: sim.error },
    })
  }

  const rec = flowRecord({
    chain,
    flowId,
    now: ts,
    p,
    payOnWarn: parsed.payOnWarn,
    owner: pre.owner,
    operator: pre.operator,
    settlement,
    block: pre.block,
    verdictBlock,
    verdict,
    prepared: prepared ?? ownerHandoff?.ownerPay ?? null,
    outcome,
    detail,
  })
  const ins = await store.insert(rec)
  const record = recordView(ins, flowUrl(flowId, origin), outcome, detail)
  const answered = {
    charged: true as const,
    checks: pre.checks,
    check: checkRef(chain, settlement, flowId),
    verdict: verdictView(v),
    ...(v.usable ? {} : { code: v.code, reason: v.reason }),
  }
  const headers = out.headers ? { headers: out.headers } : {}

  if (!record.recorded) {
    // The check was paid and answered, and the flow log does not hold it. Nothing links to a
    // record that is not there, and nothing is handed back to send: a payment on this answer
    // could never be tied to this check, so no receipt could close it or count it.
    const httpStatus = ins.ok ? 409 : 500
    if (stage === 'deny' || stage === 'verdict_unusable') {
      const why = stage === 'deny' ? 'DENY' : `The check was paid, but its answer failed ${v.usable ? '' : v.code}, so it is treated as DENY`
      return {
        httpStatus,
        ...headers,
        body: result(chain, { stage, ...answered, flowId: null, record, next: `${why}: do not pay. Nothing was prepared and nothing should be signed. The refusal is not public: ${record.reason}.` }),
      }
    }
    return {
      httpStatus,
      ...headers,
      body: result(chain, {
        stage: 'check_failed',
        ...answered,
        flowId: null,
        record,
        code: 'FLOW_NOT_RECORDED',
        reason: record.reason,
        next: `The check was paid and answered ${v.effective}, but its flow was not recorded (${record.reason}), so nothing is handed back to send: a payment made on this answer could never be tied to this check or counted. Do not pay on this flow; ask again with a new authorization.`,
      }),
    }
  }

  const next: Record<VtpStage, string> = {
    refused: '',
    unavailable: '',
    payment_required: '',
    check_failed: `The check was paid and answered ${v.effective}, but ${chain.name} did not answer for its latest block after the verdict, so a payment could not be shown to come after this check and nothing was prepared: do not pay on this flow, ask again with a new authorization.`,
    verdict_unusable: `The check was paid, but its answer failed ${v.usable ? '' : v.code}, so it is treated as DENY: do not pay. The paid check and why it was not used are public at ${record.url}.`,
    deny: `DENY: do not pay. Nothing was prepared and nothing should be signed. The refusal is public at ${record.url}.`,
    awaiting_human: `WARN: the agent must not pay this on its own. The owner can settle it by sending ownerHandoff.ownerPay from the owner key ${pre.owner}; then POST {"txHash": "0x..."} to ${receiptUrl} and the server reads the receipt itself.`,
    prepared:
      prepared?.simulation.ok === false
        ? `The verdict allows this payment, but the vault would refuse it right now (${prepared.simulation.error}): do not send it. Ask again once the vault can pay.`
        : `Send prepared exactly as given from the operator key ${pre.operator} (to the vault, value 0, chainId ${chain.evmChainId}, maxFeePerGas at least ${prepared?.fees.floorWei} wei). Then POST {"txHash": "0x..."} to ${receiptUrl}: the flow is marked executed only after the server reads the receipt from ${chain.name} itself.`,
  }

  const failed: { code: VtpCheckFailedCode; reason: string } | null =
    stage === 'check_failed' ? { code: 'VERDICT_BLOCK_UNREADABLE', reason: `${chain.name} did not answer for its latest block after the verdict` } : null

  return {
    httpStatus: failed ? 503 : 200,
    ...headers,
    body: result(chain, { stage, ...answered, flowId, prepared, ownerHandoff, record, ...(failed ?? {}), next: next[stage] }),
  }
}

function checkRef(
  chain: ChainDescriptor,
  s: { transferId: string | null; outcome: 'credited' | 'completed'; payer: string; value: string; ts: string },
  flowId: string,
): GatewayCheckReference {
  return {
    network: chain.caip2,
    authNonce: flowId,
    transferId: s.transferId,
    gatewayOutcome: s.outcome,
    payer: s.payer,
    amountUnits: s.value,
    resource: '/api/x402/gateway/tools/risk_check',
    checkedAt: s.ts,
  }
}

// ── reading a record ──────────────────────────────────────────────────────────────

export type VtpFlowReadBody = {
  flowId: string | null
  flow: VtpFlowRecord | null
  url: string | null
  receiptUrl: string | null
  paymentExplorerUrl: string | null
  error?: string
  note: string
}

/** GET /api/x402/gateway/flows/:flowId. Public on purpose: a DENY has no transaction, so this
 *  record is the evidence that it happened, and anyone has to be able to open it. */
export async function readVtpFlow(flowIdRaw: unknown, deps: Pick<VtpDeps, 'store' | 'origin'> = {}): Promise<{ httpStatus: number; body: VtpFlowReadBody }> {
  const store = deps.store ?? storageVtpStore()
  const origin = deps.origin ?? VTP_PUBLIC_ORIGIN
  const note =
    'One verify-then-pay flow: the Circle Gateway risk_check that opened it (keyed by its authorization nonce), the verdict, the call the server prepared, and, once a receipt was read back from the chain by the server itself, the payment. The hosted server never signs; executed means the chain proved it.'
  if (typeof flowIdRaw !== 'string' || !NONCE.test(flowIdRaw)) {
    return { httpStatus: 400, body: { flowId: null, flow: null, url: null, receiptUrl: null, paymentExplorerUrl: null, error: 'flowId must be the 32-byte authorization nonce (0x + 64 hex)', note } }
  }
  const id = flowIdRaw.toLowerCase()
  const read = await store.load(id)
  if (!read.ok) return { httpStatus: 503, body: { flowId: id, flow: null, url: null, receiptUrl: null, paymentExplorerUrl: null, error: `the flow log could not be read: ${read.reason}`, note } }
  if (!read.row) return { httpStatus: 404, body: { flowId: id, flow: null, url: null, receiptUrl: null, paymentExplorerUrl: null, error: 'no flow with this id', note } }
  return {
    httpStatus: 200,
    body: {
      flowId: id,
      flow: read.row,
      url: flowUrl(id, origin),
      receiptUrl: `${origin.replace(/\/$/, '')}${flowPath(id)}/receipt`,
      paymentExplorerUrl: read.row.payment?.explorerUrl ?? null,
      note,
    },
  }
}
