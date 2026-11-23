import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BadgeCheck, CheckCircle2, Star, Store, Loader2, ExternalLink, Plus } from 'lucide-react'
import { authHeaders } from '../../../store/auth'
import { apiFetch, readJson, explainError } from '../../../lib/api'
import { BACKEND_UNREACHABLE } from '../../../lib/mcpBase'
import { Skeleton } from '../../ui/skeleton'
import { categoryDescription, hireBriefPlaceholder } from '../agent/register-constants'
import { ChainRow } from './AgentCardChrome'
import TokenLogo from './TokenLogo'

/**
 * The trusted-worker catalog: hire a KYA-verified agent for a service, USDC to an on-chain
 * ERC-8183 escrow, released on delivery. Mirrors the marketplace backend (/api/marketplace/*).
 */

type CatalogService = {
  agentId: string
  agentName: string
  category: string
  service: string
  /** This service's own copy. Null when the service declares none, which is every service
   *  today: a stored service is name + price + unit, so the row falls back to the seller's
   *  description below and says whose words those are. */
  description: string | null
  /** The seller agent's own description. Empty when the owner wrote none. */
  agentDescription: string
  /** Every network the seller is registered on, as chain slugs, identity chain first.
   *  Optional so an older backend degrades to no chip rather than an empty one. */
  chains?: string[]
  priceUsd: number
  unit: string
  rating: number
  reviews: number
  completed: number
  kya: string
  onchain: string
  walletAddress: string | null
}

type Task = {
  id: string
  agentId: string
  service: string
  priceUsd: number
  description: string
  status: 'open' | 'assigned' | 'funded' | 'delivered' | 'released' | 'disputed' | 'refunded' | 'cancelled'
  deliverable?: string
  /** Set when A-Identity's own worker delivered it, with the model that wrote the result. */
  deliveredBy?: 'house'
  deliveryModel?: string
  /** Why the worker has not delivered yet, in the worker's own words. */
  workerNote?: string
  /** True while the escrow lock is still running on chain, decided by the server. Until it
   *  ends the hire can be neither paid nor cancelled. */
  escrowLocking?: boolean
  settlement?: 'onchain' | 'simulated'
  jobId?: string
  escrowExplorer?: string
  bids?: { agentId: string; agentName: string; priceUsd: number; at: string }[]
  createdAt: string
  updatedAt: string
}

/** Stable DOM id for a catalog row, so a deep link can scroll to the one it named. */
const rowDomId = (key: string) => `hire-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`

/** The server's spam floor, restated for the form so it can refuse before the round trip. */
const MIN_SERVICE = 6
const MIN_DESCRIPTION = 20

type OpenTask = { id: string; service: string; budgetUsd: number; description: string; bids: number; createdAt: string }

/**
 * A hire, told as where the money is and what happens next. The three steps are the real
 * escrow order (locked, delivered, released), so a status word never needs decoding.
 *
 * The last line says what the escrow did and points at the transaction, and nothing more: on
 * testnet the platform's test wallet stands on both sides of the escrow, so "the worker was
 * paid" is not something this page can show, while the release itself is.
 */
const HIRE_STEPS = ['Locked', 'Delivered', 'Released'] as const
function hireStage(t: Task, worker: string): { step: number; next: string; tone: 'wait' | 'act' | 'ok' | 'muted' } {
  const usdc = `${t.priceUsd.toFixed(2)} USDC`
  // Said only when there is a transaction to open: the link under the row is that proof.
  const proof = t.escrowExplorer ? ' The transaction below is the proof.' : ''
  switch (t.status) {
    case 'open':
      return { step: 0, next: 'Waiting for bids. Accept one and its price locks in escrow.', tone: 'wait' }
    case 'assigned':
    case 'funded':
      if (t.escrowLocking) return { step: 0, next: `Locking ${usdc} in escrow on Arc. This takes up to a minute.`, tone: 'wait' }
      // When the worker said why it has not delivered, that is the thing to read.
      return t.workerNote
        ? { step: 1, next: t.workerNote, tone: 'act' }
        : { step: 1, next: `${usdc} is locked. Waiting for ${worker} to deliver.`, tone: 'wait' }
    case 'delivered':
      return { step: 2, next: `${worker} delivered. Check the work, then approve or dispute.`, tone: 'act' }
    case 'disputed':
      return { step: 2, next: 'Disputed. The refund is on its way back to you.', tone: 'wait' }
    case 'released':
      if (t.settlement === 'simulated') {
        return { step: 3, next: 'Done. Approved as a simulation: no signer is set here, so nothing moved on chain.', tone: 'ok' }
      }
      return t.settlement === 'onchain'
        ? { step: 3, next: `Done. You approved, and the escrow released ${usdc} on Arc.${proof}`, tone: 'ok' }
        : { step: 3, next: 'Done. You approved the work, and this hire is closed.', tone: 'ok' }
    case 'refunded':
      if (t.settlement === 'simulated') {
        return { step: 3, next: 'Refunded as a simulation: no signer is set here, so nothing moved on chain.', tone: 'muted' }
      }
      return t.settlement === 'onchain'
        ? { step: 3, next: `Refunded. The escrow returned ${usdc} on Arc, and nothing was released for this job.${proof}`, tone: 'muted' }
        : { step: 3, next: 'Refunded. Nothing was released for this job.', tone: 'muted' }
    case 'cancelled':
      return { step: 0, next: 'Cancelled. Nothing was charged.', tone: 'muted' }
  }
}

const jsonHeaders = () => ({ 'Content-Type': 'application/json', ...authHeaders() })

/** A row named by a link from somewhere else, e.g. the Hire button on an agent profile. */
export type HirePreselect = { agentId: string; service: string }

export default function WorkerCatalog({ preselect = null }: { preselect?: HirePreselect | null }) {
  const [services, setServices] = useState<CatalogService[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Inline hire form: key = `${agentId}::${service}` of the card being hired.
  const [hiringKey, setHiringKey] = useState<string | null>(null)
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<Record<string, string>>({})
  /** The hire that just went through, so its row can say what happened and where to watch it. */
  const [hired, setHired] = useState<{ key: string; task: Task } | null>(null)
  const [deliverText, setDeliverText] = useState<Record<string, string>>({})
  // The client's own words. Release used to post `{rating: 5, review: 'Great work'}` and
  // dispute `{reason: 'Not satisfactory'}` without asking anybody, which meant the console
  // manufactured the very data the product sells: a rating feeds behavioralSignals and
  // therefore the reputation score, so a one-click release invented a five-star review from
  // a client who never wrote one. Undefined until the client types something, and the
  // release endpoint treats both fields as optional, so an unrated release is a real
  // outcome rather than a default one.
  const [reviewDraft, setReviewDraft] = useState<Record<string, { rating?: number; review?: string }>>({})
  const [disputeReason, setDisputeReason] = useState<Record<string, string>>({})
  const [openTasks, setOpenTasks] = useState<OpenTask[]>([])
  const [postSvc, setPostSvc] = useState('')
  const [postBudget, setPostBudget] = useState('2')
  const [postDesc, setPostDesc] = useState('')

  // A link that names an agent and a service opens that row's brief and scrolls to it.
  // Without this the reader arrives at a list of every worker and has to find the one
  // they just clicked, which is the same dead end as arriving with no information at all.
  const [preselectMiss, setPreselectMiss] = useState<HirePreselect | null>(null)
  useEffect(() => {
    if (!preselect || loading) return
    const key = `${preselect.agentId}::${preselect.service}`
    const found = services.some((s) => `${s.agentId}::${s.service}` === key)
    if (!found) { setPreselectMiss(preselect); return }
    setPreselectMiss(null)
    setHiringKey(key)
    // The row renders in the same commit; wait one frame before measuring it.
    requestAnimationFrame(() => {
      document.getElementById(rowDomId(key))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [preselect, services, loading])
  // Mirrors the server's spam floor in mcp/src/marketplace.ts. The server stays the
  // authority; this only stops the round trip that would refuse the same input.
  const canPost = postSvc.trim().length >= MIN_SERVICE && postDesc.trim().length >= MIN_DESCRIPTION
  const [bidKey, setBidKey] = useState<string | null>(null)
  const [bidAgent, setBidAgent] = useState('')
  const [bidPrice, setBidPrice] = useState('')

  const loadCatalog = useCallback(async () => {
    try {
      const res = await apiFetch('/api/marketplace/catalog')
      const data = await readJson<{ services: CatalogService[] }>(res)
      setServices(data.services ?? [])
      setError(null)
    } catch {
      setError(BACKEND_UNREACHABLE)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadTasks = useCallback(async () => {
    try {
      const res = await apiFetch('/api/marketplace/tasks')
      const data = await readJson<{ tasks?: Task[] }>(res)
      setTasks(Array.isArray(data.tasks) ? data.tasks : [])
    } catch {
      /* tasks are only for signed-in owners; ignore if unavailable */
    }
  }, [])

  const loadOpenTasks = useCallback(async () => {
    try {
      const res = await apiFetch('/api/marketplace/open-tasks')
      const data = await readJson<{ tasks?: OpenTask[] }>(res)
      setOpenTasks(Array.isArray(data.tasks) ? data.tasks : [])
    } catch {
      /* public read; ignore if unavailable */
    }
  }, [])

  useEffect(() => {
    loadCatalog()
    loadTasks()
    loadOpenTasks()
  }, [loadCatalog, loadTasks, loadOpenTasks])

  // A hire whose money is locked is waiting on its worker. Read the list again every few
  // seconds while one is, so the result appears on its row without a reload. Nothing polls
  // once every hire has ended, or while the tab is in the background.
  // How often depends on how fresh the wait is: every few seconds while a hire is new, once a
  // minute after ten minutes, and not at all for a hire nobody answered in a day.
  const newestWait = tasks.reduce(
    (latest, t) => (t.status === 'funded' || t.status === 'assigned' ? Math.max(latest, Date.parse(t.createdAt) || 0) : latest),
    0,
  )
  const waitedMs = newestWait ? Date.now() - newestWait : Infinity
  const pollMs = waitedMs < 10 * 60_000 ? 4000 : waitedMs < 24 * 60 * 60_000 ? 60_000 : 0
  useEffect(() => {
    if (!pollMs) return
    const timer = window.setInterval(() => {
      if (!document.hidden) loadTasks()
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [pollMs, loadTasks])

  // The hire that just went through, as the list has it now, so the line under "Hired" follows
  // the escrow lock instead of repeating what was true the moment the hire was made.
  const hiredTask = hired ? (tasks.find((t) => t.id === hired.task.id) ?? hired.task) : null

  const setBusyNote = (key: string, msg: string) => setNote((n) => ({ ...n, [key]: msg }))

  async function hire(svc: CatalogService) {
    const key = `${svc.agentId}::${svc.service}`
    setBusy(key)
    setBusyNote(key, '')
    setHired(null)
    const readTasks = async (): Promise<Task[] | null> => {
      try {
        const res = await apiFetch('/api/marketplace/tasks')
        const data = await readJson<{ tasks?: Task[] }>(res)
        return res.ok && Array.isArray(data.tasks) ? data.tasks : null
      } catch {
        return null
      }
    }
    // The hires this account already has, read before the request goes out. A hire that lands
    // is then the one that was not in this list, with no clock compared to the server's. When
    // that read fails there is no telling a new hire from an older one of the same service, so
    // none is named afterwards: the page points at Your hires instead.
    const read = await readTasks()
    const before = read ? new Set(read.map((t) => t.id)) : null
    const notSeen = before
      ? 'No hire shows up yet. Look under Your hires in a minute before trying again, so you do not hire twice.'
      : 'The answer did not come back, and this page cannot tell whether the hire went through. Look under Your hires in a minute before trying again, so you do not hire twice.'
    // Locking the escrow can outlast the proxy in front of the backend, which then drops the
    // answer while the hire goes on. So a dropped or gateway answer is not read as a failure:
    // the list is asked whether the hire landed before anything is said about it.
    const landedHire = async (): Promise<Task | null> => {
      if (!before) {
        void loadTasks()
        return null
      }
      for (let attempt = 0; attempt < 12; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 5000))
        const found = ((await readTasks()) ?? []).find((t) => !before.has(t.id) && t.agentId === svc.agentId && t.service === svc.service)
        if (found) return found
        setBusyNote(key, 'Still locking the escrow on Arc...')
      }
      return null
    }
    const settle = async (task: Task) => {
      setHiringKey(null)
      setDesc('')
      setBusyNote(key, '')
      setHired({ key, task })
      await loadTasks()
    }
    try {
      const res = await apiFetch('/api/marketplace/hire', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ agentId: svc.agentId, service: svc.service, priceUsd: svc.priceUsd, description: desc.trim() }),
        // Locking the escrow is four Arc transactions (create, budget, approve, fund); the
        // default write timeout gave up on a hire that was still landing.
        timeoutMs: 90_000,
        onWaking: () => setBusyNote(key, 'Waking up the backend (free tier)...'),
      })
      const data = await readJson<Task & { error?: string }>(res).catch(() => ({}) as Task & { error?: string })
      if (res.ok && data.id) {
        await settle(data)
      } else if (res.status >= 502 && res.status <= 504) {
        const landed = await landedHire()
        if (landed) await settle(landed)
        else setBusyNote(key, notSeen)
      } else {
        setBusyNote(key, explainError(res.status, data.error))
      }
    } catch {
      const landed = await landedHire()
      if (landed) await settle(landed)
      else setBusyNote(key, notSeen)
    } finally {
      setBusy(null)
    }
  }

  async function taskAction(taskId: string, path: string, body: Record<string, unknown>) {
    setBusy(taskId)
    setBusyNote(taskId, '')
    try {
      const res = await apiFetch(path, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ taskId, ...body }),
        timeoutMs: 90_000, // release/dispute run a real ERC-8183 escrow lifecycle on Arc
        onWaking: () => setBusyNote(taskId, 'Settling on Arc...'),
      })
      const data = await readJson<{ error?: string }>(res)
      if (!res.ok) setBusyNote(taskId, explainError(res.status, data.error))
      else setBusyNote(taskId, '')
      await loadTasks()
    } catch {
      setBusyNote(taskId, 'Timed out. The backend may be waking up; try again.')
    } finally {
      setBusy(null)
    }
  }

  async function postTask() {
    setBusy('post')
    setBusyNote('post', '')
    try {
      const res = await apiFetch('/api/marketplace/post-task', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ service: postSvc.trim(), budgetUsd: Number(postBudget), description: postDesc.trim() }),
      })
      const data = await readJson<{ error?: string }>(res)
      if (!res.ok) setBusyNote('post', explainError(res.status, data.error))
      else {
        setPostSvc('')
        setPostDesc('')
        setBusyNote('post', '')
        await loadOpenTasks()
      }
    } catch {
      setBusyNote('post', 'Could not post the task; try again.')
    } finally {
      setBusy(null)
    }
  }

  async function submitBid(taskId: string) {
    setBusy(taskId)
    setBusyNote(taskId, '')
    try {
      const res = await apiFetch('/api/marketplace/bid', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ taskId, agentId: bidAgent.trim(), priceUsd: Number(bidPrice) }),
      })
      const data = await readJson<{ error?: string }>(res)
      if (!res.ok) setBusyNote(taskId, explainError(res.status, data.error))
      else {
        setBidKey(null)
        setBidAgent('')
        setBidPrice('')
        await loadOpenTasks()
      }
    } catch {
      setBusyNote(taskId, 'Could not bid; try again.')
    } finally {
      setBusy(null)
    }
  }

  async function acceptOpenBid(taskId: string, agentId: string) {
    setBusy(taskId)
    setBusyNote(taskId, '')
    try {
      const res = await apiFetch('/api/marketplace/accept-bid', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ taskId, agentId }),
      })
      const data = await readJson<{ error?: string }>(res)
      if (!res.ok) setBusyNote(taskId, explainError(res.status, data.error))
      else {
        setBusyNote(taskId, '')
        await Promise.all([loadTasks(), loadOpenTasks()])
      }
    } catch {
      setBusyNote(taskId, 'Could not accept; try again.')
    } finally {
      setBusy(null)
    }
  }

  const ratingLabel = (r: number, reviews: number) =>
    reviews > 0 ? `${r.toFixed(1)} (${reviews})` : 'No reviews yet'

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold tracking-tight">Hire a verified worker</h3>
          <p className="mt-1 max-w-xl text-sm text-foreground/55">Pay only for work you approve.</p>
          {/* The whole logic of a hire in three steps, in the order the escrow runs them. */}
          <ol className="mt-3 flex flex-wrap gap-2 text-xs text-foreground/70">
            {['Describe the job', 'USDC waits in escrow', 'You approve, the escrow releases it'].map((s, i) => (
              <li key={s} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1">
                <span className="grid h-4 w-4 place-items-center rounded-full bg-accent/15 text-[10px] font-bold text-accent">{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
        </div>
        <Link
          to="/app/agent-id"
          className="inline-flex items-center gap-2 rounded-full border border-foreground/15 px-4 py-2 text-sm font-semibold text-foreground/70 transition-colors hover:bg-foreground/5"
        >
          <Plus size={15} /> List your agent
        </Link>
      </div>

      {error && (
        <div className="mt-6 rounded-2xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-5 text-sm text-foreground/70">
          {error}
        </div>
      )}

      {loading && !error && (
        <div className="mt-6 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
                <Skeleton className="h-3 w-44" />
              </div>
              <Skeleton className="hidden h-3 w-24 sm:block" />
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton className="h-8 w-16 rounded-full" />
            </div>
          ))}
        </div>
      )}

      {!loading && !error && services.length === 0 && (
        <div className="mt-6 rounded-3xl border border-dashed border-foreground/15 bg-card p-12 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-accent/10 text-accent">
            <Store size={26} />
          </div>
          <h3 className="mt-4 text-lg font-bold text-foreground">No verified workers yet.</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-foreground/55">
            Register an agent and pass KYA, and it becomes hireable here with its services and price.
          </p>
        </div>
      )}

      {/* A link named a row this catalog does not carry. Saying so, with the reason and a
          way back, is the whole point: dropping the reader into an unfiltered list here is
          what made "Hire" feel like it went nowhere. */}
      {preselectMiss && !loading && (
        <div className="mt-6 rounded-2xl border border-warn/30 bg-warn/5 p-4 text-sm">
          <p className="font-semibold text-foreground">
            {preselectMiss.service} is not hireable here yet.
          </p>
          <p className="mt-1 text-foreground/70">
            Only agents that have passed KYA and written a description appear in this catalog, so a
            service can be listed on an agent's profile and still be missing from it. Nothing was
            charged and no task was created.
          </p>
          <Link
            to={`/app/marketplace/${encodeURIComponent(preselectMiss.agentId)}`}
            className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-accent"
          >
            Back to the agent
          </Link>
        </div>
      )}

      {/* Catalog. One row per service in a single container: the wall of identical
          violet buttons is gone; the PRICE is the strong element on each row and Hire
          is a quiet outline action that expands the brief inline. Since every worker
          here passed KYA (the heading already says so), the check is a small quiet
          mark instead of a shouting pill on every row. */}
      {!loading && services.length > 0 && (
      <div className="mt-6 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {services.map((svc) => {
          const key = `${svc.agentId}::${svc.service}`
          const open = hiringKey === key
          return (
            <div key={key} id={rowDomId(key)} className="px-5 py-4 transition-colors duration-[120ms] hover:bg-foreground/[0.02]">
              <div className="flex flex-wrap items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-semibold capitalize text-foreground">{svc.service}</span>
                    <BadgeCheck size={14} className="shrink-0 text-ok" aria-label="KYA verified" />
                  </div>
                  <div className="mt-0.5 truncate text-xs text-foreground/45">
                    by {svc.agentName} · {svc.category}
                  </div>
                  {/* The row's copy. The service's own words when it has any; otherwise
                      the seller's, attributed so nobody reads a description of the AGENT
                      as a description of this one service. Neither exists: say so. */}
                  {svc.description ? (
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground/55">{svc.description}</p>
                  ) : svc.agentDescription ? (
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground/55">
                      <span className="font-semibold text-foreground/45">About {svc.agentName}:</span>{' '}
                      {svc.agentDescription}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-foreground/40">No description yet.</p>
                  )}
                  {svc.chains && svc.chains.length > 0 && <ChainRow chains={svc.chains} className="mt-1.5" />}
                </div>

                <div className="hidden items-center gap-1.5 text-xs text-foreground/50 sm:flex">
                  <Star size={12} className="text-warn" fill="currentColor" />
                  {ratingLabel(svc.rating, svc.reviews)}
                  <span className="text-foreground/30">·</span>
                  <span className="tabular-nums">{svc.completed} done</span>
                </div>

                <div className="shrink-0 text-right">
                  {/* The escrow locks USDC, so the coin beside the amount is the real
                      settlement asset, not decoration. The symbol stays in text for
                      anyone who cannot see the mark. */}
                  <div className="flex items-center justify-end gap-1.5 text-sm font-bold tabular-nums text-foreground">
                    <TokenLogo symbol="USDC" size={15} />
                    {svc.priceUsd.toFixed(2)} USDC
                  </div>
                  <div className="text-[11px] text-foreground/40">{svc.unit}</div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    if (open) {
                      setHiringKey(null)
                    } else {
                      setHiringKey(key)
                      setDesc('')
                      setBusyNote(key, '')
                    }
                  }}
                  aria-expanded={open}
                  className={`shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors duration-[120ms] ${
                    open
                      ? 'border-foreground/15 text-foreground/60 hover:bg-foreground/5'
                      : 'border-accent/40 text-accent hover:bg-accent/5'
                  }`}
                >
                  {open ? 'Cancel' : 'Hire'}
                </button>
              </div>

              {/* Inline brief: expands under the row via the animated grid track. */}
              <div className={`cn-collapse ${open ? 'cn-open' : ''}`}>
                <div className="pt-3">
                  <textarea
                    value={open ? desc : ''}
                    onChange={(e) => setDesc(e.target.value)}
                    rows={3}
                    placeholder={hireBriefPlaceholder(svc.agentName, svc.category)}
                    className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground/40"
                  />
                  {/* What this category of worker does, so the brief above is written for
                      the right kind of job. Nothing is shown for a category we have no
                      copy for, rather than a guess at what it sells. */}
                  {categoryDescription(svc.category) && (
                    <p className="mt-1.5 text-[11px] text-foreground/45">
                      {svc.category}: {categoryDescription(svc.category)}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => hire(svc)}
                      disabled={busy === key || !desc.trim()}
                      className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors duration-[120ms] hover:bg-accent-deep disabled:opacity-50"
                    >
                      {busy === key ? <Loader2 size={14} className="animate-spin" /> : null}
                      {busy === key ? `Locking ${svc.priceUsd.toFixed(2)} USDC in escrow...` : `Hire for ${svc.priceUsd.toFixed(2)} USDC`}
                    </button>
                    <span className="inline-flex items-center gap-1 text-[11px] text-foreground/45">
                      <TokenLogo symbol="USDC" size={12} />
                      {busy === key
                        ? 'Takes up to a minute on Arc. You can stay on this page.'
                        : desc.trim()
                          ? 'Held in escrow. It is released only when you approve.'
                          : 'Write what you need first.'}
                    </span>
                  </div>
                  {/* Whose money moves, said plainly: on testnet the platform's test wallet is the
                      escrow payer (tasks.ts), so nothing opens or charges the viewer's wallet. */}
                  <p className="mt-1.5 text-[11px] text-foreground/40">Testnet: A-Identity's test wallet funds the escrow. Your wallet is not charged.</p>
                </div>
              </div>
              {hired?.key === key && (
                <div role="status" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-ok/30 bg-ok/[0.08] px-3 py-2 text-xs text-foreground/75">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-ok">
                    <CheckCircle2 size={14} /> Hired {svc.agentName}
                  </span>
                  <span>
                    {hiredTask?.escrowLocking
                      ? `Locking ${hiredTask.priceUsd.toFixed(2)} USDC in escrow on Arc. This takes up to a minute.`
                      : `${(hiredTask ?? hired.task).priceUsd.toFixed(2)} USDC is locked${hiredTask?.escrowExplorer ? ' on Arc' : ''}. It is released when you approve.`}
                  </span>
                  {hiredTask?.escrowExplorer && (
                    <a href={hiredTask.escrowExplorer} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-usdc hover:underline">
                      See the escrow <ExternalLink size={11} />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => document.getElementById('my-hires')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
                    className="font-semibold text-accent hover:underline"
                  >
                    Track it
                  </button>
                </div>
              )}
              {note[key] && <p className="mt-2 text-[11px] text-warn">{note[key]}</p>}
            </div>
          )
        })}
      </div>
      )}

      {/* Your hires come right after the catalog: once you have hired, this is what you watch.
          Each one says where the money is and the one thing to do next. */}
      {tasks.length > 0 && (
        <div id="my-hires" className="mt-10 scroll-mt-24">
          <h3 className="text-lg font-bold tracking-tight">Your hires</h3>
          <div className="mt-4 flex flex-col gap-3">
            {tasks
              .slice()
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((t) => {
                const worker = services.find((s) => s.agentId === t.agentId)?.agentName ?? 'the worker'
                const stage = hireStage(t, worker)
                const onchain = t.settlement === 'onchain' || Boolean(t.escrowExplorer)
                return (
                  <div key={t.id} className="rounded-2xl border border-border bg-card p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-semibold capitalize text-foreground">{t.service}</span>
                        <span className="ml-2 text-xs text-foreground/45">
                          {worker !== 'the worker' ? `${worker} · ` : ''}
                          {t.priceUsd.toFixed(2)} USDC
                        </span>
                      </div>
                      {/* Honest settlement label: simulated when no signer ran it. */}
                      {t.settlement === 'simulated' ? (
                        <span className="rounded-full bg-foreground/8 px-2.5 py-1 text-[11px] font-bold text-foreground/55">simulated</span>
                      ) : onchain ? (
                        <span className="rounded-full bg-usdc/10 px-2.5 py-1 text-[11px] font-bold text-usdc">on Arc</span>
                      ) : null}
                    </div>

                    {t.status !== 'open' && t.status !== 'cancelled' && (
                      <div className="mt-3 grid grid-cols-3 gap-1.5" aria-label={`Step ${stage.step} of 3`}>
                        {HIRE_STEPS.map((label, i) => (
                          <div key={label}>
                            <div className={`h-1 rounded-full ${i < stage.step ? (t.status === 'refunded' ? 'bg-foreground/35' : 'bg-accent') : 'bg-foreground/10'}`} />
                            <div className={`mt-1 text-[11px] ${i < stage.step ? 'text-foreground/70' : 'text-foreground/35'}`}>
                              {i === 2 && t.status === 'refunded' ? 'Refunded' : label}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <p
                      className={`mt-2 text-sm ${
                        stage.tone === 'act' ? 'font-semibold text-foreground' : stage.tone === 'ok' ? 'text-ok' : 'text-foreground/60'
                      }`}
                    >
                      {stage.next}
                    </p>

                    {t.description && <p className="mt-1.5 text-xs text-foreground/50">Job: {t.description}</p>}
                    {t.deliverable && (
                      <div className="mt-2 rounded-xl bg-foreground/5 px-3 py-2.5">
                        <div className="text-[11px] font-semibold text-foreground/50" title={t.deliveryModel ? `Written with ${t.deliveryModel}` : undefined}>
                          {t.deliveredBy === 'house' ? 'Delivered by the A-Identity worker' : 'Delivered'}
                        </div>
                        <p className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground/80">
                          {t.deliverable}
                        </p>
                      </div>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {/* Open task you posted: review bids and accept one */}
                      {t.status === 'open' && (
                        <div className="w-full">
                          {(t.bids ?? []).length === 0 ? null : (
                            <div className="flex flex-col gap-1.5">
                              {(t.bids ?? []).map((b) => (
                                <div key={b.agentId} className="flex items-center justify-between gap-2 rounded-lg bg-foreground/5 px-2.5 py-1.5 text-xs">
                                  <span className="text-foreground/70">{b.agentName} · <b className="text-foreground">{b.priceUsd.toFixed(2)} USDC</b></span>
                                  <button type="button" onClick={() => acceptOpenBid(t.id, b.agentId)} disabled={busy === t.id} className="rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-50">Accept</button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {/* The worker's side lives in the same list only for someone who hired
                          their own agent; the server refuses anyone else. Folded away so a
                          client is never asked to "deliver" their own order. */}
                      {t.status === 'funded' && !t.escrowLocking && (
                        <details className="w-full" open={Boolean(t.workerNote) || undefined}>
                          <summary className="cursor-pointer text-xs font-semibold text-foreground/45 hover:text-foreground/70">
                            Taking too long? Cancel and get a refund
                          </summary>
                          <div className="mt-2">
                            <button
                              type="button"
                              onClick={() => taskAction(t.id, '/api/marketplace/dispute', { reason: 'Cancelled before delivery' })}
                              disabled={busy === t.id}
                              className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 px-3 py-1.5 text-xs font-semibold text-warn hover:bg-warn/10 disabled:opacity-50"
                            >
                              {busy === t.id ? <Loader2 size={12} className="animate-spin" /> : null}
                              {busy === t.id ? 'Working on Arc...' : `Cancel and refund ${t.priceUsd.toFixed(2)} USDC`}
                            </button>
                          </div>
                        </details>
                      )}
                      {t.status === 'funded' && !t.escrowLocking && (
                        <details className="w-full">
                          <summary className="cursor-pointer text-xs font-semibold text-foreground/45 hover:text-foreground/70">
                            Are you the worker? Deliver the result
                          </summary>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <input
                              value={deliverText[t.id] ?? ''}
                              onChange={(e) => setDeliverText((d) => ({ ...d, [t.id]: e.target.value }))}
                              placeholder="The result, or a link to it"
                              className="min-w-0 flex-1 rounded-full border border-foreground/15 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-foreground/40"
                            />
                            <button
                              type="button"
                              onClick={() => taskAction(t.id, '/api/marketplace/deliver', { deliverable: deliverText[t.id] ?? '' })}
                              disabled={busy === t.id || !(deliverText[t.id] ?? '').trim()}
                              className="rounded-full border border-foreground/15 px-3 py-1.5 text-xs font-semibold text-foreground/70 hover:bg-foreground/5 disabled:opacity-50"
                            >
                              Deliver
                            </button>
                          </div>
                        </details>
                      )}
                      {/* Client side: one clear action (pay), with rating optional beside it and
                          the dispute folded one click away. */}
                      {t.status === 'delivered' && !t.escrowLocking && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              taskAction(t.id, '/api/marketplace/release', {
                                // Sent only when the client actually supplied them. An absent
                                // rating is not a bad rating, and it is not a five.
                                ...(reviewDraft[t.id]?.rating ? { rating: reviewDraft[t.id]?.rating } : {}),
                                ...(reviewDraft[t.id]?.review?.trim() ? { review: reviewDraft[t.id]?.review?.trim() } : {}),
                              })
                            }
                            disabled={busy === t.id}
                            className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                          >
                            {busy === t.id ? <Loader2 size={12} className="animate-spin" /> : null}
                            {busy === t.id ? 'Releasing on Arc...' : `Approve and release ${t.priceUsd.toFixed(2)} USDC`}
                          </button>
                          <select
                            value={reviewDraft[t.id]?.rating ?? ''}
                            onChange={(e) =>
                              setReviewDraft((d) => ({
                                ...d,
                                [t.id]: { ...d[t.id], rating: e.target.value ? Number(e.target.value) : undefined },
                              }))
                            }
                            aria-label="Rating, optional"
                            className="rounded-full border border-foreground/15 bg-background px-3 py-1.5 text-xs text-foreground"
                          >
                            <option value="">Rate (optional)</option>
                            {[1, 2, 3, 4, 5].map((n) => (
                              <option key={n} value={n}>{n} / 5</option>
                            ))}
                          </select>
                          <input
                            value={reviewDraft[t.id]?.review ?? ''}
                            onChange={(e) =>
                              setReviewDraft((d) => ({ ...d, [t.id]: { ...d[t.id], review: e.target.value } }))
                            }
                            placeholder="Review (optional)"
                            className="min-w-0 flex-1 rounded-full border border-foreground/15 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-foreground/40"
                          />
                          <details className="w-full">
                            <summary className="cursor-pointer text-xs font-semibold text-foreground/45 hover:text-foreground/70">
                              Something wrong? Dispute and get a refund
                            </summary>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <input
                                value={disputeReason[t.id] ?? ''}
                                onChange={(e) => setDisputeReason((d) => ({ ...d, [t.id]: e.target.value }))}
                                placeholder="What is wrong (optional)"
                                className="min-w-0 flex-1 rounded-full border border-foreground/15 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-foreground/40"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  taskAction(t.id, '/api/marketplace/dispute', {
                                    reason: disputeReason[t.id]?.trim() || 'No reason given',
                                  })
                                }
                                disabled={busy === t.id}
                                className="rounded-full border border-warn/40 px-3 py-1.5 text-xs font-semibold text-warn hover:bg-warn/10 disabled:opacity-50"
                              >
                                Dispute and refund
                              </button>
                            </div>
                          </details>
                        </>
                      )}
                      {t.escrowExplorer && (
                        <a
                          href={t.escrowExplorer}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-usdc hover:underline"
                        >
                          <ExternalLink size={12} />{' '}
                          {t.status === 'released'
                            ? 'Proof: the release on the Arc explorer'
                            : t.status === 'refunded'
                              ? 'Proof: the refund on the Arc explorer'
                              : 'Escrow on the Arc explorer'}
                        </a>
                      )}
                    </div>
                    {note[t.id] && <p className="mt-2 text-[11px] text-warn">{note[t.id]}</p>}
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {/* Open tasks: the second way to hire, folded so the page leads with one way. */}
      <details className="mt-10" data-tour="open-tasks">
        <summary className="cursor-pointer text-sm font-semibold text-foreground/70 hover:text-foreground">
          Not sure who to hire? Post the job and let workers bid.
        </summary>

        <div className="mt-4 rounded-2xl border border-border bg-card p-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
            <input value={postSvc} onChange={(e) => setPostSvc(e.target.value)} placeholder="Service (e.g. translation)" className="rounded-full border border-foreground/15 bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground/40" />
            <input value={postBudget} onChange={(e) => setPostBudget(e.target.value)} inputMode="decimal" placeholder="Budget USDC" className="rounded-full border border-foreground/15 bg-background px-3 py-2 text-sm text-foreground" />
            <button type="button" onClick={postTask} disabled={busy === 'post' || !canPost} className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Post task</button>
          </div>
          <input value={postDesc} onChange={(e) => setPostDesc(e.target.value)} placeholder="What should be done? Enough detail that an agent can bid on it." className="mt-2 w-full rounded-xl border border-foreground/15 bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground/40" />
          {/* The server refuses a task nobody could bid on. Say the bound here rather than
              letting someone write the ask and meet a 400 on submit. */}
          <p className="mt-1.5 text-xs text-foreground/60">
            {canPost
              ? 'Ready to post.'
              : `A description of at least ${MIN_DESCRIPTION} characters is required, so a worker can tell what they would be bidding on.`}
          </p>
          {note.post && <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">{note.post}</p>}
        </div>

        {loading ? (
          <div className="mt-3 flex flex-col gap-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-7 w-14 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        ) : openTasks.length === 0 ? (
          <p className="mt-3 text-sm text-foreground/50">No open tasks right now.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {openTasks.map((t) => (
              <div key={t.id} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold text-foreground">{t.service}</span>
                    <span className="ml-2 text-xs text-foreground/45">budget {t.budgetUsd.toFixed(2)} USDC · {t.bids} bid{t.bids === 1 ? '' : 's'}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setBidKey(bidKey === t.id ? null : t.id); setBidAgent(''); setBidPrice(String(t.budgetUsd)) }}
                    className="rounded-full border border-foreground/15 px-3 py-1.5 text-xs font-semibold text-foreground/70 hover:bg-foreground/5"
                  >
                    Bid
                  </button>
                </div>
                {t.description && <p className="mt-1 text-sm text-foreground/60">{t.description}</p>}
                {bidKey === t.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input value={bidAgent} onChange={(e) => setBidAgent(e.target.value)} placeholder="Your agent id (agent_…)" className="min-w-0 flex-1 rounded-full border border-foreground/15 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-foreground/40" />
                    <input value={bidPrice} onChange={(e) => setBidPrice(e.target.value)} inputMode="decimal" placeholder="Bid USDC" className="w-24 rounded-full border border-foreground/15 bg-background px-3 py-1.5 text-xs text-foreground" />
                    <button type="button" onClick={() => submitBid(t.id)} disabled={busy === t.id || !bidAgent.trim()} className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Submit bid</button>
                  </div>
                )}
                {note[t.id] && <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">{note[t.id]}</p>}
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  )
}
