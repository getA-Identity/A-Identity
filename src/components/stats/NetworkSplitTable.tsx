import { useId } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { SPLIT_RAILS, type NetworkSplit, type SplitCell, type SplitSide } from '../../lib/settlement-networks'
import { int, usdFixed } from './format'

/**
 * The Circle Gateway and EIP-3009 facilitator logs split by network, as one compact table.
 *
 * The tiles above print each log's own count and payer split, which is all a reader could
 * quote before: a deliverable wrote "9 internal / 7 external payments across supported
 * networks" and had to hedge on where each external payment settled. Each row here is one
 * network from the registry, Arc Mainnet first, and each rail keeps its own two columns, so
 * the page answers that question itself without adding one log's payments to the other's.
 *
 * Rendered only when the backend sent a split (see readNetworkSplit). A log the backend
 * could not read prints "not read" in its columns, never a zero it did not count.
 */

const SPLIT_JSON = 'https://a-identity.xyz/api/proof/rails'

function Tag({ children, tone }: { children: string; tone?: 'warn' }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
        tone === 'warn' ? 'bg-warn/10 text-warn' : 'bg-foreground/[0.06] text-foreground/55'
      }`}
    >
      {children}
    </span>
  )
}

function SideCell({ side, readable, divider }: { side: SplitSide | undefined; readable: boolean; divider: boolean }) {
  const base = `px-3 py-2.5 text-right align-top tabular-nums${divider ? ' border-l border-border' : ''}`
  if (!readable) {
    return (
      <td className={base}>
        <span className="text-[11px] text-foreground/40">not read</span>
      </td>
    )
  }
  if (!side || side.count === null) {
    return (
      <td className={base}>
        <span className="text-foreground/30">-</span>
      </td>
    )
  }
  if (side.count === 0) return <td className={`${base} font-mono text-foreground/35`}>0</td>
  return (
    <td className={base}>
      <span className="block font-mono font-semibold text-foreground">{int(side.count)}</span>
      {side.usd !== null && <span className="block font-mono text-[11px] text-foreground/50">{usdFixed(side.usd, 4)}</span>}
    </td>
  )
}

function RailCells({ cell, readable }: { cell: SplitCell | null; readable: boolean }) {
  return (
    <>
      <SideCell side={cell?.internal} readable={readable} divider />
      <SideCell side={cell?.external} readable={readable} divider={false} />
    </>
  )
}

export function NetworkSplitTable({ split }: { split: NetworkSplit }) {
  const headingId = useId()
  const unread = SPLIT_RAILS.filter((rail) => !split.logs[rail].readable)
  const readAt = split.asOf && Number.isFinite(Date.parse(split.asOf)) ? new Date(split.asOf) : null
  return (
    <div className="mt-8">
      <h3 id={headingId} className="text-base font-bold tracking-tight text-foreground">
        Circle Gateway and our facilitator, by network
      </h3>
      <p className="mt-2 max-w-[75ch] text-sm leading-relaxed text-foreground/55">
        The Circle Gateway and EIP-3009 facilitator logs above, split by the network each payment settled on.
        Internal is a payment from one of our own buyer wallets and external one from a wallet we do not control:
        a payer is internal when it is on either rail&apos;s published list of our own wallets, the rule
        /api/arc/season counts by. Each rail keeps its own columns and is never added to the other.
      </p>

      {split.rows.length === 0 ? (
        <p className="mt-4 rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground/55">
          Neither log holds a settled payment yet, so there is no network to list.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card">
          <table aria-labelledby={headingId} className="w-full min-w-[36rem] text-left text-[13px]">
            <thead className="bg-foreground/[0.03] text-[11px] uppercase tracking-wide text-foreground/50">
              <tr>
                <th scope="col" rowSpan={2} className="px-3 py-2 align-bottom font-semibold">
                  Network
                </th>
                {SPLIT_RAILS.map((rail) => (
                  <th
                    key={rail}
                    scope="colgroup"
                    colSpan={2}
                    className="border-l border-border px-3 pb-1 pt-2 text-center font-semibold"
                  >
                    {split.logs[rail].label}
                  </th>
                ))}
              </tr>
              <tr>
                {SPLIT_RAILS.map((rail) => (
                  <RailHeads key={rail} />
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {split.rows.map((row) => (
                <tr key={row.caip2 || 'not-recorded'}>
                  <th scope="row" className="px-3 py-2.5 align-top font-normal">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-foreground">{row.name}</span>
                      {row.testnet && <Tag tone="warn">testnet</Tag>}
                      {row.chain === null && <Tag>not in the registry</Tag>}
                    </span>
                    {row.caip2 && row.caip2 !== row.name && (
                      <span className="mt-0.5 block font-mono text-[11px] text-foreground/45">{row.caip2}</span>
                    )}
                  </th>
                  {SPLIT_RAILS.map((rail) => (
                    <RailCells key={rail} cell={row.byRail[rail]} readable={split.logs[rail].readable} />
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border bg-foreground/[0.03]">
              <tr>
                <th scope="row" className="px-3 py-2.5 align-top font-semibold text-foreground">
                  All networks
                </th>
                {SPLIT_RAILS.map((rail) => (
                  <RailCells key={rail} cell={split.totals[rail]} readable={split.logs[rail].readable} />
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {unread.map((rail) => (
        <p key={rail} className="mt-2 text-xs leading-relaxed text-warn">
          The {split.logs[rail].label} log did not answer on this read, so its columns say not read rather than zero.
        </p>
      ))}
      <p className="mt-2 max-w-[75ch] text-xs leading-relaxed text-foreground/45">
        {readAt ? `Counted from both logs at ${readAt.toLocaleTimeString('en-US')}, ` : 'Counted from both logs, '}
        each over the rows its log retains. The same split as JSON:{' '}
        <a
          href={SPLIT_JSON}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-semibold text-accent underline-offset-4 hover:underline"
        >
          /api/proof/rails <ArrowUpRight size={12} />
        </a>
      </p>
    </div>
  )
}

function RailHeads() {
  return (
    <>
      <th scope="col" className="border-l border-border px-3 pb-2 pt-1 text-right font-semibold">
        Internal
      </th>
      <th scope="col" className="px-3 pb-2 pt-1 text-right font-semibold">
        External
      </th>
    </>
  )
}
