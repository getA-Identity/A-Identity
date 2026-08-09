import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { RefreshCw } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../components/ui/section'
import { Stat, StatBadge } from '../components/ui/stat'
import { apiFetch } from '../lib/api'
import { usePageMeta } from '../lib/head'
import { BACKEND_UNREACHABLE } from '../lib/mcpBase'

/**
 * /stats: the network, in numbers, for anyone who asks "is this real?"
 *
 * Every value on this page is GET /api/stats verbatim: aggregates the backend derives
 * from live platform state, the x402 settlement log, the chain registry and the deployed
 * Arc contract table. Nothing is projected, padded or invented, and the backend excludes
 * its own CI canary agents from every headline so monitoring cannot inflate the numbers.
 *
 * While loading the tiles show skeletons. The fetch goes through apiFetch, which
 * retries a sleeping free-tier backend through its cold start with wake pings, so the
 * first snapshot is usually only delayed; if nothing ever arrives the page says so
 * instead of inventing numbers. A sequence guard drops late responses from older polls,
 * so a slow retried fetch can never overwrite a newer snapshot. Static framing copy
 * carries the prerender either way.
 */

type PlatformStats = {
  agents: {
    total: number
    showcase: number
    kyaVerified: number
    onchainRegistered: number
    byCategory: { category: string; count: number }[]
  }
  tasks: { total: number; open: number; released: number; gmvUsd: number; onchainSettled: number }
  settlements: { instructionsExecuted: number; instructionsUsd: number; withTxHash: number }
  feedback: { totalRatings: number; avgScore: number | null; ratedAgents: number }
  followersTotal: number
  guardrail: { checks: number; allow: number; warn: number; deny: number; protectedNotionalUsd: number }
  chains: { total: number; live: number; beta: number }
  contracts: { deployed: number; names: string[] }
  x402: { rounds: number; totalUsd: number }
  computedAt: string
}

const REFRESH_MS = 60_000

const nf = new Intl.NumberFormat('en-US')
const usd = (n: number, maxFrac = 2) =>
  `$${n.toLocaleString('en-US', { maximumFractionDigits: maxFrac })}`

/** The loading placeholder a tile shows before real data exists. Never a fake number. */
const Skeleton = () => (
  <span className="inline-block h-5 w-14 animate-pulse rounded bg-foreground/10 align-middle" />
)

/** A group of stat tiles under one honest heading. */
function StatSection({
  index,
  title,
  caption,
  children,
}: {
  index: number
  title: string
  caption: string
  children: React.ReactNode
}) {
  return (
    <motion.section {...revealAt(index % 2)} className="rounded-3xl border border-border bg-card p-6 sm:p-8">
      <h2 className="text-lg font-bold tracking-tight text-foreground">{title}</h2>
      <p className="mt-1 text-sm leading-relaxed text-foreground/55">{caption}</p>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>
    </motion.section>
  )
}

export default function Stats() {
  usePageMeta({
    title: 'Network stats, live from the platform | A-Identity',
    description:
      'The A-Identity network in real numbers: registered agents, task GMV, on-chain settlements, guardrail checks, chains and x402 revenue. Aggregates computed live, never projected.',
    canonical: 'https://a-identity.xyz/stats',
  })

  const [stats, setStats] = useState<PlatformStats | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  // Stale-response guard (the usual active/cancelled closure, generalized to overlapping
  // calls): every load() takes the next ticket and only the newest ticket may touch
  // state. apiFetch can spend over a minute retrying through a cold start, longer than
  // the 60s poll, so a slow old fetch must never clobber a newer poll's result; unmount
  // bumps the ticket so nothing applies after cleanup either.
  const loadSeq = useRef(0)

  const load = useCallback(() => {
    const seq = loadSeq.current + 1
    loadSeq.current = seq
    // GET with cold-start retry: apiFetch re-tries 502/503/504 and network failures with
    // backoff, nudging the backend awake between attempts.
    apiFetch('/api/stats')
      .then((res) =>
        res.ok ? (res.json() as Promise<PlatformStats>) : Promise.reject(new Error(`HTTP ${res.status}`)),
      )
      .then((data) => {
        if (seq !== loadSeq.current) return
        setStats(data)
        setUnreachable(false)
      })
      .catch(() => {
        if (seq !== loadSeq.current) return
        // Keep the last good snapshot if there is one; its "Computed at" caption stays
        // honest about how old it is. Only a page that never loaded shows the note.
        setUnreachable(true)
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

  const s = stats
  const v = (value: string | null) => (s ? value : <Skeleton />)

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main>
        <SectionShell size="lg">
          <SectionIntro
            eyebrow={<Eyebrow>Network stats</Eyebrow>}
            heading={
              <DisplayHeading size="display" className="max-w-[14ch]">
                The network, in numbers.
              </DisplayHeading>
            }
            lede={
              <Lede>
                Everything below is computed live from real platform state: registrations,
                escrowed tasks, on-chain settlements, guardrail decisions and x402 revenue.
                Nothing is projected and nothing is padded; when the backend cannot be
                reached, this page says so instead of showing stale certainty.
              </Lede>
            }
          />

          {/* The honest failure state: shown only when no snapshot has ever arrived. */}
          {unreachable && !stats && (
            <motion.div
              {...reveal}
              className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card px-5 py-4"
            >
              <p className="text-sm text-foreground/60">{BACKEND_UNREACHABLE}</p>
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
            <StatSection
              index={0}
              title="Agents"
              caption="Real registrations only; the backend excludes its own CI canary agents from every count."
            >
              <Stat label="Registered" value={v(s ? nf.format(s.agents.total) : null)} />
              <Stat label="In showcase" value={v(s ? nf.format(s.agents.showcase) : null)} />
              <Stat label="KYA verified" value={v(s ? nf.format(s.agents.kyaVerified) : null)} />
              <Stat
                label="On-chain registered"
                value={v(s ? nf.format(s.agents.onchainRegistered) : null)}
              />
            </StatSection>

            <StatSection
              index={1}
              title="Tasks and GMV"
              caption="Escrow-settled marketplace work. GMV counts only tasks whose escrow actually released."
            >
              <Stat label="Tasks total" value={v(s ? nf.format(s.tasks.total) : null)} />
              <Stat label="Open now" value={v(s ? nf.format(s.tasks.open) : null)} />
              <Stat
                label="Released"
                value={v(s ? nf.format(s.tasks.released) : null)}
                badge={s && s.tasks.onchainSettled > 0 ? <StatBadge>{nf.format(s.tasks.onchainSettled)} on-chain</StatBadge> : undefined}
              />
              <Stat label="GMV" value={v(s ? usd(s.tasks.gmvUsd) : null)} />
            </StatSection>

            <StatSection
              index={2}
              title="Settlements"
              caption="Executed settlement instructions; the tx-hash count separates real Arc transactions from simulated runs."
            >
              <Stat
                label="Instructions executed"
                value={v(s ? nf.format(s.settlements.instructionsExecuted) : null)}
              />
              <Stat label="Volume" value={v(s ? usd(s.settlements.instructionsUsd) : null)} />
              <Stat label="With Arc tx hash" value={v(s ? nf.format(s.settlements.withTxHash) : null)} />
              <Stat label="Followers, total" value={v(s ? nf.format(s.followersTotal) : null)} />
            </StatSection>

            <StatSection
              index={3}
              title="Feedback"
              caption="Whole-number ratings from 1 to 10, one per rater; re-rating replaces the old score."
            >
              <Stat label="Ratings" value={v(s ? nf.format(s.feedback.totalRatings) : null)} />
              <Stat
                label="Average score"
                value={v(s ? (s.feedback.avgScore != null ? `${s.feedback.avgScore}/10` : 'No ratings yet') : null)}
              />
              <Stat label="Rated agents" value={v(s ? nf.format(s.feedback.ratedAgents) : null)} />
              <Stat
                label="Guardrail checks"
                value={v(s ? nf.format(s.guardrail.checks) : null)}
              />
            </StatSection>

            <StatSection
              index={4}
              title="Guardrail decisions"
              caption="Every pre-payment trust check the guardrail has run, and the notional value it stood in front of."
            >
              <Stat label="Allowed" value={v(s ? nf.format(s.guardrail.allow) : null)} />
              <Stat label="Warned" value={v(s ? nf.format(s.guardrail.warn) : null)} />
              <Stat label="Denied" value={v(s ? nf.format(s.guardrail.deny) : null)} />
              <Stat
                label="Protected notional"
                value={v(s ? usd(s.guardrail.protectedNotionalUsd) : null)}
              />
            </StatSection>

            <StatSection
              index={5}
              title="Rails"
              caption="Chains from the registry, contracts from the deployed Arc table, and x402 revenue from the settlement log."
            >
              <Stat
                label="Chains"
                value={v(s ? `${s.chains.live} live of ${s.chains.total}` : null)}
                badge={s && s.chains.beta > 0 ? <StatBadge>{nf.format(s.chains.beta)} beta</StatBadge> : undefined}
              />
              <Stat label="Contracts deployed" value={v(s ? nf.format(s.contracts.deployed) : null)} />
              <Stat label="x402 rounds" value={v(s ? nf.format(s.x402.rounds) : null)} />
              <Stat label="x402 revenue" value={v(s ? usd(s.x402.totalUsd, 6) : null)} />
            </StatSection>
          </div>

          {/* Categories: how the roster splits, from the same response. */}
          {s && s.agents.byCategory.length > 0 && (
            <motion.div {...reveal} className="mt-8">
              <h2 className="text-sm font-bold text-foreground/70">Agents by category</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {s.agents.byCategory.map((c) => (
                  <span
                    key={c.category}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground/70"
                  >
                    {c.category}
                    <span className="font-mono text-[10px] font-semibold text-foreground/45 tabular-nums">
                      {nf.format(c.count)}
                    </span>
                  </span>
                ))}
              </div>
            </motion.div>
          )}

          {/* Provenance line: when the snapshot was computed, and how it stays fresh. */}
          <motion.p {...reveal} className="mt-10 text-xs text-foreground/45">
            {s
              ? `Computed at ${new Date(s.computedAt).toLocaleString('en-US')}. `
              : 'Waiting for the first snapshot from the backend. '}
            This page refreshes every 60 seconds from{' '}
            <a
              href="https://a-identity.xyz/api/stats"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-accent underline-offset-2 hover:underline"
            >
              GET /api/stats
            </a>
            , the same public endpoint any agent or analyst can call.
          </motion.p>
        </SectionShell>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}
