import { useEffect, useRef, useState, type FormEvent } from 'react'
import TractionPanel from '../components/landing/TractionPanel'
import { Link, useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Loader2, Copy, Check, ArrowUpRight, ShieldCheck, ShieldAlert, ShieldX, BadgeCheck, AlertTriangle } from 'lucide-react'
import Logo from '../components/Logo'
import ThemeToggle from '../components/ThemeToggle'
import SiteFooter from '../components/sections/SiteFooter'
import { Input } from '../components/ui/input'
import VerifyStepper from '../components/landing/VerifyStepper'
import { useTheme } from '../components/ThemeProvider'
import { APP_NAME } from '../lib/brand'
import { short } from '../lib/format'
import { gradeOf } from '../lib/reputation-bands'
import {
  resolveAgent, getReputation, getLeaderboard,
  type AgentIdentity, type Reputation, type FeedAgent,
} from '../lib/mcp-client'
import { type OwlVerdict } from '../components/OwlMark'
import AgentAvatar from '../components/AgentAvatar'
import { track } from '../lib/analytics'

type Verdict = 'ALLOW' | 'WARN' | 'DENY'
// Semantic tokens, not literal hexes: the light values match the old hexes exactly,
// and the tokens flip with the theme so the verdict colors survive dark mode.
const VERDICT: Record<Verdict, { color: string; Icon: typeof ShieldCheck }> = {
  ALLOW: { color: 'var(--ok)', Icon: ShieldCheck },
  WARN: { color: 'var(--warn)', Icon: ShieldAlert },
  DENY: { color: 'var(--danger)', Icon: ShieldX },
}
function riskOf(score: number, kya?: string, verified = true, sybil?: string): Verdict {
  if (kya === 'revoked' || !verified || sybil === 'high') return 'DENY'
  if (score < 200) return 'DENY'
  if (score < 500 || sybil === 'medium') return 'WARN'
  return 'ALLOW'
}

function useCountUp(target: number, duration = 900) {
  const [val, setVal] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    const start = performance.now()
    const begin = from.current
    let raf = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / duration)
      const cur = Math.round(begin + (target - begin) * (1 - Math.pow(1 - t, 3)))
      setVal(cur)
      if (t < 1) raf = requestAnimationFrame(tick)
      else from.current = target
    })
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return val
}

function RiskPill({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict]
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold"
      style={{
        color: v.color,
        // Hex-alpha suffixes do not compose with var() references; mix instead.
        background: `color-mix(in srgb, ${v.color} 8%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${v.color} 20%, transparent)`,
      }}>
      <v.Icon size={13} /> {verdict}
    </span>
  )
}

/** FICO-style spectrum: a red→amber→green gradient bar with a precise pointer at the score. */
function Spectrum({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score / 10))
  return (
    <div className="w-full">
      <div className="relative h-2 w-full rounded-full" style={{ background: 'linear-gradient(90deg,#dc2626 0%,#d97706 45%,#059669 100%)' }}>
        <motion.div className="absolute -top-1 h-4 w-[3px] -translate-x-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_var(--color-background)]"
          initial={{ left: 0, opacity: 0 }} animate={{ left: `${pct}%`, opacity: 1 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0.1 }} />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-foreground/35">
        <span>0</span><span>250</span><span>500</span><span>750</span><span>1000</span>
      </div>
    </div>
  )
}

function CopyAddr({ value, href }: { value: string; href?: string | null }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-foreground/55">
      {short(value, 6, '…')}
      <button type="button" aria-label="Copy address"
        onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
        className="text-foreground/35 transition-colors hover:text-foreground">
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {href && <a href={href} target="_blank" rel="noopener noreferrer" aria-label="View on explorer" className="text-foreground/35 transition-colors hover:text-accent"><ArrowUpRight size={12} /></a>}
    </span>
  )
}

function StatRow({ label, value, cap, tone }: { label: string; value: number | string; cap?: number; tone?: string }) {
  const num = typeof value === 'number' ? value : null
  const pct = cap && num != null ? Math.max(0, Math.min(100, (Math.abs(num) / cap) * 100)) : null
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-wide text-foreground/45">{label}</span>
        <span className="font-mono text-sm font-semibold tabular-nums" style={{ color: tone }}>
          {num != null && num >= 0 && cap != null ? `${num}` : value}{cap != null && num != null ? <span className="text-foreground/30"> / {cap}</span> : null}
        </span>
      </div>
      {pct != null && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: (num ?? 0) < 0 ? '#dc2626' : 'var(--color-accent)' }} />
        </div>
      )}
    </div>
  )
}

function TrustProfile({ identity, reputation, query }: { identity: AgentIdentity | null; reputation: Reputation | null; query: string }) {
  // A resolved on-chain identity (ownerOf succeeded) IS the registration proof. Do NOT
  // read `identity.valid` here: the backend deliberately pins it to false (a tokenURI
  // self-claim is never trusted), so using it would wrongly DENY every resolved agent.
  const verified = Boolean(identity) || reputation?.onchain === 'registered'
  const score = reputation?.score ?? 0
  const shownScore = useCountUp(score)
  const verdict = riskOf(score, reputation?.kya, verified, reputation?.sybil?.level)
  const name = reputation?.name || (identity && !identity.partial ? `Agent #${identity.tokenId}` : identity?.partial ? 'OKX.AI agent' : query)
  const bd = reputation?.breakdown
  const beh = reputation?.behavioral
  const owner = identity?.owner
  const seed = owner || identity?.tokenId?.toString() || query
  const arcUrl = owner && /^0x[0-9a-fA-F]{40}$/.test(owner) ? `https://testnet.arcscan.app/address/${owner}` : null
  const g = gradeOf(score)

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {/* entity header */}
      <div className="flex flex-wrap items-center gap-4 border-b border-border p-5">
        <AgentAvatar seed={seed} size={56} verdict={verdict.toLowerCase() as OwlVerdict} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-bold tracking-tight text-foreground">{name}</h2>
            {verified && (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-600/10 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                <BadgeCheck size={12} /> ERC-8004
              </span>
            )}
            {reputation?.kya === 'revoked'
              ? <span className="rounded-md bg-red-600/10 px-1.5 py-0.5 text-[11px] font-semibold text-red-600 dark:text-red-400">KYA revoked</span>
              : reputation?.kya === 'verified'
              ? <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[11px] font-semibold text-foreground/60">KYA verified</span>
              : null}
            {(reputation?.sybil?.level === 'high' || reputation?.sybil?.level === 'medium') && (
              <span className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold" title={`${reputation.sybil.selfDealt}/${reputation.sybil.jobs} jobs hired by its own operator`}
                style={{ color: reputation.sybil.level === 'high' ? '#dc2626' : '#d97706', background: reputation.sybil.level === 'high' ? '#dc26261a' : '#d977061a' }}>
                Sybil risk: {reputation.sybil.level}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-foreground/45">
            {identity && !identity.partial && <span>#{identity.tokenId}</span>}
            {owner && <CopyAddr value={owner} href={arcUrl} />}
            <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              {identity?.chain === 'xlayer' ? 'X Layer mainnet' : 'Arc testnet'}
            </span>
            {identity?.partial && <span className="text-[11px] normal-case">identity held on-chain; search by token id for the full record</span>}
          </div>
        </div>
      </div>

      {/* reputation, credit-score style */}
      <div className="border-b border-border p-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">Reputation</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-mono text-4xl font-bold tabular-nums text-foreground">{shownScore}</span>
              <span className="font-mono text-sm text-foreground/35">/ 1000</span>
              <span className="ml-1 text-sm font-semibold" style={{ color: VERDICT[verdict].color }}>{g.label}<span className="text-foreground/35"> · {g.tier}</span></span>
            </div>
          </div>
          <RiskPill verdict={verdict} />
        </div>
        <div className="mt-4"><Spectrum score={score} /></div>
        {reputation?.onchainAttestation && (
          <div className="mt-3 text-[11px]">
            <a href={reputation.onchainAttestation.txUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">
              Anchored on-chain · ERC-8004 ReputationRegistry ↗
            </a>
            <span className="text-foreground/40"> verify the score on Arc, not just here</span>
          </div>
        )}
      </div>

      {/* stats grid */}
      {reputation ? (
        <div className="grid gap-x-8 gap-y-0 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {bd && <StatRow label="Settlement" value={bd.settlement} cap={600} />}
          {bd && <StatRow label="Validation" value={bd.validation} cap={240} />}
          {bd && <StatRow label="Tenure" value={bd.tenure} cap={160} />}
          {bd && typeof bd.behavior === 'number' && <StatRow label="Behavior (jobs)" value={bd.behavior >= 0 ? `+${bd.behavior}` : String(bd.behavior)} tone={bd.behavior < 0 ? '#dc2626' : undefined} />}
          {beh && <StatRow label="Completed jobs" value={beh.completedJobs} />}
          {beh && <StatRow label="Contested" value={beh.contestedJobs} tone={beh.contestedJobs > 0 ? '#d97706' : undefined} />}
          {beh && <StatRow label="Dispute rate" value={`${Math.round(beh.disputeRate * 100)}%`} tone={beh.disputeRate >= 0.3 ? '#dc2626' : undefined} />}
          {beh && <StatRow label="Avg rating" value={beh.avgRating != null ? `${beh.avgRating.toFixed(1)} / 5` : '·'} />}
          {typeof reputation.settledOnchain === 'number' && <StatRow label="Settled on-chain" value={`${reputation.settledOnchain}${reputation.settledUsd ? ` · $${reputation.settledUsd}` : ''}`} />}
        </div>
      ) : (
        <div className="p-5 text-sm text-foreground/50">On-chain identity resolved; no platform reputation for this agent yet.</div>
      )}

      <div className="border-t border-border px-5 py-3 text-[11px] text-foreground/40">
        Live ERC-8004 read · deterministic <a href="https://a-identity-asp.onrender.com/methodology" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">reproducible</a> score.
        Amount-aware verdict: the paid <a href="https://a-identity-asp.onrender.com/proof" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">risk_check on OKX</a>.
      </div>
    </div>
  )
}

const Shimmer = ({ className }: { className?: string }) => <div className={`animate-pulse rounded bg-foreground/[0.08] ${className ?? ''}`} />

function ProfileSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-4 border-b border-border p-5">
        <Shimmer className="h-11 w-11 rounded-lg" />
        <div className="flex-1 space-y-2"><Shimmer className="h-4 w-40" /><Shimmer className="h-3 w-64" /></div>
      </div>
      <div className="space-y-3 border-b border-border p-5">
        <Shimmer className="h-9 w-40" /><Shimmer className="h-2 w-full" />
      </div>
      <div className="grid gap-x-8 gap-y-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => <Shimmer key={i} className="h-4 w-full" />)}
      </div>
    </div>
  )
}

/** Badge levels share the palette the console and the SVG badge use, so one agent reads the
 *  same everywhere it appears. */
const GUARDRAIL_COLOR: Record<string, string> = {
  enforced: '#059669',
  enforced_with_flags: '#d97706',
  configured: '#b8860b',
  none: '#8a8f98',
  unavailable: '#8a8f98',
}

function LeaderboardSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border/60">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <Shimmer className="h-4 w-4" /><Shimmer className="h-7 w-7 rounded-lg" />
          <div className="flex-1 space-y-1.5"><Shimmer className="h-3.5 w-36" /><Shimmer className="h-2.5 w-20" /></div>
          <Shimmer className="hidden h-1.5 w-20 sm:block" /><Shimmer className="h-4 w-10" />
        </div>
      ))}
    </div>
  )
}

export default function Explorer() {
  const { theme } = useTheme()
  const [sp] = useSearchParams()
  const initialQ = sp.get('q') || '849980'
  const [query, setQuery] = useState(initialQ)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [identity, setIdentity] = useState<AgentIdentity | null>(null)
  const [reputation, setReputation] = useState<Reputation | null>(null)
  const [shown, setShown] = useState('')
  const [board, setBoard] = useState<FeedAgent[]>([])
  const [boardLoading, setBoardLoading] = useState(true)
  // The step-by-step pipeline runs first; the full profile card reveals when it completes.
  const [pipelineDone, setPipelineDone] = useState(false)
  const topRef = useRef<HTMLElement>(null)

  async function lookup(raw: string, scroll = false) {
    const q = raw.trim()
    if (!q) return
    setLoading(true); setError(null); setPipelineDone(false)
    const [idRes, repRes] = await Promise.all([resolveAgent(q), getReputation(q)])
    const id = idRes.ok && idRes.data.found ? (idRes.data.agent ?? null) : null
    const rep = repRes.ok && repRes.data.found ? (repRes.data.reputation ?? null) : null
    setIdentity(id); setReputation(rep); setShown(q)
    if (!id && !rep) setError(`No agent found for "${q}". Try a token id (849980) or an owner address.`)
    setLoading(false)
    if (scroll) topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  useEffect(() => {
    void lookup(initialQ)
    void getLeaderboard().then((r) => { if (r.ok) setBoard(r.data.filter((a) => (a.reputation?.score ?? 0) > 0).slice(0, 12)); setBoardLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    // Count that a lookup happened and roughly what kind, never what was looked
    // up: the query is a wallet address or an agent id, and neither belongs in
    // an analytics payload.
    track('agent_lookup', { kind: /^0x/i.test(query.trim()) ? 'address' : /^#?\d+$/.test(query.trim()) ? 'token_id' : 'name' })
    void lookup(query)
  }
  const activeKey = reputation?.name ? shown : null

  return (
    <div className={theme === 'dark' ? 'dark' : ''}>
      <div className="min-h-screen w-full bg-background text-foreground" style={{ fontFamily: 'var(--font-body)' }}>
        {/* tool header */}
        <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
          <div className="mx-auto flex w-full max-w-[1040px] items-center justify-between px-5 py-3 sm:px-8">
            <Link to="/" aria-label={`${APP_NAME} home`} className="flex items-center gap-2 text-foreground">
              <Logo fill="currentColor" />
              <span className="text-base font-bold tracking-tight">{APP_NAME}</span>
              <span className="ml-1 hidden rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-foreground/50 sm:inline">Explorer</span>
            </Link>
            <div className="flex items-center gap-3">
              <Link to="/app" className="hidden text-sm font-medium text-foreground/60 transition-colors hover:text-foreground sm:block">Console</Link>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main ref={topRef} className="mx-auto w-full max-w-[1040px] px-5 py-10 sm:px-8">
          {/* title */}
          <div className="max-w-2xl">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl" style={{ fontFamily: 'var(--font-heading)' }}>Agent Trust Explorer</h1>
            <p className="mt-2 text-sm text-foreground/55">Resolve any agent&apos;s on-chain identity, reputation and risk on Circle Arc. No login, no mocks.</p>
          </div>

          {/* search */}
          <form onSubmit={onSubmit} className="mt-6 flex gap-2">
            <div className="relative flex-1">
              <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground/40" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Agent query"
                placeholder="Token id (849980) or 0x owner address" className="h-11 rounded-lg pl-10 font-mono text-sm" />
            </div>
            <button type="submit" disabled={loading}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-accent px-5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60">
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              <span className="hidden sm:inline">{loading ? 'Reading' : 'Search'}</span>
            </button>
          </form>

          {/* result */}
          <div className="mt-6">
            {error && <div className="rounded-lg border border-border bg-card p-5 text-sm text-foreground/60">{error}</div>}
            {!error && loading && !identity && !reputation && <ProfileSkeleton />}
            {!error && (identity || reputation) && (
              <motion.div key={`pipe-${shown}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>
                <VerifyStepper identity={identity} reputation={reputation} query={shown} onComplete={() => setPipelineDone(true)} />
              </motion.div>
            )}
            <AnimatePresence mode="wait">
              {!error && (identity || reputation) && pipelineDone && (
                <motion.div key={shown} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }} className="mt-4">
                  {/* A bare token id that exists on more than one chain does not identify
                      one agent, so say that instead of letting the first chain's result read
                      as the answer. Each candidate is a one-click, unambiguous lookup. */}
                  {identity?.ambiguity && (
                    <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
                      <div className="flex items-start gap-2">
                        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-foreground">This number is not unique</div>
                          <div className="mt-0.5 text-[12px] text-foreground/60">{identity.ambiguity.note}</div>
                          <div className="mt-3 space-y-1.5">
                            {identity.ambiguity.matches.map((m) => (
                              <button
                                key={m.caip}
                                type="button"
                                onClick={() => { setQuery(m.caip); void lookup(m.caip, true) }}
                                className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-foreground/[0.03]"
                              >
                                <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-foreground/60">
                                  {m.chain}
                                </span>
                                <span className="truncate font-mono text-[11px] text-foreground/70">{m.caip}</span>
                                <span className="ml-auto shrink-0 font-mono text-[11px] text-foreground/40">
                                  {m.owner.slice(0, 8)}…{m.owner.slice(-4)}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  <TrustProfile identity={identity} reputation={reputation} query={shown} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Aggregate guardrail traction. Renders nothing until there is activity, so it
              never shows a dashboard of zeroes. */}
          <TractionPanel />

          {/* leaderboard table */}
          {(boardLoading || board.length > 0) && (
            <div className="mt-12">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-sm font-bold uppercase tracking-wide text-foreground/70">Most trusted agents</h2>
                <span className="font-mono text-[11px] text-foreground/40">ranked by reputation</span>
              </div>
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                {board.length === 0 ? <LeaderboardSkeleton /> : <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-foreground/40">
                      <th className="w-10 py-2.5 pl-4 font-medium">#</th>
                      <th className="py-2.5 font-medium">Agent</th>
                      <th className="hidden py-2.5 font-medium sm:table-cell">Reputation</th>
                      <th className="hidden py-2.5 font-medium md:table-cell">Guardrails</th>
                      <th className="py-2.5 pr-4 text-right font-medium">Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.map((a, i) => {
                      const s = a.reputation?.score ?? 0
                      const v = riskOf(s, a.kya)
                      const active = activeKey != null && (a.onchainAgentId === activeKey || a.id === activeKey)
                      return (
                        <tr key={a.id} onClick={() => { const q = a.onchainAgentId || a.id; setQuery(q); void lookup(q, true) }}
                          className={`cursor-pointer border-b border-border/60 transition-colors last:border-0 ${active ? 'bg-foreground/[0.04]' : 'hover:bg-foreground/[0.025]'}`}>
                          <td className="py-3 pl-4 font-mono text-foreground/35">{i + 1}</td>
                          <td className="py-3 pr-3">
                            <div className="flex items-center gap-2.5">
                              <AgentAvatar seed={a.onchainAgentId || a.id} size={32} verdict={v.toLowerCase() as OwlVerdict} />
                              <div className="min-w-0">
                                <div className="truncate font-medium text-foreground">{a.name}</div>
                                <div className="truncate font-mono text-[11px] text-foreground/40">{a.category}{a.onchainAgentId ? ` · #${a.onchainAgentId}` : ''}</div>
                              </div>
                            </div>
                          </td>
                          <td className="hidden py-3 sm:table-cell">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-foreground/[0.08]">
                                <div className="h-full rounded-full" style={{ width: `${Math.max(3, s / 10)}%`, background: 'var(--color-accent)' }} />
                              </div>
                              <span className="font-mono text-xs font-semibold tabular-nums text-foreground/80">{s}</span>
                            </div>
                          </td>
                          {/* Guardrail standing, shown only for agents whose owner PUBLISHED
                              their badge. Opt-in from Phase 1.5, so an agent that has not
                              published shows nothing about its policy here. */}
                          <td className="hidden py-3 pr-3 md:table-cell">
                            {a.guardrails?.published ? (
                              <span
                                className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold"
                                style={{
                                  color: GUARDRAIL_COLOR[a.guardrails.level ?? 'none'],
                                  background: `${GUARDRAIL_COLOR[a.guardrails.level ?? 'none']}14`,
                                }}
                              >
                                {a.guardrails.label ?? a.guardrails.level}
                              </span>
                            ) : (
                              <span className="font-mono text-[11px] text-foreground/25">not published</span>
                            )}
                          </td>
                          <td className="py-3 pr-4 text-right">
                            <span className="inline-flex items-center gap-1 font-mono text-xs font-semibold" style={{ color: VERDICT[v].color }}>
                              <span className="h-1.5 w-1.5 rounded-full" style={{ background: VERDICT[v].color }} />{v}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>}
              </div>
            </div>
          )}
        </main>
        <SiteFooter />
      </div>
    </div>
  )
}
