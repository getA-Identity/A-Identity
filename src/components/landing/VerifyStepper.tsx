import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, Check, X, ShieldCheck, ShieldAlert, ShieldX, Fingerprint, BadgeCheck, Gauge, Scale } from 'lucide-react'
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

const VERDICT_UI: Record<Verdict, { color: string; Icon: typeof ShieldCheck }> = {
  ALLOW: { color: '#059669', Icon: ShieldCheck },
  WARN: { color: '#d97706', Icon: ShieldAlert },
  DENY: { color: '#dc2626', Icon: ShieldX },
}

function StepRow({ state, ok, Icon, title, standard, children }: {
  state: StepState
  /** Whether the completed step passed (check) or surfaced a problem (x). */
  ok: boolean
  Icon: typeof Fingerprint
  title: string
  standard: string
  children?: React.ReactNode
}) {
  return (
    <div className={`flex gap-3.5 px-5 py-4 transition-opacity ${state === 'idle' ? 'opacity-35' : 'opacity-100'}`}>
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-background">
        {state === 'running' ? (
          <Loader2 size={14} className="animate-spin text-accent" />
        ) : state === 'done' ? (
          ok ? <Check size={14} className="text-emerald-600" /> : <X size={14} className="text-red-600" />
        ) : (
          <Icon size={13} className="text-foreground/40" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-foreground/50">{standard}</span>
        </div>
        <AnimatePresence>
          {state === 'done' && (
            <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
              className="mt-1 text-sm text-foreground/60">
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
  const { color, Icon: VIcon } = VERDICT_UI[verdict]
  const bd = reputation?.breakdown

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-3">
        <span className="text-[11px] font-bold uppercase tracking-wide text-foreground/50">Verification pipeline</span>
        <span className="ml-2 font-mono text-[11px] text-foreground/40">{query}</span>
      </div>
      <div className="divide-y divide-border/60">
        <StepRow state={state(1)} ok={verified} Icon={Fingerprint} title="Resolve identity" standard="ERC-8004">
          {verified && identity?.partial ? (
            <>Live read from the OKX.AI IdentityRegistry on X Layer: this wallet <b className="text-foreground">holds an ERC-8004 identity token</b>. The public RPC cannot enumerate the token id; search by agent id for the full record.</>
          ) : verified && identity ? (
            <>Live read from the IdentityRegistry on {identity.chain === 'xlayer' ? 'X Layer (OKX.AI)' : 'Circle Arc'}: token <b className="font-mono text-foreground">#{identity.tokenId}</b>, owner <b className="font-mono text-foreground">{identity.owner.slice(0, 6)}…{identity.owner.slice(-4)}</b>. The identity exists on-chain.</>
          ) : verified ? (
            <>Registered on the platform with a verified on-chain anchor.</>
          ) : (
            <>No ERC-8004 identity found for this query. An unidentifiable counterparty cannot be trusted.</>
          )}
        </StepRow>

        <StepRow state={state(2)} ok={kya === 'verified'} Icon={BadgeCheck} title="Know Your Agent" standard="KYA">
          {kya === 'verified' && <>Wallet control attested in the ValidationRegistry. The operator proved they hold the agent&apos;s keys.</>}
          {kya === 'revoked' && <>KYA attestation was <b className="text-red-600">revoked</b>. This agent is flagged as an incident.</>}
          {(kya === 'unverified' || !kya) && <>No KYA attestation yet. Identity exists, but wallet control is not proven.</>}
        </StepRow>

        <StepRow state={state(3)} ok={score >= 200} Icon={Gauge} title="Score reputation" standard="deterministic 0-1000">
          <>
            <b className="font-mono text-foreground">{score}</b> / 1000 from real on-chain settlements
            {bd && <> (settlement {bd.settlement}, validation {bd.validation}, tenure {bd.tenure}{typeof bd.behavior === 'number' ? `, behavior ${bd.behavior >= 0 ? '+' : ''}${bd.behavior}` : ''})</>}
            {sybil && sybil !== 'none' && <>. Sybil signals: <b className="text-foreground">{sybil}</b></>}
            . Recent activity outweighs ancient history.
          </>
        </StepRow>

        <StepRow state={state(4)} ok={verdict === 'ALLOW'} Icon={Scale} title="Decide" standard="risk engine">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold" style={{ color, borderColor: `${color}55`, backgroundColor: `${color}14` }}>
              <VIcon size={13} /> {verdict}
            </span>
            <span className="text-sm text-foreground/60">{reasons.join(' · ')}</span>
          </div>
        </StepRow>
      </div>
    </div>
  )
}
