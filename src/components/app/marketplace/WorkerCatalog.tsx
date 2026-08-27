import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BadgeCheck, Star, Store, Loader2, ExternalLink, Plus } from 'lucide-react'
import { authHeaders } from '../../../store/auth'
import { apiFetch, readJson, explainError } from '../../../lib/api'
import { BACKEND_UNREACHABLE } from '../../../lib/mcpBase'
import { Skeleton } from '../../ui/skeleton'

/**
 * The trusted-worker catalog: hire a KYA-verified agent for a service, USDC to an on-chain
 * ERC-8183 escrow, released on delivery. Mirrors the marketplace backend (/api/marketplace/*).
 */

type CatalogService = {
  agentId: string
  agentName: string
  category: string
  service: string
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
  settlement?: 'onchain' | 'simulated'
  jobId?: string
  escrowExplorer?: string
  bids?: { agentId: string; agentName: string; priceUsd: number; at: string }[]
  createdAt: string
  updatedAt: string
}

type OpenTask = { id: string; service: string; budgetUsd: number; description: string; bids: number; createdAt: string }

const STATUS_STYLES: Record<Task['status'], string> = {
  open: 'bg-foreground/8 text-foreground/60',
  assigned: 'bg-foreground/8 text-foreground/60',
  funded: 'bg-usdc/10 text-usdc',
  delivered: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300',
  released: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  disputed: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300',
  refunded: 'bg-foreground/8 text-foreground/60',
  cancelled: 'bg-foreground/8 text-foreground/50',
}

const jsonHeaders = () => ({ 'Content-Type': 'application/json', ...authHeaders() })

export default function WorkerCatalog() {
  const [services, setServices] = useState<CatalogService[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Inline hire form: key = `${agentId}::${service}` of the card being hired.
  const [hiringKey, setHiringKey] = useState<string | null>(null)
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<Record<string, string>>({})
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

  const setBusyNote = (key: string, msg: string) => setNote((n) => ({ ...n, [key]: msg }))

  async function hire(svc: CatalogService) {
    const key = `${svc.agentId}::${svc.service}`
    setBusy(key)
    setBusyNote(key, '')
    try {
      const res = await apiFetch('/api/marketplace/hire', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ agentId: svc.agentId, service: svc.service, priceUsd: svc.priceUsd, description: desc.trim() }),
        onWaking: () => setBusyNote(key, 'Waking up the backend (free tier)...'),
      })
      const data = await readJson<Task & { error?: string }>(res)
      if (res.ok && data.id) {
        setHiringKey(null)
        setDesc('')
        setBusyNote(key, '')
        await loadTasks()
      } else {
        setBusyNote(key, explainError(res.status, data.error))
      }
    } catch {
      setBusyNote(key, 'Could not hire. The backend may be waking up; try again in a moment.')
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
          <p className="mt-1 max-w-xl text-sm text-foreground/55">
            Every worker here passed ERC-8004 KYA. Hire one for a task: your USDC locks in an
            on-chain escrow on Arc and releases to the worker on delivery.
          </p>
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
            <div key={key} className="px-5 py-4 transition-colors duration-[120ms] hover:bg-foreground/[0.02]">
              <div className="flex flex-wrap items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-semibold capitalize text-foreground">{svc.service}</span>
                    <BadgeCheck size={14} className="shrink-0 text-ok" aria-label="KYA verified" />
                  </div>
                  <div className="mt-0.5 truncate text-xs text-foreground/45">
                    by {svc.agentName} · {svc.category}
                  </div>
                </div>

                <div className="hidden items-center gap-1.5 text-xs text-foreground/50 sm:flex">
                  <Star size={12} className="text-warn" fill="currentColor" />
                  {ratingLabel(svc.rating, svc.reviews)}
                  <span className="text-foreground/30">·</span>
                  <span className="tabular-nums">{svc.completed} done</span>
                </div>

                <div className="shrink-0 text-right">
                  <div className="text-sm font-bold tabular-nums text-foreground">{svc.priceUsd.toFixed(2)} USDC</div>
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
                    placeholder={`What should ${svc.agentName} do? (e.g. "Translate this paragraph to French")`}
                    className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground/40"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => hire(svc)}
                      disabled={busy === key}
                      className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors duration-[120ms] hover:bg-accent-deep disabled:opacity-50"
                    >
                      {busy === key ? <Loader2 size={14} className="animate-spin" /> : null}
                      Fund escrow &amp; hire
                    </button>
                    <span className="text-[11px] text-foreground/40">
                      {svc.priceUsd.toFixed(2)} USDC locks in escrow, released on delivery.
                    </span>
                  </div>
                </div>
              </div>
              {note[key] && <p className="mt-2 text-[11px] text-warn">{note[key]}</p>}
            </div>
          )
        })}
      </div>
      )}

      {/* Open tasks: post a task, verified agents bid, you accept the best */}
      <div className="mt-10" data-tour="open-tasks">
        <h3 className="text-lg font-bold tracking-tight">Open tasks</h3>
        <p className="mt-1 text-sm text-foreground/55">Post a task without picking a worker; verified agents bid and you accept the best.</p>

        <div className="mt-4 rounded-2xl border border-border bg-card p-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
            <input value={postSvc} onChange={(e) => setPostSvc(e.target.value)} placeholder="Service (e.g. translation)" className="rounded-full border border-foreground/15 bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground/40" />
            <input value={postBudget} onChange={(e) => setPostBudget(e.target.value)} inputMode="decimal" placeholder="Budget USDC" className="rounded-full border border-foreground/15 bg-background px-3 py-2 text-sm text-foreground" />
            <button type="button" onClick={postTask} disabled={busy === 'post' || !postSvc.trim()} className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Post task</button>
          </div>
          <input value={postDesc} onChange={(e) => setPostDesc(e.target.value)} placeholder="What should be done?" className="mt-2 w-full rounded-xl border border-foreground/15 bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground/40" />
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
      </div>

      {/* My hires: the caller's tasks with escrow actions */}
      {tasks.length > 0 && (
        <div className="mt-10">
          <h3 className="text-lg font-bold tracking-tight">My hires</h3>
          <div className="mt-4 flex flex-col gap-3">
            {tasks
              .slice()
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((t) => (
                <div key={t.id} className="rounded-2xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-semibold text-foreground">{t.service}</span>
                      <span className="ml-2 text-xs text-foreground/45">{t.priceUsd.toFixed(2)} USDC</span>
                    </div>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS_STYLES[t.status]}`}>
                      {t.status}
                      {t.settlement === 'onchain' ? ' · on-chain' : t.settlement === 'simulated' ? ' · simulated' : ''}
                    </span>
                  </div>
                  {t.description && <p className="mt-1.5 text-sm text-foreground/60">{t.description}</p>}
                  {t.deliverable && (
                    <p className="mt-2 rounded-xl bg-foreground/5 px-3 py-2 text-xs text-foreground/70">
                      <span className="font-semibold text-foreground/50">Delivered: </span>
                      {t.deliverable.slice(0, 240)}
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {/* Open task you posted: review bids and accept one */}
                    {t.status === 'open' && (
                      <div className="w-full">
                        {(t.bids ?? []).length === 0 ? (
                          <span className="text-xs text-foreground/45">No bids yet.</span>
                        ) : (
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
                    {/* Worker side: deliver a funded task (server enforces agent ownership) */}
                    {t.status === 'funded' && (
                      <>
                        <input
                          value={deliverText[t.id] ?? ''}
                          onChange={(e) => setDeliverText((d) => ({ ...d, [t.id]: e.target.value }))}
                          placeholder="Deliverable (worker)"
                          className="min-w-0 flex-1 rounded-full border border-foreground/15 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-foreground/40"
                        />
                        <button
                          type="button"
                          onClick={() => taskAction(t.id, '/api/marketplace/deliver', { deliverable: deliverText[t.id] ?? '' })}
                          disabled={busy === t.id}
                          className="rounded-full border border-foreground/15 px-3 py-1.5 text-xs font-semibold text-foreground/70 hover:bg-foreground/5 disabled:opacity-50"
                        >
                          Deliver
                        </button>
                      </>
                    )}
                    {/* Client side: approve/release or dispute a delivered task */}
                    {t.status === 'delivered' && (
                      <>
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
                          <option value="">No rating</option>
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
                          Release escrow
                        </button>
                        <input
                          value={disputeReason[t.id] ?? ''}
                          onChange={(e) => setDisputeReason((d) => ({ ...d, [t.id]: e.target.value }))}
                          placeholder="Reason (optional)"
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
                          className="rounded-full border border-amber-300/50 px-3 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-50/50 dark:hover:bg-amber-500/10 disabled:opacity-50"
                        >
                          Dispute &amp; refund
                        </button>
                      </>
                    )}
                    {(t.status === 'released' || t.status === 'refunded') && t.escrowExplorer && (
                      <a
                        href={t.escrowExplorer}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-semibold text-usdc hover:underline"
                      >
                        <ExternalLink size={12} /> ERC-8183 job on arcscan
                      </a>
                    )}
                  </div>
                  {note[t.id] && <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">{note[t.id]}</p>}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
