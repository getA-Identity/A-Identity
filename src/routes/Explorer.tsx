import { useEffect, useRef, useState, type FormEvent } from 'react'
import TractionPanel from '../components/landing/TractionPanel'
import { Link, useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Loader2, Copy, Check, ArrowUpRight, BadgeCheck, AlertTriangle, ShieldCheck, Trophy } from 'lucide-react'
import Logo from '../components/Logo'
import ThemeToggle from '../components/ThemeToggle'
import SiteFooter from '../components/sections/SiteFooter'
import { Input } from '../components/ui/input'
import { Badge, VerdictBadge, type BadgeProps } from '../components/ui/badge'
import VerifyStepper from '../components/landing/VerifyStepper'
import { useTheme } from '../components/ThemeProvider'
import { APP_NAME } from '../lib/brand'
import { CHAINS, CHAIN_BY_ID, type ChainId } from '../lib/chains'
import { usePageMeta } from '../lib/head'
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
/** How many chains a lookup actually dials, counted from the generated registry rather
 *  than written down: the copy said "on Circle Arc" while five more chains were live. */
const IDENTITY_CHAIN_COUNT = CHAINS.filter((c) => c.identityLive).length
/** Verdict as a text colour, for the places a whole pill would be too much (the grade
 *  word beside the score). The pill itself lives in ui/badge.tsx so ALLOW / WARN / DENY
 *  are drawn once, with the glyph and the word carrying the meaning alongside the hue. */
const VERDICT_TEXT: Record<Verdict, string> = {
  ALLOW: 'text-ok',
  WARN: 'text-warn',
  DENY: 'text-danger',
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

/**
 * A section heading that is actually legible.
 *
 * The explorer's section headings were 11px micro-caps at 40-70% foreground, which on the
 * light cream ground read as grey fog rather than as structure. This is the same header
 * shape the /stats panels use: an accent icon tile, a full-contrast title at a real size,
 * and the qualifier demoted to its own muted line instead of competing with the title.
 */
function SectionHead({ icon: Icon, title, note }: { icon: typeof ShieldCheck; title: string; note: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
          <Icon size={16} strokeWidth={2} />
        </span>
        <h2 className="text-lg font-bold tracking-tight text-foreground">{title}</h2>
      </div>
      <span className="text-xs font-medium text-foreground/60">{note}</span>
    </div>
  )
}

/** FICO-style spectrum: a danger->warn->ok gradient bar with a precise pointer at the score.
 *  The stops are the semantic tokens, so the band a score falls in is the same colour as the
 *  verdict that band produces, in either theme. */
function Spectrum({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score / 10))
  return (
    <div className="w-full">
      <div className="relative h-2.5 w-full rounded-full" style={{ background: 'linear-gradient(90deg,var(--danger) 0%,var(--warn) 45%,var(--ok) 100%)' }}>
        <motion.div className="absolute -top-1 h-[18px] w-[3px] -translate-x-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_var(--color-card)]"
          initial={{ left: 0, opacity: 0 }} animate={{ left: `${pct}%`, opacity: 1 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0.1 }} />
      </div>
      <div className="mt-2 flex justify-between text-[11px] font-medium tabular-nums text-foreground/55">
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

/** A stat's tone is a ROLE, not a colour: callers say "this number is bad", and the token
 *  decides what bad looks like in the current theme. The old signature took a raw hex, so
 *  every caller shipped its own #dc2626 and dark mode never got a say. */
type StatTone = 'warn' | 'danger'
const STAT_TONE: Record<StatTone, string> = { warn: 'text-warn', danger: 'text-danger' }

function StatRow({ label, value, cap, tone }: { label: string; value: number | string; cap?: number; tone?: StatTone }) {
  const num = typeof value === 'number' ? value : null
  const pct = cap && num != null ? Math.max(0, Math.min(100, (Math.abs(num) / cap) * 100)) : null
  const negative = (num ?? 0) < 0
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground/70">{label}</span>
        <span className={`text-sm font-bold tabular-nums ${tone ? STAT_TONE[tone] : 'text-foreground'}`}>
          {num != null && num >= 0 && cap != null ? `${num}` : value}{cap != null && num != null ? <span className="font-medium text-foreground/45"> / {cap}</span> : null}
        </span>
      </div>
      {pct != null && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
          <div className={`h-full rounded-full ${negative ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
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
  const bd = reputation?.breakdown
  const beh = reputation?.behavioral
  const owner = identity?.owner
  const seed = owner || identity?.tokenId?.toString() || query
  // The chain the identity was actually READ on decides the label, the fallback name and
  // the explorer link. This used to be a two-way ternary that sent every non-X-Layer agent
  // to Arcscan and called it "Arc testnet", so a Celo or Robinhood agent got the wrong name
  // and a dead link. An unknown slug shows itself and links nowhere rather than claiming a chain.
  const chain = identity?.chain ? CHAIN_BY_ID[identity.chain as ChainId] : undefined
  const chainLabel = chain ? `${chain.shortName} ${chain.testnet ? 'testnet' : 'mainnet'}` : identity?.chain
  const ownerUrl =
    owner && /^0x[0-9a-fA-F]{40}$/.test(owner) && chain?.explorer ? `${chain.explorer}/address/${owner}` : null
  const name =
    reputation?.name ||
    (identity && !identity.partial
      ? `Agent #${identity.tokenId}`
      : identity?.partial
      ? `${chain?.shortName ?? 'On-chain'} agent`
      : query)
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
              <Badge variant="success"><BadgeCheck size={12} /> ERC-8004</Badge>
            )}
            {reputation?.kya === 'revoked'
              ? <Badge variant="danger">KYA revoked</Badge>
              : reputation?.kya === 'verified'
              ? <Badge variant="neutral">KYA verified</Badge>
              : null}
            {(reputation?.sybil?.level === 'high' || reputation?.sybil?.level === 'medium') && (
              <Badge
                variant={reputation.sybil.level === 'high' ? 'danger' : 'warning'}
                title={`${reputation.sybil.selfDealt}/${reputation.sybil.jobs} jobs hired by its own operator`}
              >
                Sybil risk: {reputation.sybil.level}
              </Badge>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-xs text-foreground/60">
            {identity && !identity.partial && <span>#{identity.tokenId}</span>}
            {owner && <CopyAddr value={owner} href={ownerUrl} />}
            {chainLabel && (
              <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-[0.08em]">
                {chainLabel}
              </Badge>
            )}
            {identity?.partial && <span className="text-[11px] normal-case">identity held on-chain; search by token id for the full record</span>}
          </div>
        </div>
      </div>

      {/* reputation, credit-score style */}
      <div className="border-b border-border p-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground/70">Reputation</div>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <span className="text-[clamp(2.2rem,7vw,2.8rem)] font-semibold leading-none tracking-[-0.035em] tabular-nums text-foreground">{shownScore}</span>
              <span className="text-sm font-medium text-foreground/50">/ 1000</span>
              <span className={`ml-1 text-sm font-bold ${VERDICT_TEXT[verdict]}`}>{g.label}<span className="font-medium text-foreground/50"> · {g.tier}</span></span>
            </div>
          </div>
          <VerdictBadge verdict={verdict} size="md" />
        </div>
        <div className="mt-4"><Spectrum score={score} /></div>
        {reputation?.onchainAttestation && (
          <div className="mt-3.5 text-[11px]">
            <a href={reputation.onchainAttestation.txUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-accent hover:underline">
              Anchored on-chain · ERC-8004 ReputationRegistry
              <ArrowUpRight size={12} aria-hidden="true" />
            </a>
            <span className="text-foreground/60"> verify the score on-chain, not just here</span>
          </div>
        )}
      </div>

      {/* stats grid */}
      {reputation ? (
        <div className="grid gap-x-8 gap-y-0 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {bd && <StatRow label="Settlement" value={bd.settlement} cap={600} />}
          {bd && <StatRow label="Validation" value={bd.validation} cap={240} />}
          {bd && <StatRow label="Tenure" value={bd.tenure} cap={160} />}
          {bd && typeof bd.behavior === 'number' && <StatRow label="Behavior (jobs)" value={bd.behavior >= 0 ? `+${bd.behavior}` : String(bd.behavior)} tone={bd.behavior < 0 ? 'danger' : undefined} />}
          {beh && <StatRow label="Completed jobs" value={beh.completedJobs} />}
          {beh && <StatRow label="Contested" value={beh.contestedJobs} tone={beh.contestedJobs > 0 ? 'warn' : undefined} />}
          {beh && <StatRow label="Dispute rate" value={`${Math.round(beh.disputeRate * 100)}%`} tone={beh.disputeRate >= 0.3 ? 'danger' : undefined} />}
          {beh && <StatRow label="Avg rating" value={beh.avgRating != null ? `${beh.avgRating.toFixed(1)} / 5` : '·'} />}
          {typeof reputation.settledOnchain === 'number' && <StatRow label="Settled on-chain" value={`${reputation.settledOnchain}${reputation.settledUsd ? ` · $${reputation.settledUsd}` : ''}`} />}
        </div>
      ) : (
        <div className="p-5 text-sm text-foreground/50">On-chain identity resolved; no platform reputation for this agent yet.</div>
      )}

      <div className="border-t border-border px-5 py-3 text-[11px] leading-relaxed text-foreground/60">
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

/**
 * Guardrail standing, as a badge variant rather than a hex.
 *
 * The embeddable SVG badge (mcp/src/policy/badge.ts) paints from fixed hexes because it is
 * rendered for someone else's page and has no theme to read. In here the SAME meanings map
 * onto the semantic tokens: `enforced` and `enforced_with_flags` keep the exact light-mode
 * colours the SVG uses (--ok is #059669, --warn is #d97706) and gain a dark-mode value the
 * hexes never had. `configured` is the one shift, from the SVG's goldenrod to warn: the two
 * amber states are told apart by their LABEL text ("enforced, flagged" vs "configured"),
 * which is the channel that survives a colour-blind reader anyway.
 */
const GUARDRAIL_BADGE: Record<string, NonNullable<BadgeProps['variant']>> = {
  enforced: 'success',
  enforced_with_flags: 'warning',
  configured: 'warning',
  none: 'neutral',
  unavailable: 'neutral',
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

  usePageMeta({
    title: `Trust Explorer · ${APP_NAME}`,
    description:
      'Look up any agent by its ERC-8004 id and watch the verification run: on-chain identity, KYA attestation, reputation, and the verdict a payer would act on.',
    canonical: 'https://a-identity.xyz/explorer',
  })

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
            <h1 className="text-[clamp(1.75rem,4vw,2.35rem)] font-bold leading-[1.08] tracking-[-0.03em] text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>Agent Trust Explorer</h1>
            <p className="mt-2.5 text-[15px] font-medium leading-relaxed text-foreground/70">Resolve any agent&apos;s on-chain identity, reputation and verdict across the {IDENTITY_CHAIN_COUNT} chains that carry an ERC-8004 registry. No login, no mocks.</p>
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
                    <div className="mb-4 rounded-2xl border border-warn/35 bg-warn/[0.07] p-4">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
                        <div className="min-w-0">
                          <div className="text-sm font-bold text-foreground">This number is not unique</div>
                          <div className="mt-1 text-xs leading-relaxed text-foreground/70">{identity.ambiguity.note}</div>
                          <div className="mt-3 space-y-1.5">
                            {identity.ambiguity.matches.map((m) => (
                              <button
                                key={m.caip}
                                type="button"
                                onClick={() => { setQuery(m.caip); void lookup(m.caip, true) }}
                                className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-foreground/[0.03]"
                              >
                                <Badge variant="neutral" className="font-mono text-[10px] uppercase tracking-[0.08em]">
                                  {m.chain}
                                </Badge>
                                <span className="truncate font-mono text-[11px] text-foreground/70">{m.caip}</span>
                                <span className="ml-auto shrink-0 font-mono text-[11px] text-foreground/55">
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
              <SectionHead icon={Trophy} title="Most trusted agents" note="Live leaderboard, ranked by reputation" />
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                {board.length === 0 ? <LeaderboardSkeleton /> : <table className="w-full text-sm">
                  {/* Column headings, readable rather than decorative. They were 11px
                      micro-caps at 40% foreground, which on the light cream ground is below
                      any sane contrast floor: the columns had labels you could not read.
                      "Risk" is now "Verdict", because ALLOW is not a risk, it is the answer. */}
                  <thead>
                    <tr className="border-b border-border bg-foreground/[0.02] text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground/70">
                      <th scope="col" className="w-10 py-3 pl-4">#</th>
                      <th scope="col" className="py-3">Agent</th>
                      <th scope="col" className="hidden py-3 sm:table-cell">Reputation</th>
                      <th scope="col" className="hidden py-3 md:table-cell">Guardrails</th>
                      <th scope="col" className="py-3 pr-4 text-right">Verdict</th>
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
                          <td className="py-3 pl-4 text-sm font-semibold tabular-nums text-foreground/45">{i + 1}</td>
                          <td className="py-3 pr-3">
                            <div className="flex items-center gap-2.5">
                              <AgentAvatar seed={a.onchainAgentId || a.id} size={32} verdict={v.toLowerCase() as OwlVerdict} />
                              <div className="min-w-0">
                                <div className="truncate font-semibold text-foreground">{a.name}</div>
                                <div className="truncate font-mono text-[11px] text-foreground/55">{a.category}{a.onchainAgentId ? ` · #${a.onchainAgentId}` : ''}</div>
                              </div>
                            </div>
                          </td>
                          <td className="hidden py-3 sm:table-cell">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-foreground/[0.08]">
                                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(3, s / 10)}%` }} />
                              </div>
                              <span className="text-sm font-bold tabular-nums text-foreground">{s}</span>
                            </div>
                          </td>
                          {/* Guardrail standing, shown only for agents whose owner PUBLISHED
                              their badge. Opt-in from Phase 1.5, so an agent that has not
                              published shows nothing about its policy here. */}
                          <td className="hidden py-3 pr-3 md:table-cell">
                            {a.guardrails?.published ? (
                              <Badge variant={GUARDRAIL_BADGE[a.guardrails.level ?? 'none'] ?? 'neutral'}>
                                {a.guardrails.label ?? a.guardrails.level}
                              </Badge>
                            ) : (
                              <span className="text-[11px] font-medium text-foreground/55">not published</span>
                            )}
                          </td>
                          <td className="py-3 pr-4 text-right">
                            <VerdictBadge verdict={v} />
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
