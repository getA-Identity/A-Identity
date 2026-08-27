/**
 * Pre-transaction counterparty risk assessment - the logic behind the ASP
 * `risk_check` tool. Deterministic ALLOW / WARN / DENY over an agent's real
 * trust signals (on-chain ERC-8004 identity, KYA attestation, 0-1000 reputation,
 * tenure), optionally sharpened by the transaction context (amount, payee).
 *
 * This is the one piece of NEW logic the OKX ASP adds on top of A-Identity's
 * existing engine: it composes the verified identity + reputation signals into a
 * single ALLOW/WARN/DENY decision an agent can act on before it pays a counterparty.
 * Pure and side-effect free so it unit-tests offline (no RPC, no keys).
 */

export type RiskDecision = 'ALLOW' | 'WARN' | 'DENY'
export type RiskLevel = 'low' | 'medium' | 'high'
export type SybilLevel = 'none' | 'low' | 'medium' | 'high'

/** The real, verifiable signals a risk decision is computed from. */
export type RiskSignals = {
  /** A resolvable on-chain ERC-8004 identity was found for this agent. */
  onchainVerified: boolean
  /** KYA (wallet-control) attested - on the ValidationRegistry or platform-side. */
  kyaVerified: boolean
  /** 0-1000 reputation from real on-chain settlements + tenure. */
  reputationScore: number
  /** Days since the agent's identity was registered / created. */
  tenureDays: number
  /** KYA was revoked / the agent is flagged as an incident. Forces DENY. */
  revoked?: boolean
  /** Sybil / wash-reputation cluster risk (same-operator self-dealing). 'high' forces DENY. */
  sybil?: SybilLevel
}

/** Optional transaction context - makes the decision amount-aware. */
export type TxContext = {
  amountUsd?: number
  payee?: string
}

export type RiskResult = {
  decision: RiskDecision
  risk: RiskLevel
  /** Human-readable reasons, most important first. Always non-empty. */
  reasons: string[]
  signals: RiskSignals & { txContext: TxContext | null }
}

// Thresholds. Kept as named constants so the policy is auditable and testable.
const REP_DENY_BELOW = 200 // reputation under this is untrustworthy on its own
const REP_WARN_BELOW = 500 // reputation under this warrants caution
const REP_HIGHVALUE_MIN = 400 // below this, high-value txs are denied
const HIGH_VALUE_USD = 100 // "high value" relative to a low-rep counterparty
const LARGE_TX_USD = 1000 // large absolute amount -> always at least a warning
const NEW_AGENT_DAYS = 7 // younger than this is a "new agent" caution

/** Real Sybil / wash-reputation signals from platform state (same-operator hiring + cluster size). */
export type SybilSignals = {
  /** Other agents registered by the same owner (operator cluster size). */
  siblingCount: number
  /** This agent's committed hired jobs (as the worker). */
  jobs: number
  /** Distinct clients that hired it. */
  uniqueClients: number
  /** Jobs whose hirer is this agent's OWN operator (self-dealt / wash). */
  selfDealt: number
  /** selfDealt / jobs (0..1). */
  selfDealRate: number
  /** uniqueClients / jobs (0..1); low = concentrated/suspicious. */
  diversity: number
}

/**
 * Classify Sybil / wash-reputation risk from real platform signals: HIGH when reputation is
 * mostly self-dealt (an operator hiring its own agents to inflate the score), MEDIUM on partial
 * self-dealing or a large cluster with low counterparty diversity. Pure + unit-tested. Detects
 * SAME-operator wash only; cross-operator collusion needs a funder-graph indexer (see /methodology).
 */
export function classifySybil(s: SybilSignals): SybilLevel {
  if (s.jobs >= 2 && s.selfDealRate >= 0.6) return 'high'
  if (s.selfDealRate >= 0.34 || (s.siblingCount >= 4 && s.jobs >= 2 && s.diversity < 0.4)) return 'medium'
  if (s.selfDealt > 0 || s.siblingCount >= 4) return 'low'
  return 'none'
}

/**
 * Assess counterparty risk. Returns a decision, a risk level, and the reasons.
 * DENY overrides WARN overrides ALLOW; reasons from every triggered rule are kept.
 */
export function assessRisk(signals: RiskSignals, txContext: TxContext | null = null): RiskResult {
  const denyReasons: string[] = []
  const warnReasons: string[] = []
  const amount = txContext?.amountUsd

  // ── DENY rules ────────────────────────────────────────────────────────────
  if (signals.revoked) {
    denyReasons.push('KYA has been REVOKED - this agent is flagged as an incident (compromised key or repeated disputes)')
  }
  if (signals.sybil === 'high') {
    denyReasons.push('Reputation appears Sybil / wash-traded - most of its jobs were hired by its own operator, not independent counterparties')
  }
  if (!signals.onchainVerified) {
    denyReasons.push('No verifiable on-chain identity (ERC-8004) found for this agent')
  }
  if (signals.reputationScore < REP_DENY_BELOW) {
    denyReasons.push(`Reputation ${signals.reputationScore} is below the safe threshold (${REP_DENY_BELOW})`)
  }
  if (typeof amount === 'number' && amount > HIGH_VALUE_USD && signals.reputationScore < REP_HIGHVALUE_MIN) {
    denyReasons.push(
      `High-value transaction ($${amount}) to a low-reputation agent (${signals.reputationScore} < ${REP_HIGHVALUE_MIN})`,
    )
  }

  // ── WARN rules ────────────────────────────────────────────────────────────
  if (!signals.kyaVerified && !signals.revoked) {
    warnReasons.push('Identity resolved but KYA (wallet-control) is not attested')
  }
  if (signals.reputationScore >= REP_DENY_BELOW && signals.reputationScore < REP_WARN_BELOW) {
    warnReasons.push(`Moderate reputation (${signals.reputationScore}); proceed with caution`)
  }
  if (signals.sybil === 'medium') {
    warnReasons.push('Possible Sybil signals: partial same-operator hiring or low counterparty diversity')
  }
  if (signals.tenureDays < NEW_AGENT_DAYS) {
    warnReasons.push(`New agent (${signals.tenureDays}d tenure); limited on-chain track record`)
  }
  if (typeof amount === 'number' && amount > LARGE_TX_USD) {
    warnReasons.push(`Large transaction amount ($${amount})`)
  }

  let decision: RiskDecision
  let risk: RiskLevel
  let reasons: string[]
  if (denyReasons.length > 0) {
    decision = 'DENY'
    risk = 'high'
    reasons = [...denyReasons, ...warnReasons]
  } else if (warnReasons.length > 0) {
    decision = 'WARN'
    risk = 'medium'
    reasons = warnReasons
  } else {
    decision = 'ALLOW'
    risk = 'low'
    reasons = ['Verified on-chain identity, attested KYA, and strong reputation']
  }

  return { decision, risk, reasons, signals: { ...signals, txContext } }
}
