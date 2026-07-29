/**
 * Per-agent metering and the traction aggregate (Phase 5.3 and 5.5).
 *
 * Why this exists separately from the audit trail: audit entries are CAPPED at 500 per agent
 * so one persisted document cannot grow without bound. Counting traction from those rows
 * would therefore silently understate any agent busy enough to matter, and a metric that
 * quietly shrinks as usage grows is worse than no metric. These counters are monotonic and
 * are never trimmed.
 *
 * Pure: increment and aggregate are functions of their input, so platform.ts owns the state
 * and this owns the arithmetic.
 */
import type { Decision, Surface, Verdict } from './types.js'

/** Monotonic counters for one agent. Never trimmed, unlike the audit rows. */
export type AgentMeter = {
  /** Total decisions ever requested for this agent. */
  checks: number
  allow: number
  warn: number
  deny: number
  /** Decisions that failed closed for missing data. */
  unverifiable: number
  /** Refused attempts to record a blocked action as executed. */
  overrideAttempts: number
  /**
   * USD the policy actually refused, summed over every DENY. The honest traction number:
   * measured, not projected, and the one worth putting in a grant application.
   */
  blockedNotionalUsd: number
  /** USD that cleared a check. Kept separate so "protected" is never confused with "moved". */
  allowedNotionalUsd: number
  /** Per-surface decision counts. */
  bySurface: Partial<Record<Surface, number>>
  firstAt: string
  lastAt: string
}

export function emptyMeter(at: string): AgentMeter {
  return {
    checks: 0,
    allow: 0,
    warn: 0,
    deny: 0,
    unverifiable: 0,
    overrideAttempts: 0,
    blockedNotionalUsd: 0,
    allowedNotionalUsd: 0,
    bySurface: {},
    firstAt: at,
    lastAt: at,
  }
}

/** Fold one decision into a meter. Returns a new meter; never mutates its input. */
export function meterDecision(
  current: AgentMeter | undefined,
  input: { decision: Decision; notionalUsd: number; at: string },
): AgentMeter {
  const m = current ? { ...current, bySurface: { ...current.bySurface } } : emptyMeter(input.at)
  const { decision } = input
  const amount = Number.isFinite(input.notionalUsd) && input.notionalUsd > 0 ? input.notionalUsd : 0

  m.checks += 1
  m.lastAt = input.at
  m.bySurface[decision.surface] = (m.bySurface[decision.surface] ?? 0) + 1
  if (decision.unverifiable) m.unverifiable += 1

  const v: Verdict = decision.verdict
  if (v === 'ALLOW') {
    m.allow += 1
    m.allowedNotionalUsd += amount
  } else if (v === 'WARN') {
    m.warn += 1
  } else {
    m.deny += 1
    m.blockedNotionalUsd += amount
  }
  return m
}

/** Count a refused override attempt. Separate from a decision, because it is not one. */
export function meterOverrideAttempt(current: AgentMeter | undefined, at: string): AgentMeter {
  const m = current ? { ...current, bySurface: { ...current.bySurface } } : emptyMeter(at)
  m.overrideAttempts += 1
  m.lastAt = at
  return m
}

export type Traction = {
  /** Agents with at least one recorded decision. A registered agent nobody ever checked is
   *  not traction, so it is reported separately rather than folded in. */
  activeAgents: number
  registeredAgents: number
  checks: number
  allow: number
  warn: number
  deny: number
  unverifiable: number
  overrideAttempts: number
  /** The grant metric: USD of intended action the policy refused. */
  protectedNotionalUsd: number
  allowedNotionalUsd: number
  bySurface: Partial<Record<Surface, number>>
  /** CI canary activity, counted but kept OUT of every number above. */
  ci: { agents: number; checks: number }
  firstAt: string | null
  lastAt: string | null
  disclosure: string[]
}

/**
 * Aggregate meters into the public traction view.
 *
 * `ci` rows are EXCLUDED from every headline number and reported on their own. A scheduled
 * canary exists to prove the engine still enforces, and letting its synthetic checks inflate
 * a usage metric would turn our own monitoring into fake traction. That is the exact thing
 * the honesty gate forbids, so the exclusion is structural rather than a convention.
 */
export function aggregateTraction(
  rows: { meter: AgentMeter; ci: boolean }[],
  registeredAgents: number,
  ciAgents: number,
): Traction {
  const real = rows.filter((r) => !r.ci)
  const ciRows = rows.filter((r) => r.ci)

  const sum = (pick: (m: AgentMeter) => number) => real.reduce((a, r) => a + pick(r.meter), 0)
  const bySurface: Partial<Record<Surface, number>> = {}
  for (const r of real) {
    for (const [s, n] of Object.entries(r.meter.bySurface)) {
      bySurface[s as Surface] = (bySurface[s as Surface] ?? 0) + (n ?? 0)
    }
  }
  const stamps = real.flatMap((r) => [r.meter.firstAt, r.meter.lastAt]).filter(Boolean).sort()

  return {
    activeAgents: real.filter((r) => r.meter.checks > 0).length,
    registeredAgents,
    checks: sum((m) => m.checks),
    allow: sum((m) => m.allow),
    warn: sum((m) => m.warn),
    deny: sum((m) => m.deny),
    unverifiable: sum((m) => m.unverifiable),
    overrideAttempts: sum((m) => m.overrideAttempts),
    protectedNotionalUsd: Math.round(sum((m) => m.blockedNotionalUsd) * 100) / 100,
    allowedNotionalUsd: Math.round(sum((m) => m.allowedNotionalUsd) * 100) / 100,
    bySurface,
    ci: {
      agents: ciAgents,
      checks: ciRows.reduce((a, r) => a + r.meter.checks, 0),
    },
    firstAt: stamps[0] ?? null,
    lastAt: stamps[stamps.length - 1] ?? null,
    disclosure: [
      'Aggregate only. No agent, owner, holding or amount from any individual account appears here.',
      'protectedNotionalUsd is USD of intended action the policy refused, summed from real decisions. It is measured, not a projection, and it is not revenue.',
      'CI canary activity is counted separately and excluded from every number above, so our own monitoring cannot inflate usage.',
      'A registered agent that was never checked is not counted as active.',
      'Counters begin when metering was introduced. Decisions recorded before that exist in the audit trail but are deliberately not backfilled here, because backfilling from capped rows would produce a number nobody could reproduce.',
    ],
  }
}
