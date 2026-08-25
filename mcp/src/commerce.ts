/**
 * Commerce merchant verification - the trust check agentic-commerce protocols skip.
 *
 * ACP/UCP-style checkout flows anchor trust in the USER's approval: nothing in the
 * protocol verifies WHO the merchant-side agent is before money moves. This module
 * fills that gap: given a merchant URL and/or an agent id, it discovers the merchant's
 * /.well-known agent card (SSRF-guarded), resolves its ERC-8004 identity with a live
 * on-chain read, reads this platform's view (KYA state, reputation, Sybil flag), and
 * returns ALLOW / WARN / DENY with every triggered reason - so a buyer agent can
 * refuse a checkout BEFORE authorizing payment, not dispute it after.
 *
 * Free and read-only by construction: no keys, no state writes, no metering. The
 * verdict ladder mirrors the published risk methodology (asp/proof.ts /methodology:
 * DENY on revoked KYA / wash reputation / no on-chain identity / reputation < 200;
 * WARN on reputation < 500 / unattested KYA) but deliberately does NOT import the
 * paid ASP tool code paths, so this free surface can never drift the paid product.
 * The thresholds are pinned by commerce.test.ts instead.
 */
import type { AgentIdentity } from './data.js'
import { createIdentityProvider, isSafePublicHttpUrl } from './erc8004.js'

// ── verdict ladder ────────────────────────────────────────────────────────────

export type MerchantVerdict = 'ALLOW' | 'WARN' | 'DENY'
export type MerchantReason = { code: string; severity: 'deny' | 'warn' | 'info'; detail: string }

/** Thresholds mirroring the published /methodology (see docstring above; pinned by tests). */
const REP_DENY_BELOW = 200
const REP_WARN_BELOW = 500

/** The 0-1000 score mapped onto the methodology's bands: <200 low, <500 moderate, else strong. */
export function reputationBand(score: number): 'low' | 'moderate' | 'strong' {
  if (score < REP_DENY_BELOW) return 'low'
  if (score < REP_WARN_BELOW) return 'moderate'
  return 'strong'
}

/** The real, already-gathered signals the verdict is computed from. Pure input, no I/O. */
export type MerchantSignals = {
  /** A resolvable on-chain ERC-8004 identity was found for the merchant agent. */
  identityFound: boolean
  /** The platform's KYA state for the agent; null when the platform has no view. */
  kya: 'unverified' | 'verified' | 'revoked' | null
  /** The platform's 0-1000 reputation score; null when the platform has no view. */
  reputationScore: number | null
  /** The platform's Sybil / wash-reputation flag; null when the platform has no view. */
  sybil: 'none' | 'low' | 'medium' | 'high' | null
  /** Manifest discovery outcome: requested = a url was given at all. */
  manifest: { requested: boolean; found: boolean; unreachable: boolean }
}

/**
 * The pure verdict ladder. Evaluated in a fixed order; every triggered reason is
 * listed and the FIRST DECISIVE one wins (any deny reason forces DENY, else any
 * warn reason forces WARN, else ALLOW). Reasons keep ladder order, so reasons[0]
 * is always the reason that decided the verdict.
 */
export function computeMerchantVerdict(s: MerchantSignals): { verdict: MerchantVerdict; reasons: MerchantReason[] } {
  const deny: MerchantReason[] = []
  const warn: MerchantReason[] = []

  if (s.kya === 'revoked') {
    deny.push({ code: 'kya_revoked', severity: 'deny', detail: 'KYA has been REVOKED - this agent is flagged as an incident (compromised key or repeated disputes)' })
  }
  if (s.sybil === 'high') {
    deny.push({ code: 'sybil_high', severity: 'deny', detail: 'Reputation appears Sybil / wash-traded - most of its jobs were hired by its own operator, not independent buyers' })
  }
  if (!s.identityFound) {
    deny.push({ code: 'no_onchain_identity', severity: 'deny', detail: 'No verifiable on-chain identity (ERC-8004) found for this merchant agent - there is no accountable party to pay' })
  }
  if (s.reputationScore !== null && s.reputationScore < REP_DENY_BELOW) {
    deny.push({ code: 'low_reputation', severity: 'deny', detail: `Reputation ${s.reputationScore} is below the safe threshold (${REP_DENY_BELOW})` })
  }

  if (s.reputationScore !== null && s.reputationScore >= REP_DENY_BELOW && s.reputationScore < REP_WARN_BELOW) {
    warn.push({ code: 'moderate_reputation', severity: 'warn', detail: `Moderate reputation (${s.reputationScore}); proceed with caution` })
  }
  if (s.kya === 'unverified') {
    warn.push({ code: 'kya_unverified', severity: 'warn', detail: 'Identity known but KYA (wallet-control) is not attested' })
  }
  if (s.sybil === 'medium') {
    warn.push({ code: 'sybil_medium', severity: 'warn', detail: 'Possible Sybil signals: partial same-operator hiring or low counterparty diversity' })
  }
  if (s.identityFound && s.reputationScore === null) {
    warn.push({ code: 'no_platform_history', severity: 'warn', detail: 'On-chain identity verified, but this platform has no reputation history to vouch for it' })
  }
  if (s.manifest.requested && s.manifest.unreachable) {
    warn.push({ code: 'manifest_unreachable', severity: 'warn', detail: 'The merchant site could not be reached to read its agent card (network failure or timeout)' })
  }
  if (s.manifest.requested && !s.manifest.unreachable && !s.manifest.found) {
    warn.push({ code: 'manifest_not_found', severity: 'warn', detail: 'No agent card at /.well-known/agent.json or agent-card.json - the merchant declares no agent interface' })
  }

  if (deny.length > 0) return { verdict: 'DENY', reasons: [...deny, ...warn] }
  if (warn.length > 0) return { verdict: 'WARN', reasons: warn }
  return {
    verdict: 'ALLOW',
    reasons: [{ code: 'verified_merchant', severity: 'info', detail: 'Verified on-chain identity, attested KYA, and strong reputation' }],
  }
}

// ── agent-card discovery + parsing ────────────────────────────────────────────

export type ParsedManifest = {
  name: string | null
  /** ERC-8004 registrations declared in the card, normalized (CAIP id and/or bare token id). */
  registrations: Array<{ caip?: string; agentId?: string; chain?: string }>
  /** Declared payment rails / agent endpoints (x402, mcp, amp), deduplicated labels. */
  rails: string[]
  /** Declared supported interfaces, when the card lists them. */
  interfaces: string[]
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * Parse a fetched agent-card object into the summary the verdict and the caller use.
 * Tolerant by design: it reads the ERC-8004 A2A extension shape (registrations[]),
 * the A-Identity AMP manifest shape (agent.erc8004), and generic name/interface
 * fields, and returns null only when the object is not a JSON object at all.
 */
export function parseAgentManifest(data: unknown): ParsedManifest | null {
  const root = asRecord(data)
  if (!root) return null
  const agent = asRecord(root.agent)

  const name = asString(root.name) ?? asString(agent?.name)

  const registrations: ParsedManifest['registrations'] = []
  const rawRegs = Array.isArray(root.registrations) ? root.registrations : []
  for (const raw of rawRegs) {
    const reg = asRecord(raw)
    if (!reg) continue
    // ERC-8004 A2A extension: agentId (token id) + agentAddress (CAIP-10-ish string).
    const caip = asString(reg.agentAddress) ?? asString(reg.caip) ?? undefined
    const agentId = reg.agentId !== undefined && reg.agentId !== null ? String(reg.agentId) : undefined
    const chain = asString(reg.chain) ?? (reg.chainId !== undefined && reg.chainId !== null ? String(reg.chainId) : undefined)
    if (caip || agentId) registrations.push({ caip: caip ?? undefined, agentId, chain: chain ?? undefined })
  }
  // A-Identity AMP manifest: agent.erc8004 is the full CAIP id (or null pre-anchor).
  const ampErc8004 = asString(agent?.erc8004)
  if (ampErc8004) registrations.push({ caip: ampErc8004 })

  const rails = new Set<string>()
  // Explicit payment declarations keep their own labels: they are rails by definition.
  for (const hint of [root.payments, root.paymentMethods, root.rails]) {
    if (!Array.isArray(hint)) continue
    for (const entry of hint) {
      const label = asString(entry) ?? asString(asRecord(entry)?.name) ?? asString(asRecord(entry)?.uri)
      if (label) rails.add(label)
    }
  }
  // Everything else (endpoints, urls, interfaces, capability extensions, security schemes)
  // yields CANONICAL labels only, so an unrelated extension URI - e.g. the ERC-8004 spec
  // link many cards carry - is not presented as a payment rail.
  // `services` alongside `endpoints`: ERC-8004 renamed that field on 2026-01-25, and a
  // card written against the current spec declares its rails under the new name. Reading
  // only the old one meant a spec-current merchant looked like it offered no rail at all.
  // Both are read because cards in the wild carry either.
  const railText = JSON.stringify([
    root.endpoints ?? null, root.services ?? null, root.url ?? null, agent?.endpoint ?? null,
    root.supportedInterfaces ?? null, root.interfaces ?? null,
    asRecord(root.capabilities)?.extensions ?? null, root.securitySchemes ?? null,
  ])
  if (/x402/i.test(railText)) rails.add('x402')
  if (/\bmcp\b|\/mcp/i.test(railText)) rails.add('mcp')
  if (asRecord(root.amp)) {
    rails.add('amp')
    if (/x402/i.test(JSON.stringify(root.amp))) rails.add('x402')
  }

  const rawInterfaces = Array.isArray(root.supportedInterfaces)
    ? root.supportedInterfaces
    : Array.isArray(root.interfaces)
      ? root.interfaces
      : []
  const interfaces = rawInterfaces
    .map((i) => asString(i) ?? asString(asRecord(i)?.protocol) ?? asString(asRecord(i)?.transport) ?? asString(asRecord(i)?.url))
    .filter((i): i is string => i !== null)

  return { name, registrations, rails: [...rails].sort(), interfaces }
}

export type DiscoveryResult = {
  /** A candidate answered with a parseable agent card. */
  found: boolean
  /** No candidate returned ANY http answer (every fetch threw / timed out). */
  unreachable: boolean
  /** The candidate URL the card was read from (null when not found). */
  url: string | null
  manifest: ParsedManifest | null
}

const WELL_KNOWN_PATHS = ['/.well-known/agent.json', '/.well-known/agent-card.json']

/**
 * Normalize a user-supplied merchant locator into an absolute URL string: a bare domain
 * gets https://, but an EXPLICIT non-http scheme (ftp://, file://, gopher://...) is kept
 * as-is so the http(s)-only guard rejects it - prefixing it would smuggle a forbidden
 * scheme past the check as a weird-but-fetchable https URL.
 */
export function normalizeMerchantUrl(raw: string): string {
  const trimmed = raw.trim()
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/**
 * Discover the merchant's agent card: fetch the given URL (when it already points at a
 * .json document) and the two well-known paths on its origin. Every fetch is SSRF-guarded
 * (isSafePublicHttpUrl, redirect:'error', 4s cap) because the URL is caller-controlled.
 * 404s and non-JSON answers (an SPA rewrite serving index.html for every path is common)
 * are tolerated as "no card", never as errors; `unreachable` is true only when NO
 * candidate produced an http answer at all.
 */
export async function discoverManifest(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<DiscoveryResult> {
  const base = new URL(normalizeMerchantUrl(rawUrl))
  const candidates: string[] = []
  if (base.pathname.endsWith('.json')) candidates.push(base.toString())
  for (const path of WELL_KNOWN_PATHS) candidates.push(new URL(path, base.origin).toString())

  let answered = false
  for (const candidate of [...new Set(candidates)]) {
    if (!isSafePublicHttpUrl(candidate)) continue
    try {
      const res = await fetchImpl(candidate, {
        signal: AbortSignal.timeout(4000),
        redirect: 'error',
        headers: { accept: 'application/json' },
      })
      answered = true
      if (!res.ok) continue // 404 and friends are a normal "no card here"
      let data: unknown
      try {
        data = await res.json()
      } catch {
        continue // 200 with HTML (SPA catch-all) or invalid JSON: not a card
      }
      const manifest = parseAgentManifest(data)
      if (manifest) return { found: true, unreachable: false, url: candidate, manifest }
    } catch {
      /* network error / timeout on this candidate; try the next */
    }
  }
  return { found: false, unreachable: !answered, url: null, manifest: null }
}

// ── the platform's view of the agent ──────────────────────────────────────────

/** The structural subset of agentReputation() the verdict needs (fakes supply the same). */
export type PlatformReputationView = {
  agentId: string
  name: string | null
  kya: 'unverified' | 'verified' | 'revoked'
  score: number
  settledOnchain: number
  sybil?: { level: 'none' | 'low' | 'medium' | 'high' }
}

/**
 * Default platform lookup: try every identity query against agentReputation (which
 * already resolves platform ids, bare token ids and wallet addresses), then map CAIP
 * ids by their trailing token id onto anchored agents - the same mapping the public
 * /api/reputation route applies. Imported lazily through the barrel so the stdio MCP
 * entry stays free of platform state until the tool is actually called.
 */
async function defaultPlatformView(queries: string[]): Promise<PlatformReputationView | null> {
  const { agentReputation, listPlatformAgents } = await import('./platform.js')
  for (const q of queries) {
    let rep = agentReputation(q)
    if ('error' in rep) {
      const tokenId = q.match(/(\d+)\s*$/)?.[1]
      const anchored = tokenId ? listPlatformAgents().find((a) => a.onchainAgentId === tokenId) : undefined
      if (anchored) rep = agentReputation(anchored.id)
    }
    if (!('error' in rep)) return rep as unknown as PlatformReputationView
  }
  return null
}

// ── the check itself ──────────────────────────────────────────────────────────

export type MerchantCheckInput = { url?: string; agentId?: string }

export type MerchantCheckResult = {
  verdict: MerchantVerdict
  reasons: MerchantReason[]
  identity: {
    agentId: string
    tokenId: number
    owner: string
    chain: string
    domain: string
    partial?: boolean
  } | null
  manifest: {
    found: boolean
    url: string | null
    unreachable: boolean
    name?: string
    rails?: string[]
    interfaces?: string[]
    registrations?: ParsedManifest['registrations']
  } | null
  reputation: {
    platformAgentId: string
    name: string | null
    score: number
    band: 'low' | 'moderate' | 'strong'
    kya: 'unverified' | 'verified' | 'revoked'
    sybil: 'none' | 'low' | 'medium' | 'high'
    settledOnchain: number
  } | null
  checkedAt: string
}

/** Injectable dependencies so the whole check unit-tests without any network. */
export type MerchantCheckDeps = {
  fetchImpl?: typeof fetch
  resolveIdentity?: (query: string) => Promise<AgentIdentity | null>
  platformView?: (queries: string[]) => Promise<PlatformReputationView | null>
}

/**
 * Verify a merchant-side agent before a checkout: discover its agent card (when a url
 * is given), resolve its ERC-8004 identity live (when an id is given or declared),
 * read the platform's KYA/reputation/Sybil view, and compute the verdict. Read-only:
 * creates no state, writes nothing, meters nothing. Invalid input (neither locator,
 * or an SSRF-rejected url) returns a clean { error } instead of throwing.
 */
export async function merchantCheck(
  input: MerchantCheckInput,
  deps: MerchantCheckDeps = {},
): Promise<MerchantCheckResult | { error: string }> {
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : null
  const agentId = typeof input.agentId === 'string' && input.agentId.trim() ? input.agentId.trim() : null
  if (!url && !agentId) return { error: 'Provide a merchant url and/or an agentId to check' }

  // ── 1. discovery (SSRF-guarded; the guard also runs per-candidate inside) ──
  let discovery: DiscoveryResult | null = null
  if (url) {
    let normalized: string
    try {
      normalized = normalizeMerchantUrl(url)
      new URL(normalized)
    } catch {
      return { error: `Not a valid merchant url: ${url}` }
    }
    if (!isSafePublicHttpUrl(normalized)) {
      return { error: 'Refusing to fetch that url: only public http(s) hosts are checked (no loopback, private ranges, or metadata endpoints)' }
    }
    discovery = await discoverManifest(normalized, deps.fetchImpl ?? fetch)
  }

  // ── 2. identity: the given id first, else the card's declared registrations ──
  const resolveIdentity =
    deps.resolveIdentity ?? ((q: string) => createIdentityProvider().resolve(q).catch(() => null))
  const identityQueries: string[] = []
  if (agentId) identityQueries.push(agentId)
  for (const reg of discovery?.manifest?.registrations ?? []) {
    if (reg.caip) identityQueries.push(reg.caip)
    else if (reg.agentId) identityQueries.push(reg.agentId)
  }
  let identity: AgentIdentity | null = null
  for (const q of [...new Set(identityQueries)]) {
    identity = await resolveIdentity(q)
    if (identity) break
  }

  // ── 3. the platform's view (KYA, reputation band, Sybil flag) ──
  const viewQueries = [...new Set([
    ...identityQueries,
    ...(identity ? [identity.agentId, String(identity.tokenId), identity.owner] : []),
  ])].filter(Boolean)
  const platformView = deps.platformView ?? defaultPlatformView
  const view = viewQueries.length ? await platformView(viewQueries) : null

  // ── 4. verdict ──
  const { verdict, reasons } = computeMerchantVerdict({
    identityFound: identity !== null,
    kya: view?.kya ?? null,
    reputationScore: view ? view.score : null,
    sybil: view?.sybil?.level ?? null,
    manifest: {
      requested: discovery !== null,
      found: discovery?.found ?? false,
      unreachable: discovery?.unreachable ?? false,
    },
  })

  return {
    verdict,
    reasons,
    identity: identity
      ? {
          agentId: identity.agentId,
          tokenId: identity.tokenId,
          owner: identity.owner,
          chain: identity.chain,
          domain: identity.domain,
          ...(identity.partial ? { partial: true } : {}),
        }
      : null,
    manifest: discovery
      ? {
          found: discovery.found,
          url: discovery.url,
          unreachable: discovery.unreachable,
          ...(discovery.manifest?.name ? { name: discovery.manifest.name } : {}),
          ...(discovery.manifest?.rails.length ? { rails: discovery.manifest.rails } : {}),
          ...(discovery.manifest?.interfaces.length ? { interfaces: discovery.manifest.interfaces } : {}),
          ...(discovery.manifest?.registrations.length ? { registrations: discovery.manifest.registrations } : {}),
        }
      : null,
    reputation: view
      ? {
          platformAgentId: view.agentId,
          name: view.name ?? null,
          score: view.score,
          band: reputationBand(view.score),
          kya: view.kya,
          sybil: view.sybil?.level ?? 'none',
          settledOnchain: view.settledOnchain,
        }
      : null,
    checkedAt: new Date().toISOString(),
  }
}
