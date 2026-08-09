/**
 * Overview tab pane of the agent profile: About, Recent Activity, and the
 * Basic Information registry facts. Extracted verbatim from AgentProfile.tsx;
 * must keep the exact grid root element (rendered inside the cn-pane div) and
 * keep humanizeActivity/short coming from lib/format, same as before.
 */
import { Activity, ExternalLink } from 'lucide-react'
import { humanizeActivity, short } from '../../../lib/format'
import type { Chain } from '../../../lib/chains'
import type { MarketAgent } from './types'

type Props = {
  agent: MarketAgent
  chainInfo: Chain | undefined
}

export default function OverviewPane({ agent, chainInfo }: Props) {
  return (
    <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
      <div className="flex flex-col gap-4 lg:col-span-2">
        <section className="rounded-2xl border border-border bg-card p-5">
          <h3 className="text-sm font-bold text-foreground/80">About</h3>
          <p className="mt-2 text-sm leading-relaxed text-foreground/70">
            {agent.description || 'No description yet.'}
          </p>
          {agent.capabilities.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {agent.capabilities.map((c) => (
                <span key={c} className="rounded-full bg-foreground/5 px-2.5 py-1 text-[11px] font-medium text-foreground/65">
                  {c}
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-card p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-foreground/80">
            <Activity size={14} className="text-accent" /> Recent Activity
          </h3>
          {agent.activity.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-2.5">
              {[...agent.activity].reverse().slice(0, 5).map((ev, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-foreground/70">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="min-w-0 break-words">
                    {humanizeActivity(ev.text)}
                    <span className="ml-1.5 text-xs font-medium text-accent/80">
                      {new Date(ev.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-foreground/60">No recorded activity yet.</p>
          )}
        </section>
      </div>

      {/* Basic Information: the registry facts, label/value, links out. */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <h3 className="text-sm font-bold text-foreground/80">Basic Information</h3>
        <dl className="mt-3 flex flex-col divide-y divide-border text-sm">
          {(
            [
              ['Agent ID', agent.id, null],
              ['ERC-8004', agent.onchainAgentId ? `#${agent.onchainAgentId}` : 'queued', agent.onchainExplorer ?? null],
              ['Chain', chainInfo ? chainInfo.name : 'Circle Arc (testnet)', null],
              ['Category', agent.category, null],
              ['Wallet', agent.walletAddress ? short(agent.walletAddress) : 'none', agent.walletAddress ? `https://testnet.arcscan.app/address/${agent.walletAddress}` : null],
              ['Registered', new Date(agent.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }), null],
              ['Registration tx', agent.onchainTx ? short(agent.onchainTx) : 'pending', agent.onchainExplorer ?? null],
            ] as const
          ).map(([label, value, href]) => (
            <div key={label} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <dt className="shrink-0 text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/50">{label}</dt>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-xs font-semibold text-accent hover:underline">
                  <span className="truncate">{value}</span> <ExternalLink size={10} className="shrink-0" />
                </a>
              ) : (
                <dd className="min-w-0 truncate text-right font-mono text-xs font-semibold text-foreground/80">{value}</dd>
              )}
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}
