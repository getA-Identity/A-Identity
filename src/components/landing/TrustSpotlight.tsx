import { useEffect, useReducer, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Sparkles, Search, X, ArrowUpRight, ArrowRight, ShieldCheck, Wallet, QrCode, Check, Loader2 } from 'lucide-react'
import { resolveAgent, getReputation, getLeaderboard, type AgentIdentity, type Reputation, type FeedAgent } from '../../lib/mcp-client'
import { useAuth } from '../../store/auth'
import { EASE_OUT_EXPO } from '../../lib/brand'
import AgentAvatar from '../AgentAvatar'
import { type OwlVerdict } from '../OwlMark'
import { connectWalletConnect, getInjectedWallets, refreshInjectedWallets, walletConnectEnabled, type WalletOption, type Eip1193 } from '../../lib/wallets'

/*
 * TrustSpotlight, the ⌘K / FAB popup, now a self-contained two-tab flow:
 *
 *   Verify  , look up any agent and read its trust INLINE (identity, KYA, score, verdict).
 *              Detail lives in the explorer; a gentle nudge offers "is this yours? claim it".
 *   Onboard , prove you own an agent by connecting its wallet and signing once. This is the
 *              whole quick-onboarding: no gas, no signup; the console handles the details after.
 *
 * Opens on ⌘K, the FAB, or a window 'open-trust-spotlight' event. Status hues match /explorer.
 */

const ACCENT = '#7342E2'
const RISK = { ALLOW: '#059669', WARN: '#d97706', DENY: '#dc2626' } as const
type Verdict = keyof typeof RISK
const riskOf = (s: number, kya?: string, verified = true): Verdict => (kya === 'revoked' || !verified || s < 200 ? 'DENY' : s < 500 ? 'WARN' : 'ALLOW')
const gradeOf = (s: number) =>
  s >= 800 ? 'Excellent' : s >= 650 ? 'Strong' : s >= 500 ? 'Good' : s >= 350 ? 'Fair' : s >= 200 ? 'Weak' : 'High risk'
const shorten = (a?: string | null) => (a && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a ?? '')
const isAddr = (s?: string | null) => !!s && /^0x[0-9a-fA-F]{40}$/.test(s.trim())

function useCountUp(target: number, duration = 800) {
  const [val, setVal] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    const start = performance.now(), begin = from.current
    let raf = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / duration)
      setVal(Math.round(begin + (target - begin) * (1 - Math.pow(1 - t, 3))))
      if (t < 1) raf = requestAnimationFrame(tick); else from.current = target
    })
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return val
}

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '')

type Result = { identity: AgentIdentity | null; reputation: Reputation | null } | null

function ResultCard({ result, q, onOpen, onClaim }: { result: NonNullable<Result>; q: string; onOpen: () => void; onClaim: () => void }) {
  const { identity, reputation } = result
  const verified = Boolean(identity) || reputation?.onchain === 'registered'
  const score = reputation?.score ?? 0
  const shown = useCountUp(score)
  const v = riskOf(score, reputation?.kya, verified)
  const name = reputation?.name || (identity && !identity.partial ? `Agent #${identity.tokenId}` : identity?.partial ? 'On-chain agent' : q)
  const seed = identity?.owner || identity?.tokenId?.toString() || q
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="flex flex-col gap-4 rounded-xl border border-border bg-background/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar seed={seed} size={54} verdict={v.toLowerCase() as OwlVerdict} />
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-foreground">{name}</div>
            <div className="truncate font-mono text-[11px] text-foreground/45">
              {identity && !identity.partial ? `#${identity.tokenId}` : shorten(identity?.owner || q)}{identity?.owner ? ` · ${shorten(identity.owner)}` : ''} · KYA {reputation?.kya ?? '·'}
            </div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-bold" style={{ color: RISK[v], background: `${RISK[v]}14`, boxShadow: `inset 0 0 0 1px ${RISK[v]}33` }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: RISK[v] }} /> {v}
        </span>
      </div>
      {reputation && (
        <div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-3xl font-bold tabular-nums tracking-tight text-foreground">{shown}</span>
            <span className="font-mono text-xs text-foreground/35">/ 1000</span>
            <span className="ml-auto text-xs font-semibold" style={{ color: RISK[v] }}>{gradeOf(score)}</span>
          </div>
          <div className="mt-2.5 h-2 w-full rounded-full" style={{ background: 'linear-gradient(90deg,#dc2626,#d97706 45%,#059669)' }}>
            <div className="relative h-full">
              <motion.span className="absolute -top-1 h-4 w-[3px] -translate-x-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_var(--color-card)]"
                initial={{ left: 0 }} animate={{ left: `${Math.max(0, Math.min(100, score / 10))}%` }} transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }} />
            </div>
          </div>
        </div>
      )}
      {/* actions: claim (primary nudge) + open full profile (detail) */}
      <div className="flex items-center gap-2 border-t border-border pt-3">
        <button onClick={onClaim} className="inline-flex items-center gap-1.5 rounded-lg bg-accent/10 px-3 py-2 text-xs font-semibold text-accent transition-colors hover:bg-accent/15">
          <ShieldCheck size={14} /> Is this yours? Claim it
        </button>
        <button onClick={onOpen} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-foreground/50 transition-colors hover:text-foreground">
          Full profile <ArrowUpRight size={13} />
        </button>
      </div>
    </motion.div>
  )
}

/** The Onboard tab: connect the owning wallet + sign once. Completes here.
 *  When reached from a specific lookup, `claimAddress` is the agent wallet the user is
 *  claiming, shown for context and softly checked against the wallet they connect. */
function OnboardPanel({ onClose, claimAddress }: { onClose: () => void; claimAddress?: string | null }) {
  const navigate = useNavigate()
  const loginWallet = useAuth((s) => s.loginWallet)
  const verified = useAuth((s) => s.verified)
  const [wallets, setWallets] = useState<WalletOption[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [mismatch, setMismatch] = useState<string | null>(null)

  const claiming = isAddr(claimAddress)

  useEffect(() => {
    refreshInjectedWallets()
    setWallets(getInjectedWallets())
    const t = setTimeout(() => setWallets(getInjectedWallets()), 150)
    return () => clearTimeout(t)
  }, [])

  const connect = async (getProvider: () => Eip1193 | Promise<Eip1193>, id: string) => {
    setBusy(id); setError(null); setMismatch(null)
    try {
      const provider = await getProvider()
      await loginWallet(provider)
      // Soft ownership check: if the user looked up a specific agent address, warn (do not
      // block) when the wallet they connected is not that address.
      if (claiming) {
        try {
          const accts = (await provider.request({ method: 'eth_accounts' })) as string[]
          const connected = accts?.[0]?.toLowerCase()
          if (connected && connected !== claimAddress!.trim().toLowerCase()) setMismatch(connected)
        } catch { /* best-effort; never blocks the flow */ }
      }
      setDone(true)
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Connection failed.') }
    finally { setBusy(null) }
  }

  const goApp = () => { onClose(); navigate('/app') }

  if (done || verified) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="p-6 text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
          <Check size={24} />
        </span>
        <h3 className="mt-4 text-lg font-bold text-foreground">You are verified.</h3>
        <p className="mx-auto mt-1.5 max-w-xs text-sm leading-relaxed text-foreground/55">
          Wallet control proven. Your agent identity is ready. Finish the details, register, set spend limits, in your console.
        </p>
        {mismatch && (
          <p className="mx-auto mt-3 max-w-sm rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
            Heads up: you connected <span className="font-mono">{shorten(mismatch)}</span>, which does not match the agent address you looked up (<span className="font-mono">{shorten(claimAddress)}</span>). This wallet onboards as its own identity. To claim that specific agent, connect the wallet that owns it.
          </p>
        )}
        <button onClick={goApp} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90">
          Open your console <ArrowRight size={15} />
        </button>
      </motion.div>
    )
  }

  const wcOn = walletConnectEnabled()
  const nothing = wallets.length === 0 && !wcOn
  return (
    <div className="p-4">
      {/* three-step hint */}
      <div className="mb-4 flex items-center gap-2 px-1 font-mono text-[11px] text-foreground/40">
        <span className="text-accent">connect</span>
        <ArrowRight size={11} />
        <span>sign once</span>
        <ArrowRight size={11} />
        <span>verified</span>
        <span className="ml-auto normal-case tracking-normal text-foreground/35">no gas · no signup</span>
      </div>

      {claiming && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-border bg-background/40 px-3 py-2.5">
          <AgentAvatar seed={claimAddress!} size={32} />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground">Claiming this agent</div>
            <div className="truncate font-mono text-[11px] text-foreground/45">{shorten(claimAddress)}</div>
          </div>
        </div>
      )}

      <p className="mb-4 px-1 text-sm leading-relaxed text-foreground/60">
        {claiming
          ? 'Connect the wallet that owns this agent and sign a one-time message to prove control.'
          : 'Claim your agent: connect the wallet that owns it and sign a one-time message to prove control.'}
      </p>

      {nothing ? (
        <p className="px-1 py-4 text-sm text-foreground/55">
          No wallet detected. Install{' '}
          <a className="font-semibold text-accent hover:underline" href="https://metamask.io/download" target="_blank" rel="noreferrer">MetaMask</a>{' '}
          and reopen this.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {wallets.map((w) => (
            <button key={w.id} onClick={() => w.provider && connect(() => w.provider!, w.id)} disabled={!!busy}
              className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 text-left transition-colors hover:border-accent/50 disabled:opacity-50">
              {w.icon ? <img src={w.icon} alt="" className="h-7 w-7 rounded-lg" /> : <Wallet size={20} className="text-foreground/50" />}
              <span className="flex-1 text-sm font-semibold text-foreground">{w.name}</span>
              {busy === w.id ? <Loader2 size={15} className="animate-spin text-foreground/45" /> : <ArrowRight size={15} className="text-foreground/30" />}
            </button>
          ))}
          {wcOn && (
            <button onClick={() => connect(() => connectWalletConnect(), 'wc')} disabled={!!busy}
              className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 text-left transition-colors hover:border-accent/50 disabled:opacity-50">
              <QrCode size={20} className="text-[#3b99fc]" />
              <span className="flex-1 text-sm font-semibold text-foreground">WalletConnect <span className="text-foreground/40">(mobile)</span></span>
              {busy === 'wc' ? <Loader2 size={15} className="animate-spin text-foreground/45" /> : <ArrowRight size={15} className="text-foreground/30" />}
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-3 px-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}

export default function TrustSpotlight() {
  const navigate = useNavigate()
  const [open, toggle] = useReducer((o: boolean, next?: boolean) => (typeof next === 'boolean' ? next : !o), false)

  // The FAB is expanded at the top of the page, where it is introducing itself, and collapses
  // to its icon once the reader has started reading. Hover and focus re-open it, so the label
  // is one intention away rather than gone.
  const [scrolled, setScrolled] = useState(false)
  const [fabHover, setFabHover] = useState(false)
  const reducedMotion = useReducedMotion() ?? false
  const fabExpanded = !scrolled || fabHover

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 420)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  const [tab, setTab] = useState<'verify' | 'onboard'>('verify')
  const [claimAddress, setClaimAddress] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<Result>(null)
  const [featured, setFeatured] = useState<FeedAgent[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); toggle() }
      else if (e.key === 'Escape') toggle(false)
    }
    const onOpen = () => { setTab('verify'); setClaimAddress(null); toggle(true) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('open-trust-spotlight', onOpen)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('open-trust-spotlight', onOpen) }
  }, [])

  useEffect(() => {
    if (!open) return
    if (tab === 'verify') setTimeout(() => inputRef.current?.focus(), 40)
    if (!featured.length) void getLeaderboard().then((r) => { if (r.ok) setFeatured(r.data.filter((a) => (a.reputation?.score ?? 0) > 0).slice(0, 5)) })
  }, [open, tab, featured.length])

  useEffect(() => {
    const term = q.trim()
    if (!term) { setResult(null); setLoading(false); return }
    setLoading(true)
    const t = setTimeout(async () => {
      const [idRes, repRes] = await Promise.all([resolveAgent(term), getReputation(term)])
      const identity = idRes.ok && idRes.data.found ? (idRes.data.agent ?? null) : null
      const reputation = repRes.ok && repRes.data.found ? (repRes.data.reputation ?? null) : null
      setResult(identity || reputation ? { identity, reputation } : null)
      setLoading(false)
    }, 350)
    return () => clearTimeout(t)
  }, [q])

  const goExplorer = (term?: string) => { toggle(false); navigate(`/explorer${term ? `?q=${encodeURIComponent(term)}` : ''}`) }
  /** Bridge from a lookup into the claim/onboard flow, carrying the looked-up address. */
  const startClaim = (addr?: string) => { setClaimAddress(addr && addr.trim() ? addr.trim() : null); setTab('onboard') }
  const kbd = isMac ? '⌘K' : 'Ctrl K'

  const TabBtn = ({ id, label }: { id: 'verify' | 'onboard'; label: string }) => (
    <button onClick={() => { if (id === 'onboard') setClaimAddress(null); setTab(id) }} className={`relative px-1.5 pb-2.5 pt-1 text-sm font-semibold text-foreground transition-opacity ${tab === id ? 'opacity-100' : 'opacity-50 hover:opacity-80'}`}>
      {label}
      {tab === id && <motion.span layoutId="spotlight-tab" className="absolute inset-x-0 -bottom-px h-0.5 rounded-full" style={{ background: ACCENT }} />}
    </button>
  )

  return (
    <>
      <AnimatePresence>
        {!open && (
          <motion.button
            key="fab" onClick={() => { setTab('verify'); setClaimAddress(null); toggle(true) }} aria-label="Verify an agent"
            onHoverStart={() => setFabHover(true)} onHoverEnd={() => setFabHover(false)}
            onFocus={() => setFabHover(true)} onBlur={() => setFabHover(false)}
            initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }}
            whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.94 }}
            /* h-11 + 13px side padding + the 18px icon = a 44px circle when collapsed,
               the exact size of the back-to-top button above it. The label's own left
               padding replaces the flex gap so a hidden label adds zero width. */
            className="group fixed bottom-6 right-6 z-40 flex h-11 items-center justify-center rounded-full px-[13px] text-white shadow-[0_12px_40px_-8px_rgba(115,66,226,0.6)]"
            style={{ background: `linear-gradient(135deg, ${ACCENT}, #4f2bb0)` }}
          >
            {/* The ring introduces the button and then stops. A pulse that never ends is not
                an invitation, it is a nag, and it keeps a compositor layer awake for the whole
                session. It also goes quiet once the button has collapsed, because by then the
                reader has scrolled past the moment it was asking for. */}
            {fabExpanded && !reducedMotion && (
              <span className="pointer-events-none absolute inset-0 rounded-full">
                <motion.span className="absolute inset-0 rounded-full" style={{ border: `1px solid ${ACCENT}` }}
                  animate={{ scale: [1, 1.5], opacity: [0.6, 0] }}
                  transition={{ duration: 2, repeat: 3, ease: 'easeOut' }} />
              </span>
            )}
            <Sparkles size={18} className="relative shrink-0" />
            {/*
              Collapses to the icon once the reader scrolls, and re-opens on hover or focus.
              Expanded it is roughly 200px of fixed overlay parked in the bottom-right corner,
              which sits on top of whatever a long section happens to put there. Animating
              max-width rather than width keeps the label in the DOM, so the accessible name
              and the keyboard hint never depend on the visual state.
            */}
            <motion.span
              className="relative hidden items-center gap-2 overflow-hidden whitespace-nowrap sm:flex"
              initial={false}
              animate={{ maxWidth: fabExpanded ? 200 : 0, opacity: fabExpanded ? 1 : 0 }}
              transition={{ duration: 0.28, ease: EASE_OUT_EXPO }}
            >
              <span className="pl-2.5 text-sm font-semibold">Verify an agent</span>
              <kbd className="rounded bg-white/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold">{kbd}</kbd>
            </motion.span>
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            // Keyed for AnimatePresence. Without it the exiting subtree was left mounted at
            // opacity 0 with pointer-events still on, so once the spotlight had been closed
            // an invisible full-screen overlay swallowed every click on the page. That is the
            // bug this key fixes; `pointer-events-none` below is the belt to its braces, since
            // a stuck exit should never be able to take the site down again.
            key="spotlight"
            className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]"
            initial={{ opacity: 0, visibility: 'visible' }} animate={{ opacity: 1, visibility: 'visible' }}
            // The exiting subtree is a snapshot: it never re-renders, so nothing driven off
            // React state (an aria-hidden, a conditional class) can change once the exit has
            // begun. The only channel that still works is the animation itself, so the exit
            // carries all three: pointer-events off immediately, and visibility flipped when
            // the fade completes, which also drops the lingering dialog out of the
            // accessibility tree if the node overstays.
            exit={{ opacity: 0, pointerEvents: 'none', transitionEnd: { visibility: 'hidden' } }}>
            <motion.div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={() => toggle(false)}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            <motion.div role="dialog" aria-modal="true" aria-label="Trust lookup and onboarding"
              initial={{ opacity: 0, scale: 0.97, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, y: -6 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              className="relative w-full max-w-[560px] overflow-hidden rounded-2xl border border-border bg-card shadow-[0_40px_120px_-20px_rgba(10,15,25,0.6)]">

              {/* tabbar */}
              <div className="flex items-center gap-5 border-b border-border px-4 pt-3">
                <TabBtn id="verify" label="Verify an agent" />
                <TabBtn id="onboard" label="Claim yours" />
                <button onClick={() => toggle(false)} aria-label="Close" className="ml-auto mb-2 rounded-md p-1 text-foreground/40 hover:bg-foreground/5 hover:text-foreground"><X size={16} /></button>
              </div>

              {tab === 'verify' ? (
                <>
                  <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
                    <Search size={18} className="shrink-0 text-foreground/40" />
                    <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
                      placeholder="Verify an agent by token id or 0x address"
                      className="w-full bg-transparent font-mono text-sm text-foreground outline-none placeholder:font-sans placeholder:text-foreground/40" />
                  </div>
                  <div className="max-h-[52vh] overflow-y-auto p-4">
                    {loading && <div className="flex items-center gap-2 px-1 py-6 text-sm text-foreground/45"><span className="h-3 w-3 animate-spin rounded-full border-2 border-foreground/20 border-t-accent" /> Reading the chain…</div>}
                    {!loading && result && <ResultCard result={result} q={q.trim()} onOpen={() => goExplorer(q.trim())} onClaim={() => startClaim(result.identity?.owner || q.trim())} />}
                    {!loading && !result && q.trim() && (
                      <div className="flex flex-col gap-3 px-1 py-4">
                        <p className="text-sm text-foreground/55">
                          No verified agent found for <span className="font-mono text-foreground/70">{shorten(q.trim())}</span>. It may not be registered on A-Identity yet.
                        </p>
                        <button onClick={() => startClaim(q.trim())}
                          className="inline-flex items-center gap-2 self-start rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90">
                          <ShieldCheck size={15} /> Are you the owner? Claim this agent
                        </button>
                        <p className="text-xs text-foreground/40">
                          Or try a demo token id like <button onClick={() => setQ('849980')} className="font-mono text-accent hover:underline">849980</button>.
                        </p>
                      </div>
                    )}
                    {!loading && !q.trim() && (
                      <div>
                        <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-foreground/40">Featured agents</div>
                        <div className="flex flex-col">
                          {(featured.length ? featured : []).map((a) => {
                            const s = a.reputation?.score ?? 0, v = riskOf(s, a.kya)
                            return (
                              <button key={a.id} onClick={() => setQ(a.onchainAgentId || a.id)}
                                className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-foreground/[0.04]">
                                <AgentAvatar seed={a.onchainAgentId || a.id} size={34} verdict={v.toLowerCase() as OwlVerdict} />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-medium text-foreground">{a.name}</div>
                                  <div className="truncate font-mono text-[11px] text-foreground/40">{a.category}{a.onchainAgentId ? ` · #${a.onchainAgentId}` : ''}</div>
                                </div>
                                <span className="font-mono text-xs font-semibold tabular-nums text-foreground/70">{s}</span>
                                <span className="h-1.5 w-1.5 rounded-full" style={{ background: RISK[v] }} />
                              </button>
                            )
                          })}
                          {!featured.length && Array.from({ length: 4 }).map((_, i) => (
                            <div key={i} className="flex items-center gap-3 px-2 py-2.5">
                              <div className="h-[30px] w-[30px] animate-pulse rounded-lg bg-foreground/[0.08]" />
                              <div className="flex-1 space-y-1.5"><div className="h-3 w-28 animate-pulse rounded bg-foreground/[0.08]" /><div className="h-2.5 w-16 animate-pulse rounded bg-foreground/[0.08]" /></div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-[11px] text-foreground/45">
                    <span>Results are live on-chain reads. No login to look up.</span>
                    <span className="inline-flex items-center gap-1.5"><kbd className="rounded border border-border px-1.5 py-0.5 font-mono">Esc</kbd> close</span>
                  </div>
                </>
              ) : (
                <OnboardPanel onClose={() => toggle(false)} claimAddress={claimAddress} />
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
