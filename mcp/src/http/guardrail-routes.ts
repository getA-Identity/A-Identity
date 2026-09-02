/**
 * Guardrail route group (split from http.ts): action policy, traction/stats,
 * self-check, manifest registration, badges, action-check, spend preflight, audit
 * log, Circle policy plan, permissions. Handlers return true when the request was
 * handled; order within this file mirrors the original http.ts order.
 */
import {
  getAgentActionPolicy, updateAgentActionPolicy, platformTraction, platformStats,
  guardrailSelfCheck, registerAgentFromManifest, agentRegistration, setBadgeVisibility,
  agentBadge, checkAgentAction, spendPreflight, listAgentAudits, recordAuditOutcome,
  getAgentCirclePolicyPlan, updateAgentPermissions,
} from '../platform.js'
import { isSafePublicHttpUrl } from '../erc8004.js'
import { renderBadgeSvg } from '../policy/index.js'
import {
  parseExplorerAgentUrl, resolveAgentManifestUrl, describeOwnership,
  type ResolvedAgentManifest, type OwnershipNote,
} from '../chains/explorer-agent-url.js'
import { denyRead, errStatus, readBody, sendJson, validAmount, type RouteCtx } from './shared.js'

/**
 * Explorer and code-host pages people paste when they mean "the metadata URL". Each
 * serves HTML, so JSON.parse fails and the old message just said the URL was not JSON.
 * The hint names the one thing that actually works on that host.
 */
const MANIFEST_URL_HINTS: { match: RegExp; hint: string }[] = [
  {
    match: /(^|\.)8004scan\.io$/i,
    hint: 'that is an 8004scan explorer page, which serves HTML. Open the agent there, copy the tokenURI / metadata link it shows, and paste that instead',
  },
  {
    match: /(^|\.)(etherscan\.io|basescan\.org|celoscan\.io|arbiscan\.io|oklink\.com|arcscan\.app)$/i,
    hint: 'that is a block explorer page, which serves HTML. Paste the raw metadata JSON URL the token points at, not the explorer page',
  },
  {
    match: /(^|\.)github\.com$/i,
    hint: 'that is a GitHub page, which serves HTML. Use the raw.githubusercontent.com URL for the file',
  },
  {
    match: /(^|\.)(aigora\.org|okx\.ai)$/i,
    hint: 'that is a listing page, which serves HTML. Paste the manifest JSON your own service hosts',
  },
]

/**
 * Say what actually came back, so the caller can fix it without guessing. Returns a
 * fragment appended after "manifest fetch failed: ".
 */
export function describeNonJsonManifest(manifestUrl: string, contentType: string, body: string): string {
  let host = ''
  try { host = new URL(manifestUrl).hostname } catch { /* the URL already passed validation; treat as unknown */ }

  const known = MANIFEST_URL_HINTS.find((h) => h.match.test(host))
  if (known) return known.hint

  const looksHtml = /^\s*(<!doctype html|<html)/i.test(body) || /text\/html/i.test(contentType)
  if (looksHtml) {
    return 'that URL returned an HTML page, not JSON. A manifest URL must serve the raw JSON document itself, for example https://your-agent.example.com/.well-known/agent-manifest.json'
  }
  if (!body.trim()) return 'the URL returned an empty body'

  const shown = contentType.split(';')[0]?.trim()
  return shown
    ? `the URL returned ${shown}, which is not parseable JSON`
    : 'the URL did not return valid JSON'
}

/** What quick register resolved off chain, plus what that does and does not claim. Rides
 *  on BOTH the success and the failure bodies so the UI can always say where the URL it
 *  used came from, rather than the resolution being a silent rewrite of the caller's input. */
type ResolvedManifestSource = ResolvedAgentManifest & { ownership: OwnershipNote }

/** A tokenURI is agent-controlled and can be a multi-kilobyte inline data: URI, so an
 *  error message quotes the head of it instead of shipping the whole thing back. */
function shortUrl(u: string): string {
  return u.length > 120 ? `${u.slice(0, 120)}...` : u
}

export async function handleGuardrailRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url, callerId } = ctx

  // ── Policy Engine v2: the action policy (trade surface today) ────────────────
  // Distinct from /api/agents/policy above, which is the USDC payment policy. Free to
  // read and write: these are the owner's own rules. Owner-gated both ways, since a
  // policy exposes the owner's limits.
  if (req.method === 'GET' && url.pathname === '/api/agents/action-policy') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    if (denyRead(res, agentId, callerId)) return true
    const p = getAgentActionPolicy(agentId, callerId)
    sendJson(res, 'error' in p ? errStatus(p.error) : 200, p)
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/agents/action-policy') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; policy?: unknown } | null
    if (!body?.agentId || body.policy === undefined) {
      sendJson(res, 400, { error: 'agentId and policy required' }); return true
    }
    const p = updateAgentActionPolicy(body.agentId, body.policy, callerId)
    sendJson(res, 'error' in p ? errStatus(p.error) : 200, p)
    return true
  }

  // ── traction + engine self-check (Phase 5.4 and 5.5) ─────────────────────────
  // Public and unauthenticated on purpose: both are aggregate or stateless, so there is
  // nothing here that identifies an agent, an owner, a holding or an individual amount.
  if (req.method === 'GET' && url.pathname === '/api/traction') {
    sendJson(res, 200, platformTraction())
    return true
  }
  // Platform-wide aggregates (agents, tasks, settlements, feedback, chains, contracts,
  // x402). Same publication rule as /api/traction: aggregate only, nothing identifying
  // an agent owner, a holding, or an individual amount.
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    sendJson(res, 200, platformStats())
    return true
  }
  // "Is the guardrail enforcing right now?" answered by running canonical vectors through
  // the pure engine. Creates nothing and records nothing, so this monitor cannot inflate
  // the traction numbers above.
  if (req.method === 'GET' && url.pathname === '/api/guardrail-status') {
    const status = guardrailSelfCheck()
    sendJson(res, status.enforcing ? 200 : 503, status)
    return true
  }

  // ── register_agent + guardrail badge (Phase 1.5) ─────────────────────────────
  // A manifest-shaped registration over the SAME createAgent path the UI uses. Free.
  if (req.method === 'POST' && url.pathname === '/api/agents/register') {
    const body = (await readBody(req).catch(() => null)) as { manifest?: Record<string, unknown> } | null
    const manifest = (body?.manifest ?? body) as Record<string, unknown> | null
    if (!manifest?.name) { sendJson(res, 400, { error: 'manifest.name required' }); return true }
    // `ci: true` marks a canary: recorded in full, excluded from traction headlines.
    const r = registerAgentFromManifest(manifest as never, callerId)
    sendJson(res, 'error' in r ? errStatus(r.error) : 201, r)
    return true
  }
  // The same registration, by reference: the caller hands us a URL to their manifest
  // instead of the manifest inline (how an agent framework points at its own hosted
  // card). We fetch it server-side, which makes the URL an SSRF surface: only http(s)
  // to a public-looking host (isSafePublicHttpUrl - best-effort literal-host filtering,
  // acceptable for a demo backend), redirects refused so a public URL can't 30x us into
  // an internal target, and the response bounded in both time and size.
  if (req.method === 'POST' && url.pathname === '/api/agents/register-url') {
    const body = (await readBody(req).catch(() => null)) as { url?: string } | null
    if (!body?.url || typeof body.url !== 'string') { sendJson(res, 400, { error: 'url required' }); return true }
    const pasted = body.url.trim()

    // An explorer agent page is not a mistake we can only complain about. The URL names a
    // chain and a token id, and the manifest URL people are being asked for IS a value we
    // can read: tokenURI(tokenId) on that chain's ERC-8004 identity registry. Try that
    // first; anything unrecognised falls through to the hint table unchanged.
    //
    // Resolving is never silent. `resolvedFrom` rides on every reply from here on, so the
    // caller sees which chain, which token, which tokenURI, and - because registering here
    // creates OUR record with the caller as owner - what that does not claim on chain.
    let resolvedFrom: ResolvedManifestSource | null = null
    const link = parseExplorerAgentUrl(pasted)
    if (link) {
      const r = await resolveAgentManifestUrl(link)
      if ('error' in r) { sendJson(res, 502, { error: `manifest fetch failed: ${r.error}` }); return true }
      resolvedFrom = { ...r, ownership: describeOwnership(r.onchainOwner, callerId, r.tokenId, r.chainName) }
    }
    const manifestUrl = resolvedFrom?.tokenURI ?? pasted
    /** Reply shape shared by every failure below, so the resolution is visible even when
     *  the URL the chain handed us turns out to be unusable. */
    const fail = (status: number, error: string) =>
      sendJson(res, status, { error, ...(resolvedFrom ? { resolvedFrom } : {}) })
    // What the chain said, named in the failure messages: the caller must be able to tell
    // "you pasted a bad URL" apart from "the URL on chain is bad".
    const onchain = resolvedFrom
      ? `agent #${resolvedFrom.tokenId} on ${resolvedFrom.chainName} points its tokenURI at ${shortUrl(manifestUrl)}, and `
      : ''

    if (!isSafePublicHttpUrl(manifestUrl)) {
      fail(400, resolvedFrom
        ? `manifest fetch failed: ${onchain}that is not a public http(s) URL we can fetch (data: URIs, localhost, private ranges, and internal hosts are refused)`
        : 'url must be a public http(s) URL; localhost, private ranges, and internal hosts are refused')
      return true
    }
    let manifest: unknown
    let fetched = ''
    let contentType = ''
    try {
      const upstream = await fetch(manifestUrl, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
      if (!upstream.ok) { fail(502, `manifest fetch failed: ${onchain}upstream answered HTTP ${upstream.status}`); return true }
      contentType = upstream.headers.get('content-type') ?? ''
      fetched = await upstream.text()
      // Same reasoning as MAX_BODY_BYTES: a manifest is a small JSON document, and anything
      // bigger would balloon the single persisted state blob when its fields are stored.
      if (fetched.length > 200_000) { fail(400, 'manifest too large (200KB max)'); return true }
      manifest = JSON.parse(fetched)
    } catch (e) {
      // "the URL did not return valid JSON" told the caller nothing they could act on.
      // The overwhelmingly common mistake is pasting an explorer PAGE (8004scan, a block
      // explorer, a GitHub blob) rather than the raw manifest, and every one of those
      // answers with HTML. Name what came back and what to paste instead. A resolved
      // tokenURI goes through exactly the same check: the chain can point at HTML too.
      fail(e instanceof SyntaxError ? 400 : 502,
        e instanceof SyntaxError
          ? `manifest fetch failed: ${onchain}${describeNonJsonManifest(manifestUrl, contentType, fetched)}`
          : `manifest fetch failed: ${onchain}the URL did not answer within 10s (redirects are not followed)`)
      return true
    }
    const r = registerAgentFromManifest(manifest as never, callerId)
    if ('error' in r) { fail(errStatus(r.error), r.error); return true }
    sendJson(res, 201, resolvedFrom ? { ...r, resolvedFrom } : r)
    return true
  }
  // The owner's own registration + badge view.
  if (req.method === 'GET' && url.pathname === '/api/agents/register') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    if (denyRead(res, agentId, callerId)) return true
    const r = agentRegistration(agentId, callerId)
    sendJson(res, 'error' in r ? errStatus(r.error) : 200, r)
    return true
  }
  // Publish or unpublish the badge. Off by default: a badge is the owner's own claim.
  if (req.method === 'POST' && url.pathname === '/api/agents/badge-visibility') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; public?: boolean } | null
    if (!body?.agentId || typeof body.public !== 'boolean') {
      sendJson(res, 400, { error: 'agentId and public (boolean) required' }); return true
    }
    const r = setBadgeVisibility(body.agentId, body.public, callerId)
    sendJson(res, 'error' in r ? errStatus(r.error) : 200, r)
    return true
  }
  // The public badge. Served only for agents whose owner opted in. Content-negotiated:
  // an SVG for embedding, JSON otherwise. Coarse by design, and it carries no number.
  if (req.method === 'GET' && url.pathname === '/api/agents/badge') {
    const agentId = url.searchParams.get('agentId') ?? ''
    const surface = url.searchParams.get('surface') ?? 'trade'
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    const r = agentBadge(agentId, surface)
    if ('error' in r) { sendJson(res, errStatus(r.error), r); return true }
    const wantsSvg = (req.headers.accept ?? '').includes('image/svg') || url.searchParams.get('format') === 'svg'
    if (wantsSvg) {
      const svg = renderBadgeSvg(r.badge)
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        // Short cache: a badge must not keep showing "enforced" long after the state moved.
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(svg)
      return true
    }
    sendJson(res, 200, { agentId, agentName: r.agentName, ...r.badge })
    return true
  }

  // Check an intended action against the policy. Returns a verdict and the audit id; it
  // never executes anything, so the caller stays the one that acts.
  if (req.method === 'POST' && url.pathname === '/api/agents/action-check') {
    const body = (await readBody(req).catch(() => null)) as
      | {
          agentId?: string
          surface?: string
          intent?: unknown
          snapshot?: unknown
          callerId?: string
          action?: unknown
          account?: unknown
        }
      | null
    // Either shape is enough. The precondition is only "there is something to check";
    // which of the two shapes it is, and whether it can be translated, is decided in one
    // place (callers/normalize.ts) so this route cannot develop a second opinion.
    if (!body?.agentId || !body?.surface || (!body.intent && !body.callerId)) {
      sendJson(res, 400, { error: 'agentId, surface and either intent or callerId + action required' }); return true
    }
    const r = checkAgentAction(
      body.agentId,
      {
        surface: body.surface,
        intent: body.intent,
        snapshot: body.snapshot,
        callerId: body.callerId,
        action: body.action,
        account: body.account,
      },
      callerId,
    )
    sendJson(res, 'error' in r ? errStatus(r.error) : 200, r)
    return true
  }
  // D1 spend pre-flight: "if my agent tried this spend right now, what would happen and
  // why?" Runs the SAME policy ladder POST /api/instructions runs (shared pure function),
  // against the LIVE state: remaining daily cap, auto-approve ceiling, allowlist, freeze,
  // and the D3 velocity window. Read-only by contract: no instruction is created, no
  // audit row, no meter tick, no spend committed. Owner-gated like its neighbors.
  // Distinct from POST /api/agents/action-check above, which covers the Policy Engine v2
  // trade/spend-card surfaces; this is the Arc USDC payment path.
  if (req.method === 'POST' && url.pathname === '/api/agents/spend-preflight') {
    const body = (await readBody(req).catch(() => null)) as
      | { agentId?: string; amountUsd?: number; count?: number; payee?: string }
      | null
    if (!body?.agentId || !body?.payee) {
      sendJson(res, 400, { error: 'agentId, amountUsd, payee required' }); return true
    }
    // Same input rules as POST /api/instructions, so a preview can never pass an amount
    // the real submission would refuse.
    if (!validAmount(body.amountUsd)) {
      sendJson(res, 400, { error: 'amountUsd must be a finite number between 0 and 1000000' }); return true
    }
    if (body.count !== undefined && !(Number.isFinite(body.count) && body.count! >= 1 && body.count! <= 1000)) {
      sendJson(res, 400, { error: 'count must be an integer between 1 and 1000' }); return true
    }
    const r = spendPreflight(
      body.agentId,
      { amountUsd: body.amountUsd, count: body.count, payee: body.payee },
      callerId,
    )
    sendJson(res, 'error' in r ? errStatus(r.error) : 200, r)
    return true
  }
  // The decision trail for one agent (owner-gated, newest first, optional ?since=).
  if (req.method === 'GET' && url.pathname === '/api/agents/audit-log') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    if (denyRead(res, agentId, callerId)) return true
    const limitRaw = url.searchParams.get('limit')
    const r = listAgentAudits(
      agentId,
      {
        since: url.searchParams.get('since') ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      },
      callerId,
    )
    sendJson(res, 'error' in r ? errStatus(r.error) : 200, r)
    return true
  }
  // Record what happened after a verdict (a WARN a human confirmed, or an abandon).
  if (req.method === 'POST' && url.pathname === '/api/agents/audit-log/outcome') {
    const body = (await readBody(req).catch(() => null)) as
      | { agentId?: string; auditId?: string; outcome?: string; evidenceRef?: string }
      | null
    const allowed = ['executed', 'blocked', 'awaiting_human', 'abandoned']
    if (!body?.agentId || !body?.auditId || !body?.outcome) {
      sendJson(res, 400, { error: 'agentId, auditId and outcome required' }); return true
    }
    if (!allowed.includes(body.outcome)) {
      sendJson(res, 400, { error: `outcome must be one of: ${allowed.join(', ')}` }); return true
    }
    const r = recordAuditOutcome(body.agentId, body.auditId, body.outcome as never, callerId, body.evidenceRef)
    sendJson(res, 'error' in r ? errStatus(r.error) : 200, r)
    return true
  }

  // Update an agent's permissions (the real policy the engine enforces)
  // ── The same limits, as Circle Agent Wallet policy commands the owner can run ────
  if (req.method === 'GET' && url.pathname === '/api/agents/circle-policy') {
    const agentId = url.searchParams.get('agentId')
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    // Owner-gated like every other agent-scoped private read in this file. The plan spells
    // out the vault address, the per-tx and daily limits and the full payee allowlist as
    // ready-to-run CLI commands, which is exactly the shape of the policy a stranger must
    // not be able to read off an agent.
    if (denyRead(res, agentId, callerId)) return true
    const plan = await getAgentCirclePolicyPlan(agentId, url.searchParams.get('email') ?? undefined)
    sendJson(res, 'error' in plan && plan.error ? errStatus(plan.error) : 200, plan)
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/permissions') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; permissions?: Record<string, unknown> } | null
    if (!body?.agentId || !body?.permissions) { sendJson(res, 400, { error: 'agentId and permissions required' }); return true }
    const a = await updateAgentPermissions(body.agentId, body.permissions as never, callerId)
    sendJson(res, 'error' in a ? errStatus(a.error) : 200, { agent: a })
    return true
  }

  return false
}
