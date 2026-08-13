/**
 * The registered callers, and how strong each one's enforcement actually is.
 *
 * This panel exists because a verdict is only worth what the thing that received it could
 * have done about it. A DENY handed to a wrapper around a hosted API is a refusal to make
 * one call; a DENY handed to something that owns the venue process is a veto. Publishing
 * that difference next to the audit trail is what stops the trail from reading as a
 * stronger guarantee than it is.
 *
 * Static registry data, so it is a plain public GET with no agent scope.
 */
import { useEffect, useState } from 'react'
import { Plug } from 'lucide-react'
import { apiFetch } from '../../../lib/api'
import { Skeleton } from '../../ui/skeleton'

type Enforcement = 'process' | 'wrapper' | 'none'

type Caller = {
  id: string
  name: string
  venue: string
  surface: string
  status: 'live' | 'beta' | 'planned'
  enforcement: Enforcement
  /** True when we can translate this caller's own payload shape today. */
  normalizes: boolean
  note: string
}

type CallersResponse = {
  callers: Caller[]
  direct: string
  enforcement: Record<Enforcement, string>
}

/** Enforcement is ordered, so the chip colour carries the ordering rather than decorating it. */
const ENFORCEMENT_TOKEN: Record<Enforcement, string> = {
  process: 'bg-ok/15 text-ok',
  wrapper: 'bg-warn/15 text-warn',
  none: 'bg-foreground/10 text-foreground/50',
}

const STATUS_TOKEN: Record<Caller['status'], string> = {
  live: 'bg-ok/15 text-ok',
  beta: 'bg-warn/15 text-warn',
  planned: 'bg-foreground/10 text-foreground/50',
}

export default function VenuePanel() {
  const [data, setData] = useState<CallersResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const res = await apiFetch('/api/callers')
        const j = (await res.json()) as CallersResponse
        if (active) setData(j)
      } catch {
        if (active) setError('Could not read the caller registry.')
      }
    })()
    return () => { active = false }
  }, [])

  if (error) {
    return (
      <section className="mt-4 rounded-2xl border border-warn/25 bg-warn/[0.06] p-6 text-sm text-foreground/70">
        {error}
      </section>
    )
  }

  if (!data) {
    return (
      <section className="mt-4 rounded-2xl border border-border bg-card p-6">
        <Skeleton className="mb-4 h-4 w-40" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="mb-3 h-12 w-full" />
        ))}
      </section>
    )
  }

  return (
    <section className="mt-4 rounded-2xl border border-border bg-card p-6">
      <div className="mb-1 flex items-center gap-2">
        <Plug size={16} className="text-accent" />
        <h3 className="font-semibold text-foreground">Where a verdict lands</h3>
      </div>
      <p className="mb-4 text-xs text-foreground/55">
        A refusal is only as strong as the caller that receives it. These are the callers the policy engine knows,
        and what each one could actually do if a check came back DENY.
      </p>

      <ul className="space-y-3">
        {data.callers.map((c) => (
          <li key={c.id} className="rounded-xl border border-foreground/[0.07] bg-background/40 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{c.name}</span>
              <span className={`rounded-sm px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${STATUS_TOKEN[c.status]}`}>
                {c.status}
              </span>
              <span
                className={`rounded-sm px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${ENFORCEMENT_TOKEN[c.enforcement]}`}
                title={data.enforcement?.[c.enforcement]}
              >
                {c.enforcement}
              </span>
              {!c.normalizes && (
                <span className="rounded-sm bg-foreground/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
                  no adapter
                </span>
              )}
            </div>
            <div className="mt-1 font-mono text-[11px] text-foreground/40">
              {c.id} &middot; {c.venue} &middot; {c.surface}
            </div>
            <p className="mt-2 text-[12px] text-foreground/65">{c.note}</p>
            <p className="mt-1.5 text-[11px] text-foreground/45">{data.enforcement?.[c.enforcement]}</p>
          </li>
        ))}
      </ul>

      <p className="mt-4 border-t border-foreground/[0.07] pt-3 text-[11px] text-foreground/45">{data.direct}</p>
    </section>
  )
}
