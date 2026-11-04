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
 *
 * Where the line sits (decided 2026-11-04): DENY needs a record we hold that counts against this
 * payee, WARN means we do not know enough. A reputation counts only on an agent we hold a record
 * of: a low score there is on its own a DENY, which includes a new agent on our platform that has
 * not built a history yet, so a low score there is not always misconduct. A payee we have never
 * seen scores at most 60 because nothing has been recorded, not because anything went wrong. A
 * real vendor that never signed up with us is not known bad, so it gets WARN and reasons that say
 * what we do not know. It never gets ALLOW: ALLOW needs a record.
 *
 * The limit of that line, stated in the reasons as well: DENY binds an address we hold a record
 * of. A payee with a bad record can appear under a new address and get WARN, so WARN means
 * unknown, not clean.
 *
 * So the line needs one more input, RiskSignals.onPlatform, computed where the platform state
 * is read (tools.ts). A caller that does not pass it keeps the older, stricter rule, in which
 * no identity and a low score both force DENY: nothing that does not say what it knows
 * silently loosens.
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
  /**
   * Do we hold a platform record of this agent? true: we do, so its reputation is evidence.
   * false: we looked and hold none, so it is unknown, not bad. Absent: the caller could not say,
   * so the strict rule applies. Why the line sits here is at the top of this file.
   */
  onPlatform?: boolean
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
const REP_DENY_BELOW = 200 // on an agent we hold a record of, reputation under this is untrustworthy on its own
const REP_WARN_BELOW = 500 // reputation under this warrants caution
const REP_HIGHVALUE_MIN = 400 // on an agent we hold a record of, below this, high-value txs are denied
const HIGH_VALUE_USD = 100 // "high value" relative to a low-rep counterparty, or to one we know nothing about
const LARGE_TX_USD = 1000 // large absolute amount -> always at least a warning
const NEW_AGENT_DAYS = 7 // younger than this is a "new agent" caution

/** Both halves, because an owner signs on this sentence: unknown is not bad, and it is not clean either. */
const UNKNOWN_IS_NOT_CLEAN =
  'This does not mean it is bad, and it does not mean it is clean: we have no evidence at this address, and a payee with a bad record can appear under a new one.'

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
  // Explicitly false: we looked and hold no record. Absent is not this: it stays strict.
  const unknownPayee = signals.onPlatform === false
  // Explicitly true or false: the caller said what it knows, so a missing identity is a gap
  // and not evidence. Absent keeps the older rule, in which it forces DENY.
  const saidWhatItKnows = typeof signals.onPlatform === 'boolean'

  // ── DENY rules ────────────────────────────────────────────────────────────
  if (signals.revoked) {
    denyReasons.push('KYA has been REVOKED - this agent is flagged as an incident (compromised key or repeated disputes)')
  }
  if (signals.sybil === 'high') {
    denyReasons.push('Reputation appears Sybil / wash-traded - most of its jobs were hired by its own operator, not independent counterparties')
  }
  if (!signals.onchainVerified && !saidWhatItKnows) {
    denyReasons.push('No verifiable on-chain identity (ERC-8004) found for this agent')
  }
  if (signals.reputationScore < REP_DENY_BELOW && !unknownPayee) {
    denyReasons.push(`Reputation ${signals.reputationScore} is below the safe threshold (${REP_DENY_BELOW})`)
  }
  if (typeof amount === 'number' && amount > HIGH_VALUE_USD && signals.reputationScore < REP_HIGHVALUE_MIN && !unknownPayee) {
    denyReasons.push(
      `High-value transaction ($${amount}) to a low-reputation agent (${signals.reputationScore} < ${REP_HIGHVALUE_MIN})`,
    )
  }

  // ── WARN rules ────────────────────────────────────────────────────────────
  if (unknownPayee) {
    warnReasons.push(
      signals.onchainVerified
        ? 'An on-chain identity was found for this payee, but we hold no record of it on our platform, so we do not know how it has behaved. ' + UNKNOWN_IS_NOT_CLEAN
        : 'No on-chain identity (ERC-8004) was found for this payee and we hold no record of it on our platform, so we do not know who it is or how it has behaved. ' + UNKNOWN_IS_NOT_CLEAN,
    )
    if (signals.reputationScore < REP_DENY_BELOW) {
      warnReasons.push(`Its score of ${signals.reputationScore} only reflects that we have no history for it, not anything it did`)
    }
  } else if (!signals.onchainVerified && saidWhatItKnows) {
    warnReasons.push('No on-chain identity (ERC-8004) was found for this agent. We hold its platform record, and a missing identity alone does not mean it is bad')
  }
  if (!signals.kyaVerified && !signals.revoked) {
    warnReasons.push(signals.onchainVerified ? 'Identity resolved but KYA (wallet-control) is not attested' : 'KYA (wallet-control) is not attested')
  }
  if (signals.reputationScore >= REP_DENY_BELOW && signals.reputationScore < REP_WARN_BELOW) {
    warnReasons.push(`Moderate reputation (${signals.reputationScore}); proceed with caution`)
  }
  if (signals.sybil === 'medium') {
    warnReasons.push('Possible Sybil signals: partial same-operator hiring or low counterparty diversity')
  }
  // Tenure comes only from our own record, so with no record a 0 means unknown, not new.
  if (signals.tenureDays < NEW_AGENT_DAYS && !unknownPayee) {
    warnReasons.push(`New agent (${signals.tenureDays}d tenure); limited on-chain track record`)
  }
  if (unknownPayee && typeof amount === 'number' && amount > HIGH_VALUE_USD) {
    warnReasons.push(`High-value payment ($${amount}) to a payee we hold no record of`)
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
