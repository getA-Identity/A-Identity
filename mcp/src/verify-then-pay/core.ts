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
 *      a nonce that already opened a flow is refused, because a flow is keyed by it. This read
 *      only saves the preflight: the reservation in step 6 is what holds under concurrency.
 *   4. The free preflight, read from Arc Mainnet: the vault holds the registry's USDC, an agent
 *      the caller named is the payee's, the vault's policy and a simulated pay() from its
 *      operator accept the payment, and the operator can pay the gas. A refusal here costs
 *      nothing: the check is never bought for a payment the vault would refuse anyway. It
 *      runs again when the payment arrives, because the vault may have moved since the 402.
 *      A payee that holds no agent is not refused: it is unknown, not bad, so it goes on to the
 *      check and gets WARN. Nothing below reads the registry again: a flow is linked to its
 *      check by nonce, and to its payment by vault, payee and amount (receipt.ts), so a flow
 *      record needs no agent, and payeeAgentId is null unless the caller named one.
 *      A payment the operator cannot make and the owner can (above the ceiling, or off an allowlist
 *      that is on) is not refused either, on a vault with a human: pay() would revert and ownerPay()
 *      would not, so ownerPay() is what is simulated, and the check is bought for the owner's sake.
 *      The 402 says so before anything is charged. On a vault whose owner is its operator there is
 *      no human, so both stay refusals. Every other refusal stays one.
 *   5. No payment yet: the 402, carrying the Arc Mainnet Gateway offer and nothing else.
 *   6. The nonce reserved, then the check. An insert-only opening row keyed by the nonce goes
 *      in first, so of two requests carrying one signed payment only one reaches Gateway; the
 *      other is refused (409), and a flow log that refuses the write refuses the request (503)
 *      before anything is bought. A reservation is nothing yet to any reader. The check is then
 *      bought in process through the rail exactly as /api/x402/gateway/tools/risk_check sells
 *      it (same price, same settlement row, same read-back), with the payee ADDRESS as agentId
 *      and txContext {amountUsd, payee}. A CAIP agent id is never sent: the scorer matches
 *      platform agents by address, not by CAIP id, so one would always be scored off-platform.
 *      A rail failure marks the reservation abandoned: a nonce gets one attempt, so trying again
 *      takes a new authorization.
 *   7. The block the verdict came back in, read at once. A payment answers this check only
 *      when it lands in a later block (receipt.ts), so a pay() sent while the check was still
 *      running never counts as its result. If the chain does not answer for it, nothing is
 *      prepared, because no payment could be shown to come after this check.
 *   8. The decision, only from a verdict that passed verdict.ts. DENY stops. On a payment only the
 *      owner can make, ALLOW and WARN both prepare ownerPay() for the owner, and payOnWarn cannot
 *      change that: it cannot make the operator pay what the vault would refuse. Otherwise WARN
 *      prepares ownerPay() for the owner unless the caller opted into payOnWarn, and when the vault's
 *      owner and operator are one key there is no human to hand it to, so it stops there too.
 *      ALLOW prepares pay() for the operator. Every paid check closes its reservation once,
 *      compare-and-set from opening. An answer whose row could not be closed says so and links
 *      no record, and hands back nothing to send: a payment on it could never be receipted.
 *
 * The answer is always executed: false. What it hands back is the exact call, built from the
 * request's own inputs, for the caller's own key to send. The flow moves to executed only when
 * a receipt is posted to .../flows/:flowId/receipt and the server reads it from the chain
 * itself (receipt.ts).
 */
import type { ChainDescriptor } from '../chains/index.js'
import { railChallenge, railPaidNetwork, railPaywallGate, railServeTool, railStatus, toolPriceUsd, type GatewayRailStatus, type RailDeps } from '../x402-gateway/index.js'
import type { VtpDecision, VtpFlowDetail, VtpFlowOutcome, VtpFlowRecord } from '../storage.js'
import { approvalUrlFor, FLOW_LOG_REFUSED_WRITE, FLOW_LOG_UNREADABLE, flowPath, flowUrl, holdsNoFlow, logFlowStoreFault, storageVtpStore, vtpChain, vtpReadClient, VTP_PUBLIC_ORIGIN, whyNoApproval, type VtpDeps, type VtpStore } from './context.js'
import {
  assessVaultAsset,
  assessVaultPolicy,
  readPayeeRegistration,
  readVaultFacts,
  simulateVaultCall,
  ZERO_ADDRESS,
  type OperatorBlock,
  type OperatorBlockCode,
  type PayeeRegistration,
  type VaultRead,
  type VtpReadClient,
} from './reads.js'
import { evaluateVerdict, readSettlement, type ExpectedCheck, type VerdictEvaluation } from './verdict.js'
import { feesFor, gasLimitFor, prepareOwnerPay, preparePay, type Fees, type PreparedCall } from './prepare.js'

export type VtpStage = 'refused' | 'unavailable' | 'payment_required' | 'check_failed' | 'verdict_unusable' | 'deny' | 'awaiting_human' | 'warn_no_human_gate' | 'prepared'

/** Why a request was refused before anything was charged. The vault codes are the vault
 *  contract's own error names, so a refusal here reads like the revert it prevented. */
export type VtpRefusalCode =
  | 'INVALID_INPUT'
  | 'ZeroAddress'
  | 'InvalidPayee'
  | 'WRONG_ASSET'
  | 'NOT_A_VAULT'
  | 'VAULT_TOKEN_MISMATCH'
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
export type VtpCheckFailedCode = 'VERDICT_BLOCK_UNREADABLE' | 'FLOW_NOT_RECORDED' | 'SETTLEMENT_UNKNOWN'

export type VtpChecks = {
  asset: { ok: boolean | null; registryUsdc: string; vaultToken: string | null; requested: string | null; code?: string }
  /** ok: nothing here refuses the payee. agentsHeld 0 still passes: holding no agent means unknown, not refused. */
  payee: { ok: boolean | null; agentsHeld: number | null; payeeAgentId: string | null; agentOwner: string | null; code?: string }
  vault: {
    ok: boolean | null
    owner: string | null
    operator: string | null
    /** The owner and the operator are one key: a WARN has no human to hand it to. null until both are read. */
    ownerIsOperator: boolean | null
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
    /** Set when the operator cannot make this payment and the owner can: the gate in pay() that stops
     *  it, and simulation is then ownerPay() from the owner. null otherwise. */
    ownerOnly: OperatorBlock | null
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
  /** Who the scorer says this verdict is about. The caller compares it with its own payee. */
  agentId: string | null
  /** The signals behind it, so the caller can check a WARN against them for itself. */
  signals: VerdictEvaluation['signals']
  /** The context the scorer echoed. The caller compares it with its own payee and amount. */
  txContext: { payee: string | null; amountUsd: number | null } | null
  overriddenBecause?: string
}

export type OwnerHandoff = {
  auditOutcome: 'awaiting_human'
  owner: string
  ownerPay: PreparedCall
  /** Where the owner can approve this on the vault page, with their own wallet. Always the site's own origin. null where the server can see the page would refuse it: the check was not paid by the vault's operator key, or the payee is that key. A link is no promise that the page will act: see whyNoApproval. */
  approvalUrl: string | null
  /** The gate in pay() that makes this the owner's to pay, whatever the verdict was. null: the verdict did, a WARN. */
  ownerOnly: OperatorBlockCode | null
}

export type VerifyThenPayToolResult = {
  tool: 'verify_then_pay'
  /** CAIP-2 of Arc Mainnet, from the registry. */
  network: string
  stage: VtpStage
  /** Always false: the hosted server never signs for the operator or the owner. */
  executed: false
  /** Whether the check was paid for. null when Gateway answered success and its transfer could
   *  not be read back, or when the settle call got no usable answer at all: either way, whether
   *  money moved is not known here. */
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
/** 65 bytes for a key, more for a contract wallet. */
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2}){65,}$/
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

type DecodedPayment =
  | { ok: true; networks: string[]; nonce: string | null; from: string | null; to: string | null; value: string | null; signature: string | null }
  | { ok: false; reason: string }

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
  const o = p as { network?: unknown; accepted?: { network?: unknown } | null; payload?: { signature?: unknown; authorization?: { nonce?: unknown; from?: unknown; to?: unknown; value?: unknown } } }
  const auth = o.payload?.authorization
  const nonce = typeof auth?.nonce === 'string' && NONCE.test(auth.nonce) ? auth.nonce.toLowerCase() : null
  const from = typeof auth?.from === 'string' && ADDRESS.test(auth.from) ? auth.from.toLowerCase() : null
  const networks = [railPaidNetwork(p), typeof o.accepted?.network === 'string' ? o.accepted.network.trim() : undefined].filter(
    (n): n is string => typeof n === 'string' && n.length > 0,
  )
  return {
    ok: true,
    networks: [...new Set(networks)],
    nonce,
    from,
    to: typeof auth?.to === 'string' ? auth.to : null,
    value: auth?.value === undefined || auth?.value === null ? null : String(auth.value),
    signature: typeof o.payload?.signature === 'string' ? o.payload.signature : null,
  }
}

/**
 * What the rail would refuse anyway, asked before a row is written. The reservation is a
 * permanent row, and this is what stops anything that plainly is not a payment from adding one.
 * The rail still judges everything that passes: this reads the shape and proves nothing.
 */
function paymentShapeError(chain: ChainDescriptor, payment: Extract<DecodedPayment, { ok: true }>, payTo: string | null): string | null {
  if (!payment.signature || !SIGNATURE.test(payment.signature)) return 'payload.signature must be a 65-byte hex value'
  if (!payment.nonce) return 'authorization.nonce must be a 32-byte hex value'
  if (!payment.from) return 'authorization.from must be a 0x address'
  if (!payTo || payment.to?.toLowerCase() !== payTo.toLowerCase()) return `authorization.to must be ${payTo}`
  const price = String(Math.round(toolPriceUsd('risk_check') * 10 ** chain.usdcDecimals))
  if (payment.value !== price) return `authorization.value must be exactly ${price}`
  return null
}

/** How old a refused attempt must be before its row is removed. */
const ABANDONED_ROW_RETENTION_MS = 7 * 86_400_000

function emptyChecks(chain: ChainDescriptor, p: ParsedVtpInput): VtpChecks {
  return {
    asset: { ok: null, registryUsdc: (chain.contracts.usdc as string).toLowerCase(), vaultToken: null, requested: p.asset },
    payee: { ok: null, agentsHeld: null, payeeAgentId: p.payeeAgentId, agentOwner: null },
    vault: {
      ok: null,
      owner: null,
      operator: null,
      ownerIsOperator: null,
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
      ownerOnly: null,
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
    ownerIsOperator: f.owner && f.operator ? f.owner === f.operator : null,
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

type PreflightOk = { ok: true; read: VaultRead; fees: Fees; gas: bigint; checks: VtpChecks; owner: string; operator: string; block: bigint; ownerOnly: OperatorBlock | null }
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
  if (!reg.ok) return refuse('payee', reg.code === 'REGISTRY_UNREADABLE' ? 503 : 422, reg.code ?? 'REGISTRY_UNREADABLE', reg.reason ?? 'the registry did not say whether the payee is who it was named as')

  const policy = assessVaultPolicy(read, p.amount, { expiryMarginSec: deps.expiryMarginSec ?? DEFAULT_EXPIRY_MARGIN_SEC })
  if (!policy.ok) return refuse('vault', policy.httpStatus, policy.code, policy.reason)
  const f = read.facts
  const owner = f.owner as string
  const operator = f.operator as string

  if (f.gasPrice === null) return refuse('vault', 503, 'VaultUnreadable', 'the chain did not answer eth_gasPrice')
  const fees = feesFor(f.gasPrice, { capWei: deps.feeCapWei })
  if (!fees.ok) return refuse('vault', 422, 'GasPriceAboveCap', fees.reason)

  // The call the payment would be: the operator's, or on a payment only the owner can make, the owner's.
  const ownerOnly = policy.operatorBlockedBy ?? null
  checks.vault.ownerOnly = ownerOnly
  const kind = ownerOnly ? 'ownerPay' : 'pay'
  const sim = await simulateVaultCall(client, kind, { vault: p.vault, from: ownerOnly ? owner : operator, payee: p.payee, amount: p.amount })
  if (!sim.ok) {
    checks.vault.simulation = { ok: false, error: sim.error }
    if (!sim.reverted) return refuse('vault', 503, 'VaultUnreadable', `${kind}() could not be simulated: ${sim.error}`)
    const code: VtpRefusalCode = VAULT_ERRORS.has(sim.error) ? (sim.error as VtpRefusalCode) : 'SimulationReverted'
    return refuse('vault', 422, code, `${kind}() from the ${ownerOnly ? 'owner' : 'operator'} reverts at the latest block: ${sim.error}`)
  }
  checks.vault.simulation = { ok: true, gas: sim.gas.toString() }

  // A contract operator's gas is paid by whoever relays its call, so its own balance proves
  // nothing; an EOA operator has to hold the gas itself, in native USDC. A payment only the owner
  // can make costs the operator no gas.
  if (!ownerOnly) {
    if (f.operatorHasCode === null) return refuse('vault', 503, 'VaultUnreadable', "the chain did not answer for the operator's code")
    if (!f.operatorHasCode) {
      if (f.operatorGas === null) return refuse('vault', 503, 'VaultUnreadable', "the chain did not answer for the operator's gas balance")
      const need = gasLimitFor(sim.gas) * fees.fees.maxFeePerGas
      if (f.operatorGas < need) {
        return refuse('vault', 422, 'InsufficientGas', `the operator holds ${f.operatorGas} wei of gas and pay() can cost up to ${need} wei at the prepared fee`)
      }
    }
  }
  checks.vault.ok = true
  return { ok: true, read, fees: fees.fees, gas: sim.gas, checks, owner, operator, block: f.blockNumber as bigint, ownerOnly }
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

/**
 * What gets a vault with one key a person to hand a payment to. `owner` is immutable in AgentSpendPolicy, so
 * no call gives the vault another owner key. setOperator moves the agent to a new key and leaves the owner key
 * behind, which is worth nothing if the agent has ever held that key, and then only a new vault separates them.
 */
const ONE_KEY_WAY_OUT = "A vault's owner cannot be changed, so give your agent a new key of its own with setOperator, and keep this key from it. That helps only if the agent no longer has this key: if its process or logs have held it, deploy a new vault with an owner key the agent never holds."

function refused(chain: ChainDescriptor, httpStatus: number, code: VtpRefusalCode, reason: string, checks: VtpChecks | null, payOnWarn = false): VtpResponse {
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
          : (code === 'AboveAutoApprove' || code === 'PayeeNotAllowed') && checks?.vault.ownerIsOperator === true
            ? `Nothing was charged and no check was bought, so there is no verdict on this payee and nothing was prepared: ${reason}. This vault's owner and operator are one key, so there is no person to hand this to. Raising the ceiling or allowing the payee gets a verdict, where ALLOW prepares pay() and WARN ${
                // Named only to a caller who set it: this answer has no verdict and no record of the payee, and
                // pointing an autonomous agent at payOnWarn here could walk it into paying a stranger.
                payOnWarn ? "prepares pay() as the agent's own decision, because you set payOnWarn" : 'stops with the check paid'
              }. For a hand-off: ${ONE_KEY_WAY_OUT}`
            : `Nothing was charged and no check was bought: ${reason}.`,
    }),
  }
}

/** The MCP tool's answer for a caller over the verify-then-pay budget: nothing was read, nothing was
 *  charged, and the same request can be sent again once the window has passed. Over HTTP the limiter
 *  in http.ts answers before this route runs, with only {error} and Retry-After. */
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

/** What another try costs, for an answer that sends a caller to one. */
const anotherAuthorization = (): string => `a new authorization costs another ${toolPriceUsd('risk_check')} USDC`

/**
 * A nonce seen before says what this request did, and nothing about how the first one went: that one may
 * have been charged and hold a verdict, its answer lost on the way back, or still be running, in which case
 * no reader can see it yet. So this does not send the caller off to pay for a second check and open a second flow.
 *
 * A signature names no payee, so the same header can come back with other inputs, and a flow answers only the
 * vault, payee and amount it names. `otherRequest` says the row was read and names others. The race for the
 * reservation has no row to read, so the words for it have to hold in both cases.
 *
 * A nonce the proof shows with no flow to read can stay that way for good: nothing closes an opening row whose
 * server died, and nothing refreshes an unconfirmed one. So the last step says what to do with one rather than
 * leaving the caller to wait, and it is worded as what to treat it as, because a very slow first request could
 * still close its flow. The proof has no look-up: it lists its newest rows, so a nonce older than those reads
 * as missing.
 */
function nonceUsed(chain: ChainDescriptor, nonce: string, checks: VtpChecks | null, otherRequest = false): VtpResponse {
  const out = refused(chain, 409, 'NONCE_ALREADY_USED', `this authorization nonce already opened flow ${nonce}`, checks)
  return {
    ...out,
    body: {
      ...out.body,
      next: otherRequest
        ? `This request charged nothing. The first request with this nonce named another vault, payee or amount, so what is recorded under it does not answer this request, and no verdict there is about this payment. A signature names no payee, so sign a new authorization for this request: ${anotherAuthorization()}.`
        : `This request charged nothing. The first request with this nonce may have been charged and may hold a verdict, or may still be running. Read GET ${flowPath(nonce)}: a flow there that names this vault, payee and amount is your answer, so do not sign again. One that names others does not answer this request, so sign a new authorization for it. If that read answers 404, look this nonce up on GET /api/x402/gateway/proof, which lists only the newest 50 rows, and read both again in a minute, because a request still running shows in neither. If neither shows this nonce by then, or the proof log says it failed, sign a new authorization. If the proof log reads credited, completed or unconfirmed and the flow still answers 404, treat this nonce as giving no flow: ${anotherAuthorization()}, and one that reads unconfirmed may still settle until it expires.`,
    },
  }
}

type Closed = Awaited<ReturnType<VtpStore['update']>>

const CLOSE_FLOW_RETRY_MS = [200, 800]

/**
 * Close a flow whose check was paid. A write that fails here costs the buyer a second check, since
 * the nonce is spent and nothing can be handed back, so a transient database error is tried again
 * while the answer can still wait. A tx conflict is no database error and is not. When an earlier
 * try committed and only its answer was lost, the row reads as this very record, which counts.
 */
async function closePaidFlow(store: VtpStore, flowId: string, rec: VtpFlowRecord): Promise<Closed> {
  let closed = await store.update(flowId, rec, ['opening'])
  for (const wait of CLOSE_FLOW_RETRY_MS) {
    if (closed.ok || closed.conflict) return closed
    await new Promise((r) => setTimeout(r, wait))
    closed = await store.update(flowId, rec, ['opening'])
    if (closed.ok && !closed.updated && closed.row?.outcome === rec.outcome && closed.row.detail === rec.detail && closed.row.updatedAt === rec.updatedAt) {
      return { ok: true, updated: true, row: closed.row }
    }
  }
  return closed
}

/** What the answer may say about its record. A record that was not written has no url: the
 *  url would 404, or open a reservation that never became this answer. */
function recordView(closed: Closed, url: string, outcome: VtpFlowOutcome, detail: VtpFlowDetail): NonNullable<VerifyThenPayToolResult['record']> {
  if (!closed.ok) {
    logFlowStoreFault('closing a paid flow', closed.reason)
    return { url: null, outcome, detail, recorded: false, reason: FLOW_LOG_REFUSED_WRITE }
  }
  if (!closed.updated) return { url: null, outcome, detail, recorded: false, reason: 'the reservation under this nonce was no longer open, so this answer was not recorded' }
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
  asked: { payOnWarn: boolean; payee: string },
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
  const operator = checks?.vault.operator
  // The paid answer gets no link for a payment to the operator key, whoever pays the check: see whyNoApproval.
  const notToOperator = `The vault page does not offer a payment to the vault's operator key ${operator}, so the owner sends ownerPay from their own key.`
  const paysOperator = asked.payee.toLowerCase() === operator?.toLowerCase()
  return {
    httpStatus: 402,
    headers: challengeHeaders(challenge),
    body: result(chain, {
      stage: 'payment_required',
      checks,
      challenge,
      price: { usd, units: String(offer.amount ?? '') },
      ...(verifyError ? { reason: verifyError } : {}),
      next: `Nothing is charged yet, and the free checks passed.${checks?.payee.agentsHeld === 0 ? ` This payee holds no ERC-8004 agent on ${chain.name}. That is not a refusal, and unless it is an agent on our platform the check will answer WARN.` : ''}${
        checks?.vault.ownerOnly
          ? ` The agent cannot pay this and only the owner can settle it: ${checks.vault.ownerOnly.reason} (${checks.vault.ownerOnly.code}). Signing this offer still charges ${usd} USDC for the check. A usable ALLOW or WARN then hands ownerPay to the owner, payOnWarn cannot make the operator pay it, and a DENY stops it. ${paysOperator ? notToOperator : `The vault page offers the owner this approval only if the check is paid from the vault's operator key ${operator}; from any other key, the owner sends ownerPay from their own key.`}`
          : checks?.vault.ownerIsOperator === true
          ? asked.payOnWarn
            ? " On this vault the owner and the operator are one key, so there is nobody to hand a payment to. You set payOnWarn, so a WARN prepares pay() as the agent's own decision, and the check is still paid."
            : ` On this vault the owner and the operator are one key, so a WARN stops with nothing prepared: there is nobody to hand the payment to, and the check is still paid. If you need that hand-off, do this first. ${ONE_KEY_WAY_OUT}`
          : checks?.payee.agentsHeld === 0
            ? asked.payOnWarn
              ? " You set payOnWarn, so a WARN prepares pay() for the operator key as the agent's own decision, and the owner is not asked."
              : ` A WARN hands the payment to the owner. ${paysOperator ? notToOperator : `The vault page offers the owner that approval only if the check is paid from the vault's operator key ${operator}.`}`
            : ''
      } Sign the ${chain.name} offer in challenge.accepts from your Circle Gateway balance (x402 v2, GatewayWalletBatched, ${usd} USDC for risk_check), then send the same request again with the base64 PAYMENT-SIGNATURE: as that header on POST /api/x402/gateway/verify-then-pay, or as the payment argument of the verify_then_pay MCP tool.`,
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
  settlement: { transferId: string | null; outcome: VtpFlowRecord['check']['gatewayOutcome']; payer: string; value: string; ts: string }
  block: bigint
  verdictBlock: bigint | null
  verdict: VtpFlowRecord['verdict']
  prepared: PreparedCall | null
  ownerOnly?: OperatorBlockCode
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
    ...(r.ownerOnly ? { ownerOnly: r.ownerOnly } : {}),
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
    agentId: v.agentId,
    signals: v.signals,
    txContext: v.txContext,
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

/** How the prepared call has to be sent. A fee at the floor is no fee to send: on a day the base
 *  fee is above 20 gwei it would never be included. */
function sendInstruction(call: PreparedCall, path: string): string {
  const gas = call.fees.gas !== null ? `gas limit ${path}.fees.gas (${call.fees.gas})` : `your own gas limit, since ${path}.fees.gas could not be estimated`
  return `maxFeePerGas ${path}.fees.maxFeePerGas (${call.fees.maxFeePerGas} wei), never below ${path}.fees.floorWei (${call.fees.floorWei} wei), and ${gas}`
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
      if (!existing.ok) {
        logFlowStoreFault('reading a payment nonce', existing.reason)
        return refused(chain, 503, 'FLOW_STORE_UNREADABLE', `${FLOW_LOG_UNREADABLE}, so a flow for this payment could not be recorded`, null)
      }
      if (existing.row) {
        // A row holds these as flowRecord wrote them: lowercase addresses, and the amount as a string.
        const { vault, payee, amount } = existing.row
        return nonceUsed(chain, payment.nonce, null, vault !== p.vault || payee !== p.payee || amount !== p.amount.toString())
      }
    }
  }

  // 4. the free preflight
  const client = deps.client ?? (await vtpReadClient(chain, env))
  const pre = await preflight(client, chain, p, deps)
  if (!pre.ok) return refused(chain, pre.httpStatus, pre.code, pre.reason, pre.checks, parsed.payOnWarn)

  // 5. no usable payment yet: the challenge
  const asked = { payOnWarn: parsed.payOnWarn, payee: p.payee }
  if (!payment || !payment.ok) return paymentRequired(chain, status, railDeps, pre.checks, asked, payment && !payment.ok ? payment.reason : undefined)
  const shapeError = paymentShapeError(chain, payment, status.payTo)
  if (shapeError) return paymentRequired(chain, status, railDeps, pre.checks, asked, shapeError)

  // 6. the nonce reserved, so one signed payment reaches Gateway once; then the check, through the rail, in process
  const flowId = payment.nonce
  const ts0 = new Date(now()).toISOString()
  if (flowId) {
    const opening = flowRecord({
      chain,
      flowId,
      now: ts0,
      p,
      payOnWarn: parsed.payOnWarn,
      owner: pre.owner,
      operator: pre.operator,
      settlement: { transferId: null, outcome: 'none', payer: payment.from ?? '', value: '', ts: ts0 },
      block: pre.block,
      verdictBlock: null,
      verdict: null,
      prepared: null,
      outcome: 'opening',
      detail: 'opening',
    })
    const opened = await store.insert(opening)
    if (!opened.ok) {
      logFlowStoreFault('reserving a nonce', opened.reason)
      return refused(chain, 503, 'FLOW_STORE_UNREADABLE', `${FLOW_LOG_REFUSED_WRITE}, so a flow for this payment could not be recorded`, pre.checks)
    }
    if (!opened.inserted) return nonceUsed(chain, flowId, pre.checks)
  }
  const out = await railServeTool('risk_check', { agentId: p.payee, txContext: { amountUsd: p.amountUsd, payee: p.payee } }, header, status, railDeps)
  const expected: ExpectedCheck = { network: chain.caip2, authNonce: payment.nonce ?? '', payer: payment.from ?? '', payee: p.payee, amountUsd: p.amountUsd }
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
      const record = recordView(await closePaidFlow(store, flowId, rec), flowUrl(flowId, origin), rec.outcome, rec.detail)
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
    // No verdict and no paid failure. A reservation that cannot be marked stays opening, which
    // reads as nothing just the same.
    if (flowId) {
      await store.update(flowId, { outcome: 'abandoned', detail: 'rail_failed', updatedAt: ts }, ['opening'])
      await store.prune?.(new Date(now() - ABANDONED_ROW_RETENTION_MS).toISOString())
    }
    const railBody = out.body as Record<string, unknown>
    const challenge = out.httpStatus === 402 && railBody && typeof railBody === 'object' ? arcOnly(chain, railBody) : null
    const railError = (railBody as { error?: unknown })?.error
    const unconfirmed = out.httpStatus === 502 && railError === 'settlement unconfirmed'
    const unknown = out.httpStatus === 502 && railError === 'settlement unknown'
    return {
      httpStatus: out.httpStatus,
      ...(challenge ? { headers: challengeHeaders(challenge) } : {}),
      body: result(chain, {
        stage: 'check_failed',
        charged: unconfirmed || unknown ? null : false,
        ...(unknown ? { code: 'SETTLEMENT_UNKNOWN' as const } : {}),
        checks: pre.checks,
        ...(challenge ? { challenge } : {}),
        rail: { httpStatus: out.httpStatus, body: challenge ?? out.body },
        reason: String((railBody as { verifyError?: unknown })?.verifyError ?? (railBody as { reason?: unknown })?.reason ?? (railBody as { error?: unknown })?.error ?? `the rail answered ${out.httpStatus}`),
        next: unknown
          ? `The settle call got no usable answer from Gateway, so whether this authorization settled is not known and it stays valid until it expires. No verdict was served and no flow was recorded. Do not pay, and look the nonce up on GET /api/x402/gateway/proof, which lists only the newest 50 rows, before signing another. If it reads unconfirmed, treat this nonce as giving no flow: ${anotherAuthorization()}, and this one may still settle until it expires.`
          : unconfirmed
            ? `Gateway answered success but its transfer could not be read back, so no verdict was served and no flow was recorded. Do not pay; the settlement is recorded as unconfirmed on GET /api/x402/gateway/proof. Treat this nonce as giving no flow: ${anotherAuthorization()}, and this one may still settle until it expires.`
            : `No verdict, so do not pay. Nothing was recorded as a flow. Read rail.body for what the Gateway rail refused.${flowId ? ' This nonce has had its one attempt: trying again takes a new authorization.' : ''}`,
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
  } else if (pre.ownerOnly || (v.effective === 'WARN' && !parsed.payOnWarn && pre.owner !== pre.operator)) {
    // The owner's to pay: the vault refuses the operator, whatever the verdict and payOnWarn say, or
    // the verdict is a WARN and nobody opted into paying on one.
    stage = 'awaiting_human'
    outcome = 'awaiting_human'
    detail = pre.ownerOnly ? 'owner_only_handoff' : 'warn_handoff'
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
    ownerHandoff = {
      auditOutcome: 'awaiting_human',
      owner: pre.owner,
      ownerPay: call,
      approvalUrl: approvalUrlFor(chain, p.vault, flowId, { payer: settlement.payer, operator: pre.operator, payee: p.payee }),
      ownerOnly: pre.ownerOnly?.code ?? null,
    }
    prepared = null
  } else if (v.effective === 'WARN' && !parsed.payOnWarn) {
    // The hand-off would go back to the key that asked: nothing a human approved could be told
    // apart from the agent paying itself, so no owner approval is prepared or recorded.
    stage = 'warn_no_human_gate'
    outcome = 'blocked'
    detail = 'warn_no_human_gate'
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
    ...(ownerHandoff?.ownerOnly ? { ownerOnly: ownerHandoff.ownerOnly } : {}),
    outcome,
    detail,
  })
  const closed = await closePaidFlow(store, flowId, rec)
  const record = recordView(closed, flowUrl(flowId, origin), outcome, detail)
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
    const httpStatus = closed.ok ? 409 : 500
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
    awaiting_human: (() => {
      const why = pre.ownerOnly ? `${v.effective}, and the agent cannot pay this: ${pre.ownerOnly.reason} (${pre.ownerOnly.code}), so only the owner can settle it` : 'WARN: the agent must not pay this on its own'
      return ownerHandoff?.ownerPay.simulation.ok === false
        ? `${why}, and the vault would refuse the owner's payment right now (${ownerHandoff.ownerPay.simulation.error}): do not send ownerHandoff.ownerPay, it would revert and cost gas. Ask again once the vault can pay.`
        : `${why}. ${
            ownerHandoff?.approvalUrl
              ? `Send the owner this link to approve it on the vault page with their own wallet: ${ownerHandoff.approvalUrl}. Or the owner can settle it by sending`
              : `There is no link for the vault page, because it will not offer this: ${whyNoApproval({ payer: settlement.payer, operator: pre.operator, payee: p.payee })}. The owner can settle it by sending`
          } ownerHandoff.ownerPay from the owner key ${pre.owner}${ownerHandoff ? `, with ${sendInstruction(ownerHandoff.ownerPay, 'ownerHandoff.ownerPay')}` : ''}; then POST {"txHash": "0x..."} to ${receiptUrl} and the server reads the receipt itself. This payment counts toward the agent's day on the vault: if it uses up today's room, the agent cannot pay until 00:00 UTC unless the owner raises the cap.`
    })(),
    warn_no_human_gate: `WARN, and this vault's owner and operator are the same key (${pre.owner}), so there is no human to hand the payment to: do not pay. Nothing was prepared and no approval was recorded. ${ONE_KEY_WAY_OUT}${
      // A payee we know nothing about, on a vault with no human by construction: pointing an
      // autonomous agent at payOnWarn here would walk it into paying a stranger with no one asked.
      v.signals?.onPlatform === false ? '' : " Or ask again with payOnWarn to pay on the WARN as the agent's own decision."
    } The block is public at ${record.url}.`,
    prepared:
      prepared?.simulation.ok === false
        ? `${v.effective === 'WARN' ? 'payOnWarn prepared this payment on a WARN' : 'The verdict allows this payment'}, but the vault would refuse it right now (${prepared.simulation.error}): do not send it. Ask again once the vault can pay.`
        : `${v.effective === 'WARN' ? 'WARN, and you asked to pay on a WARN with payOnWarn, so this payment is your own decision. ' : ''}Send prepared exactly as given from the operator key ${pre.operator} (to the vault, value 0, chainId ${chain.evmChainId}${prepared ? `, ${sendInstruction(prepared, 'prepared')}` : ''}). Then POST {"txHash": "0x..."} to ${receiptUrl}: the flow is marked executed only after the server reads the receipt from ${chain.name} itself.`,
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
  /** The flow's approval link while it waits for its owner, unless its payer or payee already rule the vault page out. This read looks at no chain, so the link stays after a key is stopped or replaced and past 24 hours, and the page can still refuse it. */
  approvalUrl?: string | null
  error?: string
  note: string
}

/** How many waiting flows one read lists, newest first. More than a person acts on at once. */
export const VAULT_FLOWS_LIMIT = 20
/** How far the checks some other key paid for are counted. The count is a warning, not a tally. */
export const VAULT_FLOWS_OTHERS_CAP = 100

export type VtpVaultFlowsBody = {
  vault: string | null
  network: string
  /** awaiting_human flows on this vault whose check was paid by the key that was its operator at the check, newest first. Compare with the vault's operator now. */
  waiting: VtpFlowRecord[]
  /** More flows like these exist than are listed. */
  truncated: boolean
  /** awaiting_human flows naming this vault whose check another key paid, counted up to the cap. Not requests from the vault's agent. */
  notFromOperator: { count: number; capped: boolean }
  error?: string
  note: string
}

/**
 * GET /api/x402/gateway/flows?vault=0x...: the flows waiting for one vault's owner. Every flow is public
 * by id already, so this publishes nothing new. A check costs 0.005 USDC and may name any vault, so
 * whoever pays for one can put a flow on any vault with a payee of their own. Those are not listed as
 * requests and cannot crowd out the ones that are: only a count of them comes back. A row names the
 * operator of the moment it was checked, so a reader that acts on one compares it with the chain.
 */
export async function readVtpVaultFlows(vaultRaw: unknown, deps: Pick<VtpDeps, 'store'> = {}): Promise<{ httpStatus: number; body: VtpVaultFlowsBody }> {
  const chain = vtpChain()
  const store = deps.store ?? storageVtpStore()
  const note =
    "The flows waiting for this vault's owner. waiting holds those whose check was paid by the key that was the vault's operator when it was checked, newest first; compare that with the vault's operator now before treating one as a request. notFromOperator counts the rest: anyone can buy a check naming any vault, so those are not requests from its agent, and nothing about them is listed. Each flow's record is public at /api/x402/gateway/flows/<flowId>."
  const empty = { waiting: [], truncated: false, notFromOperator: { count: 0, capped: false } }
  if (typeof vaultRaw !== 'string' || !ADDRESS.test(vaultRaw)) {
    return { httpStatus: 400, body: { vault: null, network: chain.caip2, ...empty, error: 'vault must be a 0x address', note } }
  }
  const vault = vaultRaw.toLowerCase()
  const read = store.waiting ? await store.waiting(vault, { limit: VAULT_FLOWS_LIMIT + 1, othersCap: VAULT_FLOWS_OTHERS_CAP }) : { ok: false as const, reason: 'this store cannot list by vault' }
  if (!read.ok) {
    logFlowStoreFault('listing a vault', read.reason)
    return { httpStatus: 503, body: { vault, network: chain.caip2, ...empty, error: FLOW_LOG_UNREADABLE, note } }
  }
  return {
    httpStatus: 200,
    body: {
      vault,
      network: chain.caip2,
      waiting: read.waiting.rows.slice(0, VAULT_FLOWS_LIMIT),
      truncated: read.waiting.rows.length > VAULT_FLOWS_LIMIT,
      notFromOperator: { count: read.waiting.others, capped: read.waiting.others >= VAULT_FLOWS_OTHERS_CAP },
      note,
    },
  }
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
  if (!read.ok) {
    logFlowStoreFault('reading a flow', read.reason)
    return { httpStatus: 503, body: { flowId: id, flow: null, url: null, receiptUrl: null, paymentExplorerUrl: null, error: FLOW_LOG_UNREADABLE, note } }
  }
  if (!read.row || holdsNoFlow(read.row)) return { httpStatus: 404, body: { flowId: id, flow: null, url: null, receiptUrl: null, paymentExplorerUrl: null, error: 'no flow with this id', note } }
  return {
    httpStatus: 200,
    body: {
      flowId: id,
      flow: read.row,
      url: flowUrl(id, origin),
      receiptUrl: `${origin.replace(/\/$/, '')}${flowPath(id)}/receipt`,
      paymentExplorerUrl: read.row.payment?.explorerUrl ?? null,
      approvalUrl: read.row.outcome === 'awaiting_human' ? approvalUrlFor(vtpChain(), read.row.vault, id, { payer: read.row.check?.payer ?? '', operator: read.row.operator ?? '', payee: read.row.payee ?? '' }) : null,
      note,
    },
  }
}
