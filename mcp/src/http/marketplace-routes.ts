/**
 * Marketplace route group (split from http.ts): showcase, leaderboard, follow,
 * feedback, semantic search, catalog, task lifecycle (hire/deliver/release/dispute),
 * open tasks + bids, and the v1 manifest/register API. Handlers return true when the
 * request was handled; order within this file mirrors the original http.ts order.
 */
import {
  marketplace, marketplaceLeaderboard, followAgent, agentFeedback, addAgentFeedback,
  consumeSemanticQuota, semanticSearchAgents, marketplaceCatalog, hireAgent, deliverTask,
  releaseTask, disputeTask, getTask, listOpenTasks, postOpenTask, bidOnTask, acceptBid,
  listTasksForAgent, listTasksForClient, agentManifest, registerExternalAgent,
  listPlatformAgents,
} from '../platform.js'
import { agentQuotaComplaint } from '../marketplace.js'
import { errStatus, readBody, sendJson, validAmount, type RouteCtx } from './shared.js'

export async function handleMarketplaceRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url, callerId } = ctx

  // ── Platform: marketplace (Agent House) ──────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/marketplace') {
    const includeAll = url.searchParams.get('all') === '1'
    // ?category=trading|spend lists only agents who published a badge AND have been checked
    // on that surface (Phase 5.2).
    sendJson(
      res,
      200,
      // A signed-in caller's follow state comes from the session, not from a tag they can
      // type; the query param stays as the fallback for anonymous browsing.
      marketplace(callerId ?? url.searchParams.get('viewer') ?? undefined, includeAll, url.searchParams.get('category') ?? undefined),
    )
    return true
  }
  // The ranked view of the same showcase (public read): one composite score per agent, so
  // the UI never re-derives ranking client-side and drifts from what the server would say.
  if (req.method === 'GET' && url.pathname === '/api/marketplace/leaderboard') {
    sendJson(res, 200, marketplaceLeaderboard())
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/follow') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; follower?: string } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    // The follower is the session, never a string the client picked. A client-supplied name
    // let one caller push unlimited distinct followers onto any agent, and `followers` is a
    // weighted term in the leaderboard's rankScore. `body.follower` is accepted and ignored
    // so older clients keep working.
    if (!callerId) { sendJson(res, 403, { error: 'Forbidden' }); return true }
    const r = followAgent(body.agentId, callerId)
    sendJson(res, 'error' in r ? 404 : 200, r)
    return true
  }

  // ── Agent feedback: 1-10 user ratings, one entry per rater per agent ─────────
  if (req.method === 'GET' && url.pathname === '/api/marketplace/feedback') {
    const agentId = url.searchParams.get('agentId')
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    const r = agentFeedback(agentId)
    sendJson(res, 'error' in r ? 404 : 200, r)
    return true
  }
  // POST rides the global mutation gate above: guests are already 401/403 here.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/feedback') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; score?: number; comment?: string } | null
    if (!body?.agentId || body.score == null) { sendJson(res, 400, { error: 'agentId and score required' }); return true }
    const r = addAgentFeedback(body.agentId, callerId!, body.score, body.comment)
    sendJson(res, 'error' in r ? ('Unknown agent' === r.error ? 404 : 400) : 200, r)
    return true
  }

  // ── Semantic marketplace search: free daily quota, then a hard 402 ───────────
  if (req.method === 'GET' && url.pathname === '/api/marketplace/semantic-search') {
    const q = url.searchParams.get('q') ?? ''
    if (!q.trim()) { sendJson(res, 400, { error: 'q required' }); return true }
    // Metered per signed-in caller, and per IP otherwise. The `viewer` tag used to sit in
    // this key, which meant the free tier could be reset by editing a query parameter: the
    // IP fallback the comment relied on was never reached for an anonymous caller.
    const meterKey = callerId ?? (req.socket.remoteAddress || 'anon')
    const quota = consumeSemanticQuota(meterKey)
    if (!quota.ok) {
      sendJson(res, 402, {
        error: 'Free semantic searches used up for today.',
        remaining: 0,
        resetsAt: quota.resetsAt,
        premium: {
          via: 'x402',
          note: 'Metered semantic search is available as a paid x402 service on the A-Identity ASP (OKX.AI agent #6271); standard search stays free here.',
          priceUsd: 0.01,
        },
      })
      return true
    }
    const r = semanticSearchAgents(q, url.searchParams.get('viewer') ?? undefined)
    sendJson(res, 200, { ...r, remaining: quota.remaining, resetsAt: quota.resetsAt })
    return true
  }

  // ── Marketplace tasks: hire a verified worker; escrow settles on release ─────
  // Public service catalog (the card grid): verified agents' services + ratings.
  if (req.method === 'GET' && url.pathname === '/api/marketplace/catalog') {
    sendJson(res, 200, marketplaceCatalog())
    return true
  }
  // Hire a verified agent for a service -> creates a task (escrow committed). Verified-only.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/hire') {
    const body = (await readBody(req).catch(() => null)) as
      | { agentId?: string; service?: string; priceUsd?: number; description?: string; deadlineHours?: number }
      | null
    if (!body?.agentId || !body?.service) { sendJson(res, 400, { error: 'agentId and service required' }); return true }
    if (!validAmount(body.priceUsd, 1000)) { sendJson(res, 400, { error: 'priceUsd must be a finite number between 0 and 1000' }); return true }
    const t = await hireAgent({
      agentId: body.agentId, service: body.service, priceUsd: body.priceUsd,
      description: body.description, deadlineHours: body.deadlineHours, client: callerId,
    })
    sendJson(res, 'error' in t ? errStatus(t.error) : 201, t)
    return true
  }
  // The hired worker delivers a result. funded -> delivered.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/deliver') {
    const body = (await readBody(req).catch(() => null)) as { taskId?: string; deliverable?: string } | null
    if (!body?.taskId) { sendJson(res, 400, { error: 'taskId required' }); return true }
    const t = deliverTask(body.taskId, typeof body.deliverable === 'string' ? body.deliverable : '', callerId)
    sendJson(res, 'error' in t ? errStatus(t.error) : 200, t)
    return true
  }
  // The client releases the escrow (real ERC-8183 settlement) + optional review.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/release') {
    const body = (await readBody(req).catch(() => null)) as { taskId?: string; rating?: number; review?: string } | null
    if (!body?.taskId) { sendJson(res, 400, { error: 'taskId required' }); return true }
    const t = await releaseTask(body.taskId, { rating: body.rating, review: body.review }, callerId)
    sendJson(res, 'error' in t ? errStatus(t.error) : 200, t)
    return true
  }
  // The client disputes -> real ERC-8183 refund to the client.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/dispute') {
    const body = (await readBody(req).catch(() => null)) as { taskId?: string; reason?: string } | null
    if (!body?.taskId) { sendJson(res, 400, { error: 'taskId required' }); return true }
    const t = await disputeTask(body.taskId, typeof body.reason === 'string' ? body.reason : 'disputed', callerId)
    sendJson(res, 'error' in t ? errStatus(t.error) : 200, t)
    return true
  }
  // One task (party-scoped: the client or the hired agent's owner).
  if (req.method === 'GET' && url.pathname === '/api/marketplace/task') {
    const taskId = url.searchParams.get('taskId') ?? ''
    if (!taskId) { sendJson(res, 400, { error: 'taskId required' }); return true }
    const t = getTask(taskId, callerId)
    sendJson(res, 'error' in t ? errStatus(t.error) : 200, t)
    return true
  }
  // Open tasks (post -> bid -> accept). Public list of open tasks awaiting bids.
  if (req.method === 'GET' && url.pathname === '/api/marketplace/open-tasks') {
    sendJson(res, 200, listOpenTasks())
    return true
  }
  // A client posts an open task (no worker chosen yet). Verified-only.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/post-task') {
    const body = (await readBody(req).catch(() => null)) as { service?: string; budgetUsd?: number; description?: string; deadlineHours?: number } | null
    if (!body?.service) { sendJson(res, 400, { error: 'service required' }); return true }
    if (!validAmount(body.budgetUsd, 1000)) { sendJson(res, 400, { error: 'budgetUsd must be a finite number between 0 and 1000' }); return true }
    const t = postOpenTask({ service: body.service, budgetUsd: body.budgetUsd, description: body.description, deadlineHours: body.deadlineHours, client: callerId })
    sendJson(res, 'error' in t ? errStatus(t.error) : 201, t)
    return true
  }
  // A verified agent bids on an open task (bidder = the agent owner).
  if (req.method === 'POST' && url.pathname === '/api/marketplace/bid') {
    const body = (await readBody(req).catch(() => null)) as { taskId?: string; agentId?: string; priceUsd?: number } | null
    if (!body?.taskId || !body?.agentId) { sendJson(res, 400, { error: 'taskId and agentId required' }); return true }
    if (!validAmount(body.priceUsd, 1000)) { sendJson(res, 400, { error: 'priceUsd must be a finite number between 0 and 1000' }); return true }
    const t = bidOnTask(body.taskId, { agentId: body.agentId, priceUsd: body.priceUsd }, callerId)
    sendJson(res, 'error' in t ? errStatus(t.error) : 200, t)
    return true
  }
  // The client accepts a bid -> task assigned + escrow committed.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/accept-bid') {
    const body = (await readBody(req).catch(() => null)) as { taskId?: string; agentId?: string } | null
    if (!body?.taskId || !body?.agentId) { sendJson(res, 400, { error: 'taskId and agentId required' }); return true }
    const t = await acceptBid(body.taskId, body.agentId, callerId)
    sendJson(res, 'error' in t ? errStatus(t.error) : 200, t)
    return true
  }
  // Tasks: an owned agent's jobs (?agentId=, owner-only) or the caller's own hires.
  if (req.method === 'GET' && url.pathname === '/api/marketplace/tasks') {
    const agentId = url.searchParams.get('agentId') ?? undefined
    if (agentId) {
      const r = listTasksForAgent(agentId, callerId)
      if ('error' in r) { sendJson(res, errStatus(r.error), r); return true }
      sendJson(res, 200, { tasks: r })
    } else {
      sendJson(res, 200, { tasks: listTasksForClient(callerId) })
    }
    return true
  }

  // ── Open ecosystem: per-agent manifest (AMP Discover) + external self-register ──
  // Public manifest an external project / SDK reads to find + hire an agent.
  if (req.method === 'GET' && url.pathname === '/api/v1/agents/manifest') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    const m = agentManifest(agentId)
    sendJson(res, 'error' in m ? errStatus(m.error) : 200, m)
    return true
  }
  // An external framework's agent self-registers (verified session; owner = caller). Returns
  // the created agent, its manifest, and a KYA challenge to prove wallet control next.
  if (req.method === 'POST' && url.pathname === '/api/v1/agents/register') {
    const body = (await readBody(req).catch(() => null)) as {
      name?: string; description?: string; category?: string
      capabilities?: string[]; services?: { name: string; priceUsd: number; unit: string }[]
      walletAddress?: string; endpoint?: string
    } | null
    if (!body?.name) { sendJson(res, 400, { error: 'name required' }); return true }
    if (body.walletAddress && !/^0x[0-9a-fA-F]{40}$/.test(body.walletAddress)) {
      sendJson(res, 400, { error: 'walletAddress must be a 0x address' }); return true
    }
    // The same per-owner ceiling POST /api/agents enforces, from the same pure rule, because
    // this is the same row through a second door. One limit stated once (agentQuotaComplaint
    // in ../marketplace.js) so the two registration paths cannot drift apart.
    const quota = callerId ? agentQuotaComplaint(listPlatformAgents().filter((a) => a.owner === callerId).length) : null
    if (quota) { sendJson(res, 400, { error: quota }); return true }
    const r = await registerExternalAgent({
      name: body.name, description: body.description, category: body.category,
      capabilities: body.capabilities, services: body.services,
      walletAddress: body.walletAddress, endpoint: body.endpoint, owner: callerId,
    })
    sendJson(res, 'error' in r ? errStatus(r.error) : 201, r)
    return true
  }

  return false
}
