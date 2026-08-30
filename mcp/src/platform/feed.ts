/**
 * Public marketplace surfaces: the agent feed, follows, feedback, semantic search,
 * the leaderboard and platform-wide stats.
 * Layering: L6 domain module; imports ./core.js, ./reputation.js, ./guardrail.js and
 * flat ../ modules only.
 */
import { state, save, id, pushActivity, type PlatformAgent, type FeedbackEntry } from './core.js'
import { repOf } from './reputation.js'
import { platformTraction } from './guardrail.js'
import { resolveActionPolicy, deriveBadges, badgeFor, SURFACES } from '../policy/index.js'
import { CHAINS } from '../chains/index.js'
import { SETTLEMENTS } from '../asp/settlements.js'
import { CONTRACTS } from '../arc-contracts.js'
import { agentChainIds } from '../marketplace.js'

// ── marketplace ───────────────────────────────────────────────────────────────

export function followAgent(agentId: string, follower: string): { followers: number } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  const i = agent.followers.indexOf(follower)
  if (i >= 0) agent.followers.splice(i, 1)
  else {
    agent.followers.push(follower)
    pushActivity(agent, `${follower} started following`)
  }
  save(state)
  return { followers: agent.followers.length }
}

/** Minimum description length for an agent to make the default showcase. Matches the
 *  registration rule (RegisterForm requires >= 20 chars), so one-word scaffold rows like
 *  "new" / "new agent" (description "payments") that predate that rule stay out. */
const SHOWCASE_MIN_DESC = 20

/** An agent shown in the DEFAULT Agent House feed: it has passed KYA and actually
 *  describes what it does. This is exactly the landing promise ("every agent here passed
 *  KYA before it could act"), so the showcase can't contradict it. Nothing is deleted -
 *  unverified / thin-description rows stay reachable via `includeAll` (the "Show all
 *  (including pending)" toggle / ?all=1). */
export function isShowcase(a: PlatformAgent): boolean {
  return a.kya === 'verified' && (a.description?.trim().length ?? 0) >= SHOWCASE_MIN_DESC
}

/** How prominent an agent is: on-chain identity and a verified KYA float to the top. */
function marketRank(a: PlatformAgent): number {
  return (a.onchain === 'registered' ? 2 : 0) + (a.kya === 'verified' ? 1 : 0)
}

/** The marketplace feed: presentable platform agents as showcase cards, best first.
 *  Sorted by on-chain/KYA prominence, then reputation, then newest. `includeAll`
 *  (from `?all=1`) bypasses the hygiene filter and shows every agent. */
/**
 * Guardrail standing for the public feed (Phase 5.2).
 *
 * Only surfaced for agents whose owner PUBLISHED their badge. Phase 1.5 made publishing
 * opt-in, and a leaderboard that revealed guardrail state for everyone would quietly undo
 * that consent, as well as give away the paid counterparty signal for free. So an agent that
 * has not published reports `published: false` and nothing else, and the categories below
 * only contain agents who opted in.
 */
function feedGuardrails(agent: PlatformAgent): {
  published: boolean
  level?: string
  label?: string
  surfaces?: string[]
} {
  if (!agent.badgePublic) return { published: false }
  const { configured } = resolveActionPolicy(agent.actionPolicy, agent.id, agent.createdAt)
  const entries = state.audits[agent.id] ?? []
  const badge = badgeFor(deriveBadges({ surfaces: SURFACES, policyConfigured: configured, entries }), 'trade')
  // Which live surfaces this agent has actually been checked on, from the monotonic meter
  // so it survives the audit cap. This is what the Trading / Spend categories filter on.
  const meter = state.meters[agent.id]
  const surfaces = SURFACES.filter((s) => s.status === 'live' && (meter?.bySurface?.[s.id] ?? 0) > 0).map((s) => s.id)
  return { published: true, level: badge?.level, label: badge?.label, surfaces }
}

/**
 * @param category optional filter. `trading` and `spend` list only agents who PUBLISHED a
 *   badge and have been checked on that surface, so appearing there is something an owner
 *   opted into and earned rather than something we inferred about them.
 */
// ── agent feedback (1-10 user ratings) ────────────────────────────────────────

const FEEDBACK_PER_AGENT = 200

/** Average + count for a listing row; entries stay behind the detail endpoint. */
/**
 * Did this rater and this agent actually transact? A task between them that reached a
 * terminal state is the evidence, and it is the whole of it: an open or funded job is a
 * job in progress, not a completed dealing anyone can rate.
 *
 * `refunded` and `disputed` count as well as `released`. A client who was refunded has
 * every right to say so, and a scheme that only lets satisfied buyers speak is a scheme
 * that reports satisfaction.
 */
function hasTransacted(agentId: string, rater: string): boolean {
  return state.tasks.some(
    (t) => t.agentId === agentId && t.client === rater && TERMINAL_FOR_RATING.has(t.status),
  )
}
const TERMINAL_FOR_RATING = new Set(['released', 'refunded', 'disputed'])

/**
 * A rater's own average, over every agent they have rated.
 *
 * The other half of REC 3b. Two ratings are only comparable if they are on the same
 * scale, and a raw 1..10 is not: a rater who gives 9 to everyone and one who reserves 9
 * are saying different things with the same number, and averaging them mixes the two.
 *
 * Correction only applies once a rater has rated MIN_RATINGS_FOR_BIAS different agents.
 * Below that their "average" is one or two data points, and adjusting against it would
 * manufacture precision out of noise. Under the threshold the raw score is used and the
 * output says so.
 */
const MIN_RATINGS_FOR_BIAS = 3
const SCALE_MID = 5.5 // the midpoint of a whole 1..10 scale

function raterMean(rater: string): { mean: number; rated: number } {
  let total = 0
  let rated = 0
  for (const rows of Object.values(state.feedback)) {
    for (const r of rows) {
      if (r.rater !== rater) continue
      total += r.score
      rated += 1
    }
  }
  return { mean: rated ? total / rated : SCALE_MID, rated }
}

/** One rating, put on the shared scale. Clamped back into 1..10 so a corrected score is
 *  still a score on the scale it is published as. */
function commensurate(entry: FeedbackEntry): number {
  const { mean, rated } = raterMean(entry.rater)
  if (rated < MIN_RATINGS_FOR_BIAS) return entry.score
  return Math.min(10, Math.max(1, entry.score - mean + SCALE_MID))
}

/**
 * The scored view of an agent's ratings.
 *
 * `avg` is grounded ratings only, put on the shared scale. `count` counts the same set,
 * so a caller cannot read a big count next to an average computed from a smaller one.
 * The ungrounded rows are still returned by `agentFeedback` for a human to read; they
 * simply do not move a number that ranks anybody.
 */
export function feedbackSummary(agentId: string): {
  avg: number | null
  count: number
  ungroundedCount: number
  basis: string
} {
  const rows = state.feedback[agentId] ?? []
  const grounded = rows.filter((r) => r.grounded === true)
  const ungroundedCount = rows.length - grounded.length
  const basis =
    'grounded ratings only (the rater had a terminal task with this agent), each corrected ' +
    `for that rater's own mean once they have rated ${MIN_RATINGS_FOR_BIAS} or more agents`
  if (grounded.length === 0) return { avg: null, count: 0, ungroundedCount, basis }
  const avg = grounded.reduce((t, r) => t + commensurate(r), 0) / grounded.length
  return { avg: Math.round(avg * 10) / 10, count: grounded.length, ungroundedCount, basis }
}

/**
 * Sentiment split of an agent's real ratings for a listing row. Bands over the whole
 * 1..10 scale: positive >= 7, neutral 4..6, negative <= 3. `positivePct` is the rounded
 * percent of positive entries over the total, and null when there are no ratings at all
 * (an unrated agent is not "0% positive").
 */
function feedbackBreakdown(agentId: string): {
  positive: number
  neutral: number
  negative: number
  positivePct: number | null
} {
  const rows = state.feedback[agentId] ?? []
  let positive = 0
  let neutral = 0
  let negative = 0
  for (const r of rows) {
    if (r.score >= 7) positive += 1
    else if (r.score >= 4) neutral += 1
    else negative += 1
  }
  return {
    positive,
    neutral,
    negative,
    positivePct: rows.length > 0 ? Math.round((positive / rows.length) * 100) : null,
  }
}

export function agentFeedback(agentId: string) {
  const a = state.agents.find((x) => x.id === agentId)
  if (!a) return { error: 'Unknown agent' as const }
  const rows = [...(state.feedback[agentId] ?? [])].sort((x, y) => y.at.localeCompare(x.at))
  return { agentId, ...feedbackSummary(agentId), entries: rows.slice(0, 50) }
}

/**
 * Record a rating. One entry per rater per agent: rating again REPLACES your
 * previous entry rather than stacking, so a single account cannot pump an
 * average. Score is a whole 1..10; the comment is optional and bounded.
 */
export function addAgentFeedback(agentId: string, rater: string, score: number, comment?: string) {
  const a = state.agents.find((x) => x.id === agentId)
  if (!a) return { error: 'Unknown agent' as const }
  const s = Math.round(Number(score))
  if (!Number.isFinite(s) || s < 1 || s > 10) return { error: 'Score must be a whole number from 1 to 10' as const }
  const entry: FeedbackEntry = {
    id: id('fb'),
    agentId,
    rater,
    score: s,
    comment: typeof comment === 'string' ? comment.slice(0, 1000) : '',
    at: new Date().toISOString(),
    grounded: hasTransacted(agentId, rater),
  }
  const rows = (state.feedback[agentId] ?? []).filter((r) => r.rater !== rater)
  rows.push(entry)
  state.feedback[agentId] = rows.slice(-FEEDBACK_PER_AGENT)
  a.activity.push({
    at: entry.at,
    text: entry.grounded
      ? `Rated ${s}/10 by a client it worked for`
      : `Rated ${s}/10 by a verified user who has not hired it (not scored)`,
  })
  void save(state)
  return { ok: true as const, entry, summary: feedbackSummary(agentId) }
}

// ── semantic marketplace search (free daily quota, then paid) ─────────────────

const SEMANTIC_FREE_PER_DAY = 5

/** Query-term expansion: the intent behind common asks, not just the letters. */
const SEMANTIC_SYNONYMS: Record<string, string[]> = {
  translate: ['translation', 'language', 'lingua'],
  translation: ['translate', 'language'],
  research: ['data', 'analysis', 'analytics', 'market'],
  data: ['research', 'analytics', 'api'],
  trade: ['trading', 'finance', 'market'],
  trading: ['trade', 'finance'],
  code: ['review', 'developer', 'devops', 'engineering'],
  review: ['code', 'audit'],
  pay: ['payment', 'payments', 'purchase'],
  payment: ['payments', 'pay', 'purchase'],
  content: ['writing', 'creative', 'copy'],
  cheap: [],
  best: [],
  trusted: [],
}

/**
 * Natural-language search over the REAL roster. Not an LLM: a transparent
 * intent engine (term expansion + weighted field matches + quality modifiers
 * like "cheap"/"best"/"trusted"), which means identical queries always rank
 * identically and nothing is fabricated.
 */
export function semanticSearchAgents(q: string, viewer?: string) {
  const query = (q ?? '').trim().toLowerCase()
  if (!query) return { agents: [], total: 0 }
  const terms = query.split(/[^a-z0-9]+/).filter((t) => t.length > 1)
  const expanded = new Set(terms)
  for (const t of terms) for (const syn of SEMANTIC_SYNONYMS[t] ?? []) expanded.add(syn)
  const wantCheap = terms.includes('cheap') || terms.includes('cheapest')
  const wantBest = terms.includes('best') || terms.includes('top') || terms.includes('trusted')

  const scored = state.agents
    .filter((a) => isShowcase(a))
    .map((a) => {
      const rep = repOf(a)
      const hay = {
        name: a.name.toLowerCase(),
        category: a.category.toLowerCase(),
        caps: a.capabilities.join(' ').toLowerCase(),
        desc: a.description.toLowerCase(),
        services: a.services.map((sv) => sv.name).join(' ').toLowerCase(),
      }
      let score = 0
      const reasons: string[] = []
      for (const t of expanded) {
        if (hay.name.includes(t)) { score += 6; reasons.push(`name matches "${t}"`) }
        if (hay.caps.includes(t)) { score += 5; reasons.push(`capability "${t}"`) }
        if (hay.services.includes(t)) { score += 5; reasons.push(`sells "${t}"`) }
        if (hay.category.includes(t)) { score += 3; reasons.push(`category "${t}"`) }
        if (hay.desc.includes(t)) { score += 2 }
      }
      if (score > 0 && wantBest) score += rep.score / 100
      if (score > 0 && wantCheap) {
        const cheapest = Math.min(...a.services.map((sv) => sv.priceUsd), Infinity)
        if (cheapest <= 1) { score += 4; reasons.push('low price') }
      }
      const fb = feedbackSummary(a.id)
      if (score > 0 && fb.avg != null) score += fb.avg / 5
      return { a, rep, score, reasons: [...new Set(reasons)].slice(0, 4) }
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, 20)

  return {
    agents: scored.map(({ a, rep, score, reasons }) => ({
      id: a.id,
      name: a.name,
      logoUrl: a.logoUrl,
      category: a.category,
      capabilities: a.capabilities,
      kya: a.kya,
      reputation: rep,
      feedback: feedbackSummary(a.id),
      followedByViewer: viewer ? a.followers.includes(viewer) : false,
      matchScore: Math.round(score * 10) / 10,
      matchReasons: reasons,
    })),
    total: scored.length,
  }
}

/**
 * Spend one semantic search from the caller's free daily allowance. Real
 * metering: the counter persists, resets at UTC midnight, and running out is a
 * hard 402 upstream (premium continues through the x402-paid gateway service).
 */
export function consumeSemanticQuota(caller: string): { ok: boolean; remaining: number; resetsAt: string } {
  const day = new Date().toISOString().slice(0, 10)
  const row = state.semanticQuota[caller]
  const used = row && row.day === day ? row.used : 0
  const resetsAt = `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`
  if (used >= SEMANTIC_FREE_PER_DAY) return { ok: false, remaining: 0, resetsAt }
  state.semanticQuota[caller] = { day, used: used + 1 }
  // Bound the map so one-off callers do not accumulate forever.
  const keys = Object.keys(state.semanticQuota)
  if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete state.semanticQuota[k]
  void save(state)
  return { ok: true, remaining: SEMANTIC_FREE_PER_DAY - used - 1, resetsAt }
}

export function marketplace(viewer?: string, includeAll = false, category?: string) {
  const wanted = (category ?? '').trim().toLowerCase()
  const surfaceFilter = wanted === 'trading' ? 'trade' : wanted === 'spend' ? 'spend' : null

  const shown = state.agents
    .filter((a) => includeAll || isShowcase(a))
    .filter((a) => {
      if (!surfaceFilter) return true
      const g = feedGuardrails(a)
      return g.published && (g.surfaces ?? []).includes(surfaceFilter)
    })
    .map((a) => ({ a, rep: repOf(a) }))
    .sort((x, y) => {
      const byRank = marketRank(y.a) - marketRank(x.a)
      if (byRank !== 0) return byRank
      if (y.rep.score !== x.rep.score) return y.rep.score - x.rep.score
      return y.a.createdAt.localeCompare(x.a.createdAt) // newest first
    })
  return {
    agents: shown.map(({ a, rep }) => ({
      id: a.id,
      name: a.name,
      logoUrl: a.logoUrl,
      description: a.description,
      category: a.category,
      capabilities: a.capabilities,
      chain: a.chain,
      // Every network this agent is actually registered on: its identity chain plus one
      // entry per deployed vault. Derived through the registry, so an id we have no
      // descriptor for is dropped rather than handed to a card with no logo for it. A
      // chain we merely support never appears here.
      chains: agentChainIds(a),
      kya: a.kya,
      onchain: a.onchain,
      onchainTx: a.onchainTx,
      onchainExplorer: a.onchainExplorer,
      onchainAgentId: a.onchainAgentId,
      // The ERC-8004 registration document itself. Public by design: it restates fields
      // already on this card (name/description/category/capabilities/chain) plus the
      // registration date - no owner, wallet, or policy data ever lands in it.
      registration: a.passport.registrationJson,
      guardrails: feedGuardrails(a),
      reputation: rep,
      walletAddress: a.walletAddress,
      followers: a.followers.length,
      followedByViewer: viewer ? a.followers.includes(viewer) : false,
      feedback: feedbackSummary(a.id),
      // What this agent sells, trimmed to the card fields (never the full agent record).
      services: a.services.map((s) => ({ name: s.name, priceUsd: s.priceUsd, unit: s.unit })),
      // The cheapest listed service, for a "from $x" line. Null with no services: an agent
      // selling nothing has no starting price, and 0 would be a fake one.
      priceFromUsd: a.services.length > 0 ? Math.min(...a.services.map((s) => s.priceUsd)) : null,
      // Real completed sales: tasks for this agent whose escrow actually released.
      soldCount: state.tasks.filter((t) => t.agentId === a.id && t.status === 'released').length,
      feedbackBreakdown: feedbackBreakdown(a.id),
      // Honest meaning: a live callable endpoint is registered, nothing more.
      online: Boolean(a.endpoint),
      // Escrow task settlement is platform-wide; per-call x402 only makes sense when the
      // agent has a callable endpoint registered.
      payments: a.endpoint ? ['escrow', 'x402'] : ['escrow'],
      cardStyle: a.cardStyle ?? null,
      activity: a.activity.slice(-5).reverse(),
      createdAt: a.createdAt,
    })),
    total: shown.length,
    // Total across every agent, so the UI can offer "Show all (including pending)"
    // and say how many are hidden from the default (KYA-verified) showcase.
    totalAll: state.agents.length,
    showingAll: includeAll,
  }
}

/** Leaderboard depth: past the top 50 a rank stops meaning anything, and every extra row
 *  costs a repOf() recompute over the full instruction/task history. */
const LEADERBOARD_MAX = 50

/**
 * The public leaderboard: showcase agents ranked by ONE composite number, so "who is
 * winning" has a single answer instead of five sortable columns. The weights are
 * deliberate: delivered paid work and verified-user feedback move the score far more
 * than followers, so popularity alone cannot outrank agents that actually finish jobs.
 * Same showcase filter as the feed - an agent that has not passed KYA cannot place.
 */
export function marketplaceLeaderboard() {
  const ranked = state.agents
    .filter(isShowcase)
    .map((a) => {
      const reputation = repOf(a)
      const feedback = feedbackSummary(a.id)
      const followers = a.followers.length
      const tasksDone = state.tasks.filter((t) => t.agentId === a.id && t.status === 'released').length
      const rankScore =
        Math.round(
          (reputation.score + (feedback.avg ?? 0) * 20 + feedback.count * 10 + followers * 5 + tasksDone * 15) * 10,
        ) / 10
      return { a, reputation, feedback, followers, tasksDone, rankScore }
    })
    // Ties break toward tenure: on an equal score the newer agent ranks below the one
    // that has held that score longer.
    .sort((x, y) => y.rankScore - x.rankScore || x.a.createdAt.localeCompare(y.a.createdAt))
    .slice(0, LEADERBOARD_MAX)
  return {
    agents: ranked.map((r, i) => ({
      id: r.a.id,
      name: r.a.name,
      logoUrl: r.a.logoUrl,
      category: r.a.category,
      cardStyle: r.a.cardStyle ?? null,
      kya: r.a.kya,
      onchainAgentId: r.a.onchainAgentId,
      reputation: r.reputation,
      feedback: r.feedback,
      followers: r.followers,
      tasksDone: r.tasksDone,
      rankScore: r.rankScore,
      rank: i + 1,
    })),
    computedAt: new Date().toISOString(),
  }
}

// ── platform-wide stats (public aggregates, no mocks) ─────────────────────────────

/** Round a USD sum to cents. */
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The public platform-wide aggregate view (GET /api/stats). Every number is derived from
 * real state, the static x402 settlement log, the chain registry, or the deployed Arc
 * contract table; nothing is projected or invented. CI canary agents are excluded from
 * every agent-derived headline, the same way platformTraction excludes them, so our own
 * monitoring can never inflate these numbers.
 */
export function platformStats() {
  // Agent-derived numbers count REAL agents only (ci canaries out, like platformTraction).
  const real = state.agents.filter((a) => a.ci !== true)
  const ciIds = new Set(state.agents.filter((a) => a.ci === true).map((a) => a.id))

  const byCategoryMap = new Map<string, number>()
  for (const a of real) {
    const cat = a.category.trim() || 'Other'
    byCategoryMap.set(cat, (byCategoryMap.get(cat) ?? 0) + 1)
  }
  const byCategory = [...byCategoryMap.entries()]
    .map(([category, count]) => ({ category, count }))
    // Desc by count; alphabetical tie-break so the order is deterministic.
    .sort((x, y) => y.count - x.count || x.category.localeCompare(y.category))
    .slice(0, 10)

  const released = state.tasks.filter((t) => t.status === 'released')

  // Executed instructions: both real on-chain settlements and simulated executions (no
  // signer key) count as executed. "Executed" is NOT a synonym for "settled" here, and the
  // split is published rather than left to be inferred from withTxHash: a blended headline
  // is a number in which a run with no signer is indistinguishable from a run that moved
  // money, which is exactly what this project says it does not do.
  const onchainIx = state.instructions.filter((i) => i.status === 'executed_onchain')
  const simulatedIx = state.instructions.filter((i) => i.status === 'executed_simulated')
  const executed = [...onchainIx, ...simulatedIx]
  const ixUsd = (rows: typeof state.instructions) => round2(rows.reduce((s, i) => s + i.amountUsd * i.count, 0))

  // Feedback + followers are agent-derived too, so ci canary ids stay out of them.
  const feedbackRows = Object.entries(state.feedback).filter(
    ([agentId, rows]) => !ciIds.has(agentId) && rows.length > 0,
  )
  const allRatings = feedbackRows.flatMap(([, rows]) => rows)

  const traction = platformTraction()

  // Deployed Arc contract addresses from the single exported table in arc-contracts.ts.
  const contractEntries = Object.entries(CONTRACTS).filter(
    ([, addr]) => typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr),
  )

  return {
    agents: {
      total: real.length,
      showcase: real.filter(isShowcase).length,
      kyaVerified: real.filter((a) => a.kya === 'verified').length,
      onchainRegistered: real.filter((a) => a.onchain === 'registered').length,
      byCategory,
    },
    tasks: {
      total: state.tasks.length,
      open: state.tasks.filter((t) => t.status === 'open').length,
      released: released.length,
      gmvUsd: round2(released.reduce((s, t) => s + t.priceUsd, 0)),
      // gmvUsd counts every released task, including those whose escrow was simulated.
      // gmvOnchainUsd is the part backed by a real settlement, so the two can be read apart.
      gmvOnchainUsd: round2(released.filter((t) => t.settlement === 'onchain').reduce((s, t) => s + t.priceUsd, 0)),
      onchainSettled: state.tasks.filter((t) => t.settlement === 'onchain').length,
    },
    settlements: {
      instructionsExecuted: executed.length,
      instructionsUsd: ixUsd(executed),
      withTxHash: executed.filter((i) => Boolean(i.txHash)).length,
      onchainUsd: ixUsd(onchainIx),
      simulatedUsd: ixUsd(simulatedIx),
    },
    feedback: {
      totalRatings: allRatings.length,
      avgScore:
        allRatings.length > 0
          ? Math.round((allRatings.reduce((s, r) => s + r.score, 0) / allRatings.length) * 10) / 10
          : null,
      ratedAgents: feedbackRows.length,
    },
    followersTotal: real.reduce((s, a) => s + a.followers.length, 0),
    guardrail: {
      checks: traction.checks,
      allow: traction.allow,
      warn: traction.warn,
      deny: traction.deny,
      protectedNotionalUsd: traction.protectedNotionalUsd,
    },
    chains: {
      total: CHAINS.length,
      live: CHAINS.filter((c) => c.status === 'live').length,
      beta: CHAINS.filter((c) => c.status === 'beta').length,
    },
    contracts: {
      deployed: contractEntries.length,
      names: contractEntries.map(([name]) => name),
    },
    x402: {
      rounds: new Set(SETTLEMENTS.map((s) => s.round)).size,
      // Sub-cent amounts: round to 6 decimals to kill float noise without erasing value.
      totalUsd: Math.round(SETTLEMENTS.reduce((s, r) => s + r.amountUsd, 0) * 1e6) / 1e6,
    },
    computedAt: new Date().toISOString(),
  }
}
