/**
 * The audit trail (Phase 1.4): every decision, recorded.
 *
 * Pure and testable, like the rest of this module. Shaping, hashing, filtering and
 * capping live here; the state and its persistence live in platform.ts, so the decision
 * path stays a function and only one place touches storage.
 *
 * Two rules from docs/compliance-robinhood.md section 5 are structural here, not
 * conventions someone has to remember:
 *
 *  1. The snapshot is NOT stored, only a hash of it. An account snapshot is holdings and
 *     buying power. Keeping it would turn an audit log into a financial dossier, and we
 *     do not need it: the hash proves which state a verdict was computed against, which
 *     is the whole point of auditing a decision.
 *  2. What is stored is bounded and truncated, so a caller cannot grow an entry without
 *     limit or smuggle a payload through a label.
 */
import { createHash } from 'node:crypto'
import type { AccountSnapshot, ActionKind, Decision, NormalizedIntent, Surface, Verdict } from './types.js'

/** What the human or the caller did after the verdict. Recorded separately, later. */
export type AuditOutcome =
  /** The action was carried out (ALLOW, or WARN a human confirmed). */
  | 'executed'
  /** The policy stopped it. */
  | 'blocked'
  /** WARN, still waiting on a human. */
  | 'awaiting_human'
  /** WARN, and nobody ever confirmed. */
  | 'abandoned'

/** The intent as recorded: the decision-relevant fields only, all bounded. */
export type AuditIntent = {
  kind: ActionKind
  notionalUsd: number
  side?: string
  symbol?: string
  assetClass?: string
  settingKey?: string
  cadence?: string
  label?: string
  /** Spend surface. Without these the receipt for a card purchase would not say which
   *  merchant or which card, which is most of what makes it a receipt. */
  merchant?: string
  mcc?: string
  cardId?: string
}

export type AuditEntry = {
  id: string
  /** ISO timestamp of the decision. */
  ts: string
  agentId: string
  surface: Surface
  intent: AuditIntent
  verdict: Verdict
  reasons: string[]
  codes: string[]
  policyId: string
  policyVersion: number
  /** sha256 of the canonical snapshot, or null when no snapshot was supplied. Proves
   *  which account state the verdict was computed against without storing it. */
  snapshotHash: string | null
  /** True when a rule could not be evaluated and failed closed. */
  unverifiable: boolean
  outcome: AuditOutcome
  /** Set when the outcome was updated after the fact. */
  outcomeAt?: string
  /** Post-trade evidence from the caller, e.g. a venue order id. Order history is the
   *  only proof an action happened, so an audit entry can be reconciled rather than
   *  trusted (the upstream tool calls this the order-evidence rule). */
  evidenceRef?: string
  /**
   * How many times someone tried to record this blocked action as executed. Refusing the
   * override is not enough on its own: an operator repeatedly trying to mark DENYed
   * actions as done is the single most informative behavioral signal we have, and it only
   * exists if we count the attempt instead of silently rejecting it.
   */
  overrideAttempts?: number
}

const MAX_STR = 120
const trunc = (v: string | undefined, n = MAX_STR): string | undefined =>
  typeof v === 'string' && v.length ? v.slice(0, n) : undefined

/**
 * Hash a snapshot canonically: key order must not change the hash, or the same state
 * would produce two different hashes and reconciliation would be meaningless.
 */
export function hashSnapshot(snapshot: AccountSnapshot | undefined): string | null {
  if (!snapshot) return null
  const canonical = JSON.stringify({
    todayNotionalUsd: snapshot.todayNotionalUsd,
    portfolioValueUsd: snapshot.portfolioValueUsd ?? null,
    buyingPowerUsd: snapshot.buyingPowerUsd ?? null,
    cashAvailableUsd: snapshot.cashAvailableUsd ?? null,
    marginUsedUsd: snapshot.marginUsedUsd ?? null,
    accountType: snapshot.accountType ?? null,
    // Positions are sorted so an equivalent portfolio in a different order still hashes
    // the same. Only the fields a verdict can depend on are included.
    positions: [...snapshot.positions]
      .map((p) => ({ symbol: (p.symbol ?? '').toUpperCase(), shares: p.shares ?? null, valueUsd: p.valueUsd }))
      .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)),
  })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

/** The default outcome implied by a verdict, before a human does anything. */
export function initialOutcome(verdict: Verdict): AuditOutcome {
  return verdict === 'DENY' ? 'blocked' : verdict === 'WARN' ? 'awaiting_human' : 'executed'
}

/** Shape one decision into a storable entry. Pure: the id and timestamp are passed in. */
export function buildAuditEntry(input: {
  id: string
  ts: string
  agentId: string
  intent: NormalizedIntent
  snapshot?: AccountSnapshot
  decision: Decision
}): AuditEntry {
  const { intent, decision } = input
  const recorded: AuditIntent = { kind: intent.kind, notionalUsd: intent.notionalUsd }
  const side = trunc(intent.side, 8)
  if (side) recorded.side = side
  const symbol = trunc(intent.symbol, 12)
  if (symbol) recorded.symbol = symbol.toUpperCase()
  const assetClass = trunc(intent.assetClass, 12)
  if (assetClass) recorded.assetClass = assetClass
  const settingKey = trunc(intent.settingKey, 32)
  if (settingKey) recorded.settingKey = settingKey.toLowerCase()
  const cadence = trunc(intent.cadence, 32)
  if (cadence) recorded.cadence = cadence
  const label = trunc(intent.label)
  if (label) recorded.label = label
  const merchant = trunc(intent.merchant, 60)
  if (merchant) recorded.merchant = merchant
  const mcc = trunc(intent.mcc, 8)
  if (mcc) recorded.mcc = mcc
  const cardId = trunc(intent.cardId, 60)
  if (cardId) recorded.cardId = cardId

  return {
    id: input.id,
    ts: input.ts,
    agentId: input.agentId,
    surface: decision.surface,
    intent: recorded,
    verdict: decision.verdict,
    // Bound the arrays too: a pathological policy could otherwise produce a huge entry.
    reasons: decision.reasons.slice(0, 20).map((r) => r.slice(0, 300)),
    codes: decision.codes.slice(0, 20),
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    snapshotHash: hashSnapshot(input.snapshot),
    unverifiable: decision.unverifiable,
    outcome: initialOutcome(decision.verdict),
  }
}

/** Hard cap on stored entries per agent. Oldest are dropped first. */
export const MAX_AUDITS_PER_AGENT = 500

/** Rows returned when a caller does not ask for a specific number. */
export const DEFAULT_AUDIT_LIMIT = 100

/**
 * Trim an agent's entries to the cap, keeping the most recent. Returns a new array.
 * Bounded storage is not optional: this state is persisted as one JSON document.
 */
export function capAudits(entries: AuditEntry[], max = MAX_AUDITS_PER_AGENT): AuditEntry[] {
  return entries.length <= max ? entries : entries.slice(entries.length - max)
}

/**
 * Query entries: newest first, optionally only those at or after `since`, capped by
 * `limit`. An unparseable `since` is ignored rather than silently returning nothing,
 * which would read as "no activity" and is the more dangerous failure for an audit view.
 */
export function filterAudits(
  entries: AuditEntry[],
  opts: { since?: string; limit?: number } = {},
): { audits: AuditEntry[]; sinceApplied: boolean } {
  let sinceApplied = false
  let out = entries
  if (opts.since) {
    const t = Date.parse(opts.since)
    if (Number.isFinite(t)) {
      sinceApplied = true
      out = out.filter((e) => Date.parse(e.ts) >= t)
    }
  }
  // A non-positive or unparseable limit falls back to the default rather than clamping to
  // one row. Same reasoning as `since` above: in an audit view, quietly returning almost
  // nothing reads as "barely any activity", and that is the dangerous way to be wrong.
  const asked = Math.floor(opts.limit as number)
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(500, asked) : DEFAULT_AUDIT_LIMIT
  return { audits: [...out].reverse().slice(0, limit), sinceApplied }
}

/** Counts for a compact summary: how the policy actually behaved over the window. */
export function summarizeAudits(entries: AuditEntry[]): {
  total: number
  allow: number
  warn: number
  deny: number
  unverifiable: number
  blockedNotionalUsd: number
} {
  return {
    total: entries.length,
    allow: entries.filter((e) => e.verdict === 'ALLOW').length,
    warn: entries.filter((e) => e.verdict === 'WARN').length,
    deny: entries.filter((e) => e.verdict === 'DENY').length,
    unverifiable: entries.filter((e) => e.unverifiable).length,
    // The honest traction metric: USD the policy actually refused. Not a projection.
    blockedNotionalUsd: entries
      .filter((e) => e.verdict === 'DENY')
      .reduce((a, e) => a + e.intent.notionalUsd, 0),
  }
}
