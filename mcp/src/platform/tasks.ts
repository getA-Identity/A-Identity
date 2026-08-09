/**
 * Marketplace tasks: hire, open tasks + bids, delivery, escrow release/dispute and
 * the public service catalog.
 * Layering: L7 domain module; imports ./core.js, ./feed.js and flat ../ modules only.
 */
import { state, save, id, ownsAgent, pushActivity, short, type PlatformAgent } from './core.js'
import { isShowcase } from './feed.js'
import {
  type Task, type TaskStatus, type Review, type Bid,
  canTransition, normalizePriceUsd, normalizeDeadlineHours, deadlineFrom,
  sanitizeRating, aggregateRating,
} from '../marketplace.js'
import { runEscrowJobDemo, fundEscrowOnchain, completeEscrowOnchain, rejectJobOnchain } from '../arc-contracts.js'

// ── marketplace tasks: hire a verified worker, escrow-settled on release ───────────
//
// A client hires a KYA-verified agent for a service; the task runs off-chain through its
// lifecycle (funded -> delivered -> released | refunded) and SETTLES on-chain via the existing
// ERC-8183 escrow (runEscrowJobDemo) at release/dispute. Honest by design: 'onchain' settlement
// carries a real tx only with a signer key; without one it settles 'simulated' (no fake tx).
// In this build the platform signer drives the ERC-8183 escrow roles (create/fund/submit/
// complete); worker-signed, multi-party settlement is the roadmap. The escrow lifecycle IS real
// on Arc, so every task carries a real jobId + tx.

/** Testnet signer safety: the shared server key funds the escrow, so cap a task's on-chain
 *  settlement (mirrors MAX_DEMO_USD on the HTTP demo endpoints). */
const MARKETPLACE_MAX_TASK_USD = 5

function transitionTask(task: Task, to: TaskStatus): boolean {
  if (!canTransition(task.status, to)) return false
  task.status = to
  task.updatedAt = new Date().toISOString()
  return true
}

/**
 * Best-effort: lock a task's escrow ON-CHAIN at hire via the granular ERC-8183 flow (createJob
 * -> setBudget -> approve -> fund). On success the task carries a real jobId + fund tx (funds
 * genuinely held in the contract, verifiable on arcscan). ANY failure (no key, RPC, revert)
 * leaves the task off-chain funded so a hire never breaks. This is the "funds lock on-chain at
 * hire" path; the platform signer is the escrow party in this build (per-party wallet signing is
 * the remaining roadmap piece). Release completes it via completeEscrowOnchain.
 */
async function tryOnchainFund(task: Task, agent?: PlatformAgent): Promise<void> {
  try {
    const esc = await fundEscrowOnchain({ budgetUsd: task.priceUsd, description: `A-Identity marketplace task ${task.id}: ${task.service}` })
    if (esc.executed) {
      task.jobId = esc.jobId
      const fund = esc.steps.find((s) => s.step === 'fund') ?? esc.steps[esc.steps.length - 1]
      task.escrowTx = fund?.txHash
      task.escrowExplorer = fund?.explorerUrl
      if (agent) pushActivity(agent, `Escrow locked on-chain at hire (ERC-8183 job ${esc.jobId}, tx ${short(task.escrowTx ?? '')})`)
    }
  } catch {
    /* off-chain funded fallback — never blocks the hire */
  }
}

/**
 * Hire a verified worker agent. Trusted-marketplace rule: only a KYA-verified agent can be
 * hired. Creates a task in 'funded' (the client commits; the ERC-8183 escrow settles on
 * release). The price is clamped to the testnet settlement cap so the shared signer is safe.
 */
export async function hireAgent(input: {
  agentId: string
  service: string
  priceUsd: number
  description?: string
  deadlineHours?: number
  client?: string
}): Promise<Task | { error: string }> {
  if (!input.client) return { error: 'Forbidden: sign in with a verified session to hire' }
  const agent = state.agents.find((a) => a.id === input.agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (agent.kya !== 'verified') return { error: 'Only KYA-verified agents can be hired (the trusted-marketplace rule)' }
  const service = String(input.service ?? '').slice(0, 200).trim()
  if (!service) return { error: 'service required' }
  // The service must be one the agent actually offers (when it lists any).
  if (agent.services.length > 0 && !agent.services.some((s) => s.name === service)) {
    return { error: `Agent does not offer service "${service}"` }
  }
  const priceUsd = Math.min(normalizePriceUsd(input.priceUsd), MARKETPLACE_MAX_TASK_USD)
  if (priceUsd <= 0) return { error: 'priceUsd must be a positive number' }
  const now = new Date().toISOString()
  const task: Task = {
    id: id('task'),
    client: input.client,
    agentId: agent.id,
    service,
    priceUsd,
    description: String(input.description ?? '').slice(0, 2000),
    status: 'funded',
    createdAt: now,
    updatedAt: now,
    deadlineAt: deadlineFrom(now, normalizeDeadlineHours(input.deadlineHours)),
  }
  state.tasks.push(task)
  // Best-effort: lock the escrow on-chain at hire (real ERC-8183 fund). Falls back to
  // off-chain funded on any failure, so a hire never breaks.
  await tryOnchainFund(task, agent)
  pushActivity(
    agent,
    task.jobId
      ? `Hired for "${service}" ($${priceUsd.toFixed(2)}); escrow locked on-chain (task ${task.id})`
      : `Hired for "${service}" ($${priceUsd.toFixed(2)}); escrow committed (task ${task.id})`,
  )
  save(state)
  return task
}

/**
 * Post an OPEN task without choosing a worker: verified agents bid, the client picks one. The
 * budget caps what any bid may charge. Client-only (any verified session).
 */
export function postOpenTask(input: {
  service: string
  budgetUsd: number
  description?: string
  deadlineHours?: number
  client?: string
}): Task | { error: string } {
  if (!input.client) return { error: 'Forbidden: sign in with a verified session to post a task' }
  const service = String(input.service ?? '').slice(0, 200).trim()
  if (!service) return { error: 'service required' }
  const budget = Math.min(normalizePriceUsd(input.budgetUsd), MARKETPLACE_MAX_TASK_USD)
  if (budget <= 0) return { error: 'budgetUsd must be a positive number' }
  const now = new Date().toISOString()
  const task: Task = {
    id: id('task'),
    client: input.client,
    agentId: '',
    service,
    priceUsd: budget,
    description: String(input.description ?? '').slice(0, 2000),
    status: 'open',
    bids: [],
    createdAt: now,
    updatedAt: now,
    deadlineAt: deadlineFrom(now, normalizeDeadlineHours(input.deadlineHours)),
  }
  state.tasks.push(task)
  save(state)
  return task
}

/** A verified agent bids on an open task (bid ≤ the task budget). Bidder = the agent owner. */
export function bidOnTask(taskId: string, input: { agentId: string; priceUsd: number }, caller?: string): Task | { error: string } {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return { error: 'Unknown task' }
  if (task.status !== 'open') return { error: `Cannot bid on a task in status ${task.status}` }
  const agent = state.agents.find((a) => a.id === input.agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  if (agent.kya !== 'verified') return { error: 'Only KYA-verified agents can bid' }
  if (agent.services.length > 0 && !agent.services.some((s) => s.name === task.service)) {
    return { error: `Agent does not offer service "${task.service}"` }
  }
  const priceUsd = Math.min(normalizePriceUsd(input.priceUsd), task.priceUsd)
  if (priceUsd <= 0) return { error: 'bid priceUsd must be positive and no greater than the budget' }
  const bid: Bid = { agentId: agent.id, agentName: agent.name, priceUsd, at: new Date().toISOString() }
  task.bids = (task.bids ?? []).filter((b) => b.agentId !== agent.id)
  task.bids.push(bid)
  task.updatedAt = bid.at
  pushActivity(agent, `Bid $${priceUsd.toFixed(2)} on open task ${task.id}`)
  save(state)
  return task
}

/** The client accepts a bid: the task is assigned to that agent and its escrow is committed. */
export async function acceptBid(taskId: string, agentId: string, caller?: string): Promise<Task | { error: string }> {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return { error: 'Unknown task' }
  if (task.client !== caller) return { error: 'Forbidden: only the client who posted can accept a bid' }
  if (task.status !== 'open') return { error: `Task is not open (status ${task.status})` }
  const bid = (task.bids ?? []).find((b) => b.agentId === agentId)
  if (!bid) return { error: 'No such bid on this task' }
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent || agent.kya !== 'verified') return { error: 'The bidding agent is no longer verified' }
  task.agentId = agentId
  task.priceUsd = bid.priceUsd
  transitionTask(task, 'assigned')
  transitionTask(task, 'funded')
  await tryOnchainFund(task, agent) // lock the escrow on-chain on accept (best-effort)
  pushActivity(agent, `Won open task ${task.id} at $${bid.priceUsd.toFixed(2)}; escrow ${task.jobId ? 'locked on-chain' : 'committed'}`)
  save(state)
  return task
}

/** Public list of open tasks awaiting bids (minimal, no client PII). */
export function listOpenTasks() {
  return {
    tasks: state.tasks
      .filter((t) => t.status === 'open')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((t) => ({ id: t.id, service: t.service, budgetUsd: t.priceUsd, description: t.description, bids: (t.bids ?? []).length, createdAt: t.createdAt, deadlineAt: t.deadlineAt })),
  }
}

/** The hired agent's owner delivers a result. funded -> delivered. */
export function deliverTask(taskId: string, deliverable: string, caller?: string): Task | { error: string } {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return { error: 'Unknown task' }
  const agent = state.agents.find((a) => a.id === task.agentId)
  if (!agent || !ownsAgent(agent, caller)) return { error: 'Forbidden: only the hired agent owner can deliver' }
  if (!canTransition(task.status, 'delivered')) return { error: `Cannot deliver from status ${task.status}` }
  task.deliverable = String(deliverable ?? '').slice(0, 5000)
  transitionTask(task, 'delivered')
  pushActivity(agent, `Delivered task ${task.id}`)
  save(state)
  return task
}

/**
 * The client approves and RELEASES the escrow: runs the real ERC-8183 lifecycle
 * (createJob -> fund -> submit -> complete), paying the worker. With a signer key it is a
 * real on-chain settlement (jobId + tx); without one it settles 'simulated' (honest, no
 * fake tx). An optional review is recorded. delivered | funded -> released.
 */
export async function releaseTask(
  taskId: string,
  input: { rating?: number; review?: string } = {},
  caller?: string,
): Promise<Task | { error: string }> {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return { error: 'Unknown task' }
  if (task.client !== caller) return { error: 'Forbidden: only the hiring client can release' }
  if (!canTransition(task.status, 'released')) return { error: `Cannot release from status ${task.status}` }
  const agent = state.agents.find((a) => a.id === task.agentId)

  // Escrow was locked on-chain at hire (has a jobId): complete THAT job on-chain, no new job.
  if (task.jobId) {
    const done = await completeEscrowOnchain(BigInt(task.jobId))
    if (!done.executed) {
      return { error: `On-chain escrow release failed (${done.reason}); the funds remain in escrow — retry, or dispute to refund.` }
    }
    const c = done.steps.find((s) => s.step === 'complete') ?? done.steps[done.steps.length - 1]
    task.releaseTx = c?.txHash
    task.escrowExplorer = c?.explorerUrl
    task.settlement = 'onchain'
    if (input.rating !== undefined || (typeof input.review === 'string' && input.review.trim())) {
      task.review = { by: caller!, rating: sanitizeRating(input.rating ?? 5), text: String(input.review ?? '').slice(0, 1000), at: new Date().toISOString() }
    }
    transitionTask(task, 'released')
    if (agent) pushActivity(agent, `Task ${task.id} released: escrow completed on-chain (job ${task.jobId}, tx ${short(task.releaseTx ?? '')})`)
    save(state)
    return task
  }

  const escrow = await runEscrowJobDemo({
    budgetUsd: task.priceUsd,
    description: `A-Identity marketplace task ${task.id}: ${task.service}`,
    outcome: 'complete',
  })
  if (escrow.executed) {
    // executed:true can still be a partial/failed lifecycle (failedAt set, status 'Reverted'):
    // never mark a task released off a broken settlement. Honesty over optimism.
    if (escrow.failedAt || escrow.status === 'Reverted')
      return { error: `On-chain escrow did not complete (${escrow.failedAt ?? escrow.status}): ${escrow.reason ?? 'reverted'}` }
    const done = escrow.steps.find((s) => s.step === 'complete') ?? escrow.steps[escrow.steps.length - 1]
    task.jobId = escrow.jobId
    task.releaseTx = done?.txHash
    task.escrowExplorer = done?.explorerUrl
    task.settlement = 'onchain'
  } else {
    task.settlement = 'simulated'
  }
  if (input.rating !== undefined || (typeof input.review === 'string' && input.review.trim())) {
    task.review = {
      by: caller!,
      rating: sanitizeRating(input.rating ?? 5),
      text: String(input.review ?? '').slice(0, 1000),
      at: new Date().toISOString(),
    }
  }
  transitionTask(task, 'released')
  if (agent)
    pushActivity(
      agent,
      task.settlement === 'onchain'
        ? `Task ${task.id} released: escrow paid on-chain (ERC-8183 job ${task.jobId ?? '?'}, tx ${short(task.releaseTx ?? '')})`
        : `Task ${task.id} released (simulated settlement; no signer key)`,
    )
  save(state)
  return task
}

/**
 * The client disputes the deliverable: runs the real ERC-8183 refund lifecycle (the escrow
 * is refunded to the client in the same reject tx). Real on-chain with a key, 'simulated'
 * without. funded | delivered -> refunded (buyer protection).
 */
export async function disputeTask(taskId: string, reason: string, caller?: string): Promise<Task | { error: string }> {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return { error: 'Unknown task' }
  if (task.client !== caller) return { error: 'Forbidden: only the hiring client can dispute' }
  if (!canTransition(task.status, 'refunded')) return { error: `Cannot dispute from status ${task.status}` }
  const agent = state.agents.find((a) => a.id === task.agentId)

  // Escrow locked on-chain at hire: reject the job on-chain (refunds the client in the same tx).
  if (task.jobId) {
    const rej = await rejectJobOnchain(BigInt(task.jobId), String(reason ?? '').slice(0, 200))
    if (!rej.executed) {
      return { error: `On-chain dispute failed (${rej.reason}); retry.` }
    }
    task.refundTx = rej.txHash
    task.escrowExplorer = rej.explorerUrl
    task.settlement = 'onchain'
    transitionTask(task, 'refunded')
    if (agent) pushActivity(agent, `Task ${task.id} disputed: escrow refunded on-chain (tx ${short(task.refundTx ?? '')})`)
    save(state)
    return task
  }

  const escrow = await runEscrowJobDemo({
    budgetUsd: task.priceUsd,
    description: `A-Identity marketplace dispute ${task.id}: ${String(reason ?? '').slice(0, 200)}`,
    outcome: 'refund',
  })
  if (escrow.executed) {
    if (escrow.failedAt || escrow.status === 'Reverted')
      return { error: `On-chain refund did not complete (${escrow.failedAt ?? escrow.status}): ${escrow.reason ?? 'reverted'}` }
    const rej = escrow.steps.find((s) => s.step === 'reject') ?? escrow.steps[escrow.steps.length - 1]
    task.jobId = escrow.jobId
    task.refundTx = rej?.txHash
    task.escrowExplorer = rej?.explorerUrl
    task.settlement = 'onchain'
  } else {
    task.settlement = 'simulated'
  }
  transitionTask(task, 'refunded')
  if (agent)
    pushActivity(
      agent,
      task.settlement === 'onchain'
        ? `Task ${task.id} disputed: escrow refunded to client on-chain (tx ${short(task.refundTx ?? '')})`
        : `Task ${task.id} disputed (simulated refund; no signer key)`,
    )
  save(state)
  return task
}

/** Read one task; only a party to it (the client or the hired agent's owner) may read. */
export function getTask(taskId: string, caller?: string): Task | { error: string } {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return { error: 'Unknown task' }
  const agent = state.agents.find((a) => a.id === task.agentId)
  const isParty = task.client === caller || (agent ? ownsAgent(agent, caller) : false)
  if (!isParty) return { error: 'Forbidden: not a party to this task' }
  return task
}

/** Tasks a client has opened (the "my hires" view). */
export function listTasksForClient(caller?: string): Task[] {
  return caller ? state.tasks.filter((t) => t.client === caller) : []
}

/** Tasks assigned to an agent (the worker "my jobs" view). Owner-only. */
export function listTasksForAgent(agentId: string, caller?: string): Task[] | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  return state.tasks.filter((t) => t.agentId === agentId)
}

/**
 * The public service catalog (the card grid): every verified showcase agent's services with
 * an aggregated rating + review count + completed-task count from real tasks. Best-rated first.
 */
export function marketplaceCatalog() {
  const services = state.agents.filter(isShowcase).flatMap((agent) =>
    agent.services.map((svc) => {
      const svcTasks = state.tasks.filter((t) => t.agentId === agent.id && t.service === svc.name)
      const reviews = svcTasks.map((t) => t.review).filter((r): r is Review => !!r)
      const rating = aggregateRating(reviews)
      return {
        agentId: agent.id,
        agentName: agent.name,
        category: agent.category,
        kya: agent.kya,
        onchain: agent.onchain,
        walletAddress: agent.walletAddress,
        service: svc.name,
        priceUsd: svc.priceUsd,
        unit: svc.unit,
        rating: rating.average,
        reviews: rating.count,
        completed: svcTasks.filter((t) => t.status === 'released').length,
      }
    }),
  )
  services.sort((a, b) => b.rating - a.rating || b.reviews - a.reviews || b.completed - a.completed)
  return { services, total: services.length }
}
