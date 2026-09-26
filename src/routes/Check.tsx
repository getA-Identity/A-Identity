import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, ArrowUpRight, Check as CheckMark, CheckCircle2, ChevronDown, Info, Link2, Search, XCircle } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import CopyBlock from '../components/app/CopyBlock'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DisplayHeading } from '../components/ui/display'
import { apiFetch, readJson } from '../lib/api'
import { ago, short } from '../lib/format'
import { usePageMeta } from '../lib/head'
import { cn } from '../lib/utils'

/**
 * /check: paste an Algorand address (or an x402 service link) and see, in plain words,
 * whether it looks safe to pay. Built for someone we send a link to, not for a developer:
 * one input, one big answer, a few short reasons, the owl reacting to the verdict.
 *
 * The URL is the state. /check?q=<address or link> runs the check on load, a submit writes
 * ?q= back, and the back button returns to the previous answer, so every answer is a link
 * someone can forward. The first render never depends on ?q=, which keeps it identical to
 * the prerendered snapshot (the neutral empty state); the check starts in an effect after.
 *
 * The verdict itself is computed by the backend (GET /api/algorand/check). This page only
 * presents it and never upgrades or softens it.
 */

export type Verdict = 'safe' | 'careful' | 'dont_pay' | 'unknown'
export type Tone = 'good' | 'warn' | 'bad' | 'neutral'

export type CheckResult = {
  query: string
  address: string | null
  resolvedFrom: 'address' | 'domain' | 'url' | null
  name: string | null
  verdict: Verdict
  headline: string
  reasons: { tone: Tone; text: string }[]
  facts: {
    accountAgeDays: number | null
    canReceiveUsdc: boolean | null
    seller: {
      known: boolean
      settlements: number
      firstSeen: string | null
      lastSeen: string | null
      domain: string | null
      challengeRank: number | null
      volumeUsd: number | null
      blocked: { reason: string; since: string } | null
    } | null
    payers: { sampled: number; distinct: number; topPayerShare: number | null; sellerFundedShare: number | null } | null
  }
  explorerUrl: string | null
  checkedAt: string
  fullReport: { tool: string; priceUsd: number; url: string }
}

/** How one check ended. Kept apart so "bad input", "slow down" and "could not ask" read differently. */
export type CheckOutcome =
  | { kind: 'ok'; result: CheckResult }
  | { kind: 'bad_input'; message?: string }
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  | { kind: 'failed' }

/**
 * One-click examples under the input. An entry with an empty `q` is a slot waiting for a
 * real address and is not rendered, so a placeholder can never ship as a broken chip.
 */
const EXAMPLES: { label: string; q: string }[] = [
  { label: 'A listed x402 seller', q: 'onestepchess.xyz' },
  { label: 'A-Identity (us)', q: 'WHZ74ZGNGZGAVEQZTHESENVP5RTHMEQ4BOUKF7UHWOADQMKXDKAK3FESJE' },
  { label: 'A never-used address', q: 'V6F33WDMQUCBPA66AHPAWQPMMZ4PIPGYQH2EYL64KGVC6D6WVG3HG5IHG4' },
]

const AGENT_ENDPOINT = 'https://a-identity.xyz/api/x402/algorand/tools/pay_check'

const curlFor = (address: string) =>
  `curl -i -X POST ${AGENT_ENDPOINT} \\\n  -H 'content-type: application/json' \\\n  -d '{"address":"${address}"}'`

const VERDICTS: Verdict[] = ['safe', 'careful', 'dont_pay', 'unknown']

/** The body is someone else's code, written in parallel; anything off-shape is a failed check, not a guess. */
function isResult(x: unknown): x is CheckResult {
  const r = x as Partial<CheckResult> | null
  return (
    !!r &&
    typeof r.headline === 'string' &&
    VERDICTS.includes(r.verdict as Verdict) &&
    Array.isArray(r.reasons) &&
    typeof r.facts === 'object' &&
    r.facts !== null
  )
}

async function runCheck(q: string): Promise<CheckOutcome> {
  try {
    const res = await apiFetch(`/api/algorand/check?q=${encodeURIComponent(q)}`, { retries: 2, timeoutMs: 15_000 })
    // 400 is input we cannot read; 404 is a link with no Algorand seller behind it. Both carry
    // a sentence written for people, which beats ours. A bare "not found" is the route itself
    // missing (a deploy out of step), which is our failure, not the visitor's input.
    if (res.status === 400 || res.status === 404) {
      const { error } = await readJson<{ error?: unknown }>(res)
      const message = typeof error === 'string' && error.length <= 240 ? error : undefined
      if (res.status === 404 && (!message || /^not found\.?$/i.test(message))) return { kind: 'failed' }
      return { kind: 'bad_input', message }
    }
    if (res.status === 429) {
      const body = await readJson<{ retryAfterSeconds?: number }>(res)
      const header = Number(res.headers.get('retry-after'))
      const wait = typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : header > 0 ? header : undefined
      return { kind: 'rate_limited', retryAfterSeconds: wait }
    }
    if (!res.ok) return { kind: 'failed' }
    const body = await readJson(res)
    return isResult(body) ? { kind: 'ok', result: body } : { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}

// ---- The owl ----

type Mood = 'idle' | 'thinking' | 'happy' | 'cautious' | 'alarmed' | 'curious' | 'error'

/**
 * Existing renders only, no new art. The verdict owls are the soft owl with allow, warn and
 * deny eyes (the same three the deck uses for ALLOW / WARN / DENY); thinking and curious are
 * the plain soft owl with motion or a head tilt; a failed request gets the officer, which is
 * the brand's owl for "something went wrong".
 */
const OWLS: Record<Mood, { src: string; ring: string; tilt: number }> = {
  idle: { src: '/mascots/owl-soft.png', ring: 'bg-accent/10', tilt: 0 },
  thinking: { src: '/mascots/owl-soft.png', ring: 'bg-accent/15', tilt: 0 },
  happy: { src: '/mascots/owl-soft-allow.png', ring: 'bg-ok/15', tilt: 0 },
  cautious: { src: '/mascots/owl-soft-warn.png', ring: 'bg-warn/15', tilt: 0 },
  alarmed: { src: '/mascots/owl-soft-deny.png', ring: 'bg-danger/15', tilt: 0 },
  curious: { src: '/mascots/owl-soft.png', ring: 'bg-foreground/[0.06]', tilt: -9 },
  error: { src: '/mascots/owl-officer.png', ring: 'bg-foreground/[0.06]', tilt: 0 },
}

const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1]

function Owl({ mood }: { mood: Mood }) {
  const o = OWLS[mood]
  const thinking = mood === 'thinking'
  return (
    <div className="relative mx-auto h-28 w-28 sm:h-32 sm:w-32">
      <div className={cn('absolute inset-[4%] rounded-full transition-colors duration-500', o.ring)} />
      <AnimatePresence mode="wait" initial={false}>
        {/* Keyed by picture, not by mood: idle to thinking to curious is the same owl
            moving, and only a verdict swaps the render. */}
        <motion.img
          key={o.src}
          src={o.src}
          alt=""
          aria-hidden="true"
          width={128}
          height={128}
          decoding="async"
          draggable={false}
          className="relative h-full w-full select-none object-contain"
          initial={{ opacity: 0, scale: 0.88 }}
          animate={
            thinking
              ? { opacity: 1, scale: 1, y: [0, -5, 0], rotate: [-4, 4, -4] }
              : { opacity: 1, scale: 1, y: 0, rotate: o.tilt }
          }
          exit={{ opacity: 0, scale: 0.9 }}
          transition={
            thinking
              ? {
                  y: { duration: 1.1, repeat: Infinity, ease: 'easeInOut' },
                  rotate: { duration: 2.2, repeat: Infinity, ease: 'easeInOut' },
                  default: { duration: 0.3, ease: EASE },
                }
              : { duration: 0.4, ease: EASE }
          }
        />
      </AnimatePresence>
    </div>
  )
}

// ---- Presentation of one answer ----

const LOOK: Record<Verdict, { mood: Mood; text: string; band: string; border: string; fallback: string }> = {
  safe: { mood: 'happy', text: 'text-ok', band: 'bg-ok/[0.07]', border: 'border-ok/30', fallback: 'Looks safe to pay' },
  careful: { mood: 'cautious', text: 'text-warn', band: 'bg-warn/[0.08]', border: 'border-warn/35', fallback: 'Be careful' },
  dont_pay: { mood: 'alarmed', text: 'text-danger', band: 'bg-danger/[0.07]', border: 'border-danger/30', fallback: "Don't pay" },
  unknown: { mood: 'curious', text: 'text-foreground', band: 'bg-foreground/[0.03]', border: 'border-border', fallback: 'Not enough history yet' },
}

const TONE_ICON: Record<Tone, { Icon: typeof Info; cls: string; label: string }> = {
  good: { Icon: CheckCircle2, cls: 'text-ok', label: 'Good sign' },
  warn: { Icon: AlertTriangle, cls: 'text-warn', label: 'Warning' },
  bad: { Icon: XCircle, cls: 'text-danger', label: 'Problem' },
  neutral: { Icon: Info, cls: 'text-foreground/45', label: 'Note' },
}

const n = (v: number) => v.toLocaleString('en-US')
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`

/** "Aug 16", or "Aug 16, 2025" when it is not this year. UTC, so it is the same day for everyone. */
function day(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear()
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', timeZone: 'UTC' })
}

/** The facts row. Only what the backend actually knows: a null is left out, never shown as zero. */
function factsOf(r: CheckResult): string[] {
  const out: string[] = []
  const { accountAgeDays: age, payers, seller } = r.facts
  if (r.name) out.push(r.name)
  if (typeof age === 'number') out.push(age < 1 ? 'New on Algorand today' : `On Algorand for ${plural(age, 'day', 'days')}`)
  if (payers && typeof payers.distinct === 'number') {
    if (payers.distinct === 0) out.push('No payments found yet')
    else out.push(payers.distinct === 1 ? 'Paid by 1 wallet' : `Paid by ${n(payers.distinct)} different wallets`)
  }
  if (seller?.known && seller.settlements > 0) {
    const since = seller.firstSeen ? day(seller.firstSeen) : null
    out.push(`${plural(seller.settlements, 'x402 payment', 'x402 payments')}${since ? ` since ${since}` : ''}`)
  }
  return out
}

function Who({ r }: { r: CheckResult }) {
  if (!r.address) return <p className="mt-2 break-all font-mono text-sm text-foreground/55">{short(r.query, 6)}</p>
  return (
    <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 text-sm text-foreground/60">
      {r.resolvedFrom === 'url' && <span>This link pays</span>}
      <span className="font-mono" title={r.address}>
        {short(r.address, 6)}
      </span>
    </p>
  )
}

function Reasons({ reasons }: { reasons: CheckResult['reasons'] }) {
  const [all, setAll] = useState(false)
  const shown = all ? reasons : reasons.slice(0, 3)
  const hidden = reasons.length - shown.length
  return (
    <div>
      <ul className="space-y-3">
        {shown.map((r, i) => {
          const t = TONE_ICON[r.tone] ?? TONE_ICON.neutral
          return (
            <li key={i} className="flex gap-3 text-[15px] leading-snug text-foreground/85">
              <t.Icon size={18} className={cn('mt-0.5 shrink-0', t.cls)} aria-label={t.label} role="img" />
              <span>{r.text}</span>
            </li>
          )
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-3 text-sm font-semibold text-accent hover:underline"
        >
          Show {hidden} more
        </button>
      )}
    </div>
  )
}

function CopyLink({ q }: { q: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    const link = `${window.location.origin}/check?q=${encodeURIComponent(q)}`
    void navigator.clipboard?.writeText(link).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      },
      () => {},
    )
  }
  return (
    <Button type="button" variant="outline" size="sm" onClick={copy}>
      {copied ? <CheckMark size={14} className="text-ok" /> : <Link2 size={14} />}
      {copied ? 'Link copied' : 'Copy link'}
    </Button>
  )
}

// ---- The answer card: one surface for every state, so the owl reacts in place ----

type View =
  | { s: 'idle' }
  | { s: 'loading'; q: string }
  | { s: 'done'; q: string; outcome: CheckOutcome }

function moodOf(view: View): Mood {
  if (view.s === 'idle') return 'idle'
  if (view.s === 'loading') return 'thinking'
  const o = view.outcome
  if (o.kind === 'ok') return LOOK[o.result.verdict].mood
  return o.kind === 'failed' ? 'error' : 'curious'
}

function errorText(o: Exclude<CheckOutcome, { kind: 'ok' }>): string {
  if (o.kind === 'bad_input') return o.message ?? 'That does not look like an Algorand address or a service link.'
  if (o.kind === 'rate_limited') {
    const s = o.retryAfterSeconds
    return `Too many checks in a row. Try again in ${s && s > 0 ? plural(Math.ceil(s), 'second', 'seconds') : 'a minute'}.`
  }
  return 'We could not finish the check just now. Try again in a few seconds.'
}

function Answer({ view, onRetry }: { view: View; onRetry: (q: string) => void }) {
  const [slow, setSlow] = useState(false)
  const loadingQ = view.s === 'loading' ? view.q : null
  useEffect(() => {
    setSlow(false)
    if (loadingQ === null) return
    const id = window.setTimeout(() => setSlow(true), 8000)
    return () => window.clearTimeout(id)
  }, [loadingQ])

  const result = view.s === 'done' && view.outcome.kind === 'ok' ? view.outcome.result : null
  const look = result ? LOOK[result.verdict] : null
  const facts = result ? factsOf(result) : []

  return (
    <section
      aria-live="polite"
      aria-busy={view.s === 'loading'}
      // Inter's contextual alternates turn the x in "57 x402" into a multiplication sign.
      style={{ fontFeatureSettings: '"calt" 0' }}
      className={cn(
        'overflow-hidden rounded-3xl border bg-card transition-colors duration-500',
        look ? look.border : 'border-border',
        view.s === 'idle' && 'border-dashed',
      )}
    >
      <div className={cn('px-5 pb-6 pt-7 text-center transition-colors duration-500 sm:px-8', look?.band)}>
        <Owl mood={moodOf(view)} />

        {view.s === 'idle' && <p className="mt-4 text-[15px] text-foreground/60">Your answer will show up here.</p>}

        {view.s === 'loading' && (
          <p className="mt-4 text-[15px] font-medium text-foreground/75">
            {slow ? 'Still checking. This can take a few more seconds.' : 'Checking the Algorand ledger...'}
          </p>
        )}

        {view.s === 'done' && view.outcome.kind !== 'ok' && (
          <p className="mx-auto mt-4 max-w-[34ch] text-base font-medium text-foreground/80">{errorText(view.outcome)}</p>
        )}

        {result && look && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }}>
            <h2
              className={cn('mt-4 text-[clamp(1.9rem,7vw,2.6rem)] font-bold leading-[1.05] tracking-[-0.02em]', look.text)}
              style={{ fontFamily: 'var(--font-heading)', textWrap: 'balance' }}
            >
              {result.headline || look.fallback}
            </h2>
            <Who r={result} />
          </motion.div>
        )}
      </div>

      {view.s === 'loading' && (
        <div className="space-y-3 border-t border-border px-5 py-5 sm:px-8" aria-hidden="true">
          {[80, 64, 72].map((w) => (
            <div key={w} className="h-4 animate-pulse rounded bg-foreground/[0.07]" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}

      {view.s === 'done' && (view.outcome.kind === 'failed' || view.outcome.kind === 'rate_limited') && (
        <div className="border-t border-border px-5 py-4 text-center sm:px-8">
          <Button type="button" variant="outline" size="sm" onClick={() => onRetry(view.q)}>
            Try again
          </Button>
        </div>
      )}

      {result && view.s === 'done' && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="border-t border-border px-5 py-5 sm:px-8"
        >
          {result.reasons.length > 0 && <Reasons key={view.q} reasons={result.reasons} />}

          {facts.length > 0 && (
            <ul className="mt-5 flex flex-wrap gap-2">
              {facts.map((f) => (
                <li key={f} className="rounded-full border border-border bg-background px-3 py-1 text-[13px] text-foreground/70">
                  {f}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            {result.explorerUrl ? (
              <a
                href={result.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-semibold text-accent hover:underline"
              >
                View on explorer <ArrowUpRight size={14} />
              </a>
            ) : (
              <span />
            )}
            <CopyLink q={view.q} />
          </div>
        </motion.div>
      )}
    </section>
  )
}

// ---- Collapsed explainers ----

const RULES: { tone: Tone; label: string; text: string }[] = [
  {
    tone: 'bad',
    label: "Don't pay",
    text: 'the x402 facilitator has blocked this seller, the address cannot receive USDC so a payment would fail, or the address does not exist on Algorand.',
  },
  {
    tone: 'warn',
    label: 'Be careful',
    text: 'the account is less than 7 days old, most of the USDC it received came from wallets linked to it (wallets it created, or the wallet that created it), or a single wallet made most of its payments.',
  },
  {
    tone: 'good',
    label: 'Looks safe',
    text: 'none of the above, the account is at least 30 days old, and at least 3 different wallets have paid it.',
  },
  { tone: 'neutral', label: 'Everything else', text: 'not enough history yet.' },
]

function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group border-b border-border last:border-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15px] font-semibold text-foreground sm:px-6 [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown size={18} className="shrink-0 text-foreground/50 transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <div className="px-5 pb-5 sm:px-6">{children}</div>
    </details>
  )
}

// ---- Page ----

export default function Check() {
  usePageMeta({
    title: 'Before you pay: check an Algorand address | A-Identity',
    description:
      'Paste an Algorand address or an x402 service link and see in seconds whether it looks safe to pay. Read live from the Algorand ledger and public x402 records.',
    canonical: 'https://a-identity.xyz/check',
  })

  const [params, setParams] = useSearchParams()
  const urlQ = (params.get('q') ?? '').trim()
  const [input, setInput] = useState('')
  const [view, setView] = useState<View>({ s: 'idle' })
  const seq = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const run = useCallback(async (q: string) => {
    const id = ++seq.current
    setView({ s: 'loading', q })
    const outcome = await runCheck(q)
    // A newer check (or a navigation back to the empty page) wins over a slow older one.
    if (id !== seq.current) return
    setView({ s: 'done', q, outcome })
  }, [])

  // Deep links, submits and the back button all arrive here.
  useEffect(() => {
    if (!urlQ) {
      seq.current++
      setInput('')
      setView({ s: 'idle' })
      return
    }
    setInput(urlQ)
    void run(urlQ)
  }, [urlQ, run])

  const submit = (raw: string) => {
    const q = raw.trim()
    if (!q) {
      inputRef.current?.focus()
      return
    }
    setInput(q)
    // Closes the phone keyboard so the answer is not hidden behind it.
    inputRef.current?.blur()
    if (q === urlQ) void run(q)
    else
      setParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('q', q)
        return next
      })
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    submit(input)
  }

  const examples = EXAMPLES.filter((e) => e.q)
  const result = view.s === 'done' && view.outcome.kind === 'ok' ? view.outcome.result : null
  const agentPrice = result?.fullReport?.priceUsd ?? 0.01

  return (
    <ThemeScope surface="background" className="flex min-h-screen w-full flex-col" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />
      <main className="w-full flex-1 px-4 pb-16 pt-10 sm:px-8 sm:pb-24 sm:pt-16">
        <div className="mx-auto w-full max-w-[640px]">
          <div className="text-center">
            <DisplayHeading size="section" as="h1">
              Before you pay
            </DisplayHeading>
            <p
              className="mx-auto mt-3 max-w-[46ch] text-[17px] leading-relaxed text-foreground/70 sm:text-lg"
              style={{ textWrap: 'balance' }}
            >
              Paste an Algorand address or service link to see if it looks safe to pay.
            </p>
          </div>

          <form onSubmit={onSubmit} className="mt-7 flex gap-2" role="search">
            <div className="relative min-w-0 flex-1">
              <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground/40" />
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                aria-label="Algorand address or service link"
                placeholder="Address or service link"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                maxLength={512}
                className="h-12 rounded-xl pl-10 text-base"
              />
            </div>
            <Button type="submit" shape="rounded" className="h-12 px-5 text-[15px]" disabled={view.s === 'loading'}>
              Check
            </Button>
          </form>

          {examples.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-foreground/55">
              Try
              {examples.map((ex) => (
                <button
                  key={ex.q}
                  type="button"
                  onClick={() => submit(ex.q)}
                  className="rounded-full border border-border px-3 py-1 font-semibold text-foreground/70 transition-colors hover:border-accent/50 hover:text-foreground"
                >
                  {ex.label}
                </button>
              ))}
            </div>
          )}

          <div className="mt-8">
            <Answer view={view} onRetry={(q) => void run(q)} />
            {view.s === 'done' && result && (
              <p className="mt-3 text-center text-xs text-foreground/50">Read live from the Algorand ledger, {ago(result.checkedAt)}.</p>
            )}
          </div>

          <div className="mt-10 overflow-hidden rounded-2xl border border-border bg-card">
            <Fold title="How we decide">
              <ul className="space-y-3">
                {RULES.map((r) => {
                  const t = TONE_ICON[r.tone]
                  return (
                    <li key={r.label} className="flex gap-3 text-[15px] leading-snug text-foreground/80">
                      <t.Icon size={18} className={cn('mt-0.5 shrink-0', t.cls)} aria-hidden="true" />
                      <span>
                        <span className="font-semibold text-foreground">{r.label}:</span> {r.text}
                      </span>
                    </li>
                  )
                })}
              </ul>
              <p className="mt-4 text-sm leading-relaxed text-foreground/60">
                All of it is read live from public data: the Algorand ledger and the x402 facilitator's public records.
              </p>
            </Fold>
            <Fold title="For agents">
              <p className="text-[15px] leading-relaxed text-foreground/75">
                An AI agent can ask the same question for {agentPrice} USDC per call, paid over x402 on Algorand.
              </p>
              <div className="mt-4">
                <CopyBlock
                  title="Ask from an agent"
                  subtitle="Answers 402 with the payment terms"
                  text={curlFor(result?.address ?? '<ALGORAND_ADDRESS>')}
                />
              </div>
            </Fold>
          </div>
        </div>
      </main>
      <SiteFooter />
    </ThemeScope>
  )
}
