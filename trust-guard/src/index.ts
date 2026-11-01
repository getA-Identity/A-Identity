/**
 * @a-identity/trust-guard
 *
 * A tiny, dependency-free guard an AI agent calls BEFORE it pays or hires another agent.
 * One line, `await guard(counterpartyId)`, verifies the counterparty against the live
 * A-Identity Trust Oracle (ERC-8004 identity + KYA + a deterministic 0-1000 reputation +
 * a Sybil check) and THROWS if the verdict is DENY, so a bad counterparty never gets paid.
 *
 *   import { guard } from '@a-identity/trust-guard'
 *   await guard(counterpartyAgentId, { txContext: { amountUsd: 500, kind: 'payment' } })
 *   // ...only runs if the counterparty is not DENY. Otherwise it throws TrustDenyError.
 *
 * The tools are sold per call over x402 on three rails, and this SDK never hides that:
 *
 *  - rail 'xlayer' (the default, unchanged since 0.1): the OKX.AI Trust Oracle, paid in
 *    USDT0 on X Layer mainnet.
 *  - rail 'algorand': the same verdicts plus a batch audit, paid in USDC on Algorand
 *    mainnet. Pair it with `algorandPayer` from `@a-identity/trust-guard/algorand` and the
 *    agent pays from its own account, under a per-call spending cap.
 *  - rail 'arc': USDC through Circle Gateway on Arc Mainnet, signed from a Gateway balance.
 *    `arcGatewayPayer` from `@a-identity/trust-guard/arc` pays for a verdict, and
 *    `verifyThenPay` from the same entry point buys a verdict and then pays from a vault.
 *
 * If a call returns HTTP 402, the guard either invokes your `onPaymentRequired` payer and
 * retries once, or throws `PaymentRequiredError` with the challenge so you can pay.
 *
 * On rail 'arc', guard() returns only a verdict it can show is the one it paid for; see
 * TrustGuard.guard. The other two rails keep their behaviour since 0.1: their listings are
 * registered against it, so tightening them is a decision of its own.
 */

export type Decision = 'ALLOW' | 'WARN' | 'DENY'

/** Which x402 rail the calls go to and are paid on. */
export type Rail = 'xlayer' | 'algorand' | 'arc'

/** A transaction the guard is being asked about (sharpens the verdict). */
export interface TxContext {
  amountUsd?: number
  kind?: string
}

/** The risk_check verdict, exactly as the Trust Oracle returns it. */
export interface RiskVerdict {
  tool: 'risk_check'
  agentId: string
  decision: Decision
  risk: string
  reasons: string[]
  signals?: Record<string, unknown>
  checkedAt?: string
  [k: string]: unknown
}

/** One agent's line in a batch audit. */
export interface BatchAuditEntry {
  agentId: string
  decision: Decision
  risk: string
  reasons: string[]
  reputationScore: number | null
  onchainVerified: boolean | null
  kyaVerified: boolean | null
  revoked: boolean | null
}

/** The batch audit result (Algorand rail only). */
export interface BatchAudit {
  tool: 'agent_batch_audit'
  count: number
  summary: { ALLOW: number; WARN: number; DENY: number }
  results: BatchAuditEntry[]
  checkedAt?: string
  [k: string]: unknown
}

/** A risk_check bought through Circle Gateway: what was paid, and how to find it again. */
export interface GatewayCheckReference {
  /** CAIP-2 network the check settled on. */
  network: string
  /** The Gateway authorization's nonce, which is also the flow id. */
  authNonce: string
  transferId: string | null
  gatewayOutcome: 'credited' | 'completed'
  payer: string
  /** The price in USDC base units, 6 decimals. */
  amountUnits: string
  resource: string
  checkedAt?: string
}

/** Where a DENY that came out of verifyThenPay can be inspected. Absent on a plain guard(). */
export interface TrustDenyContext {
  /** The check's Gateway authorization nonce. */
  flowId?: string
  check?: GatewayCheckReference
  /** The public flow record. Absent when the server could not record the flow. */
  recordUrl?: string
}

/** Thrown by `guard()` when the counterparty must not be transacted with. */
export class TrustDenyError extends Error {
  readonly verdict: RiskVerdict
  readonly context?: TrustDenyContext
  constructor(verdict: RiskVerdict, context?: TrustDenyContext) {
    super(`Trust guard blocked agent ${verdict.agentId}: ${verdict.decision} (${verdict.reasons?.join('; ') || 'no reasons'})`)
    this.name = 'TrustDenyError'
    this.verdict = verdict
    if (context) this.context = context
  }
}

export type UnusableVerdictCode =
  | 'DECISION_UNKNOWN'
  | 'REPUTATION_NOT_FINITE'
  | 'TENURE_NOT_FINITE'
  | 'SIGNALS_MISSING'
  | 'SIGNALS_INCONSISTENT'
  | 'SETTLEMENT_MISMATCH'
  | 'TOOL_MISMATCH'
  | 'CONTEXT_MISMATCH'
  | 'STAGE_MISMATCH'

/** The check was paid and its answer cannot be acted on, so it is treated as DENY. */
export class UnusableVerdictError extends Error {
  readonly code: UnusableVerdictCode
  readonly verdict: unknown
  readonly flowId?: string
  readonly recordUrl?: string
  constructor(code: UnusableVerdictCode, message: string, o: { verdict: unknown; flowId?: string; recordUrl?: string }) {
    super(message)
    this.name = 'UnusableVerdictError'
    this.code = code
    this.verdict = o.verdict
    if (o.flowId) this.flowId = o.flowId
    if (o.recordUrl) this.recordUrl = o.recordUrl
  }
}

/** Thrown when a paid tool returns HTTP 402 and no `onPaymentRequired` handler is set. */
export class PaymentRequiredError extends Error {
  readonly challenge: unknown
  readonly resource: string
  constructor(resource: string, challenge: unknown) {
    super(`Payment required for ${resource}. Provide onPaymentRequired to pay via x402, or point baseUrl at a free instance.`)
    this.name = 'PaymentRequiredError'
    this.resource = resource
    this.challenge = challenge
  }
}

/** A generic non-402 HTTP failure from the Trust Oracle. */
export class TrustOracleError extends Error {
  readonly status: number
  readonly data: unknown
  constructor(message: string, status: number, data: unknown) {
    super(message)
    this.name = 'TrustOracleError'
    this.status = status
    this.data = data
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface TrustGuardOptions {
  /** Which rail to call and pay on. Defaults to 'xlayer', the behaviour of 0.1. */
  rail?: Rail
  /** Trust Oracle base URL. Defaults to the hosted instance for the chosen rail. */
  baseUrl?: string
  /** Inject a fetch implementation (tests, non-global-fetch runtimes). */
  fetch?: FetchLike
  /**
   * Satisfy an x402 402 challenge and return the extra request headers to retry with (an
   * `X-PAYMENT` header from an OKX Agentic Wallet on X Layer, or the `PAYMENT-SIGNATURE`
   * header `algorandPayer` builds on Algorand and `arcGatewayPayer` builds on Arc Mainnet).
   * Return null to give up (the call then throws PaymentRequiredError). Omit to always throw
   * on 402.
   */
  onPaymentRequired?: (challenge: unknown, ctx: { resource: string; body: unknown }) => Promise<Record<string, string> | null>
}

const DEFAULT_BASE_URLS: Record<Rail, string> = {
  xlayer: 'https://a-identity-asp.onrender.com',
  algorand: 'https://a-identity.xyz',
  arc: 'https://a-identity.xyz',
}

const TOOL_PATHS: Record<Rail, string> = {
  xlayer: '/tools/',
  algorand: '/api/x402/algorand/tools/',
  arc: '/api/x402/gateway/tools/',
}

/** risk_check answers ALLOW only at or above this reputation, so an ALLOW below it is a fault. */
export const ALLOW_MIN_REPUTATION = 500

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * A verdict is not signed, so TLS is the only thing binding it to the server that wrote it.
 * Https, or plain http on this machine. Parsed rather than matched, so that neither
 * http://localhost.example nor http://localhost:1@example.com counts as this machine.
 */
export function requireSecureBaseUrl(raw: string): string {
  const trimmed = String(raw).replace(/\/+$/, '')
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    throw new TypeError(`baseUrl is not a URL: ${String(raw)}`)
  }
  if (u.username || u.password) throw new TypeError('baseUrl must not carry credentials')
  if (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname))) return trimmed
  throw new TypeError(`baseUrl must be https, or http on localhost: ${trimmed}`)
}

/** What was signed for this call, read from the header the payer built. */
type SignedCheck = { nonce: string; payer: string | null; network: string | null }

const lowered = (v: unknown): string | null => (typeof v === 'string' ? v.toLowerCase() : null)

function readSignedCheck(headers: Record<string, string>): SignedCheck | null {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'payment-signature')
  if (!key) return null
  try {
    const sent = JSON.parse(decodeBase64(headers[key])) as { accepted?: { network?: unknown }; payload?: { authorization?: { nonce?: unknown; from?: unknown } } }
    const nonce = lowered(sent.payload?.authorization?.nonce)
    if (!nonce) return null
    return { nonce, payer: lowered(sent.payload?.authorization?.from), network: typeof sent.accepted?.network === 'string' ? sent.accepted.network : null }
  } catch {
    return null
  }
}

/**
 * Whether a risk_check answer on the arc rail can be acted on. The caller's next line signs a
 * payment, so everything but a shown ALLOW or WARN throws. A DENY needs nothing further to be
 * believed: it stops here whatever else the answer says, and whatever denyOn says.
 */
function judgeArcVerdict(verdict: RiskVerdict, agentId: string, signed: SignedCheck | null, denyOn: Decision[]): RiskVerdict {
  const unusable = (code: UnusableVerdictCode, why: string) => new UnusableVerdictError(code, `the answer cannot be acted on: ${why}`, { verdict, ...(signed ? { flowId: signed.nonce } : {}) })
  const decision: unknown = verdict.decision
  if (decision !== 'ALLOW' && decision !== 'WARN' && decision !== 'DENY') {
    throw unusable('DECISION_UNKNOWN', `the decision is ${JSON.stringify(decision ?? null)}, not ALLOW, WARN or DENY`)
  }
  if (decision === 'DENY' || denyOn.includes(decision)) throw new TrustDenyError(verdict)
  if (verdict.tool !== 'risk_check') throw unusable('TOOL_MISMATCH', `the answer is from ${String(verdict.tool)}, not risk_check`)
  if (lowered(verdict.agentId) !== agentId.trim().toLowerCase()) throw unusable('CONTEXT_MISMATCH', `the verdict is about ${String(verdict.agentId)}, not ${agentId}`)
  const rep = verdict.signals?.reputationScore
  if (typeof rep !== 'number' || !Number.isFinite(rep) || rep < 0 || rep > 1000) {
    throw unusable('REPUTATION_NOT_FINITE', `the reputation is ${JSON.stringify(rep ?? null)}, not a finite number in [0, 1000]`)
  }
  if (decision === 'ALLOW' && rep < ALLOW_MIN_REPUTATION) throw unusable('SIGNALS_INCONSISTENT', `ALLOW needs a reputation of at least ${ALLOW_MIN_REPUTATION}, and this one is ${rep}`)
  if (!signed) throw unusable('SETTLEMENT_MISMATCH', 'nothing was signed for this answer, so it cannot be the verdict that was paid for')
  const s = verdict.settlement as Record<string, unknown> | null | undefined
  if (typeof s !== 'object' || s === null) throw unusable('SETTLEMENT_MISMATCH', 'the answer carries no settlement record')
  if (lowered(s.authNonce) !== signed.nonce) throw unusable('SETTLEMENT_MISMATCH', 'the settlement names another authorization nonce than the one signed')
  if (lowered(s.payer) !== signed.payer) throw unusable('SETTLEMENT_MISMATCH', 'the settlement names another payer than the one that signed')
  if (s.network !== signed.network) throw unusable('SETTLEMENT_MISMATCH', `the check settled on ${String(s.network)}, not ${String(signed.network)}`)
  if (s.outcome !== 'credited' && s.outcome !== 'completed') throw unusable('SETTLEMENT_MISMATCH', `the settlement outcome is ${String(s.outcome)}, not credited or completed`)
  if (s.tool !== 'risk_check') throw unusable('SETTLEMENT_MISMATCH', `the settlement is for ${String(s.tool)}, not risk_check`)
  return verdict
}

export class TrustGuard {
  readonly rail: Rail
  readonly baseUrl: string
  private readonly doFetch: FetchLike
  private readonly onPaymentRequired?: TrustGuardOptions['onPaymentRequired']

  constructor(opts: TrustGuardOptions = {}) {
    this.rail = opts.rail ?? 'xlayer'
    if (!(this.rail in DEFAULT_BASE_URLS)) throw new Error(`Unknown rail '${String(this.rail)}'; use 'xlayer', 'algorand' or 'arc'.`)
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URLS[this.rail]).replace(/\/+$/, '')
    if (this.rail === 'arc') requireSecureBaseUrl(this.baseUrl)
    const f = opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch
    if (!f) throw new Error('No fetch available; pass opts.fetch (Node < 18 or a custom runtime).')
    this.doFetch = f
    this.onPaymentRequired = opts.onPaymentRequired
  }

  /** ERC-8004 identity + KYA status for an agent. */
  verify(agentId: string): Promise<Record<string, unknown>> {
    return this.call('verify_agent', { agentId })
  }

  /** Deterministic 0-1000 reputation (with the on-chain attestation, if published). */
  reputation(agentId: string): Promise<Record<string, unknown>> {
    return this.call('reputation_score', { agentId })
  }

  /** Pre-transaction ALLOW / WARN / DENY verdict on a counterparty. */
  riskCheck(agentId: string, txContext?: TxContext): Promise<RiskVerdict> {
    return this.call('risk_check', { agentId, txContext: txContext ?? null }) as Promise<RiskVerdict>
  }

  /** The full identity + reputation + KYA + risk passport. */
  passport(agentId: string): Promise<Record<string, unknown>> {
    return this.call('agent_passport', { agentId })
  }

  /**
   * Every verdict for a shortlist of up to 50 agents in one paid call (Algorand rail only).
   * The oracle produces the whole audit before the payment is submitted, so an audit that
   * cannot finish costs nothing.
   */
  batchAudit(agentIds: string[], txContext?: TxContext): Promise<BatchAudit> {
    if (this.rail !== 'algorand') {
      return Promise.reject(new Error("batchAudit is sold on the Algorand rail only: construct with { rail: 'algorand' }."))
    }
    return this.call('agent_batch_audit', { agentIds, txContext: txContext ?? null }) as Promise<BatchAudit>
  }

  /**
   * Before you pay an Algorand address (Algorand rail only): a Looks safe / Be careful /
   * Don't pay verdict from the public record, with its reasons, and the paid details: its
   * biggest payers, its last payments, and the wallet that created it. Takes the address, or
   * the link of an x402 seller listed with the facilitator.
   */
  payCheck(address: string): Promise<Record<string, unknown>> {
    if (this.rail !== 'algorand') {
      return Promise.reject(new Error("payCheck is sold on the Algorand rail only: construct with { rail: 'algorand' }."))
    }
    return this.call('pay_check', { address })
  }

  /**
   * The safety gate. Runs risk_check and THROWS `TrustDenyError` when the verdict is in
   * `denyOn` (default just `['DENY']`; pass `['DENY','WARN']` to also block warnings).
   * Returns the verdict otherwise, so you can log/branch on ALLOW vs WARN.
   *
   *   await guard.guard(counterpartyId, { txContext: { amountUsd: 500 } })
   *
   * On rail 'arc' this fails closed, because the caller's next line signs a payment. DENY always
   * throws, and so does anything that is not ALLOW or WARN. A returned verdict is also about
   * this agent, carries a finite reputation (at least 500 on an ALLOW), and carries a settlement
   * record for the nonce signed for this call. Anything else throws `UnusableVerdictError`. WARN
   * still returns unless `denyOn` names it; on this rail pass ['DENY', 'WARN'], or use
   * `verifyThenPay` from `@a-identity/trust-guard/arc`, where WARN never pays by itself.
   */
  async guard(agentId: string, opts: { txContext?: TxContext; denyOn?: Decision[] } = {}): Promise<RiskVerdict> {
    const denyOn = opts.denyOn ?? ['DENY']
    if (this.rail === 'arc') {
      const { data, signed } = await this.exchange('risk_check', { agentId, txContext: opts.txContext ?? null })
      return judgeArcVerdict(data as unknown as RiskVerdict, agentId, signed, denyOn)
    }
    const verdict = await this.riskCheck(agentId, opts.txContext)
    if (denyOn.includes(verdict.decision)) throw new TrustDenyError(verdict)
    return verdict
  }

  private async call(tool: string, body: unknown): Promise<Record<string, unknown>> {
    return (await this.exchange(tool, body)).data
  }

  private async exchange(tool: string, body: unknown): Promise<{ data: Record<string, unknown>; signed: SignedCheck | null }> {
    const url = this.baseUrl + TOOL_PATHS[this.rail] + tool
    let signed: SignedCheck | null = null
    let res = await this.doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 402) {
      const challenge = await readChallenge(res)
      if (this.onPaymentRequired) {
        const headers = await this.onPaymentRequired(challenge, { resource: url, body })
        if (headers) {
          signed = readSignedCheck(headers)
          res = await this.doFetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
          })
        }
      }
      if (res.status === 402) throw new PaymentRequiredError(url, challenge)
    }
    const data = await safeJson(res)
    if (!res.ok) {
      const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `HTTP ${res.status}`
      throw new TrustOracleError(msg, res.status, data)
    }
    return { data: (data ?? {}) as Record<string, unknown>, signed }
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/**
 * The 402 challenge. x402 v2 servers carry it in the PAYMENT-REQUIRED header (base64 JSON)
 * and may or may not repeat it in the body, so a body with an `accepts` list wins and the
 * header is the fallback.
 */
async function readChallenge(res: Response): Promise<unknown> {
  const body = await safeJson(res)
  if (body && typeof body === 'object' && Array.isArray((body as { accepts?: unknown }).accepts)) return body
  const header = res.headers.get('payment-required')
  if (header) {
    try {
      return JSON.parse(decodeBase64(header))
    } catch {
      /* fall back to whatever the body held */
    }
  }
  return body
}

function decodeBase64(b64: string): string {
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** One-shot convenience: construct a default guard and run the gate. Throws on DENY. */
export async function guard(
  agentId: string,
  opts: {
    txContext?: TxContext
    denyOn?: Decision[]
    rail?: Rail
    baseUrl?: string
    fetch?: FetchLike
    onPaymentRequired?: TrustGuardOptions['onPaymentRequired']
  } = {},
): Promise<RiskVerdict> {
  const { txContext, denyOn, ...clientOpts } = opts
  return new TrustGuard(clientOpts).guard(agentId, { txContext, denyOn })
}

export default TrustGuard
