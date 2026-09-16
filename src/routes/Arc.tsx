import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, Fingerprint, Gauge, ShieldCheck, Zap } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import CopyBlock from '../components/app/CopyBlock'
import { TryIt } from '../components/rail/RailKit'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { SectionShell, reveal, revealAt } from '../components/ui/section'
import { CHAIN_BY_ID } from '../lib/chains'
import { usePageMeta } from '../lib/head'
import { getJson, useCountUp } from '../lib/rail'

/** Arc's own mark on Arc's own gradient, the same tile the Built On wall uses. */
const ARC_TILE = 'linear-gradient(155deg, #011667 0%, #3B1046 55%, #7B0E25 100%)'

/**
 * /arc: Arc Mainnet, the day it opened and every day after.
 *
 * The page leads with what already exists on the network rather than with what could: the
 * agent we minted, the vault holding real USDC, and both payment rails with their receipts.
 * Every number and every receipt is read from the backend (the proof ledger and the two
 * rails' own proof endpoints), so nothing here is typed by hand and nothing goes stale
 * without the page noticing. What still runs on Arc testnet is said on the page, not hidden.
 */

const ARC = CHAIN_BY_ID['arc-mainnet']
const NETWORK = ARC.caip2

type Artifact = { kind: string; label: string; txHash: string; blockNumber?: number; explorerUrl: string | null }
type ProofNetwork = { chain: string; status: string; agent?: { tokenId: string }; artifactsLinked: Artifact[] }
type ProofRail = { networks: ProofNetwork[] }
type RailProof = { byNetwork?: Record<string, { count: number; usd: number }> }
type GatewayStatus = { prices?: Record<string, number> }
type DirectStatus = { configured?: boolean; price?: { settlementFeeUsd: number } }

/**
 * Meridian runs first because it walks the whole pipeline to a verdict. Our Arc Mainnet agent
 * is one click away, and checking it is the honest demo of a brand-new identity: it resolves
 * on-chain and still gets DENY, because a day-old agent with no KYA has not earned trust yet.
 */
const ARC_EXAMPLES = [
  { label: 'Meridian', q: '849980' },
  { label: 'Arc Mainnet #0', q: `${NETWORK}:8004/0` },
  { label: 'OKX.AI #6271', q: 'eip155:196:8004/6271' },
]

const MCP_COMMAND = 'claude mcp add a-identity \\\n  --transport http https://a-identity.xyz/mcp'

const PAY_SNIPPET = `# Ask for a paid verdict on Arc Mainnet. The 402 that answers
# carries the exact price, asset and GatewayWalletBatched domain.
curl -i -X POST https://a-identity.xyz/api/x402/gateway/tools/risk_check \\
  -H 'content-type: application/json' \\
  -d '{"agentId":"849980"}'

# Sign it from your Circle Gateway balance on Arc and send it back
# in PAYMENT-SIGNATURE. No gas on either side.`

/** Each tool, named by the question it answers. */
const QUESTIONS = [
  { tool: 'risk_check', ask: 'Should I pay this agent?' },
  { tool: 'verify_agent', ask: 'Is it who it says it is?' },
  { tool: 'reputation_score', ask: 'How has it behaved?' },
  { tool: 'counterparty_check', ask: 'Can these two trade?' },
  { tool: 'agent_passport', ask: 'Everything, in one answer' },
] as const

function useArcData() {
  const [proof, setProof] = useState<ProofNetwork | null>(null)
  const [paidChecks, setPaidChecks] = useState<{ count: number; usd: number } | null>(null)
  const [gatewayPrices, setGatewayPrices] = useState<Record<string, number> | null>(null)
  const [directFee, setDirectFee] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    void getJson<ProofRail>('/api/proof/arc').then((r) => {
      if (!alive) return
      const net = r?.networks.find((n) => n.chain === ARC.id) ?? null
      if (net) setProof(net)
      else setFailed(true)
    })
    // Paid checks on Arc Mainnet from BOTH rails, each read from its own ledger and
    // summed only for this one network, never across chains.
    void Promise.all([
      getJson<RailProof>('/api/x402/gateway/proof'),
      getJson<RailProof>(`/api/facilitator/proof?network=${NETWORK}`),
    ]).then(([gateway, direct]) => {
      if (!alive) return
      const g = gateway?.byNetwork?.[NETWORK]
      const d = direct?.byNetwork?.[NETWORK]
      if (!gateway && !direct) return
      setPaidChecks({ count: (g?.count ?? 0) + (d?.count ?? 0), usd: (g?.usd ?? 0) + (d?.usd ?? 0) })
    })
    void getJson<GatewayStatus>('/api/x402/gateway/status').then((s) => {
      if (alive && s?.prices) setGatewayPrices(s.prices)
    })
    void getJson<DirectStatus>(`/api/facilitator/status?network=${NETWORK}`).then((s) => {
      if (alive && s?.configured && s.price) setDirectFee(s.price.settlementFeeUsd)
    })
    return () => {
      alive = false
    }
  }, [])

  return { proof, paidChecks, gatewayPrices, directFee, failed }
}

/** The first artifact of a kind whose label matches, so a card links its own receipt. */
function receipt(proof: ProofNetwork | null, kind: string, match?: RegExp): Artifact | undefined {
  return proof?.artifactsLinked.find((a) => a.kind === kind && (!match || match.test(a.label)))
}

function ReceiptLink({ artifact, label = 'receipt' }: { artifact?: Artifact; label?: string }) {
  if (!artifact?.explorerUrl) {
    return <span className="inline-block h-3.5 w-16 animate-pulse rounded bg-foreground/10 align-middle" />
  }
  return (
    <a
      href={artifact.explorerUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline"
    >
      {label} {artifact.txHash.slice(0, 10)} <ArrowUpRight size={12} />
    </a>
  )
}

function DayOneNumbers({ proof, paidChecks, failed }: { proof: ProofNetwork | null; paidChecks: { count: number; usd: number } | null; failed: boolean }) {
  const checks = useCountUp(paidChecks ? paidChecks.count : null)
  const mint = receipt(proof, 'mint')
  const cells = [
    {
      value: proof?.agent ? `#${proof.agent.tokenId}` : '-',
      label: "the first identity Arc Mainnet's ERC-8004 registry minted",
      link: mint,
    },
    { value: paidChecks ? String(Math.round(checks)) : '-', label: 'paid checks settled in production', link: undefined },
    { value: '2', label: 'payment rails live, both in USDC', link: undefined },
    { value: '$1', label: 'daily cap the vault enforces on-chain', link: receipt(proof, 'deploy') },
  ]
  if (failed) {
    return <p className="mt-8 text-sm text-foreground/55">The live ledger could not be read right now. Every receipt is still at /proof/arc.</p>
  }
  return (
    <motion.div {...revealAt(4)} className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="bg-card p-5">
          <div className="text-3xl font-bold tabular-nums tracking-tight text-foreground">{c.value}</div>
          <div className="mt-1 text-sm text-foreground/60">{c.label}</div>
          {c.link && (
            <div className="mt-2">
              <ReceiptLink artifact={c.link} />
            </div>
          )}
        </div>
      ))}
    </motion.div>
  )
}

type Pillar = { icon: ComponentType<{ size?: number | string; className?: string }>; title: string; body: string; artifact?: Artifact }

function WhatRuns({ proof }: { proof: ProofNetwork | null }) {
  const pillars: Pillar[] = useMemo(
    () => [
      {
        icon: Fingerprint,
        title: 'An identity on the canonical registry',
        body: 'Agent #0 on the ERC-8004 identity registry Base and Arbitrum One share, minted the day Arc Mainnet opened.',
        artifact: receipt(proof, 'mint'),
      },
      {
        icon: Gauge,
        title: 'A reputation anyone can check',
        body: "Our oracle anchored the agent's score on the canonical reputation registry, so a caller can verify it instead of trusting us.",
        artifact: receipt(proof, 'attestation'),
      },
      {
        icon: ShieldCheck,
        title: 'A budget the contract enforces',
        body: 'A spend vault holds real USDC under a $1 daily cap. A payment over its limit was refused by the contract itself.',
        artifact: receipt(proof, 'settlement', /vault/i),
      },
      {
        icon: Zap,
        title: 'Checks paid in USDC, gasless for the buyer',
        body: 'Circle Gateway nanopayments and our own EIP-3009 rail both settled here. On Arc the gas is USDC too.',
        artifact: receipt(proof, 'settlement', /Gateway/),
      },
    ],
    [proof],
  )
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {pillars.map((p, i) => (
        <motion.div
          key={p.title}
          {...revealAt(i)}
          className="flex flex-col rounded-2xl border border-border bg-card p-6 transition-colors hover:border-accent/40"
        >
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent">
            <p.icon size={19} />
          </span>
          <h3 className="mt-4 text-lg font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
            {p.title}
          </h3>
          <p className="mt-2 flex-1 text-[15px] leading-relaxed text-foreground/65">{p.body}</p>
          <div className="mt-4">
            <ReceiptLink artifact={p.artifact} />
          </div>
        </motion.div>
      ))}
    </div>
  )
}

function TwoRails({ gatewayPrices, directFee }: { gatewayPrices: Record<string, number> | null; directFee: number | null }) {
  const money = (v: number) => `$${Number(v.toFixed(3))}`
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="grid grid-cols-[1fr_auto_auto] items-end gap-x-6 border-b border-border/60 px-5 py-3 text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/45">
          <span>Question</span>
          <span className="text-right">Gateway</span>
          <span className="text-right">Direct</span>
        </div>
        {QUESTIONS.map((q) => {
          const base = gatewayPrices?.[q.tool]
          return (
            <div key={q.tool} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 border-b border-border/60 px-5 py-3.5 last:border-0">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-foreground">{q.ask}</div>
                <div className="font-mono text-[11px] text-foreground/45">{q.tool}</div>
              </div>
              <div className="text-right text-[15px] font-bold tabular-nums text-foreground">
                {base != null ? money(base) : <span className="inline-block h-4 w-10 animate-pulse rounded bg-foreground/10 align-middle" />}
              </div>
              <div className="text-right text-[15px] font-semibold tabular-nums text-foreground/70">
                {base != null && directFee != null ? money(base + directFee) : <span className="inline-block h-4 w-10 animate-pulse rounded bg-foreground/10 align-middle" />}
              </div>
            </div>
          )
        })}
      </div>
      <div className="grid gap-4">
        <div className="rounded-2xl border border-accent/40 bg-accent/[0.06] p-6">
          <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-accent">Gateway nanopayments</div>
          <h3 className="mt-2 text-lg font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
            Gasless on both sides
          </h3>
          <p className="mt-2 text-[15px] leading-relaxed text-foreground/65">
            Your agent signs against its Circle Gateway balance. Circle credits the call at once and settles on Arc in a batch.
            The price is the tool price, nothing added.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/50">Direct, EIP-3009</div>
          <h3 className="mt-2 text-lg font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
            Pay from any USDC wallet
          </h3>
          <p className="mt-2 text-[15px] leading-relaxed text-foreground/65">
            Your agent signs a transfer and we broadcast it. The settlement fee{directFee != null ? ` (${money(directFee)})` : ''} is
            what that broadcast measurably costs on Arc, with headroom, and it is the only thing added.
          </p>
        </div>
      </div>
    </div>
  )
}

export default function Arc() {
  usePageMeta({
    title: 'A-Identity is live on Arc Mainnet | Trust before your agent pays',
    description:
      'Arc Mainnet opened on 2026-09-16 and A-Identity went live on it the same day: an agent on the canonical ERC-8004 registry, a spend vault holding real USDC, and trust checks paid in USDC through Circle Gateway nanopayments.',
    canonical: 'https://a-identity.xyz/arc',
  })

  const { proof, paidChecks, gatewayPrices, directFee, failed } = useArcData()

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />
      <main>
        <SectionShell size="lg" backdrop="proof" backdropPosition="right">
          <motion.div {...revealAt(0)} className="flex flex-wrap items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-xl shadow-[0_8px_24px_-8px_rgba(59,16,70,0.6)]" style={{ background: ARC_TILE }} aria-hidden="true">
              <img src="/logos/arc-mark.webp" alt="" width={20} height={19} className="h-[19px] w-[20px]" />
            </span>
            <Eyebrow>Arc Mainnet</Eyebrow>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-ok/30 bg-ok/10 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-ok">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
              </span>
              Live since Sep 16, 2026
            </span>
            <span className="inline-flex items-center rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-accent">
              Agent #0 on the registry
            </span>
          </motion.div>
          <motion.div {...revealAt(1)} className="mt-5">
            <DisplayHeading size="display" className="max-w-[16ch]">
              Trust, settled on Arc.
            </DisplayHeading>
          </motion.div>
          <motion.div {...revealAt(2)} className="mt-5">
            <Lede>
              The day Arc Mainnet opened, A-Identity minted the first identity on its ERC-8004 registry. Now your agent can
              check who it is paying before it pays, on Arc, in USDC, with no gas to hold.
            </Lede>
          </motion.div>
          <motion.div {...revealAt(3)} className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href="#try"
              className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white shadow-[0_10px_34px_rgba(115,66,226,0.34)] transition-transform hover:scale-[1.03]"
            >
              Check an agent <ArrowRight size={16} />
            </a>
            <Link
              to="/proof/arc"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:border-accent/50"
            >
              Every receipt <ArrowUpRight size={16} />
            </Link>
          </motion.div>
          <DayOneNumbers proof={proof} paidChecks={paidChecks} failed={failed} />
        </SectionShell>

        <SectionShell size="tight">
          <motion.div {...reveal}>
            <DisplayHeading size="section">Already running on Arc Mainnet</DisplayHeading>
          </motion.div>
          <motion.p {...reveal} className="mt-3 max-w-[62ch] text-[15px] text-foreground/65">
            Not a plan. Each of these is a transaction on Arc Mainnet you can open.
          </motion.p>
          <div className="mt-6">
            <WhatRuns proof={proof} />
          </div>
        </SectionShell>

        <SectionShell size="tight" id="try">
          <motion.div {...reveal}>
            <DisplayHeading size="section">Try it</DisplayHeading>
          </motion.div>
          <div className="mt-5">
            <TryIt inputId="arc-check-query" examples={ARC_EXAMPLES} footnote="Free preview. Your agent gets the signed verdict on Arc from $0.001 in USDC." />
          </div>
        </SectionShell>

        <SectionShell size="tight">
          <motion.div {...reveal}>
            <DisplayHeading size="section">Two ways to pay, both in USDC</DisplayHeading>
          </motion.div>
          <motion.p {...reveal} className="mt-3 max-w-[62ch] text-[15px] text-foreground/65">
            Live prices, read from the rails themselves.
          </motion.p>
          <div className="mt-6">
            <TwoRails gatewayPrices={gatewayPrices} directFee={directFee} />
          </div>
        </SectionShell>

        <SectionShell size="tight">
          <motion.div {...reveal}>
            <DisplayHeading size="section">Add it to your agent</DisplayHeading>
          </motion.div>
          <motion.p {...reveal} className="mt-3 max-w-[62ch] text-[15px] text-foreground/65">
            Free reads over MCP in one line, and a paid verdict over x402 when your agent is about to move money.
          </motion.p>
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <CopyBlock title="Claude, Cursor, any MCP client" subtitle="One command, free tools" text={MCP_COMMAND} />
            <CopyBlock title="Any HTTP client" subtitle="x402 on Arc Mainnet" text={PAY_SNIPPET} />
          </div>
        </SectionShell>

        <SectionShell size="tight">
          <motion.div {...reveal} className="rounded-2xl border border-border bg-card p-6 sm:p-7">
            <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/50">Stated plainly</div>
            <ul className="mt-3 grid gap-2 text-[15px] leading-relaxed text-foreground/70 sm:grid-cols-2 sm:gap-x-8">
              <li>The first payments on Arc Mainnet were ours, bought from ourselves, and the ledger labels them internal.</li>
              <li>Escrow and KYA anchoring still run on Arc testnet, where the full ERC-8004 set lives.</li>
              <li>Arc&apos;s mainnet explorer is permissioned for now, so a receipt link may ask you to sign in.</li>
              <li>Every claim on this page links to its transaction, and the full ledger is one click away.</li>
            </ul>
            <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
              <Link to="/proof/arc" className="inline-flex items-center gap-1 text-accent hover:underline">
                The full Arc ledger <ArrowUpRight size={14} />
              </Link>
              <Link to="/explorer" className="inline-flex items-center gap-1 text-foreground/65 hover:text-foreground">
                Browse all agents <ArrowUpRight size={14} />
              </Link>
            </div>
          </motion.div>
        </SectionShell>
      </main>
      <SiteFooter />
    </ThemeScope>
  )
}
