/**
 * The batch trust audit: one paid call, up to BATCH_MAX_AGENTS risk checks, one answer.
 *
 * Built for the buyer the per-agent tools serve badly: an orchestrator or a marketplace
 * holding a shortlist of counterparties that wants every verdict before it commits to any
 * of them. Two properties matter more than speed:
 *
 *  - All or nothing. The rail produces this answer BEFORE it submits the payment, and a
 *    batch that cannot finish inside its deadline is reported as incomplete rather than
 *    trimmed, so nobody pays for fifty verdicts and receives thirty.
 *  - Bounded load. Checks run through a small worker pool, because each one reads live
 *    registries, and fifty unthrottled reads would trade our RPC quota for a faster failure.
 */
import { riskCheck, type TxContext } from '../asp/tools.js'

export const BATCH_MAX_AGENTS = 50
export const BATCH_CONCURRENCY = 10
/** Leaves room for the facilitator's verify and settle plus our own indexer read inside a
 *  proxy's roughly thirty-second window. Ten parallel checks measured about five seconds. */
export const BATCH_DEADLINE_MS = 14_000
const MAX_ID_LENGTH = 200

/**
 * Trimmed, de-duplicated, order-preserving. A comma-separated string is accepted so a paid
 * GET can carry the list in a query param. Anything malformed is refused whole, because the
 * list decides the price.
 */
export function normalizeAgentIds(
  raw: unknown,
  max: number = BATCH_MAX_AGENTS,
): { ok: true; ids: string[] } | { ok: false; reason: string } {
  const list = typeof raw === 'string' ? raw.split(',') : raw
  if (!Array.isArray(list)) {
    return { ok: false, reason: 'agentIds must be an array of agent ids (a comma-separated string on GET)' }
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'string') return { ok: false, reason: 'every agentIds entry must be a string' }
    const id = item.trim()
    if (!id || seen.has(id)) continue
    if (id.length > MAX_ID_LENGTH) return { ok: false, reason: `an agent id is longer than ${MAX_ID_LENGTH} characters` }
    seen.add(id)
    ids.push(id)
  }
  if (ids.length === 0) return { ok: false, reason: 'agentIds names no agent' }
  if (ids.length > max) {
    return { ok: false, reason: `agentIds names ${ids.length} distinct agents; one audit covers at most ${max}` }
  }
  return { ok: true, ids }
}

type RiskLike = { decision: string; risk: string; reasons: string[]; signals?: Record<string, unknown> }
export type BatchCheck = (agentId: string, txContext: TxContext | null) => Promise<RiskLike>

export type BatchAuditEntry = {
  agentId: string
  decision: string
  risk: string
  reasons: string[]
  reputationScore: number | null
  onchainVerified: boolean | null
  kyaVerified: boolean | null
  revoked: boolean | null
}

export type BatchAuditResult = {
  tool: 'agent_batch_audit'
  count: number
  summary: { ALLOW: number; WARN: number; DENY: number }
  results: BatchAuditEntry[]
  checkedAt: string
}

export type BatchAuditOutcome =
  | { ok: true; result: BatchAuditResult }
  | { ok: false; reason: string; completed: number }

export async function runBatchAudit(
  agentIds: string[],
  txContext: TxContext | null,
  deps: { check?: BatchCheck; concurrency?: number; deadlineMs?: number } = {},
): Promise<BatchAuditOutcome> {
  if (agentIds.length === 0) return { ok: false, reason: 'agentIds names no agent', completed: 0 }
  const check: BatchCheck = deps.check ?? riskCheck
  const concurrency = Math.max(1, Math.min(deps.concurrency ?? BATCH_CONCURRENCY, agentIds.length))
  const deadlineMs = deps.deadlineMs ?? BATCH_DEADLINE_MS
  const entries: BatchAuditEntry[] = new Array(agentIds.length)
  // Shared by the workers; once `failure` is set no worker starts another check.
  const state: { next: number; completed: number; failure: string | null } = { next: 0, completed: 0, failure: null }

  const worker = async (): Promise<void> => {
    while (state.failure === null && state.next < agentIds.length) {
      const index = state.next++
      const agentId = agentIds[index]
      try {
        const verdict = await check(agentId, txContext)
        const s = verdict.signals ?? {}
        entries[index] = {
          agentId,
          decision: verdict.decision,
          risk: verdict.risk,
          reasons: verdict.reasons ?? [],
          reputationScore: typeof s.reputationScore === 'number' ? s.reputationScore : null,
          onchainVerified: typeof s.onchainVerified === 'boolean' ? s.onchainVerified : null,
          kyaVerified: typeof s.kyaVerified === 'boolean' ? s.kyaVerified : null,
          revoked: typeof s.revoked === 'boolean' ? s.revoked : null,
        }
        state.completed += 1
      } catch (e) {
        state.failure ??= `the check for ${agentId} failed: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), deadlineMs)
  })
  const finished = Promise.all(Array.from({ length: concurrency }, () => worker())).then(() => 'done' as const)
  const outcome = await Promise.race([finished, deadline])
  clearTimeout(timer)
  if (outcome === 'deadline' && state.failure === null) {
    state.failure = `the audit did not finish inside ${deadlineMs} ms (${state.completed} of ${agentIds.length} checks done)`
  }
  if (state.failure !== null) return { ok: false, reason: state.failure, completed: state.completed }

  const summary = { ALLOW: 0, WARN: 0, DENY: 0 }
  for (const e of entries) {
    if (e.decision === 'ALLOW' || e.decision === 'WARN' || e.decision === 'DENY') summary[e.decision] += 1
  }
  return {
    ok: true,
    result: { tool: 'agent_batch_audit', count: entries.length, summary, results: entries, checkedAt: new Date().toISOString() },
  }
}
