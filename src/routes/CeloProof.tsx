import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../components/ui/section'
import { Stat } from '../components/ui/stat'
import { apiFetch } from '../lib/api'
import { ago, short } from '../lib/format'
import { usePageMeta } from '../lib/head'
import { BACKEND_UNREACHABLE } from '../lib/mcpBase'

/**
 * /celo-proof: the Celo settlement log, verbatim, for judges who verify before they trust.
 *
 * Every value on this page is GET /api/celo/proof and GET /api/celo/status verbatim: the
 * x402 settlement log the backend keeps for its Celo rail, plus the configuration that
 * rail is actually running with. Nothing is projected, padded or invented. When nothing
 * has settled yet the counters show real zeros, and when the rail is not configured the
 * page says so and shows the backend's own reason instead of pretending.
 *
 * Internal and test traffic is not filtered out, it is labeled: rows the backend flags
 * as internal render with a visible badge, because a proof page that quietly hides its
 * own traffic is not a proof page. Judges doing manual sybil review are the audience.
 *
 * While loading the tiles show skeletons. Fetches go through apiFetch, which retries a
 * sleeping free-tier backend through its cold start with wake pings, so the first
 * snapshot is usually only delayed; if nothing ever arrives the page says so instead of
 * inventing numbers. A sequence guard drops late responses from older polls, so a slow
 * retried fetch can never overwrite a newer snapshot.
 */

type CeloStatus = {
  configured: boolean
  network?: string
  payTo?: string
  facilitator?: string
  reason?: string
  registry?: string
  resolver?: string
}

type CeloSettlement = {
  ts: string | number
  tool: string
  amountUsd: number
  payer?: string
  internal?: boolean
}

type CeloProofData = {
  network?: string
  payTo?: string
  configured: boolean
  totalSettlements: number
  totalUsd: number
  byTool: Record<string, number>
  recent: CeloSettlement[]
}

const REFRESH_MS = 60_000
const CELOSCAN = 'https://celoscan.io/address/'

const nf = new Intl.NumberFormat('en-US')
const usd = (n: number, maxFrac = 6) =>
  `$${n.toLocaleString('en-US', { maximumFractionDigits: maxFrac })}`

/** Normalize a backend timestamp (ISO string, epoch seconds or epoch ms) into a Date. */
const toDate = (ts: string | number) =>
  new Date(typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : ts)

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path)
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  return (await res.json()) as T
}

/** The loading placeholder a value shows before real data exists. Never a fake number. */
const Skeleton = () => (
  <span className="inline-block h-5 w-14 animate-pulse rounded bg-foreground/10 align-middle" />
)

/** An address that opens on Celoscan, because "you can open it" is the whole page. */
function AddrLink({ addr }: { addr: string }) {
  return (
    <a
      href={`${CELOSCAN}${addr}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-mono text-accent underline-offset-2 hover:underline"
    >
      <span className="break-all">{addr}</span>
      <ArrowUpRight size={12} className="shrink-0" />
    </a>
  )
}

/** One labelled line of the status card. */
function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/60 py-2.5 last:border-0">
      <span className="text-[11px] uppercase tracking-wide text-foreground/45">{label}</span>
      <span className="font-mono text-xs text-foreground/80">{children}</span>
    </div>
  )
}

/** The label internal rows carry. Labeled, not hidden: that is the sybil-review deal. */
function InternalBadge() {
  return (
    <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
      internal
    </span>
  )
}

/** A cross-link card to a proof surface we do not get to edit after the fact. */
function ProofLink({
  href,
  to,
  title,
  caption,
}: {
  href?: string
  to?: string
  title: string
  caption: string
}) {
  const inner = (
    <>
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
        {title}
        <ArrowUpRight size={13} className="text-foreground/35 transition-colors group-hover:text-accent" />
      </span>
      <span className="text-xs leading-relaxed text-foreground/55">{caption}</span>
    </>
  )
  const cls =
    'group flex flex-col gap-1.5 rounded-2xl border border-border bg-background p-4 transition-colors hover:bg-foreground/[0.03]'
  return to ? (
    <Link to={to} className={cls}>
      {inner}
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {inner}
    </a>
  )
}

export default function CeloProof() {
  usePageMeta({
    title: 'Celo settlement proof, live and verifiable | A-Identity',
    description:
      'Live x402 settlement proof on Celo: totals, per-tool breakdown and recent settlements, with internal traffic labeled instead of hidden. Read verbatim from the public API; every number is verifiable on-chain.',
    canonical: 'https://a-identity.xyz/celo-proof',
  })

  const [status, setStatus] = useState<CeloStatus | null>(null)
  const [proof, setProof] = useState<CeloProofData | null>(null)
  // 'missing' means the backend answered but these endpoints are not deployed yet, which
  // deserves honest copy of its own rather than a generic "unreachable".
  const [failure, setFailure] = useState<null | 'unreachable' | 'missing'>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Stale-response guard, same idiom as /stats: every load() takes the next ticket and
  // only the newest ticket may touch state. apiFetch can spend over a minute retrying
  // through a cold start, longer than the 60s poll, so a slow old fetch must never
  // clobber a newer poll's result; unmount bumps the ticket so nothing applies after
  // cleanup either.
  const loadSeq = useRef(0)

  const load = useCallback(() => {
    const seq = loadSeq.current + 1
    loadSeq.current = seq
    getJson<CeloProofData>('/api/celo/proof')
      .then((data) => {
        if (seq !== loadSeq.current) return
        setProof(data)
        setFailure(null)
        setCheckedAt(Date.now())
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq.current) return
        // Keep the last good snapshot if there is one; the freshness caption stays
        // honest about how old it is. Only a page that never loaded shows the note.
        const code = (e as { status?: number }).status
        setFailure(code === 404 || code === 501 ? 'missing' : 'unreachable')
      })
    getJson<CeloStatus>('/api/celo/status')
      .then((data) => {
        if (seq !== loadSeq.current) return
        setStatus(data)
      })
      .catch(() => {
        // The proof fetch owns the failure state; status just stays unknown.
      })
  }, [])

  useEffect(() => {
    load()
    const id = window.setInterval(load, REFRESH_MS)
    return () => {
      window.clearInterval(id)
      loadSeq.current += 1
    }
  }, [load])

  // The freshness caption ("checked Ns ago") needs a clock tick, not a data change.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(id)
  }, [])

  const st = status
  const p = proof
  const byTool = p ? Object.entries(p.byTool ?? {}) : []
  const recent = p && Array.isArray(p.recent) ? p.recent : []

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main>
        <SectionShell size="lg">
          <SectionIntro
            eyebrow={<Eyebrow>Celo settlement proof</Eyebrow>}
            heading={
              <DisplayHeading size="display" className="max-w-[14ch]">
                Trust, before you pay.
              </DisplayHeading>
            }
            lede={
              <Lede>
                Every number below is a transaction you can open. This page reads the live
                x402 settlement log for our Celo rail verbatim: totals, the per-tool
                breakdown and the most recent settlements, with internal traffic labeled
                instead of hidden. Nothing is projected and nothing is padded; when there
                is nothing to show yet, it says zero.
              </Lede>
            }
          />

          {/* The honest failure states: shown only when no snapshot has ever arrived. */}
          {failure && !proof && (
            <motion.div
              {...reveal}
              className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card px-5 py-4"
            >
              <p className="text-sm text-foreground/60">
                {failure === 'missing'
                  ? 'The backend is up, but its Celo endpoints have not shipped yet. This page starts reading them the moment they deploy; nothing on it is faked in the meantime.'
                  : BACKEND_UNREACHABLE}
              </p>
              <button
                type="button"
                onClick={load}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
              >
                <RefreshCw size={13} /> Retry now
              </button>
            </motion.div>
          )}

          <div className="mt-12 flex flex-col gap-5">
            {/* Rail status: the configuration the backend actually runs with, read live. */}
            <motion.section {...revealAt(0)} className="rounded-3xl border border-border bg-card p-6 sm:p-8">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-bold tracking-tight text-foreground">Rail status</h2>
                {st ? (
                  st.configured ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-current" /> Configured
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-current" /> Not configured yet
                    </span>
                  )
                ) : (
                  <Skeleton />
                )}
              </div>
              <p className="mt-1 text-sm leading-relaxed text-foreground/55">
                Read from GET /api/celo/status on every refresh; none of it is hardcoded
                into this page.
              </p>

              {st && !st.configured && (
                <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4 text-sm text-foreground/70">
                  <span className="font-semibold text-foreground">Not configured yet.</span>{' '}
                  {st.reason ??
                    'The backend has not been given its Celo settlement credentials.'}{' '}
                  The counters below hold their honest zeros until the first real
                  settlement; nothing is simulated to fill the gap.
                </div>
              )}

              <div className="mt-4">
                <StatusRow label="Network">{st ? (st.network ?? 'unknown') : <Skeleton />}</StatusRow>
                <StatusRow label="Pay-to address">
                  {st ? (
                    st.payTo ? (
                      <AddrLink addr={st.payTo} />
                    ) : (
                      <span className="text-foreground/40">not set</span>
                    )
                  ) : (
                    <Skeleton />
                  )}
                </StatusRow>
                <StatusRow label="Facilitator">
                  {st ? (st.facilitator ?? <span className="text-foreground/40">not set</span>) : <Skeleton />}
                </StatusRow>
                {typeof st?.registry === 'string' && st.registry && (
                  <StatusRow label="Registry">
                    {/^0x[0-9a-fA-F]{40}$/.test(st.registry) ? <AddrLink addr={st.registry} /> : st.registry}
                  </StatusRow>
                )}
                {typeof st?.resolver === 'string' && st.resolver && (
                  <StatusRow label="Resolver">
                    {/^0x[0-9a-fA-F]{40}$/.test(st.resolver) ? <AddrLink addr={st.resolver} /> : st.resolver}
                  </StatusRow>
                )}
              </div>
            </motion.section>

            {/* Counters: the settlement log in aggregate. Zero means zero. */}
            <motion.section {...revealAt(1)} className="rounded-3xl border border-border bg-card p-6 sm:p-8">
              <h2 className="text-lg font-bold tracking-tight text-foreground">
                Settled through x402 on Celo
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-foreground/55">
                Counted from the settlement log, never estimated. A zero here is a real
                zero; the first paid call moves it.
              </p>
              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat
                  label="Settlements"
                  value={p ? nf.format(p.totalSettlements ?? 0) : <Skeleton />}
                />
                <Stat label="Settled volume" value={p ? usd(p.totalUsd ?? 0) : <Skeleton />} />
                <Stat label="Tools earning" value={p ? nf.format(byTool.length) : <Skeleton />} />
              </div>
              {p && byTool.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-sm font-bold text-foreground/70">By tool</h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {byTool.map(([tool, count]) => (
                      <span
                        key={tool}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground/70"
                      >
                        {tool}
                        <span className="font-mono text-[10px] font-semibold text-foreground/45 tabular-nums">
                          {nf.format(count)}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {p && byTool.length === 0 && (
                <p className="mt-4 text-xs text-foreground/45">
                  No per-tool breakdown yet; it appears with the first settlement.
                </p>
              )}
            </motion.section>

            {/* Recent settlements: the rows behind the totals, internal traffic labeled. */}
            <motion.section {...revealAt(0)} className="rounded-3xl border border-border bg-card p-6 sm:p-8">
              <h2 className="text-lg font-bold tracking-tight text-foreground">Recent settlements</h2>
              <p className="mt-1 text-sm leading-relaxed text-foreground/55">
                Internal and test traffic is labeled. Judges: everything here is
                verifiable on-chain.
              </p>
              {p == null ? (
                <div className="mt-5 space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-9 animate-pulse rounded-lg bg-foreground/[0.06]" />
                  ))}
                </div>
              ) : recent.length === 0 ? (
                <div className="mt-5 rounded-xl border border-border bg-background p-5 text-sm text-foreground/55">
                  No settlements yet. The first paid x402 call on Celo appears here within
                  a minute of settling; until then this table stays honestly empty.
                </div>
              ) : (
                <div className="mt-5 overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-foreground/40">
                        <th className="py-2.5 pl-4 font-medium">Time</th>
                        <th className="py-2.5 font-medium">Tool</th>
                        <th className="py-2.5 pr-4 text-right font-medium sm:pr-0">Amount</th>
                        <th className="hidden py-2.5 pl-6 pr-4 text-right font-medium sm:table-cell">
                          Payer
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((r, i) => {
                        const d = toDate(r.ts)
                        const valid = !Number.isNaN(d.getTime())
                        return (
                          <tr key={`${r.ts}-${r.tool}-${i}`} className="border-b border-border/60 last:border-0">
                            <td
                              className="py-3 pl-4 font-mono text-xs text-foreground/55"
                              title={valid ? d.toLocaleString('en-US') : undefined}
                            >
                              {valid ? ago(d.toISOString()) : '-'}
                            </td>
                            <td className="py-3 pr-3">
                              <span className="inline-flex flex-wrap items-center gap-1.5">
                                <span className="font-medium text-foreground">{r.tool}</span>
                                {r.internal && <InternalBadge />}
                              </span>
                            </td>
                            <td className="py-3 pr-4 text-right font-mono text-xs font-semibold tabular-nums text-foreground/80 sm:pr-0">
                              {usd(r.amountUsd ?? 0)}
                            </td>
                            <td className="hidden py-3 pl-6 pr-4 text-right font-mono text-xs text-foreground/55 sm:table-cell">
                              {r.payer ? short(r.payer, 6) : <span className="text-foreground/30">-</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </motion.section>

            {/* Cross-links: proof surfaces we do not get to edit after the fact. */}
            <motion.section {...revealAt(1)} className="rounded-3xl border border-border bg-card p-6 sm:p-8">
              <h2 className="text-lg font-bold tracking-tight text-foreground">
                Check us somewhere we do not control
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-foreground/55">
                The same transparency on our other rails; a proof that only lives on its
                own page is not much of a proof.
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <ProofLink
                  href="https://a-identity-asp.onrender.com/proof"
                  title="X Layer proof"
                  caption="The same x402 settlement transparency for our OKX rail, served by the backend itself."
                />
                <ProofLink
                  to="/explorer"
                  title="Agent Trust Explorer"
                  caption="Resolve any agent's on-chain identity, reputation and risk. No login, no mocks."
                />
                <ProofLink
                  href="https://github.com/getA-Identity/A-Identity"
                  title="Source on GitHub"
                  caption="Every line of this page and the backend it reads, in the open."
                />
              </div>
            </motion.section>
          </div>

          {/* Provenance line: how fresh this read is, and where to make the same one. */}
          <motion.p {...reveal} className="mt-10 text-xs text-foreground/45">
            {checkedAt
              ? `Checked ${Math.max(0, Math.round((now - checkedAt) / 1000))}s ago. `
              : 'Waiting for the first read from the backend. '}
            This page refreshes every 60 seconds from{' '}
            <a
              href="https://a-identity.xyz/api/celo/proof"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-accent underline-offset-2 hover:underline"
            >
              GET /api/celo/proof
            </a>{' '}
            and{' '}
            <a
              href="https://a-identity.xyz/api/celo/status"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-accent underline-offset-2 hover:underline"
            >
              GET /api/celo/status
            </a>
            , the same public endpoints any judge or agent can call.
          </motion.p>
        </SectionShell>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
