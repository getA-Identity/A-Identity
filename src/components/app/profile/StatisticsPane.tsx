/**
 * Statistics tab pane of the agent profile: the three reputation breakdown
 * bars (settlement/validation/tenure with their 600/240/160 caps) and the
 * four summary figures. Extracted verbatim from AgentProfile.tsx; must keep
 * the exact section root element (rendered inside the cn-pane div).
 */
import type { MarketAgent } from './types'

type Props = {
  rep: MarketAgent['reputation']
  fbAvg: number | null
  agent: MarketAgent
}

export default function StatisticsPane({ rep, fbAvg, agent }: Props) {
  return (
    <section className="mt-4 rounded-2xl border border-border bg-card p-5">
      <h3 className="text-sm font-bold text-foreground/80">Statistics</h3>
      {rep ? (
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          {(
            [
              ['Settlement', rep.breakdown.settlement, 600, 'var(--accent)'],
              ['Validation', rep.breakdown.validation, 240, 'var(--usdc)'],
              ['Tenure', rep.breakdown.tenure, 160, 'var(--ok)'],
            ] as const
          ).map(([label, v, max, color]) => (
            <div key={label}>
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold text-foreground/65">{label}</span>
                <span className="text-sm font-bold tabular-nums" style={{ color }}>
                  {v}
                  <span className="ml-0.5 text-[10px] font-medium text-foreground/40">/ {max}</span>
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${Math.min(100, (v / max) * 100)}%`, background: color }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-foreground/60">No reputation recorded yet.</p>
      )}
      <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4 sm:grid-cols-4">
        {(
          [
            ['Reputation', rep ? `${rep.score} / 1000` : '-'],
            ['User rating', fbAvg != null ? `${fbAvg.toFixed(1)} / 10` : 'none yet'],
            ['Followers', String(agent.followers)],
            ['Recorded events', String(agent.activity.length)],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11px] font-bold text-foreground/50">{k}</dt>
            <dd className="mt-0.5 text-lg font-bold tabular-nums text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
