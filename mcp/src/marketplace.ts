/**
 * Marketplace task domain: the PURE logic for a hired-agent task's lifecycle.
 *
 * A-Identity is pivoting to a trusted agent marketplace: a client hires a verified
 * worker agent, USDC is locked in escrow, the agent delivers, and the escrow releases
 * (or refunds on dispute/expiry). The escrow itself is the existing on-chain ERC-8183
 * AgenticCommerce job (see arc-contracts.ts runEscrowJobDemo / rejectJobOnchain /
 * claimJobRefundOnchain / readJobOnchain) - a marketplace Task is an off-chain record
 * bound to an on-chain job id.
 *
 * This module holds NO state and does NO I/O: only the state machine, input
 * normalization, the anti-spam floor on posting an open task, review aggregation, and the
 * two card-payload roll-ups (chain footprint, service copy), so it is unit-testable in
 * isolation and the tested logic is the same logic platform.ts runs (mirrors the
 * reputation.ts pattern). Its one import is the chain
 * registry, which is pure data: chain slugs are RESOLVED through it rather than restated
 * here, per the single-source-of-truth rule in CLAUDE.md.
 */

import { getChain, getChainById, getChainByEvmId } from './chains/registry.js'

// ── types ─────────────────────────────────────────────────────────────────────

/**
 * A task's lifecycle. Maps onto the ERC-8183 escrow states where it settles on-chain:
 *  - open       : posted as an open task; no worker committed yet (no escrow)
 *  - assigned   : a worker agent is chosen; escrow not funded yet
 *  - funded     : the client's USDC is locked in the on-chain escrow (job funded)
 *  - delivered  : the worker submitted a deliverable (job submitted)
 *  - released   : approved; escrow released to the worker (job completed) - TERMINAL
 *  - disputed   : the client/verifier rejected the deliverable; awaiting resolution
 *  - refunded   : escrow returned to the client (dispute reject or expiry) - TERMINAL
 *  - cancelled  : abandoned before any funds moved - TERMINAL
 */
export type TaskStatus =
  | 'open'
  | 'assigned'
  | 'funded'
  | 'delivered'
  | 'released'
  | 'disputed'
  | 'refunded'
  | 'cancelled'

/** A verified agent's bid on an open task. */
export type Bid = {
  agentId: string
  agentName: string
  priceUsd: number
  at: string
}

/** A client's review of a completed task. Written once, on release. */
export type Review = {
  /** The client identity (session subject / wallet) that wrote it. */
  by: string
  /** 1..5 stars. */
  rating: number
  text: string
  at: string
}

export type Task = {
  id: string
  /** The client (session subject) who hired. */
  client: string
  /** The worker agent hired for the task (platform agent id). */
  agentId: string
  /** The service being bought (matches one of the agent's PlatformAgent.services). */
  service: string
  priceUsd: number
  description: string
  status: TaskStatus
  /** What the worker submitted (a URI or short text reference), set on delivery. */
  deliverable?: string
  /** The client's review, set on release. */
  review?: Review
  /** Bids from verified agents while the task is 'open' (before a worker is chosen). */
  bids?: Bid[]
  /** ERC-8183 on-chain job id this task's escrow is bound to (set once funded). */
  jobId?: string
  /** Escrow funding tx + release/refund txs, for the on-chain audit trail on arcscan. */
  escrowTx?: string
  escrowExplorer?: string
  releaseTx?: string
  refundTx?: string
  /** How the escrow settled once terminal: a real on-chain ERC-8183 lifecycle, or a
   *  simulation (no signer key). Honest by design: 'onchain' is set ONLY with a real tx. */
  settlement?: 'onchain' | 'simulated'
  createdAt: string
  /** When the escrow expiry-refund becomes claimable (client safety net). */
  deadlineAt?: string
  updatedAt: string
}

// ── state machine ───────────────────────────────────────────────────────────────

/** Allowed forward transitions. Anything not listed is rejected (fail closed). */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ['assigned', 'cancelled'],
  assigned: ['funded', 'cancelled'],
  funded: ['delivered', 'disputed', 'refunded'],
  delivered: ['released', 'disputed', 'refunded'],
  disputed: ['released', 'refunded'],
  released: [],
  refunded: [],
  cancelled: [],
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['released', 'refunded', 'cancelled'])

/** True once a task can never change again (paid, refunded, or abandoned). */
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status)
}

/** Whether `to` is a legal next status from `from`. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * The status a funded task moves to when its escrow settles, given the on-chain outcome.
 * 'complete' -> released (worker paid); 'refund' -> refunded (client made whole). Keeps
 * the app-layer task status in lockstep with the ERC-8183 escrow outcome.
 */
export function statusForEscrowOutcome(outcome: 'complete' | 'refund'): TaskStatus {
  return outcome === 'complete' ? 'released' : 'refunded'
}

// ── input normalization (defense in depth; the HTTP layer validates too) ──────────

/** Upper bound on a single task's price, matching the demo-spend caps elsewhere. */
export const MAX_TASK_PRICE_USD = 1000
/** Default and max escrow deadline (client can reclaim after this if undelivered). */
export const DEFAULT_DEADLINE_HOURS = 72
export const MAX_DEADLINE_HOURS = 24 * 30 // 30 days

/**
 * Coerce a client-supplied price into a safe, finite USDC amount in [0, MAX]. A non-finite
 * or negative price would corrupt escrow funding and reputation math, so it is clamped to 0
 * (an invalid task the caller must reject), never passed through.
 */
export function normalizePriceUsd(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0
  return Math.min(MAX_TASK_PRICE_USD, v)
}

/** Clamp a deadline (hours) into (0, MAX], defaulting when unset/invalid. */
export function normalizeDeadlineHours(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT_DEADLINE_HOURS
  return Math.min(MAX_DEADLINE_HOURS, Math.ceil(v))
}

/** Clamp a star rating to an integer in [1, 5]. */
export function sanitizeRating(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  return Math.min(5, Math.max(1, Math.round(v)))
}

/**
 * Compute the escrow deadline (an ISO string) from a start time and a duration, purely
 * (deterministic in its inputs, so it is testable without mocking the clock).
 */
export function deadlineFrom(startIso: string, hours: number): string {
  const start = new Date(startIso).getTime()
  const ms = Number.isFinite(start) ? start : 0
  return new Date(ms + normalizeDeadlineHours(hours) * 3600 * 1000).toISOString()
}

// ── spam floor: what an open task must say, and how many one person may keep open ──
//
// Posting an open task costs the poster nothing. No gas, and no escrow either: escrow is
// committed at acceptBid, not here. That is exactly what makes it the cheapest write on
// the platform to abuse, and "100 to 1000 tasks on a whim" is not hypothetical. Every open
// task is a row in the single state document that is serialized in full on every save, and
// a card every visitor to the open-task board has to render.
//
// Three bounds, kept here as pure functions so the rule that runs in production is the
// same rule the tests exercise:
//   1. content   a task nobody could bid on is not a task
//   2. dedup     the same ask posted twice is one ask
//   3. ceiling   one person may only have so many asks outstanding at once
//
// What is deliberately NOT here: a KYA requirement on the POSTER. The worker and the
// bidder must be verified because they are being trusted with someone else's money. A
// poster is the one spending it, and a marketplace that refuses every first-time buyer has
// no first customer. The ceiling carries that weight instead, and it is graduated rather
// than flat: a stranger gets a small allowance, and it grows once they have done something
// a spammer cannot cheaply fake.

/** Least a service title may say before it stops naming a service anyone could bid on. */
export const MIN_SERVICE_CHARS = 6
/** Least a description may say before a bidder cannot tell what the work is. */
export const MIN_DESCRIPTION_CHARS = 20
/** Distinct characters a description needs, so it cannot be one key held down. */
export const MIN_DESCRIPTION_DISTINCT_CHARS = 5
/** Open tasks a poster with no track record here may hold at once. */
export const OPEN_TASK_LIMIT_NEW = 3
/** Open tasks a poster who has paid a worker, or runs a verified agent, may hold at once. */
export const OPEN_TASK_LIMIT_ESTABLISHED = 12
/** Agents an ordinary account may register. Bounds the total; a rate budget bounds the burst. */
/**
 * KYA (Know Your Agent) status, defined ONCE.
 *
 * This union used to be retyped in five files (here, commerce.ts, platform/core.ts,
 * platform/guardrail.ts, and the console's own view type). That is how the profile screen
 * came to render `revoked` as "KYA Pending": one of those copies listed two states, so the
 * compiler had nothing to object to. Every surface now imports this, and a new state is a
 * compile error everywhere it is not handled rather than a silent fall-through.
 *
 *   verified    wallet control proven by signature
 *   unverified  not proven yet, and might never be attempted
 *   revoked     the attestation was taken away: an incident, not a waiting state
 *   unclaimed   WE created this record from someone else's on-chain agent. The party that
 *               controls it has never spoken to us, so there is nothing here to verify
 *               until they claim it. Strictly weaker than unverified, which at least
 *               belongs to the account that made it.
 */
export type KyaStatus = 'verified' | 'unverified' | 'revoked' | 'unclaimed'

export const MAX_AGENTS_PER_OWNER = 25
/** Agents an allowlisted operator account may register. See AccountTier below. */
export const MAX_AGENTS_PER_OPERATOR = 2000

/** Case-folded, whitespace-collapsed text, so two spellings of one ask compare equal. */
export function normalizeTaskText(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The identity of an ask: its service and its description, normalized.
 *
 * Joined on a newline rather than a printable separator on purpose. normalizeTaskText
 * collapses all whitespace, so a newline cannot survive inside either half, which means no
 * pair of inputs can be made to produce another pair's fingerprint by hiding the separator
 * in a field.
 */
export function taskFingerprint(service: unknown, description: unknown): string {
  return `${normalizeTaskText(service)}\n${normalizeTaskText(description)}`
}

/**
 * Why this draft could not be bid on, or null when it could.
 *
 * The bar is low enough that an honest poster clears it while typing the thing they
 * actually want, and high enough that a script has to invent real text per task rather
 * than loop on a constant. Every return is a sentence the caller can act on.
 */
export function taskContentComplaint(draft: { service: unknown; description?: unknown }): string | null {
  const service = String(draft.service ?? '').trim()
  if (service.length < MIN_SERVICE_CHARS)
    return `service must be at least ${MIN_SERVICE_CHARS} characters so a bidder can tell what is being bought (got ${service.length})`
  if (!/\p{L}/u.test(service)) return 'service must contain words, not only digits or punctuation'
  const description = String(draft.description ?? '').trim()
  if (description.length < MIN_DESCRIPTION_CHARS)
    return `description must be at least ${MIN_DESCRIPTION_CHARS} characters so a bidder knows what the work is (got ${description.length})`
  if (!/\p{L}/u.test(description)) return 'description must contain words, not only digits or punctuation'
  if (new Set(description.toLowerCase().replace(/\s+/g, '')).size < MIN_DESCRIPTION_DISTINCT_CHARS)
    return `description must say something: it uses fewer than ${MIN_DESCRIPTION_DISTINCT_CHARS} distinct characters`
  return null
}

/** The two fields that decide whether an ask is the same ask. */
export type OpenTaskDraft = { service: string; description: string }

/** What the poster has already done here, as data, so the ceiling stays a pure function. */
export type PosterStanding = {
  /** This poster's own tasks that are still open and awaiting bids. */
  open: readonly (OpenTaskDraft & { id: string })[]
  /** True when this poster owns at least one KYA-verified agent. */
  hasVerifiedAgent: boolean
  /** How many of this poster's tasks have settled through escrow to a worker. */
  released: number
}

/**
 * How many tasks this poster may keep open at once.
 *
 * Graduated, not flat, and both promotions cost something a spammer cannot fake in bulk:
 * releasing a task moves real money through the ERC-8183 escrow, and a KYA-verified agent
 * required a wallet-control signature. A brand new account still gets a real allowance,
 * which is the whole reason this is not a verification gate.
 */
export function openTaskCeiling(poster: { hasVerifiedAgent: boolean; released: number }): number {
  return poster.hasVerifiedAgent || poster.released > 0 ? OPEN_TASK_LIMIT_ESTABLISHED : OPEN_TASK_LIMIT_NEW
}

/** Why this poster may not post this task right now, or null when they may. */
export function openTaskComplaint(draft: OpenTaskDraft, poster: PosterStanding): string | null {
  const content = taskContentComplaint(draft)
  if (content) return content
  const fingerprint = taskFingerprint(draft.service, draft.description)
  const twin = poster.open.find((t) => taskFingerprint(t.service, t.description) === fingerprint)
  if (twin) return `Duplicate of your open task ${twin.id}, which asks for the same thing. Edit that one rather than posting it twice.`
  const ceiling = openTaskCeiling(poster)
  if (poster.open.length >= ceiling)
    return `Too many open tasks: you have ${poster.open.length} awaiting bids and the limit is ${ceiling}. Accept a bid, or let one close, before posting another.`
  return null
}

// ── account tiers: one rule, at two heights ──────────────────────────────────────
//
// MAX_AGENTS_PER_OWNER is the right number for a person and the wrong number for someone
// running a fleet. Two thousand agents under a twenty-five ceiling is eighty accounts, so
// for that caller the ceiling stops being a limit and becomes an instruction to open sock
// puppets, which leaves us with the same rows and no idea who owns them. The fix is a
// second height for the SAME rule, never a second rule.
//
// What is deliberately NOT decided here: who gets the higher one. Qualifying an operator
// (a business check, a stake, a track record, a fee) is a product decision nobody has
// made, and inventing a mechanism in code would make it by accident. So the only way to be
// an operator today is to be named by hand in an env allowlist, which is the posture every
// other privileged credential in this repo takes: env gated, never autonomous. With the
// variable unset nobody is an operator and every account gets exactly the ceiling it has
// today, which is a clean labeled no-op rather than a behavior change.

/** How much room an account gets. 'default' is everyone; 'operator' is allowlisted. */
export type AccountTier = 'default' | 'operator'

/** The registered-agent ceiling per tier, so a caller never picks between constants. */
export const AGENT_QUOTA_BY_TIER: Record<AccountTier, number> = {
  default: MAX_AGENTS_PER_OWNER,
  operator: MAX_AGENTS_PER_OPERATOR,
}

/** The env variable that names operator accounts, comma separated (subjects, case-folded). */
export const OPERATOR_ACCOUNTS_ENV = 'AGENT_OPERATOR_ACCOUNTS'

/** The subjects named in the operator allowlist. Empty when the variable is unset. */
export function operatorAccounts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[OPERATOR_ACCOUNTS_ENV] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Which tier an account is in.
 *
 * The env read is the one impurity in this module and it is injectable, so the rule is
 * still exercised without touching the process (the shape x402-3009/rail.ts already uses).
 * Anything not named is 'default', an absent subject included, so a missing or malformed
 * variable fails to the ordinary ceiling rather than to an accidental promotion.
 */
export function accountTier(subject: string | undefined, env: NodeJS.ProcessEnv = process.env): AccountTier {
  const id = String(subject ?? '').trim().toLowerCase()
  if (!id) return 'default'
  return operatorAccounts(env).includes(id) ? 'operator' : 'default'
}

/** How many agents an account of this tier may hold. */
export function agentQuota(tier: AccountTier = 'default'): number {
  return AGENT_QUOTA_BY_TIER[tier] ?? MAX_AGENTS_PER_OWNER
}

/**
 * Why this account may not register another agent, or null when it may.
 *
 * Registering is free and writes a durable row, which is the same hole open tasks had. The
 * rate budget bounds how fast rows can arrive; this bounds how many one account ends up
 * holding, which is the number that actually matters to the roster.
 *
 * The tier defaults, so a caller that knows nothing about tiers gets the ordinary ceiling
 * and every existing call site keeps its exact behavior.
 */
export function agentQuotaComplaint(ownedCount: number, tier: AccountTier = 'default'): string | null {
  const limit = agentQuota(tier)
  if (ownedCount < limit) return null
  const who = tier === 'operator' ? 'this operator account' : 'this account'
  return `Too many agents: ${who} has registered ${ownedCount} and the limit is ${limit}. Remove one you no longer run before adding another.`
}

// ── bulk registration: many manifests, one request ───────────────────────────────
//
// Registering is one agent per request, so a fleet arrives one HTTP round trip at a time.
// A batch door fixes the round trips and nothing else: it runs the same quota, charges the
// same row budget, and reports each row on its own, because all-or-nothing on fifty rows
// would throw away forty-nine good registrations over one typo.

/** Manifests one batch request may carry. Above this the request is refused whole. */
export const MAX_BATCH_REGISTER = 50

/**
 * Why a batch of this size cannot be accepted, or null when it can.
 *
 * An oversized batch is REFUSED, never trimmed to fit. Trimming would answer "register
 * these 200" with a 200-OK that quietly registered 50, and the caller would have no way to
 * tell which 150 are missing until it went looking.
 */
export function batchRegisterComplaint(count: unknown): string | null {
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1)
    return 'agents must be a non-empty array of manifests'
  if (count > MAX_BATCH_REGISTER)
    return `Too many manifests in one request: ${count} sent and the limit is ${MAX_BATCH_REGISTER}. Split the list into batches of at most ${MAX_BATCH_REGISTER} and send them in order. Nothing in this request was registered.`
  return null
}

// ── the spam floor on rating an agent ────────────────────────────────────────────
//
// A rating is a durable row and a reputation input: agentReputation reads feedback into
// its `behavior` and `discipline` terms, so writing one is not a neutral act. It was also
// the last free write on the marketplace with no bound of any kind on it.
//
// Two bounds, pure like the task floor above so the rule that runs is the rule the tests
// exercise:
//   1. content   a comment too short to say anything is noise attached to a score
//   2. cooldown  one rater may not rewrite the same rating in a loop
//
// The cooldown is the one that matters most, and the reason is not obvious. feed.ts drops
// a rater's previous row before pushing the new one, so ratings never STACK per rater and
// the average cannot be pumped. But every rewrite still appends an activity line to the
// agent and still rewrites the whole state document, so an unbounded rewrite loop grows
// the very thing the replacement was supposed to bound. The cooldown stops that at the
// door rather than after the write.
//
// What is deliberately NOT here: a rule that a rating must carry a comment. A star-only
// rating is a legitimate thing to leave and the console sends exactly that today, so
// requiring prose would break honest raters to inconvenience a spammer who can simply type
// twelve characters. The floor applies to a comment that IS given.

/** Least a comment may say, when one is given at all, before it stops being a comment. */
export const MIN_FEEDBACK_COMMENT_CHARS = 12
/** How long a rater must wait before changing their rating of the same agent again. */
export const FEEDBACK_REWRITE_COOLDOWN_MS = 5 * 60 * 1000

/** The two client-supplied fields of a rating. */
export type FeedbackDraft = { score: unknown; comment?: unknown }
/** What this rater has already written about THIS agent, as data, so the rule stays pure. */
export type RaterStanding = { lastAt?: string }

/** Why this rater may not rate this agent right now, or null when they may. */
export function feedbackComplaint(draft: FeedbackDraft, standing: RaterStanding, nowMs: number): string | null {
  const raw = typeof draft.score === 'number' && Number.isFinite(draft.score) ? Math.round(draft.score) : NaN
  if (!Number.isFinite(raw) || raw < 1 || raw > 10) return 'Score must be a whole number from 1 to 10'
  const comment = typeof draft.comment === 'string' ? draft.comment.trim() : ''
  if (comment.length > 0 && comment.length < MIN_FEEDBACK_COMMENT_CHARS)
    return `A comment must be at least ${MIN_FEEDBACK_COMMENT_CHARS} characters to tell anyone anything (got ${comment.length}). Leave it out to rate without one.`
  if (comment.length > 0 && !/\p{L}/u.test(comment))
    return 'A comment must contain words, not only digits or punctuation'
  const last = standing.lastAt ? new Date(standing.lastAt).getTime() : NaN
  if (Number.isFinite(last) && nowMs >= last && nowMs - last < FEEDBACK_REWRITE_COOLDOWN_MS) {
    const minutes = Math.ceil((FEEDBACK_REWRITE_COOLDOWN_MS - (nowMs - last)) / 60_000)
    return `You already rated this agent. A rating can be changed again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
  }
  return null
}

// ── review aggregation (feeds catalog ratings) ────────────────────────────────────

/**
 * Aggregate a service's reviews into an average rating + count. Empty -> { average: 0,
 * count: 0 } so an unrated service reads as "no reviews yet", never NaN. The average is
 * rounded to one decimal for display.
 */
export function aggregateRating(reviews: readonly Review[]): { average: number; count: number } {
  const valid = reviews.filter((r) => Number.isFinite(r.rating))
  if (valid.length === 0) return { average: 0, count: 0 }
  const sum = valid.reduce((s, r) => s + sanitizeRating(r.rating), 0)
  return { average: Math.round((sum / valid.length) * 10) / 10, count: valid.length }
}

// ── display helpers ──────────────────────────────────────────────────────────────

/** Human-facing label for a status (UI + activity log). */
export function statusLabel(status: TaskStatus): string {
  const labels: Record<TaskStatus, string> = {
    open: 'Open',
    assigned: 'Assigned',
    funded: 'Funded (escrow locked)',
    delivered: 'Delivered',
    released: 'Released (paid)',
    disputed: 'Disputed',
    refunded: 'Refunded',
    cancelled: 'Cancelled',
  }
  return labels[status]
}

// ── what a marketplace card can honestly say ────────────────────────────────────────
//
// Two payload fields a card needs and could not get: which networks an agent is really
// on, and what a single service says about itself. Both live here rather than in the
// callers so the catalog, the manifest and the roster can never answer them differently.

/** The slice of an agent the chain roll-up reads. */
export type ChainFootprintAgent = {
  /** Registry slug of the chain this agent's identity lives on (e.g. 'arc'). */
  chain?: string
  /** CAIP-2 of the primary on-chain spend vault, when one is deployed. */
  vaultChainCaip2?: string
  /** Every vault this agent holds, the primary one included. */
  vaults?: readonly { chainCaip2: string }[]
}

/**
 * Every network an agent is ACTUALLY registered on, as registry chain slugs: its identity
 * chain first, then a chain for each vault we have deployed for it, in deployment order.
 *
 * Honest by construction. Nothing is padded with a chain we merely support: a card built
 * from this shows one logo for an Arc-only agent and grows only when that agent really
 * gains a vault somewhere else. Every id is resolved through the registry, so a slug or a
 * CAIP-2 the registry does not know is DROPPED rather than handed to a UI that would have
 * no logo for it. Pure: same agent in, same list out.
 */
export function agentChainIds(agent: ChainFootprintAgent): string[] {
  const out: string[] = []
  const add = (id: string | undefined) => {
    if (id && !out.includes(id)) out.push(id)
  }
  if (agent.chain) add(getChainById(agent.chain)?.id)
  if (agent.vaultChainCaip2) add(getChain(agent.vaultChainCaip2)?.id)
  for (const v of agent.vaults ?? []) add(getChain(v.chainCaip2)?.id)
  return out
}

/**
 * A single service's own public copy, or null when it declares none.
 *
 * A stored service is name + price + unit today (createAgent drops anything else a
 * registration sends), so this is null for every service we serve right now. It is READ
 * rather than assumed absent because the field is what lets per-service copy travel at
 * all: without it a catalog row has no place to put a description, and the surfaces above
 * are stuck showing one sentence about the whole agent. An empty or blank string is null,
 * so a service can never publish whitespace as its pitch.
 */
export function serviceDescription(service: { name: string; description?: string | null }): string | null {
  const text = typeof service.description === 'string' ? service.description.trim() : ''
  return text.length > 0 ? text : null
}

// ── AMP "Discover": per-agent manifest ────────────────────────────────────────────
//
// The discovery primitive of the AMP layer (Discover -> Authorize -> Execute -> Settle):
// a self-describing manifest an external project reads to find and hire an agent. Pure:
// it formats an agent record + its reputation into the manifest, so it is unit-testable.

/** The minimal agent shape the manifest needs (a subset of PlatformAgent). */
export type ManifestAgent = {
  id: string
  onchainAgentId?: string
  chainId: number
  name: string
  description: string
  category: string
  capabilities: string[]
  walletAddress: string | null
  kya: KyaStatus
  onchain: 'queued' | 'registered'
  endpoint?: string
  services: { name: string; priceUsd: number; unit: string; description?: string | null }[]
  /**
   * Every vault this agent holds, so the manifest can name the chains it is really on.
   * Optional: a caller that does not pass it gets the identity chain alone, which is the
   * truth for an agent with no second vault anyway.
   */
  vaults?: readonly { chainCaip2: string }[]
}

/**
 * Build an agent's public manifest (AMP Discover). Includes its ERC-8004 identity (CAIP-10
 * when anchored), services, reputation, and how to hire it. `hireable` is true only for a
 * KYA-verified agent (the trusted-marketplace rule), so the manifest never invites a hire the
 * server would reject. Relative URLs by default (baseUrl=''), so it works behind any host.
 */
export function buildAgentManifest(agent: ManifestAgent, reputationScore: number, baseUrl = '') {
  const hireable = agent.kya === 'verified'
  return {
    protocol: 'a-identity/amp',
    version: '1',
    agent: {
      id: agent.id,
      erc8004: agent.onchainAgentId ? `eip155:${agent.chainId}:8004/${agent.onchainAgentId}` : null,
      name: agent.name,
      description: agent.description,
      category: agent.category,
      capabilities: agent.capabilities,
      wallet: agent.walletAddress,
      kya: agent.kya,
      onchain: agent.onchain,
      reputation: reputationScore,
      endpoint: agent.endpoint ?? null,
      // The networks this agent is really on, identity chain first. Derived, never typed:
      // an unknown chain is dropped rather than named.
      chains: agentChainIds({ chain: getChainByEvmId(agent.chainId)?.id, vaults: agent.vaults }),
      hireable,
    },
    services: agent.services.map((s) => ({
      name: s.name,
      priceUsd: s.priceUsd,
      unit: s.unit,
      // The service's own copy, or null when it declares none. See serviceDescription.
      description: serviceDescription(s),
    })),
    amp: {
      discover: `${baseUrl}/api/v1/agents/manifest?agentId=${agent.id}`,
      authorize: 'permissions: daily cap + auto-approve line + human-on-the-loop for large payments',
      execute: 'x402 / nanopayments per call; ERC-8183 escrow for tasks',
      settle: `USDC on Arc (eip155:${agent.chainId}), sub-second finality`,
    },
    hire: hireable
      ? { method: 'POST', endpoint: `${baseUrl}/api/marketplace/hire`, body: { agentId: agent.id, service: '<service name>', priceUsd: '<amount>' } }
      : null,
  }
}
