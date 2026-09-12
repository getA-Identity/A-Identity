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
 * The tools are sold per call over x402 on two rails, and this SDK never hides that:
 *
 *  - rail 'xlayer' (the default, unchanged since 0.1): the OKX.AI Trust Oracle, paid in
 *    USDT0 on X Layer mainnet.
 *  - rail 'algorand': the same verdicts plus a batch audit, paid in USDC on Algorand
 *    mainnet. Pair it with `algorandPayer` from `@a-identity/trust-guard/algorand` and the
 *    agent pays from its own account, under a per-call spending cap.
 *
 * If a call returns HTTP 402, the guard either invokes your `onPaymentRequired` payer and
 * retries once, or throws `PaymentRequiredError` with the challenge so you can pay.
 */

export type Decision = 'ALLOW' | 'WARN' | 'DENY'

/** Which x402 rail the calls go to and are paid on. */
export type Rail = 'xlayer' | 'algorand'

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

/** Thrown by `guard()` when the counterparty must not be transacted with. */
export class TrustDenyError extends Error {
  readonly verdict: RiskVerdict
  constructor(verdict: RiskVerdict) {
    super(`Trust guard blocked agent ${verdict.agentId}: ${verdict.decision} (${verdict.reasons?.join('; ') || 'no reasons'})`)
    this.name = 'TrustDenyError'
    this.verdict = verdict
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
   * header `algorandPayer` builds on Algorand). Return null to give up (the call then throws
   * PaymentRequiredError). Omit to always throw on 402.
   */
  onPaymentRequired?: (challenge: unknown, ctx: { resource: string; body: unknown }) => Promise<Record<string, string> | null>
}

const DEFAULT_BASE_URLS: Record<Rail, string> = {
  xlayer: 'https://a-identity-asp.onrender.com',
  algorand: 'https://a-identity.xyz',
}

const TOOL_PATHS: Record<Rail, string> = {
  xlayer: '/tools/',
  algorand: '/api/x402/algorand/tools/',
}

export class TrustGuard {
  readonly rail: Rail
  readonly baseUrl: string
  private readonly doFetch: FetchLike
  private readonly onPaymentRequired?: TrustGuardOptions['onPaymentRequired']

  constructor(opts: TrustGuardOptions = {}) {
    this.rail = opts.rail ?? 'xlayer'
    if (!(this.rail in DEFAULT_BASE_URLS)) throw new Error(`Unknown rail '${String(this.rail)}'; use 'xlayer' or 'algorand'.`)
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URLS[this.rail]).replace(/\/+$/, '')
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
   * The safety gate. Runs risk_check and THROWS `TrustDenyError` when the verdict is in
   * `denyOn` (default just `['DENY']`; pass `['DENY','WARN']` to also block warnings).
   * Returns the verdict otherwise, so you can log/branch on ALLOW vs WARN.
   *
   *   await guard.guard(counterpartyId, { txContext: { amountUsd: 500 } })
   */
  async guard(agentId: string, opts: { txContext?: TxContext; denyOn?: Decision[] } = {}): Promise<RiskVerdict> {
    const denyOn = opts.denyOn ?? ['DENY']
    const verdict = await this.riskCheck(agentId, opts.txContext)
    if (denyOn.includes(verdict.decision)) throw new TrustDenyError(verdict)
    return verdict
  }

  private async call(tool: string, body: unknown): Promise<Record<string, unknown>> {
    const url = this.baseUrl + TOOL_PATHS[this.rail] + tool
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
    return (data ?? {}) as Record<string, unknown>
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
