import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  ArrowUpRight,
  Check as CheckMark,
  CheckCircle2,
  ChevronDown,
  FileText,
  Info,
  Link2,
  Loader2,
  Lock,
  QrCode,
  Search,
  Wallet,
  X,
  XCircle,
} from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import CopyBlock from '../components/app/CopyBlock'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DisplayHeading } from '../components/ui/display'
import { apiFetch, readJson } from '../lib/api'
import { ALGORAND_WALLETS, algorandWalletError, connectAlgorand, signAlgorandGroup, type AlgorandWalletId } from '../lib/algorand/wallet'
import {
  PAY_CHECK_PATH,
  PayRefusal,
  accountUrl,
  buildGroup,
  buildHeader,
  fetchFeePayer,
  fetchParams,
  fetchQuote,
  fetchUsdcHolding,
  formatUsd,
  formatUsdc,
  fundsProblem,
  submitPayment,
  txUrl,
  type PaidReport,
  type Poster,
  type Quote,
} from '../lib/algorand/x402pay'
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

// ---- The detailed report: bought from the visitor's own Algorand wallet ----

/** The paid endpoint, reached the way every other call on this page is. One send, never retried. */
const postReport: Poster = (body, headers) => apiFetch(PAY_CHECK_PATH, { method: 'POST', body, headers, timeoutMs: 120_000 })

/** A bought report, kept for this tab so a reload or a detour does not lose what was paid for. */
type Bought = { report: PaidReport & Partial<CheckResult>; tx: string; amountUsd: number }
const boughtKey = (address: string) => `a-identity:check-report:${address}`

function loadBought(address: string): Bought | null {
  try {
    const raw = window.sessionStorage.getItem(boughtKey(address))
    const b = raw ? (JSON.parse(raw) as Bought) : null
    return b && b.report && Array.isArray(b.report.details?.topPayers) && typeof b.tx === 'string' ? b : null
  } catch {
    return null
  }
}

function saveBought(address: string, b: Bought): void {
  try {
    window.sessionStorage.setItem(boughtKey(address), JSON.stringify(b))
  } catch {
    /* storage can be off; the report is still on screen */
  }
}

/** How a purchase stopped short of a report, each with what happened to the money. */
type Stop =
  | { kind: 'cancelled' }
  | { kind: 'refusal'; text: string }
  | { kind: 'wallet'; wallet: string; text: string }
  | { kind: 'before' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unavailable' }
  | { kind: 'pending'; tx: string }
  | { kind: 'unknown'; tx: string }
  | { kind: 'paid_unreadable'; tx: string }

type Pay =
  | { s: 'idle' }
  | { s: 'quoting' }
  | { s: 'choosing'; quote: Quote; busy: AlgorandWalletId | null; error: string | null }
  | { s: 'checking' | 'signing' | 'confirming'; from: string; wallet: string }
  | { s: 'paid'; bought: Bought }
  | { s: 'stopped'; stop: Stop }

const sentence = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`)

function TxLink({ tx, children }: { tx: string; children?: ReactNode }) {
  return (
    <a
      href={txUrl(tx)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 break-all font-mono font-semibold text-accent hover:underline"
    >
      {children ?? short(tx, 6)}
      <ArrowUpRight size={13} className="shrink-0" />
    </a>
  )
}

function AccountLink({ address }: { address: string }) {
  return (
    <a
      href={accountUrl(address)}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className="font-mono text-foreground underline decoration-foreground/25 underline-offset-2 hover:text-accent hover:decoration-accent/50"
    >
      {address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address}
    </a>
  )
}

/** One line per ending, each saying what happened to the money. Only true sentences. */
function StopText({ stop }: { stop: Stop }) {
  switch (stop.kind) {
    case 'cancelled':
      return <>Payment cancelled. Nothing was charged.</>
    case 'refusal':
      return <>{sentence(stop.text)} Nothing was charged.</>
    case 'wallet':
      return (
        <>
          {stop.wallet}: {sentence(stop.text)} Nothing was charged.
        </>
      )
    case 'before':
      return <>Something went wrong before paying. Nothing was charged.</>
    case 'refused':
      return <>The payment was refused: {stop.reason}. Nothing was charged.</>
    case 'unavailable':
      return <>The report could not be made right now. Nothing was charged.</>
    case 'pending':
      return (
        <>
          Your payment was sent but is not confirmed yet. Check it here: <TxLink tx={stop.tx} />. Do not pay again.
        </>
      )
    case 'unknown':
      return (
        <>
          We could not confirm what happened. Check your wallet before trying again. Your payment, if it went through:{' '}
          <TxLink tx={stop.tx} />
        </>
      )
    case 'paid_unreadable':
      return (
        <>
          Your payment went through, but the report could not be shown. Receipt: <TxLink tx={stop.tx} />
        </>
      )
  }
}

/** One flat list of the three Algorand wallets. Nothing is picked for the visitor. */
function WalletList({
  price,
  busy,
  error,
  onPick,
  onCancel,
  onClose,
}: {
  price: string
  busy: AlgorandWalletId | null
  error: string | null
  onPick: (id: AlgorandWalletId) => void
  onCancel: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const busyName = ALGORAND_WALLETS.find((w) => w.id === busy)?.name
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/45 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-report-title"
        className="w-full max-w-sm overflow-hidden rounded-3xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            <h3 id="pay-report-title" className="text-lg font-bold tracking-tight text-foreground">
              Pay with
            </h3>
            <p className="mt-0.5 text-sm text-foreground/55">Pick the Algorand wallet that holds your USDC.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border text-foreground/50 transition-colors hover:text-foreground"
          >
            <X size={15} />
          </button>
        </div>
        <div className="flex flex-col gap-1 p-3">
          {error && (
            <p role="alert" className="mb-1 rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-xs font-semibold text-danger">
              {error}
            </p>
          )}
          {ALGORAND_WALLETS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => onPick(w.id)}
              disabled={busy !== null}
              className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-background/60">
                {busy === w.id ? (
                  <Loader2 size={18} className="animate-spin text-accent" />
                ) : w.kind === 'mobile' ? (
                  <QrCode size={18} className="text-foreground/55" />
                ) : (
                  <Wallet size={18} className="text-foreground/55" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">{w.name}</span>
                <span className="block text-[11px] text-foreground/50">{w.kind === 'mobile' ? 'Phone app, scan a code' : 'Browser extension'}</span>
              </span>
            </button>
          ))}
          {busy && (
            <div className="mt-1 flex items-center justify-between gap-3 rounded-2xl border border-border bg-background/60 px-3.5 py-2.5 text-xs text-foreground/60">
              <span>Waiting for {busyName ?? 'your wallet'}. If it opened a prompt, finish it there.</span>
              <button type="button" onClick={onCancel} className="shrink-0 font-semibold text-foreground/70 underline underline-offset-2 hover:text-foreground">
                Cancel
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-5 py-3 text-[11px] text-foreground/50">
          <Lock size={12} className="shrink-0" />
          You approve one {price} USDC payment in your wallet. Network fees are covered.
        </div>
      </div>
    </div>
  )
}

function ReportView({ bought }: { bought: Bought }) {
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
      className="mt-6 overflow-hidden rounded-3xl border border-border bg-card print:break-inside-avoid"
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

function ReportOffer({ result, onBusy }: { result: CheckResult; onBusy: (busy: boolean) => void }) {
  const address = result.address as string
  const priceUsd = result.fullReport.priceUsd
  const price = formatUsd(priceUsd)
  const [pay, setPay] = useState<Pay>(() => {
    const b = loadBought(address)
    return b ? { s: 'paid', bought: b } : { s: 'idle' }
  })
  /** Which attempt is current: a wallet that answers after a cancel, or after the visitor left, is ignored. */
  const attempt = useRef(0)

  const inFlight = pay.s === 'checking' || pay.s === 'signing' || pay.s === 'confirming'
  useEffect(() => {
    onBusy(inFlight)
  }, [inFlight, onBusy])
  // Leaving while the payment is out makes its answer unreadable; the browser asks first.
  useEffect(() => {
    if (pay.s !== 'confirming') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pay.s])
  // Unmounting before the payment is sent drops any signature that arrives later.
  useEffect(
    () => () => {
      attempt.current += 1
      onBusy(false)
    },
    [onBusy],
  )

  const stop = (s: Stop) => setPay({ s: 'stopped', stop: s })

  const start = async () => {
    const mine = ++attempt.current
    setPay({ s: 'quoting' })
    try {
      const quote = await fetchQuote(postReport, address, priceUsd)
      if (mine === attempt.current) setPay({ s: 'choosing', quote, busy: null, error: null })
    } catch (e) {
      if (mine === attempt.current) stop(e instanceof PayRefusal ? { kind: 'refusal', text: e.message } : { kind: 'before' })
    }
  }

  const closeList = useCallback(() => {
    attempt.current += 1
    setPay({ s: 'idle' })
  }, [])

  /** Stop waiting for the wallet. A signature that still arrives is dropped, never sent. */
  const cancelSigning = () => {
    attempt.current += 1
    stop({ kind: 'cancelled' })
  }

  const pick = async (id: AlgorandWalletId) => {
    if (pay.s !== 'choosing' || pay.busy) return
    const { quote } = pay
    const wallet = ALGORAND_WALLETS.find((w) => w.id === id)?.name ?? 'Your wallet'
    const mine = ++attempt.current
    setPay({ s: 'choosing', quote, busy: id, error: null })

    let from: string
    try {
      from = (await connectAlgorand(id)).address
    } catch (e) {
      if (mine !== attempt.current) return
      const w = algorandWalletError(e)
      if (w.cancelled) stop({ kind: 'cancelled' })
      else setPay({ s: 'choosing', quote, busy: null, error: w.message || `${wallet} could not connect.` })
      return
    }
    if (mine !== attempt.current) return

    // Everything that can refuse does so here, before the wallet is asked to sign.
    setPay({ s: 'checking', from, wallet })
    let sdk: typeof import('algosdk')
    let group: ReturnType<typeof buildGroup>
    try {
      sdk = await import('algosdk')
      const [holding, feePayer, params] = await Promise.all([
        fetchUsdcHolding(from),
        fetchFeePayer(quote.facilitator, quote.accept.network),
        fetchParams(),
      ])
      const problem = fundsProblem(holding, quote.amount)
      if (problem) throw new PayRefusal(problem)
      group = buildGroup(sdk, { quote, sender: from, feePayer, params })
    } catch (e) {
      if (mine === attempt.current) stop(e instanceof PayRefusal ? { kind: 'refusal', text: e.message } : { kind: 'before' })
      return
    }
    if (mine !== attempt.current) return

    setPay({ s: 'signing', from, wallet })
    let header: string
    try {
      const signedPayTxn = await signAlgorandGroup(id, from, [group.feeTxn, group.payTxn], 1)
      if (mine !== attempt.current) return
      header = buildHeader(sdk, { quote, feeTxn: group.feeTxn, payTxn: group.payTxn, signedPayTxn })
    } catch (e) {
      if (mine !== attempt.current) return
      if (e instanceof PayRefusal) return stop({ kind: 'refusal', text: e.message })
      const w = algorandWalletError(e)
      stop(w.cancelled ? { kind: 'cancelled' } : w.message ? { kind: 'wallet', wallet, text: w.message } : { kind: 'before' })
      return
    }

    // From here the signed payment has left the page. No cancel, and every answer is kept.
    setPay({ s: 'confirming', from, wallet })
    const out = await submitPayment(postReport, address, header, group.payTxn.txID())
    if (out.kind === 'paid') {
      const bought: Bought = { report: out.report as Bought['report'], tx: out.tx, amountUsd: out.amountUsd ?? quote.amountUsd }
      saveBought(address, bought)
      setPay({ s: 'paid', bought })
    } else if (out.kind === 'not_charged') stop({ kind: 'before' })
    else stop(out)
  }

  if (pay.s === 'paid') return <ReportView bought={pay.bought} />

  // A payment that is out, or went through, is not offered a second time on this screen.
  const canBuy = !(pay.s === 'stopped' && (pay.stop.kind === 'pending' || pay.stop.kind === 'paid_unreadable'))

  return (
    <section className="mt-6 rounded-3xl border border-border bg-card px-5 py-5 sm:px-8">
      <h3 className="flex items-center gap-2 text-lg font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
        <FileText size={18} className="shrink-0 text-accent" />
        Detailed report
      </h3>
      <p className="mt-1.5 text-[15px] leading-snug text-foreground/70">
        See who pays this address: its ten biggest payers, its last ten payments, and the wallet that created it.
      </p>

      {pay.s === 'stopped' && (
        <div
          role="alert"
          className={cn(
            // A refusal reason can carry a 58-character address; it wraps instead of widening the page.
            'mt-4 break-words rounded-2xl border px-4 py-3 text-sm leading-relaxed [overflow-wrap:anywhere]',
            pay.stop.kind === 'pending' || pay.stop.kind === 'unknown'
              ? 'border-warn/35 bg-warn/[0.08] text-foreground'
              : 'border-border bg-background/60 text-foreground/80',
          )}
        >
          <StopText stop={pay.stop} />
        </div>
      )}

      {pay.s === 'checking' || pay.s === 'signing' || pay.s === 'confirming' ? (
        <div className="mt-4 rounded-2xl border border-border bg-background/60 px-4 py-3" role="status" aria-live="polite">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
            <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
            {pay.s === 'checking' ? 'Checking the USDC in your wallet...' : pay.s === 'signing' ? `Approve the ${price} payment in your wallet` : 'Confirming on Algorand...'}
          </p>
          <p className="mt-1 text-xs text-foreground/55">
            Paying from <span className="font-mono">{short(pay.from, 4)}</span> in {pay.wallet}.
            {pay.s === 'confirming' && ' This can take up to a minute. Keep this page open.'}
          </p>
          {pay.s === 'signing' && (
            <button
              type="button"
              onClick={cancelSigning}
              className="mt-2 text-xs font-semibold text-foreground/70 underline underline-offset-2 hover:text-foreground"
            >
              Cancel
            </button>
          )}
        </div>
      ) : (
        canBuy && (
          <>
            <Button type="button" className="mt-4 w-full sm:w-auto" onClick={() => void start()} disabled={pay.s === 'quoting'}>
              {pay.s === 'quoting' && <Loader2 size={15} className="animate-spin" />}
              Get the detailed report ({price})
            </Button>
            <p className="mt-2.5 text-xs leading-relaxed text-foreground/55">
              Paid in USDC on Algorand from your own wallet. Network fees are covered. If the report cannot be produced, nothing is
              charged.
            </p>
          </>
        )
      )}

      {pay.s === 'choosing' && (
        <WalletList
          price={price}
          busy={pay.busy}
          error={pay.error}
          onPick={(id) => void pick(id)}
          onCancel={() => {
            attempt.current += 1
            setPay({ s: 'choosing', quote: pay.quote, busy: null, error: null })
          }}
          onClose={closeList}
        />
      )}
    </section>
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
  /** A report payment is out: a new check now would unmount it mid-payment. */
  const [payBusy, setPayBusy] = useState(false)
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
    if (payBusy) return
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
  const reportPrice = result?.fullReport?.priceUsd
  const hasPrice = typeof reportPrice === 'number' && Number.isFinite(reportPrice) && reportPrice > 0
  // The report is offered for an address that exists on Algorand; for one that was never used
  // it would be an empty page for money.
  const offerReport = !!result?.address && hasPrice && result.facts.payers !== null

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
            <Button type="submit" shape="rounded" className="h-12 px-5 text-[15px]" disabled={view.s === 'loading' || payBusy}>
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
                  disabled={payBusy}
                  className="rounded-full border border-border px-3 py-1 font-semibold text-foreground/70 transition-colors hover:border-accent/50 hover:text-foreground disabled:opacity-50"
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
            {view.s === 'done' && result && offerReport && <ReportOffer key={result.address} result={result} onBusy={setPayBusy} />}
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
                {hasPrice
                  ? `An AI agent can buy the same detailed report for ${formatUsd(reportPrice)} per call, paid over x402 on Algorand.`
                  : 'An AI agent can buy the same detailed report, paid per call over x402 on Algorand.'}
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
