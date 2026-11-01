/**
 * Whether a paid risk_check answer can be acted on, and what it decides.
 *
 * Pure. The Gateway rail returns the tool's body with its settlement record attached; before
 * anything is prepared from it, the answer has to be shown to belong to THIS request and to
 * be a verdict at all. Each rule below exists because the scorer, which this layer may not
 * change (the OKX.AI listings are registered against it), would otherwise let it through:
 *
 *   - The settlement must echo the check we sent: Arc Mainnet, the nonce the payer signed,
 *     the payer, an outcome Gateway credited, and risk_check as the tool. Anything else is a
 *     verdict bought for some other request.
 *   - The verdict must be about the payee, for the amount: agentId is the payee address we
 *     sent, and signals.txContext echoes that payee and that amount. The scorer only echoes
 *     txContext.payee and never compares it with anything, so the comparison is ours.
 *   - A decision that is not ALLOW, WARN or DENY decides nothing and is blocked.
 *   - A reputation that is not a finite number in [0, 1000] is blocked. assessRisk compares
 *     the score with < and >=, which are all false for NaN, so a NaN reputation (null after
 *     JSON) on an otherwise clean agent comes out ALLOW. The same holds for tenure.
 *   - An ALLOW has to agree with the signals it was computed from (on-chain identity,
 *     attested KYA, not revoked, no Sybil flag, reputation at least 500, tenure at least 7
 *     days), the exact conditions under which assessRisk returns ALLOW. An ALLOW that
 *     contradicts them is a scorer fault and is not paid on.
 *   - A WARN has to agree with its signals too: none of the conditions under which assessRisk
 *     returns DENY (revoked, Sybil high, no on-chain identity, reputation under 200, over 100
 *     USD with reputation under 400) may hold. A WARN can lead to pay() with payOnWarn, or to
 *     the owner being asked to pay, so a WARN that should have been a DENY is not acted on.
 *
 * An unusable answer is treated as DENY, with the failing check named, and is recorded as
 * such: the check was paid for, so the record says what was bought and why it was not used.
 */
import type { VtpDecision } from '../storage.js'

export type ExpectedCheck = {
  /** CAIP-2 network the check must have settled on. */
  network: string
  /** The nonce the payer signed, any case. */
  authNonce: string
  /** The payer that signed it, any case. */
  payer: string
  /** The payee address sent as agentId and as txContext.payee, any case. */
  payee: string
  /** txContext.amountUsd as sent. */
  amountUsd: number
}

export type UnusableCode =
  | 'SETTLEMENT_MISMATCH'
  | 'TOOL_MISMATCH'
  | 'CONTEXT_MISMATCH'
  | 'DECISION_UNKNOWN'
  | 'SIGNALS_MISSING'
  | 'REPUTATION_NOT_FINITE'
  | 'TENURE_NOT_FINITE'
  | 'SIGNALS_INCONSISTENT'

/** The parts of the rail's settlement record the flow keeps. */
export type SettlementEcho = {
  network: string
  authNonce: string
  payer: string
  outcome: 'credited' | 'completed'
  transferId: string | null
  value: string
  ts: string
  resource: string
}

type Common = {
  risk: string | null
  reasons: string[]
  reputationScore: number | null
  agentId: string | null
  checkedAt: string | null
}

export type VerdictEvaluation =
  | (Common & { usable: true; decision: VtpDecision; effective: VtpDecision; reputationScore: number; settlement: SettlementEcho })
  | (Common & { usable: false; code: UnusableCode; reason: string; decision: VtpDecision | null; effective: 'DENY'; settlement: SettlementEcho | null })

const DECISIONS: readonly VtpDecision[] = ['ALLOW', 'WARN', 'DENY']
const SETTLED = new Set(['credited', 'completed'])

/** The thresholds under which assessRisk returns ALLOW (asp/risk.ts), restated only to check
 *  that an ALLOW agrees with its own signals. */
const ALLOW_MIN_REPUTATION = 500
const ALLOW_MIN_TENURE_DAYS = 7
/** The thresholds under which it returns DENY, restated to check that a WARN agrees too. */
const DENY_BELOW_REPUTATION = 200
const HIGH_VALUE_USD = 100
const HIGH_VALUE_MIN_REPUTATION = 400

const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : null)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The settlement record, if it echoes the check we sent; otherwise why not. */
export function readSettlement(body: unknown, expected: ExpectedCheck): { ok: true; settlement: SettlementEcho } | { ok: false; reason: string } {
  const s = isObject(body) ? body.settlement : undefined
  if (!isObject(s)) return { ok: false, reason: 'the answer carries no settlement record' }
  if (s.network !== expected.network) return { ok: false, reason: `the check settled on ${String(s.network)}, not ${expected.network}` }
  if (lower(s.authNonce) !== expected.authNonce.toLowerCase()) return { ok: false, reason: 'the settlement names another authorization nonce than the one signed' }
  if (lower(s.payer) !== expected.payer.toLowerCase()) return { ok: false, reason: 'the settlement names another payer than the one that signed' }
  if (typeof s.outcome !== 'string' || !SETTLED.has(s.outcome)) return { ok: false, reason: `the settlement outcome is ${String(s.outcome)}, not credited or completed` }
  if (s.tool !== 'risk_check') return { ok: false, reason: `the settlement is for ${String(s.tool)}, not risk_check` }
  return {
    ok: true,
    settlement: {
      network: s.network,
      authNonce: (s.authNonce as string).toLowerCase(),
      payer: (s.payer as string).toLowerCase(),
      outcome: s.outcome as 'credited' | 'completed',
      transferId: typeof s.transferId === 'string' ? s.transferId : null,
      value: String(s.value ?? ''),
      ts: String(s.ts ?? ''),
      resource: String(s.resource ?? ''),
    },
  }
}

export function evaluateVerdict(body: unknown, expected: ExpectedCheck): VerdictEvaluation {
  const b = isObject(body) ? body : {}
  const signals = isObject(b.signals) ? b.signals : null
  const decision = typeof b.decision === 'string' && (DECISIONS as readonly string[]).includes(b.decision) ? (b.decision as VtpDecision) : null
  const rep = signals?.reputationScore
  const reputationScore = typeof rep === 'number' && Number.isFinite(rep) && rep >= 0 && rep <= 1000 ? rep : null
  const reasons = Array.isArray(b.reasons) ? b.reasons.filter((r): r is string => typeof r === 'string') : []
  const common: Common = {
    risk: typeof b.risk === 'string' ? b.risk : null,
    reasons,
    reputationScore,
    agentId: typeof b.agentId === 'string' ? b.agentId : null,
    checkedAt: typeof b.checkedAt === 'string' ? b.checkedAt : null,
  }
  const settled = readSettlement(body, expected)
  const settlement = settled.ok ? settled.settlement : null
  const unusable = (code: UnusableCode, reason: string): VerdictEvaluation => ({ ...common, usable: false, code, reason, decision, effective: 'DENY', settlement })

  if (!settled.ok) return unusable('SETTLEMENT_MISMATCH', settled.reason)
  if (b.tool !== 'risk_check') return unusable('TOOL_MISMATCH', `the answer is from ${String(b.tool)}, not risk_check`)
  if (lower(b.agentId) !== expected.payee.toLowerCase()) return unusable('CONTEXT_MISMATCH', 'the verdict is about another agent than the payee that was sent')
  if (!decision) return unusable('DECISION_UNKNOWN', `the decision is ${JSON.stringify(b.decision ?? null)}, not ALLOW, WARN or DENY`)
  if (!signals) return unusable('SIGNALS_MISSING', 'the verdict carries no signals to check it against')
  if (!Array.isArray(b.reasons) || reasons.length === 0) return unusable('SIGNALS_MISSING', 'the verdict carries no reasons')
  if (reputationScore === null) {
    return unusable('REPUTATION_NOT_FINITE', `the reputation is ${JSON.stringify(rep ?? null)}, not a finite number in [0, 1000]; the scorer can turn that into ALLOW`)
  }
  const tenure = signals.tenureDays
  if (typeof tenure !== 'number' || !Number.isFinite(tenure) || tenure < 0) {
    return unusable('TENURE_NOT_FINITE', `the tenure is ${JSON.stringify(tenure ?? null)}, not a finite number of days`)
  }
  const ctx = signals.txContext
  if (!isObject(ctx) || lower(ctx.payee) !== expected.payee.toLowerCase() || ctx.amountUsd !== expected.amountUsd) {
    return unusable('CONTEXT_MISMATCH', 'signals.txContext does not echo the payee and the amount that were sent')
  }
  if (decision === 'ALLOW') {
    const contradictions: string[] = []
    if (signals.onchainVerified !== true) contradictions.push('no on-chain identity')
    if (signals.kyaVerified !== true) contradictions.push('KYA not attested')
    if (signals.revoked === true) contradictions.push('revoked')
    if (signals.sybil === 'high' || signals.sybil === 'medium') contradictions.push(`sybil ${String(signals.sybil)}`)
    if (reputationScore < ALLOW_MIN_REPUTATION) contradictions.push(`reputation ${reputationScore} under ${ALLOW_MIN_REPUTATION}`)
    if (tenure < ALLOW_MIN_TENURE_DAYS) contradictions.push(`tenure ${tenure}d under ${ALLOW_MIN_TENURE_DAYS}d`)
    if (contradictions.length) return unusable('SIGNALS_INCONSISTENT', `ALLOW contradicts its own signals: ${contradictions.join(', ')}`)
  }
  if (decision === 'WARN') {
    const denyLevel: string[] = []
    if (signals.revoked) denyLevel.push('revoked')
    if (signals.sybil === 'high') denyLevel.push('sybil high')
    if (signals.onchainVerified !== true) denyLevel.push('no on-chain identity')
    if (reputationScore < DENY_BELOW_REPUTATION) denyLevel.push(`reputation ${reputationScore} under ${DENY_BELOW_REPUTATION}`)
    if (expected.amountUsd > HIGH_VALUE_USD && reputationScore < HIGH_VALUE_MIN_REPUTATION) {
      denyLevel.push(`${expected.amountUsd} USD with reputation ${reputationScore} under ${HIGH_VALUE_MIN_REPUTATION}`)
    }
    if (denyLevel.length) return unusable('SIGNALS_INCONSISTENT', `WARN carries signals that force DENY: ${denyLevel.join(', ')}`)
  }
  return { ...common, usable: true, decision, effective: decision, reputationScore, settlement: settled.settlement }
}
