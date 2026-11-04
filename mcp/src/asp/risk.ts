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
 * Where the line sits (decided 2026-11-04): DENY means we hold evidence against the payee, or that
 * we could not read our record and stayed strict, and the reasons say which. WARN means we do not know
 * enough to vouch for it. A low score is not evidence. A payee we have never seen scores at most 60
 * because nothing has been recorded, and most agents on our platform score under 200 because they have
 * little history, nearly all of them with nothing against them. Signing up with us must not turn a real
 * vendor's WARN into a DENY, so on an agent we hold a record of a low score denies only with evidence on
 * the record. Neither one gets ALLOW: ALLOW needs a record, and a strong one. Revoked KYA and Sybil high
 * are evidence on their own, so they are DENY in every case.
 *
 * The limit of that line, stated in the reasons as well: DENY binds an address we hold a proven record
 * of. A payee with a bad record can appear under a new address and get WARN, so WARN means unknown, not
 * clean.
 *
 * So the line needs two more inputs, RiskSignals.onPlatform and RiskSignals.adverseRecord, computed
 * where the platform state is read (tools.ts). A caller that does not pass them keeps the older,
 * stricter rule, in which no identity and a low score both force DENY: nothing that does not say
 * what it knows silently loosens.
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
  /**
   * Does the record we hold count against this agent? See adverseRecordFrom. true: a low score
   * denies. false, on an agent with onPlatform true: a low score is a WARN, because we hold
   * nothing against it and not enough to vouch for it. Absent: the strict rule applies.
   */
  adverseRecord?: boolean
  /** Jobs a client refunded or disputed. Named in the reasons and never a DENY: see adverseRecordFrom. */
  contestedJobs?: number
}

/** What a platform record can hold against an agent, where agentReputation echoes it. */
export type AdverseEcho = {
  discipline?: { rejectedSettlements?: unknown; overrideAttempts?: unknown } | null
}

/**
 * Whether the platform record holds evidence against this agent. Two inputs count, each a thing the
 * record really holds and each the conduct of the agent's own operator, and one of either is enough:
 *
 *   - rejected settlements: instructions of its own a human refused to let settle
 *     (rejectedSettlements). Only the owner can do that, so a stranger cannot write it.
 *   - guardrail override attempts: tries at recording a blocked action as executed
 *     (overrideAttempts). Only the owner can do that too, and no strict policy can explain it.
 *
 * A row written before a claim is not the owner's, because the importer owned the record until then, so
 * platform/reputation.ts counts from the claim on, and nothing at all on a record still unclaimed.
 *
 * Left out on purpose:
 *
 *   - Contested jobs (refunded or disputed). While the platform signer funds the escrow, a contest
 *     costs the client nothing: one free sign-in can hire any verified agent with a one-hour deadline
 *     at any price, wait it out or refuse a delivery, and refund. That is a stranger writing a permanent
 *     DENY on a vendor, which is the griefing this line exists to prevent. A contest lowers the score
 *     and is named in the reasons, so a reader still sees it. It can move ALLOW to WARN. It cannot make
 *     a DENY. The founder can change this once a client funds its own escrow.
 *   - A low star rating alone. Any client with a finished job can leave one, one star is an opinion
 *     and not an event, and it has the same free-write problem.
 *   - The velocity breaker's refusals and the guardrail block rate. Both are the owner's own limit
 *     doing its job, and scoring them punishes whoever configured themselves most carefully.
 *   - Unverifiable decisions and approvals left open: sloppy integration, not conduct against a
 *     counterparty. They lower the score and stay out of DENY.
 *   - Settled volume, tenure and a missing identity: those say how much we know, not what we hold
 *     against it, which is the whole distinction this file draws.
 *
 * Revoked KYA and Sybil high are not here because they deny by themselves.
 *
 * The limit, stated rather than implied: this catches an operator acting on its own record. What a
 * paying client says about an agent reaches the score and the reasons, and not the DENY.
 *
 * Null when the echo does not carry both and neither is already positive: nothing seen is not nothing
 * held, so a caller passes that on as absent and the strict rule applies.
 */
export function adverseRecordFrom(echo: AdverseEcho | null | undefined): boolean | null {
  const inputs = [echo?.discipline?.rejectedSettlements, echo?.discipline?.overrideAttempts]
  if (inputs.some((n) => typeof n === 'number' && n > 0)) return true
  return inputs.every((n) => typeof n === 'number') ? false : null
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
const REP_DENY_BELOW = 200 // with a record against the agent, reputation under this is denied
const REP_WARN_BELOW = 500 // reputation under this warrants caution
const REP_HIGHVALUE_MIN = 400 // with a record against the agent, below this, high-value txs are denied
const HIGH_VALUE_USD = 100 // "high value" relative to a low-rep counterparty, or to one we know nothing about
const LARGE_TX_USD = 1000 // large absolute amount -> always at least a warning
const NEW_AGENT_DAYS = 7 // younger than this is a "new agent" caution

/**
 * Both halves, because an owner signs on this sentence: unknown is not bad, and it is not clean either.
 * The last sentence is for the clients already installed: this rule reaches them when the server
 * deploys, and an agent that acts on the reasons has to read here that a WARN does not pay by itself.
 */
const UNKNOWN_IS_NOT_CLEAN =
  'This does not mean it is bad, and it does not mean it is clean: we have no evidence at this address, and a payee with a bad record can appear under a new one. Hold the payment for a person to approve, unless the owner has chosen to pay payees like this.'

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
  // Both explicit: we hold a record, and it holds nothing against this agent. Anything else that
  // is not unknownPayee stays strict, so a caller has to say both before a low score stops denying.
  const nothingAgainstIt = signals.onPlatform === true && signals.adverseRecord === false
  const scoreAloneDenies = !unknownPayee && !nothingAgainstIt
  // Revoked and Sybil high are held against it, so "holds nothing against it" would be false there.
  const heldAgainstIt = Boolean(signals.revoked) || signals.sybil === 'high'
  const contested = signals.contestedJobs ?? 0
  const nothingWording = contested > 0 ? 'holds no evidence against it' : 'holds nothing against it'
  const lowScore = signals.reputationScore < REP_DENY_BELOW
  const highValueLowScore = typeof amount === 'number' && amount > HIGH_VALUE_USD && signals.reputationScore < REP_HIGHVALUE_MIN
  const evidence = signals.adverseRecord === true ? ', and our record of it holds evidence against it' : ''

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
  if (lowScore && scoreAloneDenies) {
    denyReasons.push(`Reputation ${signals.reputationScore} is below the safe threshold (${REP_DENY_BELOW})${evidence}`)
  }
  if (highValueLowScore && scoreAloneDenies) {
    denyReasons.push(
      `High-value transaction ($${amount}) to a low-reputation agent (${signals.reputationScore} < ${REP_HIGHVALUE_MIN})${evidence}`,
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
  if (nothingAgainstIt && lowScore && !heldAgainstIt) {
    warnReasons.push(`Our record of this agent ${nothingWording}, and not enough to vouch for it: its reputation is ${signals.reputationScore}, under ${REP_DENY_BELOW}`)
  }
  if (nothingAgainstIt && highValueLowScore && !heldAgainstIt) {
    warnReasons.push(`This payment of $${amount} is over $${HIGH_VALUE_USD}, and our record of this agent ${nothingWording} but not enough to vouch for that amount: its reputation is ${signals.reputationScore}, under ${REP_HIGHVALUE_MIN}`)
  }
  if (!signals.kyaVerified && !signals.revoked) {
    warnReasons.push(signals.onchainVerified ? 'Identity resolved but KYA (wallet-control) is not attested' : 'KYA (wallet-control) is not attested')
  }
  if (signals.reputationScore >= REP_DENY_BELOW && signals.reputationScore < REP_WARN_BELOW) {
    warnReasons.push(`Moderate reputation (${signals.reputationScore}): not enough for us to vouch for it`)
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

  // Added after the decision, because neither of these may move it: evidence at a score above the
  // lines does not reach DENY, and a contest may not do more than the score already did. Both are still
  // named, so a reader who checks the record does not find it contradicts what we told them.
  if (signals.adverseRecord === true && decision !== 'DENY') {
    const belowAmountLine = signals.reputationScore < REP_HIGHVALUE_MIN ? ` A payment over $${HIGH_VALUE_USD} to it would be refused.` : ''
    reasons = [...reasons, `Our record of this agent holds evidence against it: rejected settlements or guardrail override attempts.${belowAmountLine}`]
  }
  if (contested > 0) {
    reasons = [...reasons, `Our record holds ${contested} job${contested === 1 ? '' : 's'} a client refunded or disputed. A contest costs the client nothing while we fund the escrow, so it lowers the score and is not counted as evidence.`]
  }

  return { decision, risk, reasons, signals: { ...signals, txContext } }
}
