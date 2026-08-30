import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, CheckCircle2, Clock, ExternalLink, FileText, FlaskConical, Globe, Info, KeyRound, Layers, Link2, Receipt, Send, ShieldCheck, ShieldQuestion, Store, Wallet, XCircle, Zap } from 'lucide-react'
import { authHeaders } from '../../store/auth'

import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { fetchPlatformAgents } from '../../lib/platformAgents'
import { pickPrimaryAgent } from '../../lib/pickAgent'
import { short } from '../../lib/format'
import { cn } from '../../lib/utils'
import { CHAINS, type Chain, type ChainId } from '../../lib/chains'
import { useSelectedAgent } from '../../store/agent'
import { useTabCarousel } from '../../hooks/useTabCarousel'
import AgentSelect from '../../components/app/AgentSelect'
import AppPage from '../../components/app/AppPage'
import ChainLogo from '../../components/app/ChainLogo'
import { Badge } from '../../components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip'
import { Skeleton } from '../../components/ui/skeleton'

/* The rails below the payment queue used to render as one 11-panel column: every panel
   mounted at once, each firing its own request, and the page you actually came for was
   buried. They are grouped into tabs and code-split, so only the panels you open load. */
const AutopilotPanel = lazy(() => import('../../components/app/settlements/AutopilotPanel'))
const SessionKeyPanel = lazy(() => import('../../components/app/settlements/SessionKeyPanel'))
const BatchPanel = lazy(() => import('../../components/app/settlements/BatchPanel'))
const X402Panel = lazy(() => import('../../components/app/settlements/X402Panel'))
const NanopayPanel = lazy(() => import('../../components/app/settlements/NanopayPanel'))
const EscrowPanel = lazy(() => import('../../components/app/settlements/EscrowPanel'))
const TrustOraclePanel = lazy(() => import('../../components/app/settlements/TrustOraclePanel'))
const GatewayPanel = lazy(() => import('../../components/app/settlements/GatewayPanel'))
const CctpPanel = lazy(() => import('../../components/app/settlements/CctpPanel'))
const AppKitPanel = lazy(() => import('../../components/app/settlements/AppKitPanel'))
const GasPanel = lazy(() => import('../../components/app/settlements/GasPanel'))

type Tab = 'payments' | 'automation' | 'commerce' | 'rails'

const TABS: { id: Tab; label: string; hint: string; icon: typeof Send }[] = [
  { id: 'payments', label: 'Payments', hint: 'Create a payment and work the approval queue.', icon: Send },
  { id: 'automation', label: 'Automation', hint: 'Let the agent act on its own within the limits you set.', icon: Bot },
  { id: 'commerce', label: 'Agent commerce', hint: 'Getting paid by other agents, and paying them safely.', icon: Store },
  { id: 'rails', label: 'Rails', hint: 'Where the money can move, and what it costs to move it.', icon: Globe },
]

/** Placeholder while a tab's code-split panels arrive. */
function PanelFallback() {
  return (
    <div className="mt-4 space-y-4">
      {[0, 1].map((i) => (
        <div key={i} className="rounded-2xl border border-border bg-card p-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-3 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </div>
      ))}
    </div>
  )
}

type Status =
  | 'auto_approved'
  | 'pending_approval'
  | 'approved'
  | 'executed_simulated'
  | 'executed_onchain'
  | 'rejected'

type Instruction = {
  id: string
  agentId: string
  type: string
  amountUsd: number
  count: number
  payee: string
  memo: string
  status: Status
  policyNote: string
  txHash?: string
  explorerUrl?: string
  enforcedBy?: 'server' | 'circle-agent-stack' | 'onchain-vault' | 'session-key'
  /** On-chain Memo audit trail (Arc Memo precompile): the indexed memoId and the
   *  decoded "why" payload emitted alongside the USDC transfer. */
  memoId?: string
  memoReason?: string
  /**
   * The same "why" payload for settlements that CANNOT carry a Memo: the vault and the
   * Circle wallet are smart contracts and cannot call the precompile. Written by the
   * server after the receipt, so it is a real audit record but NOT on-chain evidence.
   * The two never both appear on one instruction, and the UI must not dress this one up
   * as a chain receipt.
   */
  offchainAuditId?: string
  offchainAuditReason?: string
  createdAt: string
}

type Agent = { id: string; name: string }

const TAB_ORDER = TABS.map((t) => t.id)

/**
 * Which chain a row settled on, READ FROM THE ROW rather than assumed.
 *
 * This screen used to print "Settled on Arc" and "View on arcscan" on every executed row,
 * which was true only for as long as Arc was the only rail. The explorer URL the backend
 * attaches to a receipt is the one piece of chain evidence a row actually carries, so the
 * label is derived from it by matching against the generated chain registry. A new chain
 * therefore names itself here the day it lands in the registry, and a URL we do not
 * recognise stays honestly generic ("Settled on-chain") instead of borrowing a chain's
 * name it cannot prove.
 */
function receiptChain(explorerUrl?: string): Chain | undefined {
  if (!explorerUrl) return undefined
  return CHAINS.find((c) => c.explorer && explorerUrl.startsWith(c.explorer))
}

/** "Arc testnet" / "Base mainnet". Never typed anywhere, always read off the registry. */
function chainLabel(c: Chain): string {
  return `${c.shortName} ${c.testnet ? 'testnet' : 'mainnet'}`
}

/** The explorer's own host, so a receipt link names where it actually goes. */
function explorerHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'the explorer'
  }
}

/** Column headings for the queue. Kept beside the row grid so the two cannot drift. */
const QUEUE_COLS = 'sm:grid sm:grid-cols-[10.5rem_minmax(0,1fr)_8rem] sm:gap-5'

export default function Settlements() {
  const [agents, setAgents] = useState<Agent[]>([])
  const agentId = useSelectedAgent((s) => s.agentId)
  const syncRoster = useSelectedAgent((s) => s.syncRoster)
  const [items, setItems] = useState<Instruction[]>([])
  const [amount, setAmount] = useState('0.01')
  const [payee, setPayee] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('payments')
  // Display scope for the queue. The chips used to be a hardcoded "All chains / Circle Arc"
  // pair that both printed the SAME count and filtered nothing, which is a control that
  // lies. They are now built from the chains the rows themselves settled on, and selecting
  // one actually narrows the list.
  const [chainScope, setChainScope] = useState<ChainId | 'all'>('all')
  // Directional carousel: the pane renders the committed tab; direction follows
  // the tab order, so clicking rightward always slides forward.
  const { shown: shownTab, className: paneClass } = useTabCarousel(tab, TAB_ORDER)
  /** Id of the pending payment being edited, and the values being edited into it. */
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ amount: string; payee: string } | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const data = await fetchPlatformAgents<Agent>()
        setAgents(data.agents)
        syncRoster(data.agents.map((a) => a.id), pickPrimaryAgent(data.agents)?.id)
        if (!data.agents.length) setLoading(false)
      } catch {
        setError(BACKEND_UNREACHABLE)
        setLoading(false)
      }
    })()
  }, [syncRoster])

  // `isActive` guards setState so a late response for a previously-selected agent can't
  // overwrite the settlements now shown for a different one.
  const load = useCallback(async (id: string, isActive: () => boolean = () => true) => {
    try {
      const res = await apiFetch(`/api/instructions?agentId=${id}`)
      const data = (await res.json()) as { instructions: Instruction[] }
      // Pin real on-chain settlements to the top, then the active queue, then rejected,
      // then simulated rows, so the on-chain proof leads instead of being buried under
      // repeated "simulated" lines. Newest first within each group.
      const rank = (s: Status) =>
        s === 'executed_onchain' ? 0
          : s === 'pending_approval' || s === 'approved' || s === 'auto_approved' ? 1
          : s === 'rejected' ? 2
          : 3
      const sorted = [...data.instructions].sort(
        (a, b) => rank(a.status) - rank(b.status) || b.createdAt.localeCompare(a.createdAt),
      )
      if (isActive()) { setItems(sorted); setError(null) }
    } catch {
      if (isActive()) setError('Could not load settlements.')
    } finally {
      if (isActive()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    if (agentId) load(agentId, () => active)
    return () => { active = false }
  }, [agentId, load])

  const createPayment = async () => {
    if (!agentId) return
    setBusy('create')
    setError(null)
    try {
      const res = await apiFetch('/api/instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          agentId,
          type: 'payment',
          amountUsd: Math.max(0, Number(amount) || 0), // never send a negative amount
          payee: payee.trim() || 'agent://provider',
        }),
        onWaking: () => setError('Waking up the backend (free tier)…'),
      })
      if (!res.ok) {
        const j = await readJson<{ error?: string }>(res)
        setError(explainError(res.status, j.error))
        return
      }
      setPayee('')
      setError(null)
      await load(agentId)
    } catch {
      setError('Could not create the payment. The backend may be waking up, try again in a moment.')
    } finally {
      setBusy(null)
    }
  }

  /**
   * Edit a pending payment: reject the original, then create a replacement.
   *
   * Nothing is rewritten in place. The queue keeps both the payment that was proposed and
   * the one that was actually authorised, so an approval always points at the exact terms
   * a human saw. A pending instruction has not committed against the daily cap, so there
   * is nothing to unwind when it is rejected.
   *
   * Order is deliberate. Rejecting first means a failed create leaves the original
   * cancelled, and we keep the editor open holding the values so it can be retried. The
   * other order would risk two live payments for the same thing, and someone approving
   * both, which is the worse failure by a distance.
   */
  const saveEdit = async (id: string) => {
    if (!draft) return
    const amountUsd = Math.max(0, Number(draft.amount) || 0)
    const nextPayee = draft.payee.trim()
    if (!nextPayee) { setError('Give the replacement a payee.'); return }
    setBusy(id)
    setError(null)
    try {
      const rej = await apiFetch('/api/instructions/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id, reason: 'Cancelled by a human, replaced with edited terms.' }),
        onWaking: () => setError('Waking up the backend (free tier)…'),
      })
      if (!rej.ok) {
        const j = await readJson<{ error?: string }>(rej)
        setError(explainError(rej.status, j.error))
        return
      }

      const made = await apiFetch('/api/instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId, type: 'payment', amountUsd, payee: nextPayee }),
      })
      if (!made.ok) {
        const j = await readJson<{ error?: string }>(made)
        setError(
          `The original was cancelled but the replacement did not go through: ${explainError(made.status, j.error)} Your edits are still here, try again.`,
        )
        await load(agentId)
        return
      }

      setDraft(null)
      setEditing(null)
      setError(null)
      await load(agentId)
    } catch {
      setError('Could not save the edit. The backend may be waking up, try again in a moment.')
    } finally {
      setBusy(null)
    }
  }

  const act = async (path: 'approve' | 'execute', id: string) => {
    setBusy(id)
    setError(null)
    try {
      // Execute settles on-chain, which can take longer than a normal request; give it room.
      const res = await apiFetch(`/api/instructions/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id }),
        timeoutMs: path === 'execute' ? 90_000 : 60_000,
        onWaking: () => setError('Waking up the backend (free tier)…'),
      })
      if (!res.ok) {
        const j = await readJson<{ error?: string }>(res)
        setError(explainError(res.status, j.error))
        return
      }
      setError(null)
      await load(agentId)
    } catch {
      setError(`Could not ${path} the payment. On-chain settlement can be slow, give it a few seconds and try again.`)
    } finally {
      setBusy(null)
    }
  }

  /**
   * Everything the queue can honestly say about chains, derived from the receipts.
   *
   * `rails` counts only rows that CARRY a receipt: a payment still waiting for approval has
   * not settled anywhere, so counting it under a chain would be an invention. That is also
   * why the chip strip carries a sentence saying so, rather than leaving the reader to
   * assume the counts add up to the queue length.
   */
  const rails = useMemo(() => {
    const seen = new Map<ChainId, { chain: Chain; count: number }>()
    for (const ix of items) {
      const c = receiptChain(ix.explorerUrl)
      if (!c) continue
      const hit = seen.get(c.id)
      if (hit) hit.count += 1
      else seen.set(c.id, { chain: c, count: 1 })
    }
    return [...seen.values()].sort((a, b) => b.count - a.count)
  }, [items])

  /**
   * How the summary line is allowed to name a chain.
   *
   * "on Arc testnet" is only said when EVERY settled row resolved to that one chain. A row
   * whose receipt URL is not in the registry counts as unknown and drops the whole line
   * back to "on-chain", because one unrecognised receipt is enough to make the specific
   * claim wrong.
   */
  const settledWhere = useMemo(() => {
    const names = new Set(
      items
        .filter((i) => i.status === 'executed_onchain')
        .map((i) => {
          const c = receiptChain(i.explorerUrl)
          return c ? chainLabel(c) : null
        }),
    )
    return names.size === 1 && !names.has(null) ? `on ${[...names][0]}` : 'on-chain'
  }, [items])

  const shownItems = useMemo(
    () => (chainScope === 'all' ? items : items.filter((ix) => receiptChain(ix.explorerUrl)?.id === chainScope)),
    [items, chainScope],
  )

  const settledOnchain = items.filter((i) => i.status === 'executed_onchain').length

  return (
    <AppPage
      ambient
      width="form"
      title="Settlements"
      description={
        <>
          Every payment your agent makes runs through the policy engine before anything moves.
          Pay a 0x address or another agent (agent://&lt;agentId&gt;); both move real funds. Each
          row says which of the three it is: prepared, settled on-chain with a receipt, or
          simulated.
        </>
      }
    >
      {error && (
        <div className="mt-6 rounded-2xl border border-warn/35 bg-warn/[0.08] p-4 text-sm font-medium leading-relaxed text-foreground/80">{error}</div>
      )}

      {!loading && agents.length === 0 && !error && (
        <div className="mt-6 rounded-2xl border border-dashed border-foreground/20 bg-card p-8 text-center text-sm font-medium text-foreground/70">
          No agents yet. Register one in Agent ID first.
        </div>
      )}

      <AgentSelect agents={agents} className="mt-6" />

      {/* Surface tabs. The payment queue is the page; the rails that feed it (automation,
          agent-to-agent commerce, cross-chain) each get their own tab instead of stacking
          eleven panels under the list. Micro-caps labels, the active one in a quiet box. */}
      <div data-tour="tabs" className="mt-6 flex flex-wrap gap-1.5 border-b border-border pb-3" role="tablist" aria-label="Settlement surfaces">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            onClick={() => setTab(id)}
            aria-selected={tab === id}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors duration-[120ms] ${
              tab === id
                ? 'border-foreground/60 text-foreground'
                : 'border-transparent text-foreground/70 hover:text-foreground'
            }`}
          >
            <Icon size={13} className={tab === id ? 'text-accent' : ''} />
            {label}
          </button>
        ))}
      </div>
      <p className="mt-2.5 text-[13px] font-medium text-foreground/70">{TABS.find((t) => t.id === tab)?.hint}</p>

      <div className="cn-tab-clip">
      <div className={paneClass}>
      {shownTab === 'payments' && agents.length > 0 && (
        <>
          {/* New payment */}
          <div data-tour="new-payment" className="mt-4 rounded-2xl border border-border bg-card p-6">
            <div className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
                <Send size={15} strokeWidth={2} />
              </span>
              <h3 className="text-base font-bold tracking-tight text-foreground">New payment</h3>
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label="How the policy engine decides" className="text-foreground/55 hover:text-foreground">
                      <Info size={14} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Paid in USDC. The policy engine decides: auto-approve under your line, or pause for
                    your approval. Small amounts (e.g. 0.01) keep the demo wallet alive.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className="mt-4 flex flex-wrap items-stretch gap-2.5">
              <input
                value={payee}
                onChange={(e) => setPayee(e.target.value)}
                placeholder="0x address or agent://<agentId>"
                aria-label="Payee"
                className="min-w-[220px] flex-1 rounded-xl border border-border bg-background/40 px-3.5 py-3 font-mono text-xs outline-none transition-colors duration-[120ms] focus:border-accent"
              />
              <div className="relative">
                <img src="/tokens/usdc.svg" alt="" aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-label="Amount in USDC"
                  className="w-32 rounded-xl border border-border bg-background/40 py-3 pl-9 pr-3 text-sm font-semibold tabular-nums outline-none transition-colors duration-[120ms] focus:border-accent"
                />
              </div>
              <button
                type="button"
                onClick={createPayment}
                disabled={busy === 'create'}
                className="inline-flex items-center gap-2 rounded-xl bg-accent px-6 py-3 text-sm font-bold text-white transition-colors duration-[120ms] hover:bg-accent-deep disabled:opacity-50"
              >
                <Send size={15} />
                {busy === 'create' ? 'Paying...' : 'Pay'}
              </button>
            </div>
          </div>

          {/* Human-on-the-loop */}
          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-accent/20 bg-accent/[0.05] p-4">
            <ShieldQuestion size={18} className="mt-0.5 shrink-0 text-accent" />
            <p className="text-sm leading-relaxed text-foreground/80">
              Payments above your limits pause here for approval. Nothing settles on-chain until
              it is approved and executed.{' '}
              {settledOnchain > 0 && (
                <b className="text-foreground">
                  {settledOnchain} settled {settledWhere}.
                </b>
              )}
            </p>
          </div>

          {/* Where these settled. One chip per chain that appears in a RECEIPT on this
              queue, so the strip grows itself as rails land and never claims a chain the
              rows cannot back. The note is load-bearing: a row still in the queue has not
              settled anywhere, which is why the chip counts do not add up to the list. */}
          {rails.length > 0 && (
            <div className="mt-5">
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { id: 'all' as const, label: 'All rows', count: items.length, icon: <Layers key="l" size={13} /> },
                  ...rails.map(({ chain, count }) => ({
                    id: chain.id,
                    label: chainLabel(chain),
                    count,
                    icon: <ChainLogo key={chain.id} id={chain.id} size={16} />,
                  })),
                ].map(({ id, label, count, icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setChainScope(id)}
                    aria-pressed={chainScope === id}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors duration-[120ms]',
                      chainScope === id
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-border bg-card text-foreground/70 hover:bg-foreground/[0.04]',
                    )}
                  >
                    {icon}
                    {label}
                    <span className="tabular-nums opacity-70">{count}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] font-medium leading-relaxed text-foreground/60">
                Chain chips count the rows that carry a settlement receipt. A payment still in the
                queue has not settled anywhere yet, so these do not add up to the list.
              </p>
            </div>
          )}

          {/* The queue, as columns.
              It used to be one flat row per payment: the payee, then a horizontal run of
              four identically-shaped pills (status, enforcer, audit), then a right-hand
              block. Status had no privileged position, so the one thing a reader scans for
              was the hardest thing to find. Three columns fix that: STATUS on the left in a
              fixed lane so it reads down the page, WHAT AND TO WHOM in the middle, AMOUNT on
              the right. Everything that is detail rather than column (the policy note, the
              audit record) drops below the grid instead of competing inside it. */}
          {(loading || shownItems.length > 0) && (
            <div className={cn('mt-5 px-4 pb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground/70 sm:px-5', QUEUE_COLS, 'hidden')}>
              <span>Status</span>
              <span>Payment</span>
              <span className="text-right">Amount</span>
            </div>
          )}
          <ul data-tour="queue" className="flex flex-col gap-2.5">
            {loading &&
              Array.from({ length: 4 }).map((_, i) => (
                <li key={`sk-${i}`} className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                  <div className={cn('flex flex-col gap-3', QUEUE_COLS)}>
                    <Skeleton className="h-6 w-28 rounded-full" />
                    <div className="min-w-0 space-y-2">
                      <Skeleton className="h-3.5 w-40" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                    <Skeleton className="h-5 w-20 sm:ml-auto" />
                  </div>
                </li>
              ))}
            {shownItems.map((ix) => {
              const chain = receiptChain(ix.explorerUrl)
              const settled = ix.status === 'executed_onchain'
              const pending = ix.status === 'pending_approval'
              const executable = ix.status === 'approved' || ix.status === 'auto_approved'
              // A rejected row has nothing to do and nothing to open, so it gets no footer
              // rule at all rather than an empty bordered strip pretending to hold controls.
              const hasFooter = pending || executable || settled || ix.status === 'executed_simulated'
              return (
              <li key={ix.id} className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                <div className={cn('flex flex-col gap-3', QUEUE_COLS)}>
                  {/* Column 1: what happened, and whether money moved. */}
                  <div className="min-w-0">
                    <StatusBadge status={ix.status} />
                    <p className="mt-1.5 text-[11px] font-medium leading-relaxed text-foreground/60">
                      {STATUS_META[ix.status].stage}
                    </p>
                    {/* The chain is read off this row's own receipt. No receipt, no chain
                        name: a settled row on an unrecognised explorer says "on-chain". */}
                    {settled && (
                      <div className="mt-2 flex items-center gap-1.5">
                        {chain ? (
                          <>
                            <ChainLogo id={chain.id} size={16} />
                            <span className="truncate text-[11px] font-semibold text-foreground/75">{chainLabel(chain)}</span>
                          </>
                        ) : (
                          <span className="text-[11px] font-semibold text-foreground/75">on-chain</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Column 2: who was paid, under whose authority. */}
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[13px] font-semibold text-foreground" title={ix.payee}>
                      {short(ix.payee)}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {ix.enforcedBy === 'onchain-vault' && (
                        <Badge variant="default" className="text-[10px]"><Link2 size={10} /> On-chain policy</Badge>
                      )}
                      {ix.enforcedBy === 'circle-agent-stack' && (
                        <Badge variant="info" className="text-[10px]"><Wallet size={10} /> Circle Agent Wallet</Badge>
                      )}
                      {ix.enforcedBy === 'session-key' && (
                        <Badge variant="default" className="text-[10px]"><KeyRound size={10} /> Session key</Badge>
                      )}
                      {ix.count > 1 && (
                        <Badge variant="neutral" className="text-[10px]">{ix.count} identical actions</Badge>
                      )}
                      {/* An on-chain memo is evidence; an app-layer record is a note we
                          kept. They must never wear the same badge, so one is a settled-green
                          receipt and the other is deliberately neutral. */}
                      {ix.memoId && (
                        <Badge variant="success" className="text-[10px]"><Receipt size={10} /> Memo audit</Badge>
                      )}
                      {ix.offchainAuditId && !ix.memoId && (
                        <Badge variant="neutral" className="text-[10px]"><FileText size={10} /> App-layer audit</Badge>
                      )}
                    </div>
                    {/* Shown for EVERY state, simulated included. A simulated row's note is
                        the reason it could not settle, which is the most useful line on it. */}
                    {ix.policyNote && (
                      <p
                        className={cn(
                          'mt-2 text-xs leading-relaxed',
                          ix.status === 'pending_approval' && ix.enforcedBy === 'onchain-vault'
                            ? 'font-semibold text-warn'
                            : 'text-foreground/65',
                        )}
                      >
                        {ix.policyNote}
                      </p>
                    )}
                  </div>

                  {/* Column 3: how much, and when. */}
                  <div className="sm:text-right">
                    <div className="text-base font-bold tabular-nums text-foreground">
                      {(ix.amountUsd * ix.count).toFixed(ix.amountUsd < 0.01 ? 4 : 2)}{' '}
                      <span className="text-xs font-semibold text-usdc">USDC</span>
                    </div>
                    <div className="mt-1 text-[11px] font-medium text-foreground/60">
                      {new Date(ix.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                    {ix.txHash && (
                      <div className="mt-0.5 truncate font-mono text-[10px] text-foreground/55" title={ix.txHash}>
                        tx {ix.txHash.slice(0, 8)}...{ix.txHash.slice(-4)}
                      </div>
                    )}
                  </div>
                </div>

                {/* The "why", below the columns rather than inside them. */}
                {ix.memoId && (
                  <div className="mt-3 flex items-start gap-2 rounded-xl bg-ok/[0.07] p-2.5 text-[11px] ring-1 ring-inset ring-ok/20">
                    <Receipt size={13} className="mt-0.5 shrink-0 text-ok" />
                    <div className="min-w-0">
                      <span className="font-bold text-ok">On-chain reason</span>
                      <span className="text-foreground/65"> · why this agent paid, written to the chain via the Memo precompile</span>
                      {ix.memoReason && (
                        <div className="mt-1 truncate font-mono text-foreground/80" title={ix.memoReason}>
                          {ix.memoReason}
                        </div>
                      )}
                      <div className="truncate font-mono text-[10px] text-foreground/55" title={ix.memoId}>
                        memoId {short(ix.memoId)}
                      </div>
                    </div>
                  </div>
                )}
                {ix.offchainAuditId && !ix.memoId && (
                  <div className="mt-3 flex items-start gap-2 rounded-xl bg-foreground/[0.04] p-2.5 text-[11px] ring-1 ring-inset ring-foreground/10">
                    <FileText size={13} className="mt-0.5 shrink-0 text-foreground/55" />
                    <div className="min-w-0">
                      <span className="font-bold text-foreground/80">Recorded reason</span>
                      <span className="text-foreground/65">
                        {' '}
                        · why this agent paid. The vault and the Circle wallet are contracts and cannot
                        call the Memo precompile, so this is kept by the server, not on the chain.
                      </span>
                      {ix.offchainAuditReason && (
                        <div className="mt-1 truncate font-mono text-foreground/80" title={ix.offchainAuditReason}>
                          {ix.offchainAuditReason}
                        </div>
                      )}
                      {/* Shown untruncated and unlinked: there is no explorer page for it,
                          and shortening it like a hash would imply there was. */}
                      <div className="truncate font-mono text-[10px] text-foreground/55" title={ix.offchainAuditId}>
                        {ix.offchainAuditId}
                      </div>
                    </div>
                  </div>
                )}

                {/* Editing a pending payment: change the terms, then approve the result.
                    Approve/Cancel is a false choice when the only thing wrong is a digit. */}
                {editing === ix.id && draft && (
                  <div className="mt-3 rounded-xl border border-accent/25 bg-accent/[0.04] p-3">
                    <div className="text-xs font-semibold text-foreground">Edit before approving</div>
                    <p className="mt-1 text-[11px] leading-relaxed text-foreground/65">
                      This cancels the payment below and puts a new one through the policy engine, so
                      the queue keeps both what was proposed and what you actually authorised.
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <input
                        value={draft.payee}
                        onChange={(e) => setDraft({ ...draft, payee: e.target.value })}
                        aria-label="Replacement payee"
                        className="min-w-0 flex-1 rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-xs outline-none focus:border-accent"
                      />
                      <input
                        value={draft.amount}
                        onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                        inputMode="decimal"
                        aria-label="Replacement amount in USDC"
                        className="w-24 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm tabular-nums outline-none focus:border-accent"
                      />
                      <button
                        type="button"
                        onClick={() => saveEdit(ix.id)}
                        disabled={busy === ix.id}
                        className="rounded-full bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        {busy === ix.id ? 'Replacing...' : 'Replace'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setEditing(null); setDraft(null) }}
                        className="rounded-full border border-foreground/15 px-3 py-2 text-xs font-semibold text-foreground/60 hover:bg-foreground/5"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Actions and receipt */}
                {hasFooter && (
                <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
                  {pending && editing !== ix.id && (
                    <button
                      type="button"
                      onClick={() => { setEditing(ix.id); setDraft({ amount: String(ix.amountUsd), payee: ix.payee }); setError(null) }}
                      disabled={busy === ix.id}
                      className="rounded-full border border-foreground/15 px-3 py-1.5 text-xs font-semibold text-foreground/70 hover:bg-foreground/5 disabled:opacity-50"
                    >
                      Edit
                    </button>
                  )}
                  {pending && (
                    <button
                      type="button"
                      onClick={() => act('approve', ix.id)}
                      disabled={busy === ix.id}
                      className="rounded-full border border-accent/30 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/5 disabled:opacity-50"
                    >
                      {busy === ix.id ? '...' : 'Approve'}
                    </button>
                  )}
                  {executable && (
                    <button
                      type="button"
                      onClick={() => act('execute', ix.id)}
                      disabled={busy === ix.id}
                      className="rounded-full bg-usdc px-3.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {/* Not "Settling on Arc": which chain this settles on is a property of
                          the agent's vault, not of this button. */}
                      {busy === ix.id ? 'Settling...' : 'Execute'}
                    </button>
                  )}
                  {/* The link names the host it opens, read from the receipt URL itself.
                      It used to say "arcscan" on every row, including rows whose receipt
                      pointed at a different chain's explorer entirely. */}
                  {settled && ix.explorerUrl && (
                    <a
                      href={ix.explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-usdc hover:underline"
                    >
                      {ix.memoId ? 'View memo on' : 'View receipt on'} {explorerHost(ix.explorerUrl)}
                      <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  )}
                  {settled && !ix.explorerUrl && (
                    <span className="text-xs font-medium text-foreground/60">Settled, no explorer link on this rail.</span>
                  )}
                  {ix.status === 'executed_simulated' && (
                    <span className="text-xs font-medium text-foreground/60">
                      Nothing was broadcast, so there is no receipt to open.
                    </span>
                  )}
                </div>
                )}
              </li>
              )
            })}
          </ul>

          {!loading && items.length > 0 && shownItems.length === 0 && (
            <div className="mt-4 rounded-2xl border border-dashed border-foreground/15 bg-card p-6 text-center text-sm text-foreground/65">
              No row in this queue carries a receipt on that chain.{' '}
              <button type="button" onClick={() => setChainScope('all')} className="font-semibold text-accent hover:underline">
                Show all rows
              </button>
            </div>
          )}

          {!loading && items.length === 0 && (
            <div className="mt-4 rounded-2xl border border-dashed border-foreground/20 bg-card p-8 text-center text-sm font-medium text-foreground/65">
              {/* Calm bird, eyes open, nothing to judge. That is what an empty approval
                  queue means. This owl has real transparency, so it needs no mask, only a
                  faint disc to keep its cream body off a bone-coloured card. */}
              <span className="mx-auto mb-3 grid h-28 w-28 place-items-center rounded-full bg-accent/[0.06]">
                <img src="/mascots/owl-soft-allow.png" alt="" aria-hidden="true" loading="lazy" decoding="async" className="h-24 w-24 object-contain" />
              </span>
              No payments yet. Create one above to see the policy engine and on-chain settlement.
            </div>
          )}
        </>
      )}

      {shownTab !== 'payments' && (
        <Suspense fallback={<PanelFallback />}>
          {shownTab === 'automation' && (
            <>
              <AutopilotPanel />
              <SessionKeyPanel />
              <BatchPanel />
            </>
          )}
          {shownTab === 'commerce' && (
            <>
              <X402Panel />
              <NanopayPanel />
              <EscrowPanel />
              <TrustOraclePanel />
            </>
          )}
          {shownTab === 'rails' && (
            <>
              <GatewayPanel />
              <CctpPanel />
              <AppKitPanel />
              <GasPanel />
            </>
          )}
        </Suspense>
      )}
      </div>
      </div>
    </AppPage>
  )
}

/**
 * The six settlement states, drawn so the two distinctions that matter cannot blur.
 *
 * PREPARED vs EXECUTED. `auto_approved`, `approved` and `executed_onchain` used to share
 * one emerald pill with one tick in it, so a payment that had merely passed policy looked
 * exactly like a payment that had moved money. They are now different colours, different
 * glyphs and, decisively, different words: every state carries a `stage` line that says in
 * plain English whether funds have moved. Only a settled row is allowed to be green.
 *
 * REAL vs SIMULATED. A simulation gets a DASHED outline and no fill, which reads as
 * provisional in greyscale, on a monochrome projector and to a colour-blind reader. It is
 * the only state drawn that way, so "this did not really happen" is carried by the shape
 * before any hue is involved.
 *
 * Colour is the last channel here, never the only one: glyph, outline style and the stage
 * sentence each carry the state on their own.
 */
const STATUS_META: Record<Status, { label: string; stage: string; cls: string; Icon: typeof Clock }> = {
  pending_approval: {
    label: 'Needs approval',
    stage: 'Waiting on you. Nothing sent.',
    cls: 'bg-warn/12 text-warn ring-1 ring-inset ring-warn/40',
    Icon: Clock,
  },
  approved: {
    label: 'Approved',
    stage: 'Prepared, not settled.',
    cls: 'bg-accent/10 text-accent ring-1 ring-inset ring-accent/25',
    Icon: ShieldCheck,
  },
  auto_approved: {
    label: 'Auto-approved',
    stage: 'Prepared, not settled.',
    cls: 'bg-accent/10 text-accent ring-1 ring-inset ring-accent/25',
    Icon: Zap,
  },
  executed_onchain: {
    // The chain is appended by the caller from the row's own receipt, never hardcoded.
    label: 'Settled',
    stage: 'On-chain, with a receipt.',
    cls: 'bg-ok/10 text-ok ring-1 ring-inset ring-ok/30',
    Icon: CheckCircle2,
  },
  executed_simulated: {
    label: 'Simulated',
    stage: 'No funds moved.',
    cls: 'border border-dashed border-foreground/30 text-foreground/70',
    Icon: FlaskConical,
  },
  rejected: {
    label: 'Rejected',
    stage: 'No payment made.',
    cls: 'bg-danger/10 text-danger ring-1 ring-inset ring-danger/35',
    Icon: XCircle,
  },
}

function StatusBadge({ status }: { status: Status }) {
  const m = STATUS_META[status]
  return (
    <span
      aria-label={`Status: ${m.label}. ${m.stage}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold leading-none',
        m.cls,
      )}
    >
      <m.Icon size={12} strokeWidth={2.4} aria-hidden="true" />
      {m.label}
    </span>
  )
}
