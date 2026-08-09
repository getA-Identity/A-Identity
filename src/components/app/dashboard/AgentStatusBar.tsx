import { Link } from 'react-router-dom'
import { ArrowUpRight, Check, Clock, Snowflake, Wrench } from 'lucide-react'
import Freshness from '../Freshness'
import { Skeleton } from '../../ui/skeleton'

/**
 * What the agent is doing right now, in one line.
 *
 * The console showed four numbers and three static Ready/Pending badges, none of which
 * answered the question an operator actually opens the page with. This is that answer,
 * and every part of it is derived from state we already hold: nothing here is a guess
 * about what the agent is "thinking".
 *
 * The narrative sentence is assembled only from clauses we can prove. A figure we have
 * not read is left out rather than shown as zero, because "0 settled" and "we do not know
 * yet" are different claims.
 */
export type AgentState = 'setup' | 'frozen' | 'waiting' | 'ready'

const LOOK: Record<
  AgentState,
  { label: string; icon: typeof Check; dot: string; text: string; bg: string; border: string }
> = {
  setup: {
    label: 'Finish setup',
    icon: Wrench,
    dot: 'bg-foreground/35',
    text: 'text-foreground/70',
    bg: 'bg-foreground/[0.03]',
    border: 'border-border',
  },
  frozen: {
    label: 'Paused by you',
    icon: Snowflake,
    dot: 'bg-red-500',
    text: 'text-red-700 dark:text-red-300',
    bg: 'bg-red-500/[0.06]',
    border: 'border-red-500/25',
  },
  waiting: {
    label: 'Waiting for you',
    icon: Clock,
    dot: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-300',
    bg: 'bg-amber-500/[0.07]',
    border: 'border-amber-500/25',
  },
  ready: {
    label: 'Ready to act',
    icon: Check,
    dot: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-300',
    bg: 'bg-emerald-500/[0.06]',
    border: 'border-emerald-500/25',
  },
}

export default function AgentStatusBar({
  state,
  agentName,
  clauses,
  lastActedAt,
  readAt,
  action,
  loading,
}: {
  state: AgentState
  agentName: string
  /** Proven statements about right now. Empty is fine and renders nothing. */
  clauses: string[]
  /** ISO time of the agent's most recent recorded activity, if it has any. */
  lastActedAt?: string | null
  /** When we last read this from the backend. */
  readAt: number | null
  action?: { label: string; to: string }
  loading?: boolean
}) {
  const look = LOOK[state]
  const Icon = look.icon

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
        </div>
      </div>
    )
  }

  return (
    // Solid card base under the state tint: the bar often sits on the ambient dot
    // field, and a bare translucent tint let the dots bleed through the copy.
    <div className={`rounded-xl border ${look.border} bg-card`}>
      <div className={`rounded-[inherit] ${look.bg} p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-card ${look.text}`}>
            <Icon size={15} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${look.dot}`} />
              <span className={`text-sm font-semibold ${look.text}`}>{look.label}</span>
              <span className="truncate text-sm text-foreground/45">{agentName}</span>
            </div>
            {clauses.length > 0 && (
              <p className="mt-1 text-sm text-foreground/80">{clauses.join(' · ')}</p>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-medium text-foreground/55">
              {lastActedAt && <Freshness at={new Date(lastActedAt).getTime()} prefix="last acted" />}
              {lastActedAt && readAt != null && <span aria-hidden="true">·</span>}
              <Freshness at={readAt} />
            </div>
          </div>
        </div>

        {action && (
          <Link
            to={action.to}
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border ${look.border} bg-card px-3 py-1.5 text-xs font-semibold ${look.text} transition-colors hover:bg-foreground/[0.04]`}
          >
            {action.label} <ArrowUpRight size={13} />
          </Link>
        )}
      </div>
      </div>
    </div>
  )
}
