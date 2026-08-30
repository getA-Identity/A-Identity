import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, Check, X, AlertTriangle, Fingerprint, BadgeCheck, Gauge, Scale, ListChecks } from 'lucide-react'
import { CHAIN_BY_ID, type ChainId } from '../../lib/chains'
import { Badge, VerdictBadge } from '../ui/badge'
import type { AgentIdentity, Reputation } from '../../lib/mcp-client'

/**
 * VerifyStepper, the step-by-step "verify an agent" walkthrough.
 *
 * Takes the already-fetched on-chain data for one query and REVEALS the logical
 * verification pipeline one stage at a time, the way an agent (or a human) should
 * reason about a counterparty:
 *
 *   1. Resolve , does a real ERC-8004 identity exist on-chain?
 *   2. KYA     , is wallet control attested (Know Your Agent), or revoked?
 *   3. Score   , the deterministic 0-1000 reputation from real settlements
 *   4. Verdict , ALLOW / WARN / DENY, with the reasons that produced it
 *
 * The checks themselves already ran (live reads, no mocks); this component stages
 * the presentation so each signal and the standard behind it is legible.
 */

type StepState = 'idle' | 'running' | 'done'
type Verdict = 'ALLOW' | 'WARN' | 'DENY'

const STEP_MS = 850

function verdictOf(score: number, kya?: string, verified = true, sybil?: string): Verdict {
  if (kya === 'revoked' || !verified || sybil === 'high') return 'DENY'
  if (score < 200) return 'DENY'
  if (score < 500 || sybil === 'medium') return 'WARN'
  return 'ALLOW'
}

function verdictReasons(score: number, kya: string | undefined, verified: boolean, sybil: string | undefined): string[] {
  const r: string[] = []
  if (kya === 'revoked') r.push('KYA attestation revoked (flagged as an incident)')
  if (!verified) r.push('no verifiable on-chain ERC-8004 identity')
  if (sybil === 'high') r.push('Sybil signals: reputation mostly self-dealt')
  if (sybil === 'medium') r.push('Sybil signals: partial same-operator activity')
  if (score < 200) r.push(`reputation ${score} is below 200`)
  else if (score < 500) r.push(`reputation ${score} is in the caution band (200-500)`)
  if (kya === 'unverified' && verified) r.push('KYA (wallet control) not attested yet')
  if (r.length === 0) r.push('verified identity, attested KYA, strong reputation')
  return r
}

/**
 * How a finished step turned out. Three outcomes, not two, because the Decide step can end
 * in WARN: rendering that as the same red cross a DENY gets said "refused" in the gutter
 * while the pill beside it said "caution", and the gutter is read first.
 */
type Outcome = 'pass' | 'caution' | 'fail'

const OUTCOME: Record<Outcome, { ring: string; glyph: React.ReactNode }> = {
  pass: { ring: 'bg-ok/10 ring-ok/30', glyph: <Check size={15} strokeWidth={2.6} className="text-ok" /> },
  caution: { ring: 'bg-warn/10 ring-warn/40', glyph: <AlertTriangle size={14} strokeWidth={2.6} className="text-warn" /> },
  fail: { ring: 'bg-danger/10 ring-danger/35', glyph: <X size={15} strokeWidth={2.6} className="text-danger" /> },
}

function StepRow({ state, outcome, Icon, title, standard, children }: {
  state: StepState
  /** How the completed step turned out: passed, passed with a caution, or refused. */
  outcome: Outcome
  Icon: typeof Fingerprint
  title: string
  standard: string
  children?: React.ReactNode
}) {
  return (
    <div className={`flex gap-3.5 px-5 py-4 transition-opacity ${state === 'idle' ? 'opacity-40' : 'opacity-100'}`}>
      <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${
        state === 'done' ? OUTCOME[outcome].ring : 'bg-background ring-border'
      }`}>
        {state === 'running' ? (
          <Loader2 size={15} className="animate-spin text-accent" />
        ) : state === 'done' ? (
          OUTCOME[outcome].glyph
        ) : (
          <Icon size={14} className="text-foreground/45" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[15px] font-bold tracking-tight text-foreground">{title}</span>
          <Badge variant="neutral" className="font-mono text-[10px] uppercase tracking-[0.08em]">{standard}</Badge>
        </div>
        <AnimatePresence>
          {state === 'done' && (
            <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
              className="mt-1.5 text-sm leading-relaxed text-foreground/70">
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

export default function VerifyStepper({ identity, reputation, query, onComplete }: {
  identity: AgentIdentity | null
  reputation: Reputation | null
  query: string
  onComplete?: () => void
}) {
  const [stage, setStage] = useState(0) // 0..4 = how many steps have completed
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    setStage(0)
    timers.current.forEach(clearTimeout)
    timers.current = [1, 2, 3, 4].map((i) => setTimeout(() => {
      setStage(i)
      if (i === 4) onComplete?.()
    }, i * STEP_MS))
    return () => timers.current.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const state = (i: number): StepState => (stage >= i ? 'done' : stage === i - 1 ? 'running' : 'idle')

  const verified = Boolean(identity) || reputation?.onchain === 'registered'
  const kya = reputation?.kya
  const score = reputation?.score ?? 0
  const sybil = reputation?.sybil?.level
  const verdict = verdictOf(score, kya, verified, sybil)
  const reasons = verdictReasons(score, kya, verified, sybil)
  const bd = reputation?.breakdown
  // Name the chain the read actually happened on. The old copy named X Layer or Circle Arc
  // and nothing else, so an identity resolved on Celo or Robinhood was reported as Arc.
  const chain = identity?.chain ? CHAIN_BY_ID[identity.chain as ChainId] : undefined
  const chainName = chain?.name ?? identity?.chain ?? 'chain'

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {/* Card header, matching the /stats panel header: an accent icon tile, a
          full-contrast title at a real size, and the qualifier on its own muted line.
          It used to be 11px micro-caps at 50% foreground, which on the light ground was a
          heading you had to hunt for. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
            <ListChecks size={16} strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-bold tracking-tight text-foreground">Verification pipeline</h3>
            <p className="text-xs font-medium text-foreground/60">Four live reads, in the order a payer should ask them</p>
          </div>
        </div>
        <span className="truncate font-mono text-xs text-foreground/60">{query}</span>
      </div>
      <div className="divide-y divide-border/60">
        <StepRow state={state(1)} outcome={verified ? 'pass' : 'fail'} Icon={Fingerprint} title="Resolve identity" standard="ERC-8004">
          {verified && identity?.partial ? (
            <>Live read from the ERC-8004 IdentityRegistry on {chainName}: this wallet <b className="text-foreground">holds an ERC-8004 identity token</b>. The public RPC cannot enumerate the token id; search by agent id for the full record.</>
          ) : verified && identity ? (
            <>Live read from the IdentityRegistry on {chainName}: token <b className="font-mono text-foreground">#{identity.tokenId}</b>, owner <b className="font-mono text-foreground">{identity.owner.slice(0, 6)}…{identity.owner.slice(-4)}</b>. The identity exists on-chain.</>
          ) : verified ? (
            <>Registered on the platform with a verified on-chain anchor.</>
          ) : (
            <>No ERC-8004 identity found for this query. An unidentifiable counterparty cannot be trusted.</>
          )}
        </StepRow>

        <StepRow state={state(2)} outcome={kya === 'verified' ? 'pass' : 'fail'} Icon={BadgeCheck} title="Know Your Agent" standard="KYA">
          {kya === 'verified' && <>Wallet control attested in the ValidationRegistry. The operator proved they hold the agent&apos;s keys.</>}
          {kya === 'revoked' && <>KYA attestation was <b className="text-danger">revoked</b>. This agent is flagged as an incident.</>}
          {(kya === 'unverified' || !kya) && <>No KYA attestation yet. Identity exists, but wallet control is not proven.</>}
        </StepRow>

        <StepRow state={state(3)} outcome={score >= 200 ? 'pass' : 'fail'} Icon={Gauge} title="Score reputation" standard="deterministic 0-1000">
          <>
            <b className="font-mono text-foreground">{score}</b> / 1000 from real on-chain settlements
            {bd && <> (settlement {bd.settlement}, validation {bd.validation}, tenure {bd.tenure}{typeof bd.behavior === 'number' ? `, behavior ${bd.behavior >= 0 ? '+' : ''}${bd.behavior}` : ''})</>}
            {sybil && sybil !== 'none' && <>. Sybil signals: <b className="text-foreground">{sybil}</b></>}
            . Recent activity outweighs ancient history.
          </>
        </StepRow>

        <StepRow state={state(4)} outcome={verdict === 'ALLOW' ? 'pass' : verdict === 'WARN' ? 'caution' : 'fail'} Icon={Scale} title="Decide" standard="risk engine">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <VerdictBadge verdict={verdict} size="md" />
            <span className="text-sm font-medium leading-relaxed text-foreground/70">{reasons.join(' · ')}</span>
          </div>
        </StepRow>
      </div>
    </div>
  )
}
