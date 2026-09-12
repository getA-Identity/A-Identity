import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowUpRight, Loader2, Search } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import CopyBlock from '../components/app/CopyBlock'
import VerifyStepper from '../components/landing/VerifyStepper'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { SectionShell, reveal, revealAt } from '../components/ui/section'
import { Input } from '../components/ui/input'
import { apiFetch } from '../lib/api'
import { ago } from '../lib/format'
import { usePageMeta } from '../lib/head'
import { getReputation, resolveAgent, type AgentIdentity, type Reputation } from '../lib/mcp-client'

/**
 * /algorand: the one page someone arriving from the Algorand ecosystem needs.
 *
 * Four blocks, each doing something rather than describing it: live numbers from the rail,
 * a check that runs by itself the moment the page opens, the two lines that put the check
 * inside an agent, and the live price of every question. Everything technical lives one
 * link away, on /proof/algorand.
 */

type Sale = { ts: string; outcome: string; tool: string; amountUsd: number; tx?: string; explorerUrl?: string }
type RailProof = { configured: boolean; totalSettlements: number; totalUsd: number; recent: Sale[] }
type Prices = {
  verify_agent: number
  reputation_score: number
  risk_check: number
  agent_passport: number
  agent_batch_audit?: { perAgentUsd: number; maxAgents: number }
}
type RailStatus = { configured: boolean; challenge?: { prices?: Prices } }

const MCP_COMMAND = 'claude mcp add a-identity-trust \\\n  -e A_IDENTITY_ALGORAND_MNEMONIC="your 25 words" \\\n  -- npx -y @a-identity/trust-mcp'

const SDK_SNIPPET = `import { TrustGuard } from '@a-identity/trust-guard'
import { algorandPayer } from '@a-identity/trust-guard/algorand'

const oracle = new TrustGuard({ rail: 'algorand', onPaymentRequired: algorandPayer({ mnemonic }) })
await oracle.guard(agentId) // throws if you should not pay`

const EXAMPLES = [
  { label: 'Meridian', q: '849980' },
  { label: 'OKX.AI #6271', q: 'eip155:196:8004/6271' },
]

/** Each tool, named by the question it answers. */
const QUESTIONS: { key: keyof Omit<Prices, 'agent_batch_audit'> | 'agent_batch_audit'; ask: string; tool: string }[] = [
  { key: 'risk_check', ask: 'Should I pay this agent?', tool: 'risk_check' },
  { key: 'verify_agent', ask: 'Is it who it says it is?', tool: 'verify_agent' },
  { key: 'reputation_score', ask: 'How has it behaved?', tool: 'reputation_score' },
  { key: 'agent_passport', ask: 'Everything, in one answer', tool: 'agent_passport' },
  { key: 'agent_batch_audit', ask: 'A whole shortlist at once', tool: 'agent_batch_audit' },
]

function useCountUp(target: number | null, duration = 900) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (target == null) return
    const start = performance.now()
    let raf = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / duration)
      setValue(target * (1 - Math.pow(1 - t, 3)))
      if (t < 1) raf = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return value
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await apiFetch(path)
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

function LiveNumbers({ proof, failed }: { proof: RailProof | null; failed: boolean }) {
  const count = useCountUp(proof ? proof.totalSettlements : null)
  const usd = useCountUp(proof ? proof.totalUsd : null)
  const last = proof ? [...proof.recent].reverse().find((s) => s.outcome === 'settled') : undefined
  if (failed) {
    return <p className="mt-8 text-sm text-foreground/55">The live numbers could not be read right now. The rail itself is unaffected.</p>
  }
  return (
    <motion.div {...revealAt(3)} className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3">
      <div className="bg-card p-5">
        <div className="text-3xl font-bold tabular-nums tracking-tight text-foreground">{proof ? Math.round(count) : '-'}</div>
        <div className="mt-1 text-sm text-foreground/60">paid checks settled on mainnet</div>
      </div>
      <div className="bg-card p-5">
        <div className="text-3xl font-bold tabular-nums tracking-tight text-foreground">{proof ? usd.toFixed(3) : '-'}</div>
        <div className="mt-1 text-sm text-foreground/60">USDC paid, every cent on-chain</div>
      </div>
      <div className="bg-card p-5">
        <div className="text-3xl font-bold tracking-tight text-foreground">{last ? ago(last.ts) : '-'}</div>
        <div className="mt-1 flex items-center gap-1 text-sm text-foreground/60">
          {last?.explorerUrl ? (
            <a href={last.explorerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              last paid check <ArrowUpRight size={13} />
            </a>
          ) : (
            'last paid check'
          )}
        </div>
      </div>
    </motion.div>
  )
}

function TryIt() {
  const [query, setQuery] = useState(EXAMPLES[0].q)
  const [loading, setLoading] = useState(false)
  const [identity, setIdentity] = useState<AgentIdentity | null>(null)
  const [reputation, setReputation] = useState<Reputation | null>(null)
  const [shown, setShown] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ran = useRef(false)

  async function check(raw: string) {
    const q = raw.trim()
    if (!q) return
    setLoading(true)
    setError(null)
    const [idRes, repRes] = await Promise.all([resolveAgent(q), getReputation(q)])
    const id = idRes.ok && idRes.data.found ? (idRes.data.agent ?? null) : null
    const rep = repRes.ok && repRes.data.found ? (repRes.data.reputation ?? null) : null
    setIdentity(id)
    setReputation(rep)
    setShown(q)
    // "Not found" and "could not ask" are different answers, so they get different words.
    if (!idRes.ok && !repRes.ok) setError('The oracle could not be reached just now. Try again in a few seconds.')
    else if (!id && !rep) setError(`No agent found for "${q}". Try a token id or an owner address.`)
    setLoading(false)
  }

  // The check runs by itself once, so the first thing a visitor sees is the product working.
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    void check(EXAMPLES[0].q)
  }, [])

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void check(query)
  }

  return (
    <div className="rounded-3xl border border-border bg-card p-5 sm:p-7">
      <form onSubmit={onSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground/40" />
          <Input
            id="algorand-check-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Agent to check"
            placeholder="Agent id or owner address"
            className="h-11 rounded-lg pl-10 font-mono text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="inline-flex h-11 items-center gap-2 rounded-lg bg-accent px-5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
          Check
        </button>
      </form>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-foreground/55">
        Try
        {EXAMPLES.map((ex) => (
          <button
            key={ex.q}
            type="button"
            onClick={() => {
              setQuery(ex.q)
              void check(ex.q)
            }}
            className="rounded-full border border-border px-3 py-1 font-semibold text-foreground/70 transition-colors hover:border-accent/50 hover:text-foreground"
          >
            {ex.label}
          </button>
        ))}
      </div>
      <div className="mt-5">
        {error && <p className="rounded-xl border border-border bg-background p-4 text-sm text-foreground/60">{error}</p>}
        {!error && (identity || reputation) && (
          <motion.div key={shown} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
            <VerifyStepper identity={identity} reputation={reputation} query={shown} />
          </motion.div>
        )}
        {!error && loading && !identity && !reputation && <div className="h-40 animate-pulse rounded-2xl bg-foreground/[0.05]" />}
      </div>
      <p className="mt-4 text-xs text-foreground/50">Free preview. Your agent gets the signed verdict for $0.05.</p>
    </div>
  )
}

function PriceList({ prices }: { prices: Prices | null }) {
  const price = (key: string) => {
    if (!prices) return null
    if (key === 'agent_batch_audit') {
      const b = prices.agent_batch_audit
      return b ? `$${b.perAgentUsd} per agent` : null
    }
    const v = prices[key as keyof Omit<Prices, 'agent_batch_audit'>]
    return typeof v === 'number' ? `$${v}` : null
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      {QUESTIONS.map((q) => (
        <div key={q.key} className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-4 last:border-0">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-foreground">{q.ask}</div>
            <div className="font-mono text-[11px] text-foreground/45">{q.tool}</div>
          </div>
          <div className="shrink-0 text-right text-[15px] font-bold tabular-nums text-foreground">
            {price(q.key) ?? <span className="inline-block h-4 w-12 animate-pulse rounded bg-foreground/10 align-middle" />}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function Algorand() {
  usePageMeta({
    title: 'Check an agent before you pay it, on Algorand | A-Identity',
    description:
      'One call, paid in USDC on Algorand: is this agent who it claims, how has it behaved, and should your agent pay it. Try it free, then add it to your agent in one line.',
    canonical: 'https://a-identity.xyz/algorand',
  })

  const [proof, setProof] = useState<RailProof | null>(null)
  const [prices, setPrices] = useState<Prices | null>(null)
  const [proofFailed, setProofFailed] = useState(false)

  useEffect(() => {
    let alive = true
    void getJson<RailProof>('/api/x402/algorand/proof').then((p) => {
      if (!alive) return
      if (p) setProof(p)
      else setProofFailed(true)
    })
    void getJson<RailStatus>('/api/x402/algorand/status').then((s) => {
      if (alive && s?.challenge?.prices) setPrices(s.challenge.prices)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />
      <main>
        <SectionShell size="lg">
          <motion.div {...revealAt(0)}>
            <Eyebrow>Algorand</Eyebrow>
          </motion.div>
          <motion.div {...revealAt(1)} className="mt-4">
            <DisplayHeading size="display" className="max-w-[15ch]">
              Check an agent before you pay it.
            </DisplayHeading>
          </motion.div>
          <motion.div {...revealAt(2)} className="mt-5">
            <Lede>One call. A clear answer. Paid in USDC on Algorand.</Lede>
          </motion.div>
          <LiveNumbers proof={proof} failed={proofFailed} />
        </SectionShell>

        <SectionShell size="tight">
          <motion.h2 {...reveal} className="text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
            Try it
          </motion.h2>
          <div className="mt-5">
            <TryIt />
          </div>
        </SectionShell>

        <SectionShell size="tight">
          <motion.h2 {...reveal} className="text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
            Add it to your agent
          </motion.h2>
          <p className="mt-2 max-w-[60ch] text-[15px] text-foreground/65">
            Your agent pays from its own account. Anything above its limit is refused before it signs.
          </p>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <CopyBlock title="Claude, Cursor, any MCP client" subtitle="One command" text={MCP_COMMAND} />
            <CopyBlock title="TypeScript" subtitle="npm install @a-identity/trust-guard algosdk" text={SDK_SNIPPET} />
          </div>
        </SectionShell>

        <SectionShell size="tight">
          <motion.h2 {...reveal} className="text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
            Ask one question, pay for one answer
          </motion.h2>
          <div className="mt-5">
            <PriceList prices={prices} />
          </div>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
            <Link to="/proof/algorand" className="inline-flex items-center gap-1 text-accent hover:underline">
              Every payment, with its transaction <ArrowUpRight size={14} />
            </Link>
            <Link to="/explorer" className="inline-flex items-center gap-1 text-foreground/65 hover:text-foreground">
              Browse all agents <ArrowUpRight size={14} />
            </Link>
          </div>
        </SectionShell>
      </main>
      <SiteFooter />
    </ThemeScope>
  )
}
