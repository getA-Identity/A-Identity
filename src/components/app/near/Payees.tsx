/**
 * Every payee in view, with what the A-Identity registry says about it and what the vault would
 * do with an agent payment to it right now.
 *
 * The verdict is the registry's get_verdict, the same read the vault makes before every payment.
 * The "agent payment now" column is computed in this browser from those live reads (model.ts
 * follows the contract's own order), and says so; the ceiling and the day's cap still apply to
 * whatever amount the agent asks for. The two refusal counts are kept apart on purpose: only the
 * registry's DENY refusals say something about the payee, while the agent's own recorded
 * refusals are its word, which a prompt-injected agent could write about anyone.
 */
import { useState, type FormEvent } from 'react'
import { CircleCheck, Hourglass, Loader2, Search, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, Users } from 'lucide-react'
import { nearAccountUrl } from '../../../lib/near/chain'
import { isNearAccountId } from '../../../lib/near/ids'
import { predictionFor, type Prediction, type VerdictRead } from '../../../lib/near/model'
import type { PayeeFacts, VaultSnapshot } from '../../../lib/near/read'
import { BUTTON_QUIET, INPUT } from './styles'
import { Card, ExtLink, IdText, Mono, Pill } from './ui'

/** `noRegistry`: the vault asks no registry, so there is no verdict to read, rather than one not read yet. */
export function VerdictPill({ read, loading, noRegistry }: { read: VerdictRead | undefined; loading?: boolean; noRegistry?: boolean }) {
  if (noRegistry)
    return (
      <Pill tone="muted" icon={<ShieldQuestion size={11} className="text-foreground/70" aria-hidden="true" />}>
        No registry
      </Pill>
    )
  if (read === undefined || (read === null && loading)) return <Pill tone="muted">{loading ? 'Reading...' : 'Not read'}</Pill>
  if (read === null) return <Pill tone="muted">Not read</Pill>
  if (!read.ok)
    return (
      <Pill tone="danger" icon={<ShieldX size={11} className="text-danger" aria-hidden="true" />}>
        Unreadable: the vault refuses
      </Pill>
    )
  const v = read.verdict
  if (!v)
    return (
      <Pill tone="muted" icon={<ShieldQuestion size={11} className="text-foreground/70" aria-hidden="true" />}>
        No verdict
      </Pill>
    )
  if (v.verdict === 'ALLOW')
    return (
      <Pill tone="ok" icon={<ShieldCheck size={11} className="text-ok" aria-hidden="true" />}>
        ALLOW
      </Pill>
    )
  if (v.verdict === 'WARN')
    return (
      <Pill tone="warn" icon={<ShieldAlert size={11} className="text-warn" aria-hidden="true" />}>
        WARN
      </Pill>
    )
  return (
    <Pill tone="danger" icon={<ShieldX size={11} className="text-danger" aria-hidden="true" />}>
      DENY
    </Pill>
  )
}

export function PredictionPill({ p }: { p: Prediction }) {
  if (p.kind === 'paid')
    return (
      <Pill tone="ok" icon={<CircleCheck size={11} className="text-ok" aria-hidden="true" />}>
        Paid
      </Pill>
    )
  if (p.kind === 'held')
    return (
      <Pill tone="warn" icon={<Hourglass size={11} className="text-warn" aria-hidden="true" />}>
        Held for you
      </Pill>
    )
  if (p.kind === 'refused')
    return (
      <Pill tone="danger" icon={<ShieldX size={11} className="text-danger" aria-hidden="true" />}>
        Refused on chain
      </Pill>
    )
  return <Pill tone="muted">Not decided here</Pill>
}

export default function PayeesCard({
  s,
  payees,
  byPayee,
  loading,
  onCheck,
}: {
  s: VaultSnapshot
  payees: string[]
  byPayee: Map<string, PayeeFacts>
  loading: boolean
  onCheck: (payee: string) => void
}) {
  const [input, setInput] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const p = input.trim()
    if (!isNearAccountId(p)) {
      setProblem('Enter a NEAR account id, such as merchant.testnet: lowercase letters, digits, and . - _ between them.')
      return
    }
    setProblem(null)
    setInput('')
    onCheck(p)
  }
  return (
    <Card title="Payees and their verdicts" icon={<Users size={14} />} aside={<Pill tone="muted">get_verdict and the vault's counters, read live</Pill>}>
      <p className="text-xs text-foreground/80">
        The verdict is what the registry answers the vault before every payment. "Agent payment now" is worked out in this browser from these live
        reads, in the contract's own order; the per-payment ceiling and the day's cap still apply to the amount.
      </p>
      {payees.length === 0 ? (
        <p className="mt-3 text-sm text-foreground/80">No payee is waiting or listed yet. Check any account below.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {payees.map((p) => {
            const f = byPayee.get(p)
            const prediction = predictionFor(s, p, f)
            const reasons = f?.verdict && f.verdict.ok && f.verdict.verdict ? f.verdict.verdict.reasons : []
            return (
              <li key={p} className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <ExtLink href={nearAccountUrl(p)} className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">
                    <IdText id={p} />
                  </ExtLink>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <VerdictPill read={f ? f.verdict : undefined} loading={loading} noRegistry={!s.config.registryId} />
                    {f && <PredictionPill p={prediction} />}
                  </span>
                </div>
                {f && (
                  <div className="mt-1.5 space-y-1 text-xs text-foreground/85">
                    <p>
                      <span className="font-semibold text-foreground">Agent payment now: </span>
                      {prediction.text}
                    </p>
                    {reasons.length > 0 && (
                      <p>
                        Registry reasons:{' '}
                        {/* The registry's words: nothing makes them unique, so the position keys them. */}
                        {reasons.map((r, i) => (
                          <span key={`${i}:${r}`}>
                            {i > 0 ? ', ' : ''}
                            <code className="rounded bg-foreground/[0.06] px-1 font-mono text-[11px] text-foreground">{r}</code>
                          </span>
                        ))}
                      </p>
                    )}
                    <p className="text-foreground/80">
                      Paid here {f.paidCount ?? '?'} time{f.paidCount === 1 ? '' : 's'}; refused by the registry {f.refusalCount ?? '?'}; refusals the agent recorded itself{' '}
                      {f.guardRefusals ?? '?'} (the agent's word, not a verdict){s.allowlist.includes(p) ? '; on the allowlist' : ''}.
                    </p>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="near-check-payee" className="text-[11px] font-semibold text-foreground/80">
            Check any payee
          </label>
          <input
            id="near-check-payee"
            className={`${INPUT} font-mono text-xs`}
            placeholder="merchant.testnet"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <button type="submit" className={BUTTON_QUIET}>
          {loading ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Search size={12} aria-hidden="true" />}
          Check live
        </button>
        {problem && (
          <p role="alert" className="w-full text-xs text-foreground">
            {problem}
          </p>
        )}
      </form>
      {!s.config.registryId && (
        <p className="mt-3 text-xs text-foreground/80">
          <Mono>{s.vaultId}</Mono> reads no registry, so every payee is unjudged to it.
        </p>
      )}
    </Card>
  )
}
