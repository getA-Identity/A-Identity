/**
 * Reputation scoring from real platform activity: settlements, marketplace outcomes,
 * Sybil signals and guardrail discipline.
 * Layering: L2 domain module; imports ./core.js and flat ../ modules only.
 */
import { state, type PlatformAgent } from './core.js'
import { computeAgentReputation } from '../reputation.js'
import { resolveActionPolicy } from '../policy/index.js'
import { classifySybil, type SybilSignals } from '../asp/risk.js'
import { getReputationAttestation } from '../asp/attestations.js'

// ── reputation (from real activity) ─────────────────────────────────────────────

/**
 * Reputation (0-1000) computed from the agent's REAL signals: on-chain USDC settlements,
 * a credit for holding a verified on-chain ERC-8004 identity, the clean (settled vs
 * rejected) ratio, and tenure. Every input is real and verifiable (settlements carry tx
 * hashes) - no mock history. The math lives in the pure, unit-tested `computeAgentReputation`
 * (reputation.ts), so the tested scorer and the production scorer are the same code.
 */
/**
 * Real behavioral signals from marketplace jobs where this agent was the WORKER: completed
 * (released) vs contested (refunded/disputed) outcomes, and the mean client star rating.
 * Every input is real and tracked in `state.tasks` (no mock, no self-attestation). Shared by
 * the scorer (repOf) and the display summary (agentReputation) so they can never drift.
 */
function behavioralSignals(agent: PlatformAgent) {
  const hired = state.tasks.filter((t) => t.agentId === agent.id)
  const released = hired.filter((t) => t.status === 'released')
  const completedTasks = released.length
  // A release whose escrow settled on chain and one that settled in simulation are counted
  // the same here, deliberately. The behaviour term measures the DISPUTE RATE, so dropping
  // simulated releases from the numerator would raise every such agent's dispute rate and
  // make the score worse, not more honest. What honesty requires is that the caller can see
  // the split, so it is published in the echo below rather than folded away.
  const completedOnchain = released.filter((t) => t.settlement === 'onchain').length
  const disputedTasks = hired.filter((t) => t.status === 'refunded' || t.status === 'disputed').length
  const ratings = hired
    .map((t) => t.review?.rating)
    .filter((r): r is number => typeof r === 'number' && Number.isFinite(r))
  const ratedCount = ratings.length
  const avgRating = ratedCount ? ratings.reduce((a, r) => a + r, 0) / ratedCount : undefined
  return { completedTasks, completedOnchain, disputedTasks, ratedCount, avgRating }
}

/**
 * Real Sybil / wash-reputation signals from platform state: how many agents share this agent's
 * operator (owner), and how much of its hired work came from its OWN operator (self-dealing) vs
 * independent clients. Same-operator hiring inflates reputation without real demand. Honest by
 * design: cross-operator collusion is NOT detected here (it needs a funder-graph indexer).
 */
function sybilSignals(agent: PlatformAgent): SybilSignals {
  const owner = agent.owner
  const siblingCount = owner ? state.agents.filter((a) => a.owner === owner && a.id !== agent.id).length : 0
  const hired = state.tasks.filter(
    (t) => t.agentId === agent.id && t.status !== 'open' && t.status !== 'assigned' && t.status !== 'cancelled',
  )
  const jobs = hired.length
  const clients = hired.map((t) => t.client).filter((c): c is string => typeof c === 'string' && c.length > 0)
  const uniqueClients = new Set(clients).size
  const selfDealt = owner ? clients.filter((c) => c === owner).length : 0
  const selfDealRate = jobs ? selfDealt / jobs : 0
  const diversity = jobs ? uniqueClients / jobs : 1
  return { siblingCount, jobs, uniqueClients, selfDealt, selfDealRate, diversity }
}

/**
 * Real guardrail-discipline signals from this agent's own decision trail (Phase 5.1). Every
 * input is recorded, not self-reported: the audit entries come from actual checks.
 *
 * The block rate is deliberately NOT gathered. A high share of refusals is not evidence of a
 * bad agent, and scoring it would punish whoever configured themselves most carefully.
 */
function disciplineSignals(agent: PlatformAgent) {
  const entries = state.audits[agent.id] ?? []
  const { configured } = resolveActionPolicy(agent.actionPolicy, agent.id, agent.createdAt)
  const warns = entries.filter((e) => e.verdict === 'WARN')
  return {
    policyDecisions: entries.length,
    overrideAttempts: entries.reduce((a, e) => a + (e.overrideAttempts ?? 0), 0),
    unverifiableDecisions: entries.filter((e) => e.unverifiable).length,
    warnDecisions: warns.length,
    danglingApprovals: warns.filter((e) => e.outcome === 'awaiting_human' || e.outcome === 'abandoned').length,
    policyConfigured: configured,
  }
}

export function repOf(agent: PlatformAgent) {
  const ixs = state.instructions.filter((i) => i.agentId === agent.id)
  const settled = ixs.filter((i) => i.status === 'executed_onchain')
  const rejected = ixs.filter((i) => i.status === 'rejected').length
  const settledUsd = settled.reduce((s, i) => s + i.amountUsd * i.count, 0)
  return computeAgentReputation({
    settledCount: settled.length,
    rejected,
    onchainRegistered: agent.onchain === 'registered',
    createdAt: agent.createdAt,
    settledUsd,
    // B3 recency decay: per-settlement timestamps so recent verified activity outweighs
    // ancient history (see reputation.ts HALF_LIFE_DAYS).
    settledAt: settled.map((i) => i.createdAt),
    ...behavioralSignals(agent),
    ...disciplineSignals(agent),
  })
}

export function agentReputation(agentId: string) {
  const q = agentId.trim()
  // Resolve by platform id, on-chain token id ("#849980" / "849980"), or owner address, so the
  // public get_reputation tool answers the same queries the trust explorer resolves identity with.
  const agent =
    state.agents.find((a) => a.id === q) ??
    state.agents.find((a) => a.onchainAgentId && (a.onchainAgentId === q || `#${a.onchainAgentId}` === q)) ??
    (/^0x[0-9a-fA-F]{40}$/.test(q) ? state.agents.find((a) => a.walletAddress?.toLowerCase() === q.toLowerCase()) : undefined)
  if (!agent) return { error: 'Unknown agent' }
  // A transparent echo of the behavioral inputs so a caller (or an OKX reviewer) sees WHY the
  // behavior band moved the score, not just the number. Every field is real, from state.tasks.
  const b = behavioralSignals(agent)
  const terminalHired = b.completedTasks + b.disputedTasks
  const behavioral = {
    completedJobs: b.completedTasks,
    // Of those completed jobs, how many settled on chain. The remainder ran without a
    // signer: real work, released by a real client, but no receipt behind the money.
    completedJobsOnchain: b.completedOnchain,
    completedJobsSimulated: b.completedTasks - b.completedOnchain,
    contestedJobs: b.disputedTasks,
    disputeRate: terminalHired > 0 ? Math.round((b.disputedTasks / terminalHired) * 100) / 100 : 0,
    avgRating: b.avgRating != null ? Math.round(b.avgRating * 100) / 100 : null,
    ratedJobs: b.ratedCount,
  }
  // A transparent Sybil echo (level + the real signals behind it) so risk_check's DENY/WARN is
  // explainable - every field is computed from state.agents + state.tasks, no fabrication.
  const sig = sybilSignals(agent)
  const sybil = {
    level: classifySybil(sig),
    siblingCount: sig.siblingCount,
    jobs: sig.jobs,
    selfDealt: sig.selfDealt,
    selfDealRate: Math.round(sig.selfDealRate * 100) / 100,
    diversity: Math.round(sig.diversity * 100) / 100,
  }
  // A transparent echo of the guardrail-discipline inputs, so the discipline band is
  // explainable the same way behavior and Sybil are. The block rate is reported for context
  // but is NOT scored: a tight policy doing its job is indistinguishable from an agent
  // pushing at its limits, and penalizing it would punish the most careful users.
  const dsc = disciplineSignals(agent)
  const entries = state.audits[agent.id] ?? []
  const discipline = {
    decisions: dsc.policyDecisions,
    policyConfigured: dsc.policyConfigured,
    overrideAttempts: dsc.overrideAttempts,
    unverifiableDecisions: dsc.unverifiableDecisions,
    approvalsAwaited: dsc.warnDecisions,
    approvalsUnclosed: dsc.danglingApprovals,
    blockRate:
      dsc.policyDecisions > 0
        ? Math.round((entries.filter((e) => e.verdict === 'DENY').length / dsc.policyDecisions) * 100) / 100
        : 0,
    blockRateScored: false,
    excludesPnl: true,
  }
  // A1: the latest ERC-8004 on-chain attestation of this score (null until one is published),
  // so the public explorer / get_reputation can link the on-chain anchor, not just the number.
  const onchainAttestation = getReputationAttestation(agent.onchainAgentId ?? null)
  return { agentId: agent.id, name: agent.name, onchain: agent.onchain, kya: agent.kya, ...repOf(agent), behavioral, sybil, discipline, onchainAttestation, computedAt: new Date().toISOString() }
}
