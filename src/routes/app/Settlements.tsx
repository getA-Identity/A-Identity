import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, CheckCircle2, Clock, ExternalLink, KeyRound, Link2, Receipt, Send, ShieldQuestion, Wallet } from 'lucide-react'
import { authHeaders } from '../../store/auth'

import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { fetchPlatformAgents } from '../../lib/platformAgents'
import { pickPrimaryAgent } from '../../lib/pickAgent'
import { short } from '../../lib/format'
import { useSelectedAgent } from '../../store/agent'
import { useTabCarousel } from '../../hooks/useTabCarousel'
import AgentSelect from '../../components/app/AgentSelect'
import AppPage from '../../components/app/AppPage'
import { Skeleton } from '../../components/ui/skeleton'

/* The rails below the payment queue used to render as one 11-panel column: every panel
   mounted at once, each firing its own request, and the page you actually came for was
   buried. They are grouped into tabs and code-split, so only the panels you open load. */
const AutopilotPanel = lazy(() => import('../../components/app/AutopilotPanel'))
const SessionKeyPanel = lazy(() => import('../../components/app/SessionKeyPanel'))
const BatchPanel = lazy(() => import('../../components/app/BatchPanel'))
const X402Panel = lazy(() => import('../../components/app/X402Panel'))
const NanopayPanel = lazy(() => import('../../components/app/NanopayPanel'))
const EscrowPanel = lazy(() => import('../../components/app/EscrowPanel'))
const TrustOraclePanel = lazy(() => import('../../components/app/TrustOraclePanel'))
const GatewayPanel = lazy(() => import('../../components/app/GatewayPanel'))
const CctpPanel = lazy(() => import('../../components/app/CctpPanel'))
const AppKitPanel = lazy(() => import('../../components/app/AppKitPanel'))
const GasPanel = lazy(() => import('../../components/app/GasPanel'))

type Tab = 'payments' | 'automation' | 'commerce' | 'rails'

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'payments', label: 'Payments', hint: 'Create a payment and work the approval queue.' },
  { id: 'automation', label: 'Automation', hint: 'Let the agent act on its own within the limits you set.' },
  { id: 'commerce', label: 'Agent commerce', hint: 'Getting paid by other agents, and paying them safely.' },
  { id: 'rails', label: 'Rails', hint: 'Where the money can move, and what it costs to move it.' },
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
  createdAt: string
}

type Agent = { id: string; name: string }

const TAB_ORDER = TABS.map((t) => t.id)

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

  const settledOnchain = items.filter((i) => i.status === 'executed_onchain').length

  return (
    <AppPage
      width="form"
      title="Settlements"
      description={
        <>
          Every payment your agent makes runs through the policy engine, then settles in real
          USDC on Arc. Pay a 0x address or another agent (agent://&lt;agentId&gt;). Both move real
          testnet funds.
        </>
      }
    >
      {error && (
        <div className="mt-5 rounded-2xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-4 text-sm text-foreground/70">{error}</div>
      )}

      {!loading && agents.length === 0 && !error && (
        <div className="mt-5 rounded-2xl border border-dashed border-foreground/15 bg-card p-8 text-center text-sm text-foreground/55">
          No agents yet. Register one in Agent ID first.
        </div>
      )}

      <AgentSelect agents={agents} />

      {/* Surface tabs. The payment queue is the page; the rails that feed it (automation,
          agent-to-agent commerce, cross-chain) each get their own tab instead of stacking
          eleven panels under the list. Micro-caps labels, the active one in a quiet box. */}
      <div data-tour="tabs" className="mt-5 flex flex-wrap gap-1.5 border-b border-border pb-3" role="tablist" aria-label="Settlement surfaces">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            onClick={() => setTab(id)}
            aria-selected={tab === id}
            className={`rounded-md border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors duration-[120ms] ${
              tab === id
                ? 'border-foreground/60 text-foreground'
                : 'border-transparent text-foreground/50 hover:text-foreground/80'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-foreground/45">{TABS.find((t) => t.id === tab)?.hint}</p>

      <div className="cn-tab-clip">
      <div className={paneClass}>
      {shownTab === 'payments' && agents.length > 0 && (
        <>
          {/* New payment */}
          <div data-tour="new-payment" className="mt-4 rounded-2xl border border-border bg-card p-6">
            <h3 className="font-semibold text-foreground">New payment</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
              <input
                value={payee}
                onChange={(e) => setPayee(e.target.value)}
                placeholder="Payee: 0x address or agent://<agentId> (both settle for real)"
                className="rounded-xl border border-border bg-background/40 px-3 py-2.5 font-mono text-xs outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-24 rounded-xl border border-border bg-background/40 px-3 py-2.5 text-sm outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={createPayment}
                  disabled={busy === 'create'}
                  className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.02] disabled:opacity-50"
                >
                  <Send size={14} />
                  {busy === 'create' ? '...' : 'Pay'}
                </button>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-foreground/45">
              USDC. The policy engine decides: auto-approve, or pause for your approval. Small
              amounts (e.g. 0.01) keep the demo wallet alive.
            </p>
          </div>

          {/* Human-on-the-loop */}
          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-accent/20 bg-accent/[0.05] p-4">
            <ShieldQuestion size={18} className="mt-0.5 shrink-0 text-accent" />
            <p className="text-sm text-foreground/70">
              Payments above your limits pause here for approval. Nothing settles on-chain until
              it is approved and executed. {settledOnchain > 0 && <b>{settledOnchain} settled on Arc.</b>}
            </p>
          </div>

          {/* List */}
          <ul data-tour="queue" className="mt-4 flex flex-col gap-2.5">
            {loading &&
              Array.from({ length: 4 }).map((_, i) => (
                <li key={`sk-${i}`} className="rounded-2xl border border-border bg-card p-4">
                  <div className="flex items-center gap-4">
                    <Skeleton className="h-9 w-9 shrink-0 rounded-xl" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-40" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                    <Skeleton className="h-5 w-16" />
                  </div>
                </li>
              ))}
            {items.map((ix) => (
              <li key={ix.id} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center gap-4">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-white">
                    <ArrowUpRight size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-xs text-foreground">{short(ix.payee)}</span>
                      <StatusPill status={ix.status} />
                      {ix.enforcedBy === 'onchain-vault' && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold text-accent">
                          <Link2 size={10} /> On-chain policy
                        </span>
                      )}
                      {ix.enforcedBy === 'circle-agent-stack' && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-usdc/10 px-2 py-0.5 text-[10px] font-bold text-usdc">
                          <Wallet size={10} /> Circle Agent Wallet
                        </span>
                      )}
                      {ix.enforcedBy === 'session-key' && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold text-accent">
                          <KeyRound size={10} /> Session key
                        </span>
                      )}
                      {ix.memoId && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                          <Receipt size={10} /> Memo audit
                        </span>
                      )}
                    </div>
                    {ix.status !== 'executed_simulated' && ix.policyNote && (
                      <div
                        className={`mt-0.5 text-xs ${
                          ix.status === 'pending_approval' && ix.enforcedBy === 'onchain-vault'
                            ? 'font-semibold text-amber-700 dark:text-amber-300'
                            : 'text-foreground/50'
                        }`}
                      >
                        {ix.policyNote}
                      </div>
                    )}
                    {ix.memoId && (
                      <div className="mt-1 flex items-start gap-1.5 rounded-lg bg-emerald-500/8 px-2 py-1 text-[11px]">
                        <Receipt size={12} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <div className="min-w-0">
                          <span className="font-semibold text-emerald-700 dark:text-emerald-300">On-chain reason</span>
                          <span className="text-foreground/50"> · why this agent paid, written to Arc via the Memo precompile</span>
                          {ix.memoReason && (
                            <div className="mt-0.5 truncate font-mono text-foreground/70" title={ix.memoReason}>
                              {ix.memoReason}
                            </div>
                          )}
                          <div className="truncate font-mono text-[10px] text-foreground/40" title={ix.memoId}>
                            memoId {short(ix.memoId)}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-foreground">
                      {(ix.amountUsd * ix.count).toFixed(ix.amountUsd < 0.01 ? 4 : 2)}{' '}
                      <span className="text-xs font-semibold text-usdc">USDC</span>
                    </div>
                  </div>
                </div>

                {/* Editing a pending payment: change the terms, then approve the result.
                    Approve/Cancel is a false choice when the only thing wrong is a digit. */}
                {editing === ix.id && draft && (
                  <div className="mt-3 rounded-xl border border-accent/25 bg-accent/[0.04] p-3">
                    <div className="text-xs font-semibold text-foreground">Edit before approving</div>
                    <p className="mt-1 text-[11px] leading-relaxed text-foreground/55">
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

                {/* Actions */}
                <div className="mt-3 flex items-center justify-end gap-2 border-t border-foreground/8 pt-3">
                  {ix.status === 'pending_approval' && editing !== ix.id && (
                    <button
                      type="button"
                      onClick={() => { setEditing(ix.id); setDraft({ amount: String(ix.amountUsd), payee: ix.payee }); setError(null) }}
                      disabled={busy === ix.id}
                      className="rounded-full border border-foreground/15 px-3 py-1.5 text-xs font-semibold text-foreground/70 hover:bg-foreground/5 disabled:opacity-50"
                    >
                      Edit
                    </button>
                  )}
                  {ix.status === 'pending_approval' && (
                    <button
                      type="button"
                      onClick={() => act('approve', ix.id)}
                      disabled={busy === ix.id}
                      className="rounded-full border border-accent/30 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/5 disabled:opacity-50"
                    >
                      {busy === ix.id ? '...' : 'Approve'}
                    </button>
                  )}
                  {(ix.status === 'approved' || ix.status === 'auto_approved') && (
                    <button
                      type="button"
                      onClick={() => act('execute', ix.id)}
                      disabled={busy === ix.id}
                      className="rounded-full bg-usdc px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {busy === ix.id ? 'Settling on Arc...' : 'Execute'}
                    </button>
                  )}
                  {ix.status === 'executed_onchain' && ix.explorerUrl && (
                    <a
                      href={ix.explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-semibold text-usdc hover:underline"
                    >
                      {ix.memoId ? 'View memo on arcscan' : 'View on arcscan'} <ExternalLink size={11} />
                    </a>
                  )}
                  {ix.status === 'executed_simulated' && (
                    <span
                      className="text-xs text-foreground/40"
                      title={ix.policyNote || 'Simulated: the payee has no Arc address to settle to.'}
                    >
                      Simulated
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {!loading && items.length === 0 && (
            <div className="mt-4 rounded-2xl border border-dashed border-foreground/15 bg-card p-8 text-center text-sm text-foreground/50">
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

function StatusPill({ status }: { status: Status }) {
  const map: Record<Status, { label: string; cls: string; icon?: 'ok' | 'wait' }> = {
    auto_approved: { label: 'Auto-approved', cls: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', icon: 'ok' },
    pending_approval: { label: 'Pending approval', cls: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300', icon: 'wait' },
    approved: { label: 'Approved', cls: 'bg-usdc/10 text-usdc', icon: 'ok' },
    executed_onchain: { label: 'Settled on Arc', cls: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', icon: 'ok' },
    executed_simulated: { label: 'Simulated', cls: 'bg-foreground/8 text-foreground/50' },
    rejected: { label: 'Rejected', cls: 'bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300' },
  }
  const s = map[status]
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${s.cls}`}>
      {s.icon === 'ok' && <CheckCircle2 size={10} />}
      {s.icon === 'wait' && <Clock size={10} />}
      {s.label}
    </span>
  )
}
