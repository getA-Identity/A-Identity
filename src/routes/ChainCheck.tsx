import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { AlertTriangle, ArrowUpRight, Check as CheckMark, CheckCircle2, ChevronDown, Info, Link2, Search, ShieldCheck, XCircle } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import CopyBlock from '../components/app/CopyBlock'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DisplayHeading } from '../components/ui/display'
import Owl, { type Mood } from '../components/check/Owl'
import { EASE } from '../components/check/format'
import { apiFetch, readJson } from '../lib/api'
import { ago, short } from '../lib/format'
import { usePageMeta } from '../lib/head'
import { cn } from '../lib/utils'

/**
 * /check/robinhood and /check/arbitrum: before an agent pays on an Arbitrum chain, is the
 * dollar the real one, and is the payee a registered agent? Paste a token, a wallet, an agent
 * id or an x402 link. The verdict is computed by the backend (GET /api/<slug>/check, see
 * mcp/src/evm-pay-check/check.ts); this page presents it and never upgrades or softens it.
 *
 * Same contract as /check: the URL is the state (?q=), the first render never depends on it
 * so it matches the prerendered snapshot, and the check starts in an effect after.
 */

export type PayCheckSlug = 'robinhood' | 'arbitrum'

type Verdict = 'safe' | 'careful' | 'dont_pay' | 'unknown'
type Tone = 'good' | 'warn' | 'bad' | 'neutral'

type Result = {
  query: string
  chain: { id: string; name: string; caip2: string }
  arbitrum: { arbSys: string; arbChainId: number; matches: boolean } | null
  kind: 'token' | 'address' | 'agent' | 'x402'
  address: string | null
  verdict: Verdict
  headline: string
  reasons: { tone: Tone; code: string; text: string }[]
  canonical: {
    symbol: string
    address: string
    explorerUrl: string | null
    domainProven: boolean
    domainName: string | null
    domainVersion: string | null
  }
  account: { isContract: boolean; nonce: number | null; nativeBalance: string | null; settlementBalance: string | null; agentsHeld: number | null } | null
  agent: { caip: string; tokenId: string; owner: string | null; tokenUri: string | null } | null
  challenge: { url: string; networks: string[]; onThisChain: { amount: string | null; payTo: string | null; asset: string | null } | null } | null
  explorerUrl: string | null
  checkedAt: string
}

type About = { settlementToken: { symbol: string; address: string; explorerUrl: string | null } | null }

type Outcome =
  | { kind: 'ok'; result: Result }
  | { kind: 'bad_input'; message?: string }
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  | { kind: 'failed' }

type View = { s: 'idle' } | { s: 'loading'; q: string } | { s: 'done'; q: string; outcome: Outcome }

const OUR_LINK = 'https://a-identity.xyz/api/x402/tools/verify_agent'

/**
 * Per chain: its name, the settlement symbol the copy talks about, and example inputs. The
 * real token's address is NOT here: it arrives from /api/<slug>/check/codes, which reads it
 * from the registry, so this page cannot drift from what the check calls real.
 */
const PAGES: Record<PayCheckSlug, { name: string; symbol: string; examples: { label: string; q: string }[]; problem: ReactNode }> = {
  robinhood: {
    name: 'Robinhood Chain',
    symbol: 'USDG',
    examples: [
      // The impostor with the most holders on the chain's public Blockscout token list, read
      // 2026-09-30: symbol "USDG", name "Global Dollar", 194,589 holders from airdrop spam.
      { label: 'A fake USDG', q: '0xA913C4C2F28AA7b0B15A7C6008a6e19Ff8Bf85c0' },
      { label: 'Agent #0', q: '#0' },
      { label: 'Agent #1', q: '#1' },
      { label: 'Our x402 link', q: OUR_LINK },
    ],
    problem: (
      <>
        On 2026-09-30, 900 tokens on Robinhood Chain's public explorer called themselves USDG or Global Dollar. The biggest showed 194,589
        holders. A symbol is not an identity: an agent that pays by name can pay in the wrong dollar.
      </>
    ),
  },
  arbitrum: {
    name: 'Arbitrum One',
    symbol: 'USDC',
    examples: [
      { label: 'Agent #1259', q: '#1259' },
      { label: 'Our x402 link', q: OUR_LINK },
    ],
    problem: <>An agent that pays by symbol can pay in the wrong dollar. Check the token, the signing domain and who gets paid first.</>,
  },
}

const VERDICTS: Verdict[] = ['safe', 'careful', 'dont_pay', 'unknown']

function isResult(x: unknown): x is Result {
  const r = x as Partial<Result> | null
  return !!r && typeof r.headline === 'string' && VERDICTS.includes(r.verdict as Verdict) && Array.isArray(r.reasons) && !!r.canonical
}

async function runCheck(slug: PayCheckSlug, q: string): Promise<Outcome> {
  try {
    // No client retry: the server answers within its own 15 s deadline, and a retry would run
    // the whole check twice for one question. A failure shows Try again instead.
    const res = await apiFetch(`/api/${slug}/check?q=${encodeURIComponent(q)}`, { retries: 0, timeoutMs: 20_000 })
    if (res.status === 400 || res.status === 404) {
      const { error } = await readJson<{ error?: unknown }>(res)
      const message = typeof error === 'string' && error.length <= 240 ? error : undefined
      if (res.status === 404 && (!message || /^not found\.?$/i.test(message))) return { kind: 'failed' }
      return { kind: 'bad_input', message }
    }
    if (res.status === 429) {
      const body = await readJson<{ retryAfterSeconds?: number }>(res)
      return { kind: 'rate_limited', retryAfterSeconds: typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined }
    }
    if (!res.ok) return { kind: 'failed' }
    const body = await readJson(res)
    return isResult(body) ? { kind: 'ok', result: body } : { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}

const LOOK: Record<Verdict, { mood: Mood; text: string; band: string; border: string }> = {
  safe: { mood: 'happy', text: 'text-ok', band: 'bg-ok/[0.07]', border: 'border-ok/30' },
  careful: { mood: 'cautious', text: 'text-warn', band: 'bg-warn/[0.08]', border: 'border-warn/35' },
  dont_pay: { mood: 'alarmed', text: 'text-danger', band: 'bg-danger/[0.07]', border: 'border-danger/30' },
  unknown: { mood: 'curious', text: 'text-foreground', band: 'bg-foreground/[0.03]', border: 'border-border' },
}

const TONE_ICON: Record<Tone, { Icon: typeof Info; cls: string; label: string }> = {
  good: { Icon: CheckCircle2, cls: 'text-ok', label: 'Good sign' },
  warn: { Icon: AlertTriangle, cls: 'text-warn', label: 'Warning' },
  bad: { Icon: XCircle, cls: 'text-danger', label: 'Problem' },
  neutral: { Icon: Info, cls: 'text-foreground/45', label: 'Note' },
}

function unitsToAmount(raw: string | null, decimals = 6): string | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const v = raw.padStart(decimals + 1, '0')
  const whole = v.slice(0, -decimals)
  const frac = v.slice(-decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/** The facts row: only what the backend read. A null is left out, never shown as zero. */
function factsOf(r: Result): string[] {
  const out: string[] = []
  const a = r.account
  if (a) {
    if (a.agentsHeld !== null) out.push(a.agentsHeld === 1 ? 'Holds 1 agent id' : `Holds ${a.agentsHeld} agent ids`)
    if (a.nonce !== null) out.push(a.nonce === 1 ? '1 transaction sent' : `${a.nonce} transactions sent`)
    if (a.settlementBalance !== null) out.push(`${a.settlementBalance} ${r.canonical.symbol}`)
    if (a.isContract) out.push('A contract')
  }
  const offer = r.challenge?.onThisChain
  if (offer) {
    const amount = unitsToAmount(offer.amount)
    if (amount) out.push(`Asks ${amount} ${r.canonical.symbol}`)
  } else if (r.challenge) {
    out.push(`Asks on ${r.challenge.networks.join(', ') || 'no named network'}`)
  }
  return out
}

function Target({ r }: { r: Result }) {
  const who = r.address
  // An agent id the registry does not have is held by nobody: show the id alone.
  if (!who) return <p className="mt-2 break-all font-mono text-sm text-foreground/55">{r.agent?.caip ?? short(r.query, 8)}</p>
  const lead = r.kind === 'x402' ? 'This link pays' : r.kind === 'agent' ? `${r.agent?.caip ?? ''} is held by` : null
  return (
    <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 text-sm text-foreground/60">
      {lead && <span>{lead}</span>}
      <span className="font-mono" title={who}>
        {short(who, 6)}
      </span>
    </p>
  )
}

function Reasons({ reasons }: { reasons: Result['reasons'] }) {
  return (
    <ul className="space-y-3">
      {reasons.map((r, i) => {
        const t = TONE_ICON[r.tone] ?? TONE_ICON.neutral
        return (
          <li key={i} className="flex gap-3 text-[15px] leading-snug text-foreground/85">
            <t.Icon size={18} className={cn('mt-0.5 shrink-0', t.cls)} aria-label={t.label} role="img" />
            {/* A reason can carry a full address, which has no break points of its own. */}
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {r.text}{' '}
              <code className="ml-1 whitespace-nowrap rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-foreground/55">{r.code}</code>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function RealToken({ r }: { r: Result }) {
  const c = r.canonical
  return (
    <div className="mt-5 rounded-xl border border-border bg-background px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <ShieldCheck size={16} className={c.domainProven ? 'text-ok' : 'text-foreground/45'} aria-hidden="true" />
        The real {c.symbol} on {r.chain.name}
      </div>
      <p className="mt-1 break-all font-mono text-[13px] text-foreground/70">{c.address}</p>
      <p className="mt-1 text-[13px] text-foreground/60">
        {c.domainProven
          ? `Signing domain proven live: "${c.domainName}", version ${c.domainVersion}.`
          : 'Signing domain not proven right now, so nothing about it is asserted.'}
        {c.explorerUrl && (
          <>
            {' '}
            <a href={c.explorerUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent hover:underline">
              Explorer
            </a>
          </>
        )}
      </p>
      {r.arbitrum?.matches && (
        <p className="mt-1 text-[13px] text-foreground/60">
          An Arbitrum chain, read from the chain itself: its ArbSys precompile answers chain id {r.arbitrum.arbChainId}.
        </p>
      )}
    </div>
  )
}

function CopyLink({ slug, q }: { slug: PayCheckSlug; q: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    const link = `${window.location.origin}/check/${slug}?q=${encodeURIComponent(q)}`
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

function errorText(o: Exclude<Outcome, { kind: 'ok' }>): string {
  if (o.kind === 'bad_input') return o.message ?? 'Paste a token or wallet address, an agent id, or an x402 link.'
  if (o.kind === 'rate_limited') return `Too many checks in a row. Try again in ${o.retryAfterSeconds ? `${Math.ceil(o.retryAfterSeconds)} seconds` : 'a minute'}.`
  return 'We could not finish the check just now. Try again in a few seconds.'
}

function Answer({ slug, view, onRetry }: { slug: PayCheckSlug; view: View; onRetry: (q: string) => void }) {
  const result = view.s === 'done' && view.outcome.kind === 'ok' ? view.outcome.result : null
  const look = result ? LOOK[result.verdict] : null
  const mood: Mood = view.s === 'idle' ? 'idle' : view.s === 'loading' ? 'thinking' : look ? look.mood : view.outcome.kind === 'failed' ? 'error' : 'curious'
  const facts = result ? factsOf(result) : []
  return (
    <section
      aria-live="polite"
      aria-busy={view.s === 'loading'}
      style={{ fontFeatureSettings: '"calt" 0' }}
      className={cn('overflow-hidden rounded-3xl border bg-card transition-colors duration-500', look ? look.border : 'border-border', view.s === 'idle' && 'border-dashed')}
    >
      <div className={cn('px-5 pb-6 pt-7 text-center transition-colors duration-500 sm:px-8', look?.band)}>
        <Owl mood={mood} />
        {view.s === 'idle' && <p className="mt-4 text-[15px] text-foreground/60">Your answer will show up here.</p>}
        {view.s === 'loading' && <p className="mt-4 text-[15px] font-medium text-foreground/75">Reading {PAGES[slug].name}...</p>}
        {view.s === 'done' && view.outcome.kind !== 'ok' && (
          <p className="mx-auto mt-4 max-w-[36ch] text-base font-medium text-foreground/80">{errorText(view.outcome)}</p>
        )}
        {result && look && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }}>
            <h2
              className={cn('mt-4 text-[clamp(1.8rem,7vw,2.5rem)] font-bold leading-[1.05] tracking-[-0.02em]', look.text)}
              style={{ fontFamily: 'var(--font-heading)', textWrap: 'balance' }}
            >
              {result.headline}
            </h2>
            <Target r={result} />
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
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 0.1 }} className="border-t border-border px-5 py-5 sm:px-8">
          <Reasons reasons={result.reasons} />
          {facts.length > 0 && (
            <ul className="mt-5 flex flex-wrap gap-2">
              {facts.map((f) => (
                <li key={f} className="rounded-full border border-border bg-background px-3 py-1 text-[13px] text-foreground/70">
                  {f}
                </li>
              ))}
            </ul>
          )}
          <RealToken r={result} />
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            {result.explorerUrl ? (
              <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-semibold text-accent hover:underline">
                View on explorer <ArrowUpRight size={14} />
              </a>
            ) : (
              <span />
            )}
            <CopyLink slug={slug} q={view.q} />
          </div>
        </motion.div>
      )}
    </section>
  )
}

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

const RULES: { tone: Tone; label: string; text: (sym: string) => string }[] = [
  {
    tone: 'bad',
    label: "Don't pay",
    text: (sym) =>
      `a token that presents itself as ${sym} but is not at its address, a 402 challenge that asks for another token or hands you a signing domain the real token does not have, an agent id the registry does not have, or the zero address.`,
  },
  {
    tone: 'warn',
    label: 'Be careful',
    text: (sym) => `a payee that holds no ERC-8004 agent id, an address never used on this chain, a token that is not ${sym}, or an agent whose registration file does not list it back.`,
  },
  {
    tone: 'good',
    label: 'Looks right',
    text: (sym) => `the real ${sym} with its signing domain proven against the live DOMAIN_SEPARATOR, or a registered agent. A registration is identity, not a review.`,
  },
  { tone: 'neutral', label: 'Could not verify', text: () => 'the chain or the registry could not be read, or the domain could not be proven. Never reported as safe.' },
]

const curlFor = (slug: PayCheckSlug, q: string) => `curl -s 'https://a-identity.xyz/api/${slug}/check?q=${encodeURIComponent(q)}'`

export default function ChainCheck({ slug }: { slug: PayCheckSlug }) {
  const page = PAGES[slug]
  usePageMeta({
    title: `Before you pay on ${page.name}: is it the real ${page.symbol}? | A-Identity`,
    description: `Paste a token, a wallet, an agent id or an x402 link and see, read live from ${page.name}, whether the dollar is the real ${page.symbol} and whether the payee is a registered agent.`,
    canonical: `https://a-identity.xyz/check/${slug}`,
  })

  const [params, setParams] = useSearchParams()
  const urlQ = (params.get('q') ?? '').trim()
  const [input, setInput] = useState('')
  const [view, setView] = useState<View>({ s: 'idle' })
  const [about, setAbout] = useState<About | null>(null)
  const seq = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    apiFetch(`/api/${slug}/check/codes`, { retries: 1, timeoutMs: 10_000 })
      .then((res) => (res.ok ? readJson<About>(res) : null))
      .then((a) => {
        if (live && a) setAbout(a)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [slug])

  const run = useCallback(
    async (q: string) => {
      const id = ++seq.current
      setView({ s: 'loading', q })
      const outcome = await runCheck(slug, q)
      if (id !== seq.current) return
      setView({ s: 'done', q, outcome })
    },
    [slug],
  )

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

  const real = about?.settlementToken
  const examples = [...(real ? [{ label: `The real ${real.symbol}`, q: real.address }] : []), ...page.examples]
  const result = view.s === 'done' && view.outcome.kind === 'ok' ? view.outcome.result : null
  const other: PayCheckSlug = slug === 'robinhood' ? 'arbitrum' : 'robinhood'

  return (
    <ThemeScope surface="background" className="flex min-h-screen w-full flex-col" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />
      <main className="w-full flex-1 px-4 pb-16 pt-6 sm:px-8 sm:pb-24 sm:pt-10">
        <div className="mx-auto w-full max-w-[640px]">
          <nav aria-label="Chain" className="flex justify-center gap-2 text-sm">
            {(['robinhood', 'arbitrum'] as PayCheckSlug[]).map((s) => (
              <Link
                key={s}
                to={`/check/${s}`}
                aria-current={s === slug ? 'page' : undefined}
                className={cn(
                  'rounded-full border px-3 py-1 font-semibold transition-colors',
                  s === slug ? 'border-accent/50 bg-accent/10 text-foreground' : 'border-border text-foreground/60 hover:text-foreground',
                )}
              >
                {PAGES[s].name}
              </Link>
            ))}
          </nav>

          <div className="mt-5 text-center sm:mt-6">
            <DisplayHeading size="section" as="h1">
              Is it the real {page.symbol}?
            </DisplayHeading>
            <p className="mx-auto mt-3 max-w-[48ch] text-[17px] leading-relaxed text-foreground/70 sm:text-lg" style={{ textWrap: 'balance' }}>
              Before an agent pays on {page.name}: paste a token, a wallet, an agent id or an x402 link.
            </p>
            <p className="mx-auto mt-3 max-w-[56ch] text-sm leading-relaxed text-foreground/55">{page.problem}</p>
          </div>

          <form onSubmit={onSubmit} className="mt-7 flex gap-2" role="search">
            <div className="relative min-w-0 flex-1">
              <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground/40" />
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                aria-label="Token, wallet, agent id or x402 link"
                placeholder="0x..., #0, eip155:...:8004/0 or https://..."
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                maxLength={500}
                className="h-12 rounded-xl pl-10 text-base"
              />
            </div>
            <Button type="submit" shape="rounded" className="h-12 px-5 text-[15px]" disabled={view.s === 'loading'}>
              Check
            </Button>
          </form>

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

          <div className="mt-8">
            <Answer slug={slug} view={view} onRetry={(q) => void run(q)} />
            {result && <p className="mt-3 text-center text-xs text-foreground/50">Read live from {result.chain.name}, {ago(result.checkedAt)}.</p>}
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
                        <span className="font-semibold text-foreground">{r.label}:</span> {r.text(page.symbol)}
                      </span>
                    </li>
                  )
                })}
              </ul>
              <p className="mt-4 text-sm leading-relaxed text-foreground/60">
                Everything is read live from {page.name}: the token's own DOMAIN_SEPARATOR, the canonical ERC-8004 identity registry, and, for a link, the
                402 challenge it serves. The real token's address comes from our chain registry, which records where its issuer documents it.
              </p>
            </Fold>
            <Fold title="For agents">
              <p className="text-[15px] leading-relaxed text-foreground/75">
                The same check is a free JSON call. Every reason carries a stable code, so an agent can refuse a payment on NOT_CANONICAL_TOKEN or
                DOMAIN_MISMATCH without reading prose.
              </p>
              <div className="mt-4 space-y-3">
                <CopyBlock title="Check before paying" subtitle="GET, no key, JSON" text={curlFor(slug, result?.query ?? real?.address ?? '#0')} />
                <CopyBlock title="Every reason code" subtitle="What each one means" text={`curl -s 'https://a-identity.xyz/api/${slug}/check/codes'`} />
              </div>
            </Fold>
          </div>

          <p className="mt-6 text-center text-sm text-foreground/55">
            Also on{' '}
            <Link to={`/check/${other}`} className="font-semibold text-accent hover:underline">
              {PAGES[other].name}
            </Link>
            . The receipts behind this chain are on{' '}
            <Link to={`/proof/${slug}`} className="font-semibold text-accent hover:underline">
              /proof/{slug}
            </Link>
            .
          </p>
        </div>
      </main>
      <SiteFooter />
    </ThemeScope>
  )
}
