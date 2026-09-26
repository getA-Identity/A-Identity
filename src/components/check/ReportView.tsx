import { motion } from 'framer-motion'
import { ArrowUpRight, CheckCircle2, FileText } from 'lucide-react'
import { formatUsd, formatUsdc, txUrl } from '../../lib/algorand/x402pay'
import { ago } from '../../lib/format'
import { cn } from '../../lib/utils'
import type { Bought } from './bought'
import { EASE, day, n, plural } from './format'
import { AccountLink, TxLink } from './Receipt'

/** The detailed report: who created the address, its biggest payers, its last payments, the receipt. */
export default function ReportView({ bought, className }: { bought: Bought; className?: string }) {
  const { report, tx, amountUsd } = bought
  const d = report.details
  const created = d.createdAt ? day(d.createdAt) : null
  const sampled = report.facts?.payers?.sampled
  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      style={{ fontFeatureSettings: '"calt" 0' }}
      className={cn('mt-6 overflow-hidden rounded-3xl border border-border bg-card print:break-inside-avoid', className)}
    >
      <div className="px-5 pb-4 pt-5 sm:px-8">
        <h3 className="flex items-center gap-2 text-lg font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
          <FileText size={18} className="shrink-0 text-accent" />
          Detailed report
        </h3>
        {report.address && <p className="mt-1 break-all font-mono text-xs text-foreground/50">{report.address}</p>}
        {d.createdBy && (
          <p className="mt-3 text-[15px] text-foreground/80">
            Created by <AccountLink address={d.createdBy} />
            {created ? ` on ${created}` : ''}
          </p>
        )}
      </div>

      <div className="border-t border-border px-5 py-5 sm:px-8">
        <h4 className="text-sm font-semibold text-foreground">Biggest payers</h4>
        {d.topPayers.length === 0 ? (
          <p className="mt-2 text-sm text-foreground/60">No USDC payments found.</p>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto rounded-xl border border-border print:overflow-visible">
              <table className="w-full text-left text-[13px]">
                <thead className="bg-foreground/[0.03] text-[11px] uppercase tracking-wide text-foreground/50">
                  <tr>
                    <th scope="col" className="px-2.5 py-2 font-semibold sm:px-3">Payer</th>
                    <th scope="col" className="px-2.5 py-2 text-right font-semibold sm:px-3">Payments</th>
                    <th scope="col" className="px-2.5 py-2 text-right font-semibold sm:px-3">USDC</th>
                    <th scope="col" className="px-2.5 py-2 text-right font-semibold sm:px-3">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {d.topPayers.map((p) => (
                    <tr key={p.address} className="align-top">
                      <td className="px-2.5 py-2.5 sm:px-3">
                        <AccountLink address={p.address} />
                        {p.linked && (
                          <span className="mt-1 block w-fit rounded-md bg-warn/10 px-2 py-0.5 text-[11px] font-semibold leading-snug text-warn">
                            linked to this address
                          </span>
                        )}
                      </td>
                      <td className="px-2.5 py-2.5 text-right tabular-nums text-foreground/75 sm:px-3">{n(p.payments)}</td>
                      <td className="px-2.5 py-2.5 text-right tabular-nums text-foreground/75 sm:px-3">{formatUsdc(p.usdc)}</td>
                      <td className="px-2.5 py-2.5 text-right tabular-nums text-foreground/75 sm:px-3">
                        {p.share > 0 && p.share < 0.005 ? '<1%' : `${Math.round(p.share * 100)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-foreground/50">
              Share of the {formatUsdc(d.totalUsdcSampled)} USDC in {typeof sampled === 'number' ? `its last ${plural(sampled, 'payment', 'payments')}` : 'the payments read'}.
            </p>
          </>
        )}
      </div>

      <div className="border-t border-border px-5 py-5 sm:px-8">
        <h4 className="text-sm font-semibold text-foreground">Last payments</h4>
        {d.recentPayments.length === 0 ? (
          <p className="mt-2 text-sm text-foreground/60">No USDC payments found.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {d.recentPayments.map((p, i) => (
              <li key={p.txId ?? i} className="flex items-center gap-3 py-2.5 text-[13px]">
                <span className="w-[4.5rem] shrink-0 text-foreground/55">{(p.at && day(p.at)) || ''}</span>
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                  <AccountLink address={p.payer} />
                  {p.linked && <span className="rounded-full bg-warn/10 px-2 py-0.5 text-[11px] font-semibold text-warn">linked</span>}
                </span>
                <span className="shrink-0 tabular-nums text-foreground/80">{formatUsdc(p.usdc)} USDC</span>
                {p.txId ? (
                  <a
                    href={txUrl(p.txId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="View this payment on the explorer"
                    className="shrink-0 text-accent hover:opacity-80"
                  >
                    <ArrowUpRight size={15} />
                  </a>
                ) : (
                  <span className="w-[15px] shrink-0" />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border bg-foreground/[0.02] px-5 py-4 text-sm text-foreground/75 sm:px-8">
        <p className="flex flex-wrap items-center gap-x-1.5">
          <CheckCircle2 size={15} className="shrink-0 text-ok" aria-hidden="true" />
          Paid {formatUsd(amountUsd)}. Receipt: <TxLink tx={tx} />
        </p>
        {typeof report.checkedAt === 'string' && (
          <p className="mt-1 text-xs text-foreground/50">Read live from the Algorand ledger, {ago(report.checkedAt)}.</p>
        )}
      </div>
    </motion.section>
  )
}
