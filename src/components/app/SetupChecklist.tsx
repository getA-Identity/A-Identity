import { Link } from 'react-router-dom'
import { ArrowUpRight, Check } from 'lucide-react'

/**
 * The zero state, as four steps instead of one sentence.
 *
 * A brand-new console used to say "No agent registered yet" and leave the reader to work
 * out what the rest of the journey looks like. This shows the whole path with real
 * completion state read from the account, so the first session has a visible finish line.
 *
 * It stays on screen until every step is done, not only while the account is empty: the
 * gap between "registered an agent" and "made a payment" is exactly where people stall.
 * Once the last step lands, it disappears for good.
 */
export type Step = {
  label: string
  detail: string
  done: boolean
  to: string
  /** Shown instead of the link when an earlier step has to happen first. */
  blockedBy?: string
}

export default function SetupChecklist({ steps }: { steps: Step[] }) {
  const doneCount = steps.filter((s) => s.done).length
  const next = steps.find((s) => !s.done && !s.blockedBy)

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Get your agent running</h3>
        <span className="font-mono text-xs text-foreground/45 tabular-nums">
          {doneCount} / {steps.length} done
        </span>
      </div>

      {/* Progress is a real fraction of real steps, not a decorative bar. */}
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-foreground/10">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${(doneCount / steps.length) * 100}%` }}
        />
      </div>

      <ol className="mt-4 flex flex-col gap-1">
        {steps.map((s, i) => {
          const isNext = next?.label === s.label
          return (
            <li
              key={s.label}
              className={`flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors ${
                isNext ? 'bg-accent/[0.06]' : ''
              }`}
            >
              <div
                className={`mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                  s.done
                    ? 'bg-accent text-white'
                    : isNext
                      ? 'border border-accent text-accent'
                      : 'border border-foreground/20 text-foreground/35'
                }`}
              >
                {s.done ? <Check size={12} /> : i + 1}
              </div>

              <div className="min-w-0 flex-1">
                <div
                  className={`text-sm font-medium ${
                    s.done ? 'text-foreground/45 line-through decoration-foreground/25' : 'text-foreground'
                  }`}
                >
                  {s.label}
                </div>
                {!s.done && <div className="mt-0.5 text-xs text-foreground/50">{s.detail}</div>}
              </div>

              {!s.done &&
                (s.blockedBy ? (
                  <span className="shrink-0 self-center text-[11px] text-foreground/35">{s.blockedBy}</span>
                ) : (
                  <Link
                    to={s.to}
                    className="inline-flex shrink-0 items-center gap-1 self-center text-xs font-semibold text-accent hover:underline"
                  >
                    Go <ArrowUpRight size={12} />
                  </Link>
                ))}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
