import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { apiFetch } from '../../lib/api'
import { formatUsd, toolPath, type PaidTool, type Poster } from '../../lib/algorand/x402pay'
import { paymentIsOut, purchase, type PayStep, type Stop } from '../../lib/algorand/purchase'
import {
  batchUsd,
  bodyFor,
  BREAKDOWN,
  labelFor,
  readAgentId,
  readAgentIds,
  readAnswer,
  readDealSize,
  readPayAddress,
  readPrices,
  type Answer,
  type Decision,
  type Prices,
  type ServiceInput,
} from '../../lib/algorand/services'
import { short } from '../../lib/format'
import { cn } from '../../lib/utils'
import { REPORT_BOUGHT_EVENT, addAnswer, loadAnswers, saveBought, storeAnswers, type SavedAnswer } from './bought'
import { plural } from './format'
import { PayProgress, StopBox, TxLink } from './Receipt'
import ReportView from './ReportView'
import { useCheckWallet } from './walletContext'

/**
 * "Paid checks": every paid Algorand service, bought from the visitor's own wallet on this
 * page. One row per question, a live price, Buy opens the one input it needs, Pay runs the
 * same purchase the detailed report does (lib/algorand/purchase.ts). Prices come from the
 * rail's own status; each Pay is checked against the 402 before the wallet is asked to sign.
 */

/** The last finished check in the main box: what was typed, what it resolved to, whether it was ever used. */
export type CheckedAddress = { query: string; address: string | null; neverUsed: boolean }

type PriceState = { s: 'loading' } | { s: 'ok'; prices: Prices } | { s: 'off' } | { s: 'failed' }

async function loadPrices(): Promise<PriceState> {
  try {
    const res = await apiFetch('/api/x402/algorand/status', { retries: 2, timeoutMs: 15_000 })
    if (!res.ok) return { s: 'failed' }
    const body = (await res.json().catch(() => null)) as { configured?: unknown } | null
    if (!body || typeof body !== 'object') return { s: 'failed' }
    if (body.configured === false) return { s: 'off' }
    const prices = readPrices(body)
    return prices ? { s: 'ok', prices } : { s: 'failed' }
  } catch {
    return { s: 'failed' }
  }
}

/** The paid endpoint of one tool, reached the way every other call on this page is. One send, never retried. */
const posterFor =
  (tool: PaidTool): Poster =>
  (body, headers) =>
    apiFetch(toolPath(tool), { method: 'POST', body, headers, timeoutMs: 120_000 })

type Service = { tool: PaidTool; question: string; detail: string }

const SERVICES: Service[] = [
  { tool: 'pay_check', question: 'Who pays this Algorand address?', detail: 'Its biggest payers, its last payments, and the wallet that created it.' },
  { tool: 'verify_agent', question: 'Is this AI agent who it says it is?', detail: 'Its on-chain identity and its KYA status.' },
  { tool: 'reputation_score', question: 'How has this AI agent behaved?', detail: 'A score out of 1000, and what it is made of.' },
  { tool: 'risk_check', question: 'Should I pay this AI agent?', detail: 'Allow, warn or deny, with the reasons.' },
  { tool: 'agent_passport', question: 'Everything about this AI agent, in one answer', detail: 'Identity, KYA, score and verdict together.' },
  { tool: 'agent_batch_audit', question: 'Check a whole list of AI agents', detail: 'A verdict for each agent on your list.' },
]

function priceLabel(tool: PaidTool, p: Prices): string {
  if (tool === 'agent_batch_audit') return `${formatUsd(p.batch.perAgentUsd)} per agent`
  return formatUsd(p[tool])
}

export default function PaidChecks({
  boxValue,
  checked,
  reportAddress,
}: {
  /** The text in the main box right now. */
  boxValue: string
  checked: CheckedAddress | null
  /** The address whose detailed report card is showing above, if any. */
  reportAddress: string | null
}) {
  const [price, setPrice] = useState<PriceState>({ s: 'loading' })
  const seq = useRef(0)

  const load = useCallback(async () => {
    const id = ++seq.current
    setPrice({ s: 'loading' })
    const next = await loadPrices()
    if (id === seq.current) setPrice(next)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const prices = price.s === 'ok' ? price.prices : null

  return (
    <section aria-labelledby="paid-checks-title" className="mt-10">
      <h2 id="paid-checks-title" className="text-xl font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
        Paid checks
      </h2>
      {price.s === 'failed' && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-foreground/70">
          Prices could not be loaded just now.
          <button type="button" onClick={() => void load()} className="font-semibold text-accent hover:underline">
            Try again
          </button>
        </p>
      )}
      {price.s === 'off' && <p className="mt-2 text-sm text-foreground/70">Paid checks are not available right now.</p>}
      <div className="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {SERVICES.map((s) => (
          <ServiceRow key={s.tool} service={s} prices={prices} pricesLoading={price.s === 'loading'} boxValue={boxValue} checked={checked} reportAddress={reportAddress} />
        ))}
      </div>
      <p className="mt-2.5 text-xs leading-relaxed text-foreground/55">
        Paid in USDC on Algorand from your own wallet. Network fees are covered. If an answer cannot be produced, nothing is charged.
      </p>
    </section>
  )
}

// ---- one row ----

type RowPay = { s: 'idle' } | PayStep | { s: 'stopped'; stop: Stop }

const fieldHint = 'mt-1.5 text-xs leading-relaxed'
const hintText = (problem: string | null, fallback: string) => (
  <p className={cn(fieldHint, problem ? 'font-semibold text-danger' : 'text-foreground/55')}>{problem ?? fallback}</p>
)
const inputProps = { autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const

function ServiceRow({
  service,
  prices,
  pricesLoading,
  boxValue,
  checked,
  reportAddress,
}: {
  service: Service
  prices: Prices | null
  pricesLoading: boolean
  boxValue: string
  checked: CheckedAddress | null
  reportAddress: string | null
}) {
  const { tool } = service
  const w = useCheckWallet()
  const [open, setOpen] = useState(false)
  const [agentId, setAgentId] = useState('')
  const [deal, setDeal] = useState('')
  const [ids, setIds] = useState('')
  const [address, setAddress] = useState('')
  const [pay, setPay] = useState<RowPay>({ s: 'idle' })
  const [answers, setAnswers] = useState<SavedAnswer[]>([])
  /** The body of a payment that is out or went through without an answer: not offered again here. */
  const [locked, setLocked] = useState<string | null>(null)
  const answersRef = useRef<SavedAnswer[]>([])
  /** Which attempt is current: a wallet that answers after a cancel is ignored. */
  const attempt = useRef(0)
  const release = useRef<(() => void) | null>(null)

  // Answers bought earlier in this tab. Read after the first render, which must match the prerender.
  useEffect(() => {
    const saved = loadAnswers(tool)
    answersRef.current = saved
    setAnswers(saved)
    if (saved.length) setOpen(true)
  }, [tool])

  // Leaving while the payment is out makes its answer unreadable; the browser asks first.
  useEffect(() => {
    if (pay.s !== 'confirming') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pay.s])

  // Leaving the page before the payment is sent drops any signature that arrives later.
  useEffect(
    () => () => {
      attempt.current += 1
      release.current?.()
    },
    [],
  )

  // What this row would be sent, and what is wrong with it if it cannot be sent yet.
  let input: ServiceInput | null = null
  let problem: string | null = null
  let dealProblem: string | null = null
  let batchCount = 0
  const box = boxValue.trim()
  switch (tool) {
    case 'pay_check': {
      const raw = box || address
      const p = readPayAddress(raw)
      if (!p.ok) problem = p.problem
      else {
        const same = checked !== null && checked.query === raw
        if (same && checked.neverUsed) problem = 'This address has never been used, so the report would be empty.'
        else input = { tool, address: same && checked.address ? checked.address : p.value }
      }
      break
    }
    case 'agent_batch_audit': {
      const r = readAgentIds(ids, prices?.batch.maxAgents ?? 50)
      batchCount = r.ids.length
      if (r.problem) problem = r.problem
      else if (r.ids.length) input = { tool, agentIds: r.ids }
      break
    }
    case 'risk_check': {
      const a = readAgentId(agentId)
      const d = readDealSize(deal)
      if (!a.ok) problem = a.problem
      if (!d.ok) dealProblem = d.problem
      if (a.ok && d.ok) input = { tool, agentId: a.value, amountUsd: d.value }
      break
    }
    default: {
      const a = readAgentId(agentId)
      if (a.ok) input = { tool, agentId: a.value }
      else problem = a.problem
    }
  }
  const expectedUsd = !prices ? null : tool === 'agent_batch_audit' ? (batchCount > 0 ? batchUsd(prices.batch.perAgentUsd, batchCount) : null) : prices[tool]
  const body = input ? bodyFor(input) : null
  const busyHere = pay.s !== 'idle' && pay.s !== 'stopped'
  const isLocked = body !== null && body === locked
  const canPay = input !== null && expectedUsd !== null && !busyHere && !w.paying && !isLocked
  const priceText = expectedUsd !== null ? formatUsd(expectedUsd) : null

  const run = async () => {
    if (!input || expectedUsd === null || busyHere || w.paying || isLocked) return
    const sent = bodyFor(input)
    const label = labelFor(input)
    const mine = ++attempt.current
    const alive = () => mine === attempt.current
    const done = w.holdPayment()
    release.current = done
    try {
      const end = await purchase<Answer>({
        post: posterFor(tool),
        body: sent,
        expectedUsd,
        what: 'this check',
        read: (json) => readAnswer(tool, json),
        wallet: w.wallet,
        askWallet: w.askWallet,
        alive,
        step: (s) => {
          if (alive()) setPay(s)
        },
      })
      if (end === null) return
      if (end.kind === 'closed') {
        setPay({ s: 'idle' })
        return
      }
      if (end.kind === 'stopped') {
        setPay({ s: 'stopped', stop: end.stop })
        if (paymentIsOut(end.stop)) setLocked(sent)
        // The signed payment left the page: the balance may have moved.
        if (end.stop.kind === 'pending' || end.stop.kind === 'unknown' || end.stop.kind === 'paid_unreadable') w.refreshBalance()
        return
      }
      const saved: SavedAnswer = { tool, label, body: sent, raw: end.raw, tx: end.tx, amountUsd: end.amountUsd, at: new Date().toISOString() }
      const next = addAnswer(saved, answersRef.current)
      answersRef.current = next
      storeAnswers(tool, next)
      setAnswers(next)
      if (end.answer.tool === 'pay_check') {
        // Kept where the report card above looks for it too, and that card is told.
        const key = end.answer.report.address ?? (input.tool === 'pay_check' ? input.address : '')
        if (key) {
          saveBought(key, { report: end.answer.report, tx: end.tx, amountUsd: end.amountUsd })
          window.dispatchEvent(new CustomEvent(REPORT_BOUGHT_EVENT, { detail: { address: key } }))
        }
      }
      setPay({ s: 'idle' })
      setAgentId('')
      setDeal('')
      setIds('')
      setAddress('')
      w.refreshBalance()
    } finally {
      done()
      if (release.current === done) release.current = null
    }
  }

  /** Stop waiting for the wallet. A signature that still arrives is dropped, never sent. */
  const cancelSigning = () => {
    attempt.current += 1
    release.current?.()
    release.current = null
    setPay({ s: 'stopped', stop: { kind: 'cancelled' } })
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void run()
  }

  const id = `paid-${tool}`
  const priceSlot = prices ? (
    <span className="whitespace-nowrap text-sm font-bold tabular-nums text-foreground">{priceLabel(tool, prices)}</span>
  ) : pricesLoading ? (
    <span className="h-4 w-10 animate-pulse rounded bg-foreground/[0.08]" aria-hidden="true" />
  ) : null

  return (
    <div>
      <div className="flex items-start gap-3 px-4 py-4 sm:px-5">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-snug text-foreground">{service.question}</p>
          <p className="mt-0.5 text-[13px] leading-snug text-foreground/55">{service.detail}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {priceSlot}
          <Button
            type="button"
            size="sm"
            variant={open ? 'outline' : 'default'}
            aria-expanded={open}
            aria-controls={`${id}-body`}
            disabled={open ? busyHere : !prices}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Close' : 'Buy'}
          </Button>
        </div>
      </div>

      {open && (
        <div id={`${id}-body`} className="border-t border-border bg-background/40 px-4 pb-4 pt-4 sm:px-5">
          <form onSubmit={onSubmit}>
            {tool === 'pay_check' &&
              (box ? (
                <p className="break-words text-sm leading-relaxed text-foreground/75 [overflow-wrap:anywhere]">
                  About <span className="font-mono font-semibold text-foreground" title={box}>{/^[A-Z2-7]{58}$/.test(box) ? short(box, 4) : box}</span>, from the box above.
                  {problem && <span className="mt-1 block font-semibold text-danger">{problem}</span>}
                </p>
              ) : (
                <>
                  <label htmlFor={`${id}-address`} className="block text-sm font-semibold text-foreground">
                    Algorand address or service link
                  </label>
                  <Input id={`${id}-address`} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Address or service link" maxLength={512} className="mt-1.5 h-11 text-base" {...inputProps} />
                  {hintText(problem, 'Paste the address you are about to pay.')}
                </>
              ))}

            {(tool === 'verify_agent' || tool === 'reputation_score' || tool === 'risk_check' || tool === 'agent_passport') && (
              <>
                <label htmlFor={`${id}-agent`} className="block text-sm font-semibold text-foreground">
                  Agent id
                </label>
                <Input id={`${id}-agent`} value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="#0 or eip155:5042:8004/0" maxLength={200} className="mt-1.5 h-11 text-base" {...inputProps} />
                {hintText(problem, "The agent's number, like #0, its full id, or its owner's 0x address.")}
              </>
            )}

            {tool === 'risk_check' && (
              <div className="mt-3">
                <label htmlFor={`${id}-deal`} className="block text-sm font-semibold text-foreground">
                  Deal size in USD <span className="font-normal text-foreground/55">(optional)</span>
                </label>
                <Input id={`${id}-deal`} value={deal} onChange={(e) => setDeal(e.target.value)} placeholder="25" inputMode="decimal" maxLength={16} className="mt-1.5 h-11 text-base" {...inputProps} />
                {hintText(dealProblem, 'How much you are about to pay it. The verdict is sized to it.')}
              </div>
            )}

            {tool === 'agent_batch_audit' && (
              <>
                <label htmlFor={`${id}-ids`} className="block text-sm font-semibold text-foreground">
                  Agent ids
                </label>
                <textarea
                  id={`${id}-ids`}
                  value={ids}
                  onChange={(e) => setIds(e.target.value)}
                  placeholder={'#0\n#1\neip155:5042:8004/2'}
                  rows={4}
                  className="mt-1.5 flex w-full resize-y rounded-xl border border-foreground/15 bg-card px-3.5 py-2.5 font-mono text-base text-foreground shadow-sm transition-colors placeholder:text-foreground/40 focus:border-accent/40 focus:outline-none focus:ring-2 focus:ring-ring/30"
                  {...inputProps}
                />
                {hintText(problem, `One per line, or separated by commas. Up to ${prices?.batch.maxAgents ?? 50}.`)}
                {prices && batchCount > 0 && !problem && (
                  <p className="mt-1 text-sm font-semibold tabular-nums text-foreground/80">
                    {plural(batchCount, 'agent', 'agents')} at {formatUsd(prices.batch.perAgentUsd)} each: {formatUsd(batchUsd(prices.batch.perAgentUsd, batchCount))}
                  </p>
                )}
              </>
            )}

            {!isLocked && !(pay.s === 'checking' || pay.s === 'signing' || pay.s === 'confirming') && (
              <Button type="submit" className="mt-4 w-full sm:w-auto" disabled={!canPay}>
                {(pay.s === 'quoting' || pay.s === 'wallet') && <Loader2 size={15} className="animate-spin" />}
                {priceText ? `Pay ${priceText}` : 'Pay'}
              </Button>
            )}
          </form>

          {(pay.s === 'checking' || pay.s === 'signing' || pay.s === 'confirming') && (
            <PayProgress step={pay} price={priceText ?? ''} onCancel={cancelSigning} className="mt-4" />
          )}

          {pay.s === 'stopped' && (
            <StopBox stop={pay.stop} noun={tool === 'pay_check' ? 'report' : 'answer'} className="mt-4">
              {pay.stop.kind === 'paid_unreadable' && pay.stop.raw !== undefined && pay.stop.raw !== null && (
                <div className="mt-2">
                  <RawToggle raw={pay.stop.raw} />
                </div>
              )}
            </StopBox>
          )}

          {answers.length > 0 && (
            <div className="mt-4 space-y-3">
              {answers.map((a) => (
                <AnswerCard key={a.tx} saved={a} reportAbove={reportAddress} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---- the answers ----

function RawToggle({ raw }: { raw: unknown }) {
  const [shown, setShown] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-expanded={shown}
        className="text-xs font-semibold text-foreground/60 underline underline-offset-2 hover:text-foreground"
      >
        {shown ? 'Hide raw answer' : 'Show raw answer'}
      </button>
      {shown && (
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground/75">
          {JSON.stringify(raw, null, 2)}
        </pre>
      )}
    </>
  )
}

function PaidLine({ saved }: { saved: SavedAnswer }) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5">
      <CheckCircle2 size={15} className="shrink-0 text-ok" aria-hidden="true" />
      Paid {formatUsd(saved.amountUsd)}. Receipt: <TxLink tx={saved.tx} />
    </p>
  )
}

function AnswerCard({ saved, reportAbove }: { saved: SavedAnswer; reportAbove: string | null }) {
  const answer = readAnswer(saved.tool, saved.raw)

  if (answer?.tool === 'pay_check') {
    const addr = answer.report.address
    if (addr && addr === reportAbove) {
      return (
        <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm text-foreground/75">
          <p>Your report for this address is shown above, under the check.</p>
          <div className="mt-1.5">
            <PaidLine saved={saved} />
          </div>
          <div className="mt-2">
            <RawToggle raw={saved.raw} />
          </div>
        </div>
      )
    }
    return (
      <div>
        <ReportView bought={{ report: answer.report, tx: saved.tx, amountUsd: saved.amountUsd }} className="mt-0 rounded-2xl" />
        <div className="mt-2 px-1">
          <RawToggle raw={saved.raw} />
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card" style={{ fontFeatureSettings: '"calt" 0' }}>
      <div className="px-4 py-4">
        <p className="break-words text-xs text-foreground/55 [overflow-wrap:anywhere]">
          Answer for <span className="font-mono text-foreground/80">{saved.label}</span>
        </p>
        {answer ? <AnswerBody answer={answer} /> : <p className="mt-2 text-sm text-foreground/75">This answer could not be shown here. The raw answer is below.</p>}
      </div>
      <div className="border-t border-border bg-foreground/[0.02] px-4 py-3 text-sm text-foreground/75">
        <PaidLine saved={saved} />
        <div className="mt-2">
          <RawToggle raw={saved.raw} />
        </div>
      </div>
    </div>
  )
}

const DECISION: Record<Decision, { text: string; band: string; border: string; badge: string; plain: string; Icon: typeof Info }> = {
  ALLOW: { text: 'text-ok', band: 'bg-ok/[0.07]', border: 'border-ok/30', badge: 'bg-ok/10 text-ok', plain: 'OK to pay', Icon: CheckCircle2 },
  WARN: { text: 'text-warn', band: 'bg-warn/[0.08]', border: 'border-warn/35', badge: 'bg-warn/10 text-warn', plain: 'Be careful', Icon: AlertTriangle },
  DENY: { text: 'text-danger', band: 'bg-danger/[0.07]', border: 'border-danger/30', badge: 'bg-danger/10 text-danger', plain: "Don't pay", Icon: XCircle },
}

function Verdict({ d }: { d: Decision }) {
  const look = DECISION[d]
  return (
    <div className={cn('mt-2 flex items-center gap-3 rounded-xl border px-3.5 py-3', look.band, look.border)}>
      <look.Icon size={28} className={cn('shrink-0', look.text)} aria-hidden="true" />
      <div>
        <p className={cn('text-3xl font-bold leading-none tracking-tight', look.text)} style={{ fontFamily: 'var(--font-heading)' }}>
          {d}
        </p>
        <p className="mt-1 text-sm font-semibold text-foreground/75">{look.plain}</p>
      </div>
    </div>
  )
}

function Reasons({ reasons, d }: { reasons: string[]; d: Decision }) {
  if (reasons.length === 0) return d === 'ALLOW' ? <p className="mt-3 text-sm text-foreground/70">No warning signs found.</p> : null
  const look = DECISION[d]
  const Icon = d === 'ALLOW' ? Info : look.Icon
  return (
    <ul className="mt-3 space-y-2">
      {reasons.map((r, i) => (
        <li key={i} className="flex gap-2.5 text-sm leading-snug text-foreground/85">
          <Icon size={16} className={cn('mt-0.5 shrink-0', d === 'ALLOW' ? 'text-foreground/45' : look.text)} aria-hidden="true" />
          <span>{r}</span>
        </li>
      ))}
    </ul>
  )
}

function Chips({ items }: { items: { text: string; tone?: string }[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {items.map((c) => (
        <li key={c.text} className={cn('rounded-full border border-border bg-background px-3 py-1 text-[13px] text-foreground/75', c.tone)}>
          {c.text}
        </li>
      ))}
    </ul>
  )
}

const kyaTone = (s: string) => (s === 'verified' ? 'text-ok' : s === 'revoked' ? 'text-danger' : undefined)
const kyaWord = (s: string) => s.replace(/_/g, ' ')

function Score({ score }: { score: number }) {
  return (
    <>
      <p className="mt-2 flex items-baseline gap-1.5">
        <span className="text-4xl font-bold tabular-nums tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
          {score}
        </span>
        <span className="text-sm font-semibold text-foreground/55">out of 1000</span>
      </p>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-foreground/[0.07]" aria-hidden="true">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, score / 10))}%` }} />
      </div>
    </>
  )
}

function AnswerBody({ answer }: { answer: Exclude<Answer, { tool: 'pay_check' }> }) {
  switch (answer.tool) {
    case 'verify_agent': {
      const { verified, kyaStatus, revoked } = answer.a
      const Icon = verified ? CheckCircle2 : XCircle
      return (
        <>
          <p className={cn('mt-2 flex items-center gap-2 text-3xl font-bold tracking-tight', verified ? 'text-ok' : 'text-danger')} style={{ fontFamily: 'var(--font-heading)' }}>
            <Icon size={28} className="shrink-0" aria-hidden="true" />
            {verified ? 'Verified' : 'Not verified'}
          </p>
          <p className="mt-1.5 text-sm text-foreground/75">
            {verified ? 'Its on-chain identity (ERC-8004) was found.' : 'No on-chain identity (ERC-8004) was found for it.'}
          </p>
          <Chips
            items={[
              { text: `KYA (Know Your Agent): ${kyaWord(kyaStatus)}`, tone: kyaTone(kyaStatus) },
              ...(revoked ? [{ text: 'Its KYA was revoked', tone: 'text-danger' }] : []),
            ]}
          />
        </>
      )
    }
    case 'reputation_score': {
      const { score, breakdown, name } = answer.a
      const parts = breakdown.map((b) => `${BREAKDOWN.find((x) => x.key === b.key)?.label ?? b.key} ${b.value}`)
      return (
        <>
          {name && <p className="mt-1 text-sm font-semibold text-foreground/80">{name}</p>}
          <Score score={score} />
          {parts.length > 0 && <p className="mt-2 text-sm leading-snug text-foreground/70">From {parts.join(', ')}.</p>}
        </>
      )
    }
    case 'risk_check': {
      const { decision, reasons, amountUsd } = answer.a
      return (
        <>
          <Verdict d={decision} />
          {amountUsd !== null && <p className="mt-2 text-xs text-foreground/55">For a {formatUsd(amountUsd)} deal.</p>}
          <Reasons reasons={reasons} d={decision} />
        </>
      )
    }
    case 'agent_passport': {
      const { decision, reasons, score, kyaStatus, verified, name } = answer.a
      return (
        <>
          {name && <p className="mt-1 text-sm font-semibold text-foreground/80">{name}</p>}
          <Verdict d={decision} />
          <Chips
            items={[
              ...(score !== null ? [{ text: `Score ${score} out of 1000` }] : []),
              ...(kyaStatus ? [{ text: `KYA: ${kyaWord(kyaStatus)}`, tone: kyaTone(kyaStatus) }] : []),
              { text: verified ? 'Identity: found on-chain' : 'Identity: not found', tone: verified ? 'text-ok' : 'text-danger' },
            ]}
          />
          <Reasons reasons={reasons} d={decision} />
        </>
      )
    }
    case 'agent_batch_audit': {
      const { summary, results } = answer.a
      return (
        <>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {(['ALLOW', 'WARN', 'DENY'] as Decision[]).map((d) => (
              <div key={d} className={cn('rounded-xl border px-2 py-2 text-center', DECISION[d].band, DECISION[d].border)}>
                <p className={cn('text-2xl font-bold tabular-nums', DECISION[d].text)}>{summary[d]}</p>
                <p className="text-[11px] font-semibold text-foreground/70">{d}</p>
              </div>
            ))}
          </div>
          <ul className="mt-3 divide-y divide-border">
            {results.map((r) => (
              <li key={r.agentId} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                <span className="min-w-0 truncate font-mono text-foreground/85" title={r.agentId}>
                  {r.agentId}
                </span>
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold', DECISION[r.decision].badge)}>{r.decision}</span>
              </li>
            ))}
          </ul>
        </>
      )
    }
  }
}
