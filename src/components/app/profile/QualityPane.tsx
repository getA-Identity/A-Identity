/**
 * Quality tab pane of the agent profile: the derived quality signals list and
 * the met-count badge. Extracted verbatim from AgentProfile.tsx; the signals
 * themselves stay computed in the parent (every flag derives from a real
 * field), this pane only renders them. Must keep the exact section root
 * element (rendered inside the cn-pane div) and the 5/3 badge thresholds.
 */
import { BadgeCheck, Clock } from 'lucide-react'
import { Badge } from '../../ui/badge'

type QualitySignal = { ok: boolean; label: string; detail: string; miss: string }

type Props = {
  quality: QualitySignal[]
  qualityMet: number
}

export default function QualityPane({ quality, qualityMet }: Props) {
  return (
    <section className="mt-4 rounded-2xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-foreground/80">Quality Signals</h3>
        <Badge variant={qualityMet >= 5 ? 'success' : qualityMet >= 3 ? 'default' : 'warning'}>
          {qualityMet} / {quality.length} signals met
        </Badge>
      </div>
      <p className="mt-1 text-xs text-foreground/55">
        Every signal derives from the live record; nothing here is scored by opinion.
      </p>
      <ul className="mt-4 flex flex-col gap-1.5">
        {quality.map((q) => (
          <li
            key={q.label}
            className={`flex items-start gap-3 rounded-xl px-3.5 py-2.5 ${q.ok ? 'bg-ok/[0.06]' : 'bg-warn/[0.08]'}`}
          >
            <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-white ${q.ok ? 'bg-ok' : 'bg-warn'}`}>
              {q.ok ? <BadgeCheck size={12} /> : <Clock size={12} />}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">{q.label}</div>
              <div className="text-xs text-foreground/60">{q.ok ? q.detail : q.miss}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
