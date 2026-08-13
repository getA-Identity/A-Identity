/**
 * Policy Engine v2: action-policy CRUD, the decision path + audit trail, manifest
 * registration, badges, traction and the public guardrail profile.
 * Layering: L5 domain module; imports ./core.js, ./agents.js and flat ../ modules only.
 */
import { state, save, id, ownsAgent, pushActivity, type PlatformAgent, type Service } from './core.js'
import { createAgent } from './agents.js'
import {
  applyPolicyPatch, buildAuditEntry, capAudits, evaluateAction, filterAudits,
  resolveActionPolicy, summarizeAudits, guardrailProfile, unobservableProfile,
  notRegisteredProfile, deriveBadges, badgeFor, SURFACES, meterDecision,
  meterOverrideAttempt, aggregateTraction, defaultActionPolicy,
  type AgentMeter, type Traction, type Badge, type ActionPolicy,
  type AuditEntry, type AuditOutcome, type AuditProvenance, type Decision, type GuardrailProfile,
} from '../policy/index.js'
import { resolveCallerInput, type CallerInput } from '../callers/normalize.js'

// ── Policy Engine v2 store (Phase 1.3) ───────────────────────────────────────────
//
// Owner-gated CRUD over the action policy, versioned so an audit entry (Phase 1.4) can
// name the exact policy version that produced a verdict. The decision logic itself lives
// in the pure `policy/` module and is unit-tested there; this is only storage, ownership
// and persistence. Free: no x402 on reading or writing your own rules.

/**
 * Read an agent's action policy. Owner-gated, since a policy reveals the owner's limits
 * and holdings strategy. Returns the safe defaults with `configured: false` when the owner
 * has not set one yet, rather than an error, so a client can render the starting point.
 */
export function getAgentActionPolicy(
  agentId: string,
  caller?: string,
): { agentId: string; policy: ActionPolicy; configured: boolean } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  const { policy, configured } = resolveActionPolicy(agent.actionPolicy, id('pol'), new Date().toISOString())
  return { agentId: agent.id, policy, configured }
}

/**
 * Update an agent's action policy from a client patch. Owner-gated. The patch goes through
 * the sanitizer (clamps, symbol normalization, margin forced off) and the version bumps by
 * one, so a stored policy can only ever have been produced by sanitized input.
 *
 * First write materializes the resolved defaults, so an owner who sets only a daily cap
 * still ends up with a complete, safe policy rather than a one-field object.
 */
export function updateAgentActionPolicy(
  agentId: string,
  patch: unknown,
  caller?: string,
): { agentId: string; policy: ActionPolicy; configured: true } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  if (typeof patch !== 'object' || patch === null) return { error: 'policy object required' }

  const now = new Date().toISOString()
  const { policy: current } = resolveActionPolicy(agent.actionPolicy, id('pol'), now)
  const next = applyPolicyPatch(current, patch, now)
  agent.actionPolicy = next
  pushActivity(agent, `Action policy updated by a human (v${next.version})`)
  save(state)
  return { agentId: agent.id, policy: next, configured: true }
}

// ── Policy Engine v2 decision path + audit trail (Phase 1.2 wiring, Phase 1.4) ───

/**
 * Check one intended action against the agent's policy, record the decision, and return
 * it. This is the server side of `pre_action_check`: resolve the owner's policy (1.3),
 * evaluate it with the pure engine (1.2), persist the outcome (1.4).
 *
 * We never execute anything. The caller acts on the verdict, which keeps the same
 * prepared-or-executed separation the chain writes use.
 *
 * The snapshot comes from the CALLER, and per ../policy/README.md ("An agent that writes
 * its own snapshot") that caller must be the skill rather than the agent being policed: an
 * agent that can author its own snapshot can buy an ALLOW by lying about buying power. We
 * cannot verify that from here, so the audit entry records a hash of exactly what was used,
 * which makes a falsified snapshot detectable after the fact instead of invisible.
 *
 * Two request shapes are accepted (see ../callers/normalize.ts): a pre-normalized
 * `{intent, snapshot}` or a registered `{callerId, action, account}`. The returned
 * `provenance` says which one produced this verdict, and it is recorded on the audit row.
 */
export function checkAgentAction(
  agentId: string,
  input: CallerInput,
  caller?: string,
): { decision: Decision; auditId: string; policyConfigured: boolean; provenance: AuditProvenance } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  if (!input?.surface) return { error: 'surface required' }

  // Translation failures are refused BEFORE a decision exists, and deliberately write no
  // audit row: there is no action to record. That is the opposite of a malformed intent,
  // which does reach the engine and does leave a recorded DENY.
  const resolved = resolveCallerInput(input)
  if (!resolved.ok) return { error: `${resolved.code}: ${resolved.reason}` }

  const now = new Date().toISOString()
  const { policy, configured } = resolveActionPolicy(agent.actionPolicy, id('pol'), now)
  const decision = evaluateAction({
    surface: input.surface,
    policy,
    intent: resolved.intent,
    snapshot: resolved.snapshot,
    now: new Date(now),
  })

  const entry = buildAuditEntry({
    id: id('aud'),
    ts: now,
    agentId: agent.id,
    intent: resolved.intent,
    snapshot: resolved.snapshot,
    decision,
    caller: resolved.provenance,
  })
  state.audits[agent.id] = capAudits([...(state.audits[agent.id] ?? []), entry])
  // Monotonic counters alongside the capped rows, so traction survives the audit cap.
  state.meters[agent.id] = meterDecision(state.meters[agent.id], {
    decision,
    // From the RECORDED intent, not the raw request: the entry's number is already
    // bounded and is the one the verdict was computed against, so the meter and the
    // audit row can never disagree about how much was at stake.
    notionalUsd: entry.intent.notionalUsd,
    at: now,
  })
  // Only surface it on the agent's activity feed when the policy actually intervened;
  // an ALLOW on every routine action would drown the feed.
  if (decision.verdict !== 'ALLOW') {
    pushActivity(agent, `Policy ${decision.verdict} on a ${entry.intent.kind} action: ${decision.reasons[0] ?? ''}`.trim())
  }
  save(state)

  return { decision, auditId: entry.id, policyConfigured: configured, provenance: resolved.provenance }
}

/**
 * Record what actually happened after a verdict. Kept separate from the decision because
 * the outcome is only known later: a WARN sits at `awaiting_human` until someone acts.
 * `evidenceRef` is the caller's post-action proof (e.g. a venue order id), so an entry can
 * be reconciled against the venue rather than believed.
 */
export function recordAuditOutcome(
  agentId: string,
  auditId: string,
  outcome: AuditOutcome,
  caller?: string,
  evidenceRef?: string,
): { audit: AuditEntry } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  const entry = (state.audits[agent.id] ?? []).find((e) => e.id === auditId)
  if (!entry) return { error: 'Unknown audit entry' }
  // A DENY is final. Letting a caller mark a blocked action "executed" would turn the
  // audit trail into a place where the policy can be overridden retroactively. The
  // attempt is COUNTED before it is refused: repeated attempts are the most informative
  // behavioral signal we have, and rejecting them silently would throw that away.
  if (entry.verdict === 'DENY' && outcome === 'executed') {
    entry.overrideAttempts = (entry.overrideAttempts ?? 0) + 1
    state.meters[agent.id] = meterOverrideAttempt(state.meters[agent.id], new Date().toISOString())
    pushActivity(agent, 'Refused an attempt to record a blocked action as executed')
    save(state)
    return { error: 'Forbidden: a DENY cannot be recorded as executed' }
  }
  entry.outcome = outcome
  entry.outcomeAt = new Date().toISOString()
  if (evidenceRef) entry.evidenceRef = evidenceRef.slice(0, 200)
  save(state)
  return { audit: entry }
}

/** An agent's decision trail, newest first, owner-gated. Optionally bounded by `since`. */
export function listAgentAudits(
  agentId: string,
  opts: { since?: string; limit?: number } = {},
  caller?: string,
):
  | { agentId: string; audits: AuditEntry[]; summary: ReturnType<typeof summarizeAudits>; sinceApplied: boolean }
  | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  const all = state.audits[agent.id] ?? []
  const { audits, sinceApplied } = filterAudits(all, opts)
  // The summary covers the SAME window the rows do, so the counts and the list agree.
  return { agentId: agent.id, audits, summary: summarizeAudits(audits), sinceApplied }
}

// ── register_agent + guardrail badges (Phase 1.5) ────────────────────────────────

/** What a manifest registration answers with. */
export type RegistrationResult = {
  agentId: string
  /** Honest on-chain state. `queued` means no ERC-8004 tx has been broadcast yet. */
  erc8004Status: {
    onchain: 'queued' | 'registered'
    tokenId?: string
    explorerUrl?: string
    kya: 'unverified' | 'verified' | 'revoked'
  }
  badges: Badge[]
  /** Present only once the owner opts in to publishing (see setBadgeVisibility). */
  badgeUrl: string | null
}

/**
 * Register an agent from a manifest (Phase 1.5). A THIN wrapper over createAgent, not a
 * second registration path: two ways to create an agent is exactly the drift this session
 * has been removing everywhere else.
 *
 * A fresh registration is honest about itself: `queued`, KYA `unverified`, and a badge set
 * that reads `no policy` until the owner actually configures one.
 */
export function registerAgentFromManifest(
  manifest: {
    name?: string
    description?: string
    category?: string
    capabilities?: unknown
    services?: Service[]
    endpoint?: string
    walletAddress?: string
    /** Optional card style preset (whole 1..6); invalid input means unset. */
    cardStyle?: unknown
    /**
     * Mark this agent as canary/monitoring. Its decisions are still recorded in full, but
     * they are EXCLUDED from every traction headline (see policy/meter.ts). There is no
     * abuse vector worth gating: labelling yourself `ci` only removes you from a public
     * aggregate, so it costs visibility rather than buying any.
     */
    ci?: boolean
  },
  caller?: string,
): RegistrationResult | { error: string } {
  if (!manifest?.name || typeof manifest.name !== 'string') return { error: 'manifest.name required' }

  const agent = createAgent({
    name: manifest.name,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    category: typeof manifest.category === 'string' ? manifest.category : 'Other',
    capabilities: Array.isArray(manifest.capabilities) ? (manifest.capabilities as string[]) : [],
    services: manifest.services,
    endpoint: manifest.endpoint,
    walletAddress: manifest.walletAddress,
    cardStyle: manifest.cardStyle,
    permissions: {},
    owner: caller,
  })
  if (manifest.ci === true) {
    agent.ci = true
    pushActivity(agent, 'Marked as canary: activity is excluded from traction headlines')
    save(state)
  }
  return buildRegistrationResult(agent)
}

function buildRegistrationResult(agent: PlatformAgent): RegistrationResult {
  const { configured } = resolveActionPolicy(agent.actionPolicy, id('pol'), new Date().toISOString())
  return {
    agentId: agent.id,
    erc8004Status: {
      onchain: agent.onchain,
      ...(agent.onchainAgentId ? { tokenId: agent.onchainAgentId } : {}),
      ...(agent.onchainExplorer ? { explorerUrl: agent.onchainExplorer } : {}),
      kya: agent.kya,
    },
    badges: deriveBadges({ surfaces: SURFACES, policyConfigured: configured, entries: state.audits[agent.id] ?? [] }),
    badgeUrl: agent.badgePublic ? badgeUrlFor(agent.id) : null,
  }
}

const badgeUrlFor = (agentId: string) => `/api/agents/badge?agentId=${encodeURIComponent(agentId)}&surface=trade`

/** The current registration + badge view for an existing agent. Owner-gated. */
export function agentRegistration(agentId: string, caller?: string): RegistrationResult | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  return buildRegistrationResult(agent)
}

/** Owner opts in or out of publishing the badge. Off by default. */
export function setBadgeVisibility(
  agentId: string,
  isPublic: boolean,
  caller?: string,
): { agentId: string; badgePublic: boolean; badgeUrl: string | null } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  agent.badgePublic = isPublic
  pushActivity(agent, isPublic ? 'Guardrail badge published' : 'Guardrail badge unpublished')
  save(state)
  return { agentId: agent.id, badgePublic: isPublic, badgeUrl: isPublic ? badgeUrlFor(agent.id) : null }
}

/**
 * The public badge for one surface. Served ONLY when the owner opted in: without that a
 * free public endpoint would publish everyone's guardrail state and undercut the paid
 * third-party pull, which is where the revenue is.
 */
export function agentBadge(
  agentId: string,
  surface: string,
): { badge: Badge; agentName: string } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!agent.badgePublic) return { error: 'Forbidden: this agent has not published a badge' }
  const { configured } = resolveActionPolicy(agent.actionPolicy, id('pol'), new Date().toISOString())
  const badges = deriveBadges({ surfaces: SURFACES, policyConfigured: configured, entries: state.audits[agent.id] ?? [] })
  const badge = badgeFor(badges, surface)
  if (!badge) return { error: `Unknown surface: ${surface}` }
  return { badge, agentName: agent.name }
}

/**
 * The public traction view (Phase 5.5). Aggregate only, no auth: there is nothing here that
 * identifies an agent, an owner, a holding or an individual amount, which is what makes it
 * safe to publish. Counted from monotonic meters rather than the capped audit rows, so it
 * cannot shrink as usage grows.
 */
export function platformTraction(): Traction {
  const rows = state.agents
    .map((a) => ({ meter: state.meters[a.id], ci: a.ci === true }))
    .filter((r): r is { meter: AgentMeter; ci: boolean } => Boolean(r.meter))
  const registered = state.agents.filter((a) => a.ci !== true).length
  const ciAgents = state.agents.filter((a) => a.ci === true).length
  return aggregateTraction(rows, registered, ciAgents)
}

/**
 * A live self-check of the decision engine (Phase 5.4). Runs canonical vectors through the
 * PURE engine at request time and reports what it answered, so "the guardrail is enforcing
 * right now" is a verifiable claim rather than an assurance.
 *
 * No state, no auth, no side effects: it creates no agent, records no decision and moves
 * nothing. That is deliberate, because a monitor that writes is a monitor that can fake
 * traction.
 */
export function guardrailSelfCheck(now: Date = new Date()) {
  const policy = defaultActionPolicy('selfcheck', now.toISOString())
  const snapshot = {
    todayNotionalUsd: 0,
    positions: [],
    portfolioValueUsd: 10_000,
    cashAvailableUsd: 10_000,
    marginUsedUsd: 0,
    accountType: 'cash' as const,
  }
  const vectors = [
    {
      name: 'in-policy equity buy is allowed',
      surface: 'trade',
      intent: { kind: 'order' as const, side: 'buy' as const, symbol: 'AAPL', assetClass: 'equity' as const, notionalUsd: 20 },
      expect: 'ALLOW',
    },
    {
      name: 'over the per-action cap is refused',
      surface: 'trade',
      intent: { kind: 'order' as const, side: 'buy' as const, symbol: 'AAPL', notionalUsd: 5_000 },
      expect: 'DENY',
    },
    {
      name: 'money leaving the account waits for a human',
      surface: 'trade',
      intent: { kind: 'transfer' as const, notionalUsd: 5 },
      expect: 'WARN',
    },
    {
      name: 'an ATM cash purchase on a card is refused by default',
      surface: 'spend',
      intent: { kind: 'purchase' as const, notionalUsd: 20, merchant: 'ATM', mcc: '6011', cardId: 'selfcheck' },
      expect: 'DENY',
    },
    {
      name: 'a decision with no account snapshot fails closed',
      surface: 'trade',
      intent: { kind: 'order' as const, side: 'buy' as const, symbol: 'AAPL', notionalUsd: 20 },
      snapshot: undefined,
      expect: 'DENY',
    },
  ]

  const results = vectors.map((v) => {
    const d = evaluateAction({
      surface: v.surface,
      policy,
      intent: v.intent,
      snapshot: 'snapshot' in v ? v.snapshot : snapshot,
      now,
    })
    return { name: v.name, expected: v.expect, got: d.verdict, pass: d.verdict === v.expect, codes: d.codes }
  })

  const failed = results.filter((r) => !r.pass)
  return {
    enforcing: failed.length === 0,
    checkedAt: now.toISOString(),
    surfaces: SURFACES.map((s) => ({ id: s.id, status: s.status })),
    vectors: results,
    note:
      failed.length === 0
        ? 'Every canonical vector answered as expected. This runs the same pure engine the product uses, with no state and no side effects.'
        : `${failed.length} canonical vector(s) did NOT answer as expected. Treat the guardrail as unreliable until this is green.`,
  }
}

/**
 * The guardrail profile for one agent (Phase 1.6). Deliberately NOT owner-gated: it
 * returns bands only, never caps, allowlists, symbols, amounts or holdings, which is
 * exactly what makes it safe to sell to a counterparty. The owner-scoped data stays
 * behind `getAgentActionPolicy` and `listAgentAudits`.
 *
 * Returns `observability: 'unavailable'` rather than a clean-looking profile when the
 * store cannot be read, so absence of data is never reported as absence of guardrails.
 */
export function agentGuardrailProfile(agentId: string): {
  found: boolean
  agentId: string
  profile: GuardrailProfile
} {
  // An entirely empty roster means this process has no view of platform state (the ASP is
  // a separate process; see refreshPlatformState). Reporting "no policy" here would be a
  // lie dressed as a fact.
  if (state.agents.length === 0) {
    return { found: false, agentId, profile: unobservableProfile() }
  }
  // Roster readable, agent not on it: a real finding, and a DIFFERENT one from "we cannot
  // see policy state". Collapsing the two would let a buyer read either as "no problems".
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { found: false, agentId, profile: notRegisteredProfile() }

  const now = new Date()
  const { policy, configured } = resolveActionPolicy(agent.actionPolicy, id('pol'), now.toISOString())
  return {
    found: true,
    agentId: agent.id,
    profile: guardrailProfile({
      entries: state.audits[agent.id] ?? [],
      policyConfigured: configured,
      policyVersion: policy.version,
      now,
    }),
  }
}
