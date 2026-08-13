/**
 * Audit trail + the shareable guardrail card (Phase 3.3).
 *
 * The decision trail is the product's receipt: what the agent intended, what the policy
 * answered, why, and what happened next. Two honesty rules carry over from the backend into
 * how this renders:
 *
 *  - The account snapshot is never stored, only a hash of it, so there is nothing here that
 *    could turn into a holdings dossier. The hash is shown as evidence of WHICH state a
 *    verdict was computed against.
 *  - A decision flagged `unverifiable` failed closed for lack of data. That is materially
 *    different from a clean refusal and is labeled, not blended in.
 *
 * The share card is the badge from Phase 1.5: opt-in, coarse, and it carries no number.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, RefreshCw, Share2, ShieldAlert, ShieldCheck } from 'lucide-react'
import { authHeaders } from '../../../store/auth'
import { apiFetch, readJson, explainError } from '../../../lib/api'
import { Skeleton } from '../../ui/skeleton'

type Verdict = 'ALLOW' | 'WARN' | 'DENY'
type Outcome = 'executed' | 'blocked' | 'awaiting_human' | 'abandoned'
type Enforcement = 'process' | 'wrapper' | 'none'

/**
 * Where a decision's numbers came from. OPTIONAL, and optional forever: rows written
 * before the caller seam existed carry none, and the backend deliberately does not
 * backfill them. So an absent value renders as "not recorded" and never as "direct":
 * inventing a provenance is the one thing an audit view must not do.
 */
type Provenance = {
  callerId: string | null
  venue: string | null
  enforcement: Enforcement
  intentSource: 'direct' | 'caller-adapter'
  snapshotSource: 'direct' | 'caller-adapter' | 'absent'
}

type AuditEntry = {
  id: string
  ts: string
  surface: string
  intent: {
    kind: string
    notionalUsd: number
    side?: string
    symbol?: string
    assetClass?: string
    settingKey?: string
    cadence?: string
    label?: string
    merchant?: string
    mcc?: string
    cardId?: string
  }
  verdict: Verdict
  reasons: string[]
  codes: string[]
  policyId: string
  policyVersion: number
  snapshotHash: string | null
  unverifiable: boolean
  outcome: Outcome
  outcomeAt?: string
  evidenceRef?: string
  overrideAttempts?: number
  caller?: Provenance
}

type Summary = {
  total: number
  allow: number
  warn: number
  deny: number
  unverifiable: number
  blockedNotionalUsd: number
}

type Badge = { surface: string; level: string; label: string; note: string }

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

const VERDICT_STYLE: Record<Verdict, { fg: string; bg: string }> = {
  ALLOW: { fg: 'var(--ok)', bg: 'var(--ok)14' },
  WARN: { fg: 'var(--warn)', bg: 'var(--warn)14' },
  DENY: { fg: 'var(--danger)', bg: 'var(--danger)14' },
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  executed: 'carried out',
  blocked: 'stopped by policy',
  awaiting_human: 'waiting on you',
  abandoned: 'never confirmed',
}

/**
 * What the caller could have done about a DENY. Ordered, so the token carries the ordering
 * rather than decorating it: a real veto reads as ok, a wrapper as a caveat, and nothing
 * standing in between as neutral rather than as a failure.
 */
const ENFORCEMENT_TOKEN: Record<Enforcement, string> = {
  process: 'bg-ok/15 text-ok',
  wrapper: 'bg-warn/15 text-warn',
  none: 'bg-foreground/10 text-foreground/45',
}

const ENFORCEMENT_TITLE: Record<Enforcement, string> = {
  process: 'The caller starts the venue process and gates its writes, so a DENY is a real veto.',
  wrapper: 'The caller can only decline to make the call it was handed. An agent with another route to the same account is not contained.',
  none: 'Nothing we can name stood between the agent and the venue: the verdict is advice plus a record.',
}

/** A one-line, human description of the action, built from the recorded intent. */
function describe(i: AuditEntry['intent']): string {
  const amount = i.notionalUsd > 0 ? usd(i.notionalUsd) : null
  switch (i.kind) {
    case 'order':
      return [i.side, i.symbol, amount && `for ${amount}`, i.assetClass === 'option' && '(option)']
        .filter(Boolean)
        .join(' ')
    case 'purchase':
      // The merchant is the whole point of a card receipt, so it leads.
      return [amount ?? 'a purchase', i.merchant && `at ${i.merchant}`].filter(Boolean).join(' ')
    case 'cancel':
      return `cancel ${i.symbol ?? 'an order'}`
    case 'recurring':
      // Covers both a DCA buy and a card subscription, so it reads from whichever it has.
      return `recurring ${[i.side, i.symbol, i.merchant && `at ${i.merchant}`].filter(Boolean).join(' ') || 'charge'}${amount ? ` for ${amount}` : ''}${i.cadence ? `, ${i.cadence}` : ''}`
    case 'settings':
      return `change setting "${i.settingKey ?? 'unknown'}"`
    case 'transfer':
      return `transfer${amount ? ` ${amount}` : ''} out`
    case 'document':
      return `download documents${i.label ? ` (${i.label})` : ''}`
    default:
      return i.kind
  }
}

export default function AuditTrail({ agentId }: { agentId: string }) {
  const [audits, setAudits] = useState<AuditEntry[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [badge, setBadge] = useState<Badge | null>(null)
  const [badgePublic, setBadgePublic] = useState(false)
  const [badgeUrl, setBadgeUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (id: string, isActive: () => boolean = () => true) => {
    try {
      const [logRes, regRes] = await Promise.all([
        apiFetch(`/api/agents/audit-log?agentId=${encodeURIComponent(id)}&limit=100`),
        apiFetch(`/api/agents/register?agentId=${encodeURIComponent(id)}`),
      ])
      if (!logRes.ok) {
        const j = await readJson<{ error?: string }>(logRes)
        if (isActive()) setError(explainError(logRes.status, j.error))
        return
      }
      const log = (await logRes.json()) as { audits: AuditEntry[]; summary: Summary }
      if (isActive()) {
        setAudits(log.audits ?? [])
        setSummary(log.summary ?? null)
        setError(null)
      }
      // The registration view carries the badge set and, when published, the badge url.
      if (regRes.ok) {
        const reg = (await regRes.json()) as { badges?: Badge[]; badgeUrl?: string | null }
        const trade = reg.badges?.find((b) => b.surface === 'trade') ?? null
        if (isActive()) {
          setBadge(trade)
          setBadgeUrl(reg.badgeUrl ?? null)
          setBadgePublic(Boolean(reg.badgeUrl))
        }
      }
    } catch {
      if (isActive()) setError('Could not load the decision trail.')
    } finally {
      if (isActive()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    if (agentId) void load(agentId, () => active)
    return () => {
      active = false
    }
  }, [agentId, load])

  const togglePublish = async () => {
    setBusy(true)
    try {
      const res = await apiFetch('/api/agents/badge-visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId, public: !badgePublic }),
      })
      if (!res.ok) {
        const j = await readJson<{ error?: string }>(res)
        setError(explainError(res.status, j.error))
        return
      }
      const j = (await res.json()) as { badgePublic: boolean; badgeUrl: string | null }
      setBadgePublic(j.badgePublic)
      setBadgeUrl(j.badgeUrl)
      setError(null)
    } catch {
      setError('Could not change the badge visibility.')
    } finally {
      setBusy(false)
    }
  }

  const absoluteBadgeUrl = badgeUrl ? `${window.location.origin}${badgeUrl}` : null
  // Links to the site rather than /explorer?q=<internal id>: an internal platform id does
  // not always resolve there, and a shared badge that lands on "not found" is worse than a
  // badge that lands on the homepage.
  const markdown = absoluteBadgeUrl
    ? `[![Guardrails](${absoluteBadgeUrl}&format=svg)](${window.location.origin})`
    : ''

  const copy = async () => {
    if (!markdown) return
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy. Select the text and copy it manually.')
    }
  }

  if (loading) {
    return (
      <div className="mt-4 space-y-4">
        <section className="rounded-2xl border border-border bg-card p-6">
          <Skeleton className="mb-4 h-4 w-32" />
          <div className="grid gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        </section>
        <section className="rounded-2xl border border-border bg-card p-6">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="mb-3 h-12 w-full" />
          ))}
        </section>
      </div>
    )
  }

  return (
    <div className="mt-4">
      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/[0.06] p-3 text-xs text-foreground/70">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
          <span>{error}</span>
        </div>
      )}

      {/* Summary. blockedNotionalUsd is measured, not projected: it is the USD the policy
          actually refused over the rows shown below. */}
      <section className="rounded-2xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold text-foreground">Decisions</h3>
          <button
            type="button"
            onClick={() => void load(agentId)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-foreground/60 hover:text-foreground"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        {summary && summary.total > 0 ? (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              {(
                [
                  ['Allowed', summary.allow, 'var(--ok)'],
                  ['Needed you', summary.warn, 'var(--warn)'],
                  ['Stopped', summary.deny, 'var(--danger)'],
                  ['Value stopped', summary.blockedNotionalUsd, 'var(--foreground)'],
                ] as const
              ).map(([k, v, color], i) => (
                <div key={k} className="rounded-xl border border-foreground/[0.07] bg-background/40 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">{k}</div>
                  <div className="mt-1 font-mono text-lg tabular-nums" style={{ color: color as string }}>
                    {i === 3 ? usd(v as number) : v}
                  </div>
                </div>
              ))}
            </div>
            {summary.unverifiable > 0 && (
              <p className="mt-3 flex items-start gap-2 text-[11px] text-foreground/50">
                <ShieldAlert size={13} className="mt-0.5 shrink-0 text-warn" />
                <span>
                  {summary.unverifiable} decision{summary.unverifiable === 1 ? '' : 's'} could not be fully checked for
                  missing account data and failed closed. That is a refusal for lack of evidence, not a rule breach.
                </span>
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-foreground/55">
            No decisions recorded yet. This fills in as your agent asks for verdicts, and each row keeps the reasons.
          </p>
        )}
      </section>

      {/* The trail */}
      {audits.length > 0 && (
        <section className="mt-4 overflow-hidden rounded-2xl border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-foreground/[0.07] text-[11px] uppercase tracking-wide text-foreground/45">
                  <th className="px-5 py-3 font-semibold">When</th>
                  <th className="px-5 py-3 font-semibold">Action</th>
                  <th className="px-5 py-3 font-semibold">Venue</th>
                  <th className="px-5 py-3 font-semibold">Verdict</th>
                  <th className="px-5 py-3 font-semibold">Why</th>
                  <th className="px-5 py-3 font-semibold">Then</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((a) => {
                  const s = VERDICT_STYLE[a.verdict]
                  return (
                    <tr key={a.id} className="border-b border-foreground/[0.05] align-top last:border-0">
                      <td className="whitespace-nowrap px-5 py-3 font-mono text-[11px] tabular-nums text-foreground/50">
                        {new Date(a.ts).toLocaleString()}
                      </td>
                      <td className="px-5 py-3">
                        <div className="font-medium text-foreground">{describe(a.intent)}</div>
                        <div className="mt-0.5 text-[11px] text-foreground/40">
                          {[a.intent.kind, a.intent.cardId, a.surface].filter(Boolean).join(' · ')} · policy v
                          {a.policyVersion}
                        </div>
                      </td>
                      {/* Provenance. A row with none predates the caller seam, and it says
                          so: "not recorded" is a fact, "direct" would be a fabrication. */}
                      <td className="px-5 py-3">
                        {a.caller ? (
                          <>
                            <div className="text-[12px] text-foreground/70">{a.caller.venue ?? 'no venue named'}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              <span
                                className={`rounded-sm px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${ENFORCEMENT_TOKEN[a.caller.enforcement]}`}
                                title={ENFORCEMENT_TITLE[a.caller.enforcement]}
                              >
                                {a.caller.enforcement}
                              </span>
                              {a.caller.callerId && (
                                <span className="font-mono text-[10px] text-foreground/40">{a.caller.callerId}</span>
                              )}
                            </div>
                            {a.caller.snapshotSource === 'absent' && (
                              <div className="mt-1 text-[10px] text-foreground/40">no account state supplied</div>
                            )}
                          </>
                        ) : (
                          <span className="text-[12px] text-foreground/35" title="This decision predates provenance recording. It was not backfilled, because inventing one would be worse than admitting the gap.">
                            not recorded
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3">
                        <span
                          className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold"
                          style={{ color: s.fg, background: s.bg }}
                        >
                          {a.verdict}
                        </span>
                        {a.unverifiable && (
                          <div className="mt-1 text-[10px] font-semibold text-warn">unverifiable</div>
                        )}
                        {(a.overrideAttempts ?? 0) > 0 && (
                          <div className="mt-1 text-[10px] font-semibold text-danger">
                            {a.overrideAttempts} override attempt{a.overrideAttempts === 1 ? '' : 's'} refused
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3 text-[12px] text-foreground/65">
                        {a.reasons.length ? (
                          <ul className="space-y-0.5">
                            {a.reasons.map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-foreground/35">within every limit</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-[12px] text-foreground/55">
                        {OUTCOME_LABEL[a.outcome]}
                        {a.evidenceRef && (
                          <div className="mt-0.5 font-mono text-[10px] text-foreground/40">ref {a.evidenceRef}</div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-foreground/[0.07] px-5 py-3 text-[11px] text-foreground/40">
            The account snapshot behind each verdict is stored as a hash, never as your holdings, so a decision can be
            reconciled without keeping a record of your positions. Venue and enforcement are recorded from the caller
            that asked; rows written before that existed read &quot;not recorded&quot; rather than being filled in after
            the fact.
          </div>
        </section>
      )}

      {/* Share card */}
      <section className="mt-4 rounded-2xl border border-accent/20 bg-accent/[0.04] p-6">
        <div className="mb-1 flex items-center gap-2">
          <Share2 size={16} className="text-accent" />
          <h3 className="font-semibold text-foreground">My agent&apos;s guardrails</h3>
        </div>
        <p className="mb-4 text-xs text-foreground/55">
          A badge you can publish showing that this agent runs under an enforced policy. Coarse on purpose: it carries
          no numbers, and it never discloses your caps, symbols, amounts or holdings.
        </p>

        {badge && (
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <span className="inline-flex overflow-hidden rounded-md text-[11px] font-semibold">
              <span className="bg-foreground/80 px-2 py-1 text-background">trade guardrails</span>
              <span
                className="px-2 py-1 text-white"
                style={{
                  background:
                    badge.level === 'enforced'
                      ? 'var(--ok)'
                      : badge.level === 'enforced_with_flags'
                        ? 'var(--warn)'
                        : badge.level === 'configured'
                          ? '#b8860b'
                          : '#8a8f98',
                }}
              >
                {badge.label}
              </span>
            </span>
            <span className="text-[11px] text-foreground/50">{badge.note}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={togglePublish}
            disabled={busy}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-transform hover:scale-[1.02] disabled:opacity-50 ${
              badgePublic ? 'border border-foreground/15 text-foreground/70' : 'bg-accent text-white'
            }`}
          >
            {badgePublic ? 'Unpublish' : 'Publish badge'}
          </button>
          {badgePublic && markdown && (
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-2 rounded-full border border-foreground/15 px-4 py-2 text-sm font-semibold text-foreground/70 hover:text-foreground"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy markdown'}
            </button>
          )}
        </div>

        {badgePublic ? (
          <p className="mt-3 break-all font-mono text-[10px] text-foreground/40">{markdown}</p>
        ) : (
          <p className="mt-3 flex items-start gap-2 text-[11px] text-foreground/45">
            <ShieldCheck size={13} className="mt-0.5 shrink-0" />
            <span>Off by default. Nothing about this agent&apos;s guardrails is public until you publish it.</span>
          </p>
        )}
      </section>
    </div>
  )
}
