/**
 * The A-Identity ASP tools sold on OKX.AI, each a THIN wrapper over logic the
 * backend already runs live - no new trust claims, no mocks:
 *
 *   verify_agent       -> on-chain ERC-8004 resolve (erc8004.ts) + KYA (readValidation)
 *   reputation_score   -> the deterministic 0-1000 scorer (reputation.ts / platform repOf)
 *   risk_check         -> ALLOW/WARN/DENY composition over those signals (./risk.ts)
 *   counterparty_check -> deal-specific verdict between two agents (+ same-operator signal)
 *   agent_passport     -> aggregation of all of the above into one passport JSON
 *   trust_preview      -> FREE tier: coarse band + flags only (the adoption on-ramp)
 *
 * An `agentId` may be a platform agent id, an ERC-8004 token id ("#849980" / "849980"),
 * an owner address, or a CAIP-10 id. We resolve platform state first (richest signals),
 * then fall back to a live on-chain read, and cross-link the two when both exist.
 */
import { createIdentityProvider, isSafePublicHttpUrl } from '../erc8004.js'
import { ARC_CHAIN } from '../chains/index.js'
import { readValidationOn } from '../validation-registry.js'
import { computeAgentReputation, type ReputationResult } from '../reputation.js'
import {
  listPlatformAgents,
  agentReputation,
  agentGuardrailProfile,
  refreshPlatformState,
  type PlatformAgent,
} from '../platform.js'
import { notRegisteredProfile, unobservableProfile } from '../policy/index.js'
import { assessRisk, type RiskSignals, type TxContext, type SybilLevel } from './risk.js'
import { getReputationAttestation } from './attestations.js'
import { PRICES } from './payment.js'

const DAY_MS = 86_400_000

type Bundle = {
  agentId: string
  platform: PlatformAgent | null
  /** Live on-chain ERC-8004 identity, or null if unresolved. */
  identity: Awaited<ReturnType<ReturnType<typeof createIdentityProvider>['resolve']>>
  /** ERC-8004 token id (bigint) if we know one, for on-chain KYA / reputation anchoring. */
  tokenId: bigint | null
  /** On-chain KYA validation summary (from the ValidationRegistry), if a token id is known. */
  validation: Awaited<ReturnType<typeof readValidationOn>> | null
  reputation: ReputationResult & { basis: string; behavioral: BehavioralSummary | null; sybil: SybilSummary | null }
  onchainVerified: boolean
  kyaVerified: boolean
  kyaStatus: 'verified' | 'unverified' | 'revoked' | 'unknown'
  /** KYA revoked (incident) - forces a risk DENY. */
  revoked: boolean
  tenureDays: number
}

/** A transparent echo of the behavioral inputs behind the reputation `behavior` band. */
type BehavioralSummary = { completedJobs: number; contestedJobs: number; disputeRate: number; avgRating: number | null; ratedJobs: number }
/** A transparent echo of the Sybil signals behind a risk DENY/WARN. */
type SybilSummary = { level: SybilLevel; siblingCount: number; jobs: number; selfDealt: number; selfDealRate: number; diversity: number }

export const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)
export const asTokenId = (s: string): bigint | null => {
  const m = s.trim().match(/^#?(\d+)$/)
  // A uint256 is at most 78 digits; cap here so a giant numeric string can't force an
  // expensive BigInt parse (defense-in-depth with the gateway's length bound).
  if (!m || m[1].length > 78) return null
  return BigInt(m[1])
}

/** Hard cap on any single on-chain read behind a PAID tool call. */
const RPC_TIMEOUT_MS = 6000

/**
 * Race a promise against a timeout so a paid tool call never hangs on a slow or
 * unavailable RPC - it degrades gracefully to `fallback` and still responds fast.
 * Also absorbs rejections (returns fallback) so the caller never sees an error from
 * a best-effort on-chain read.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
  })
  const result = await Promise.race([p.catch(() => fallback), timeout])
  clearTimeout(timer!)
  return result
}

/** Resolve every real signal we have for an agent, from platform state + the chain. */
async function gather(agentId: string): Promise<Bundle> {
  const q = agentId.trim()
  const agents = listPlatformAgents()
  const platform =
    agents.find((a) => a.id === q) ??
    agents.find((a) => a.onchainAgentId && (a.onchainAgentId === q || `#${a.onchainAgentId}` === q)) ??
    (isAddress(q) ? agents.find((a) => a.walletAddress?.toLowerCase() === q.toLowerCase()) : undefined) ??
    null

  // On-chain resolve. Prefer the platform agent's known token id; else the raw query.
  // Timeout-guarded so a slow/unavailable RPC never leaves a paying caller hanging.
  const onchainQuery = platform?.onchainAgentId ?? q
  const provider = createIdentityProvider()
  const identity: Bundle['identity'] = await withTimeout(provider.resolve(onchainQuery), RPC_TIMEOUT_MS, null)

  // An ERC-8004 token id is only meaningful on the chain that minted it: the same numeric
  // id on X Layer (OKX.AI) belongs to a different agent, so a read must be scoped to the
  // right chain rather than defaulted to one. This used to be `identity.chain === 'arc'`,
  // which silently dropped every other chain's attestations; now the chain comes from
  // whatever anchored the id, and the registry decides whether that chain can answer.
  // Partial identities carry no usable id.
  const anchorChain = platform?.onchainAgentId
    ? platform.chain
    : (identity?.chain ?? platform?.chain ?? ARC_CHAIN.id)
  const tokenId =
    (platform?.onchainAgentId ? asTokenId(platform.onchainAgentId) : null) ??
    (identity && !identity.partial ? BigInt(identity.tokenId) : asTokenId(q))

  // On-chain KYA validation summary (real ValidationRegistry read), when a token id is
  // known. Timeout-guarded. A chain with no ValidationRegistry answers `supported: false`
  // with a reason rather than `kyaCount: 0`, because "not anchorable here" and "anchored
  // zero times" are different facts and a buyer must not read one as the other.
  const validation: Bundle['validation'] =
    tokenId !== null ? await withTimeout(readValidationOn(anchorChain, tokenId), RPC_TIMEOUT_MS, null) : null

  const onchainVerified = Boolean(identity) || platform?.onchain === 'registered'

  // KYA: platform state is authoritative when present; else fall back to the on-chain
  // validation summary; else unknown.
  let kyaStatus: Bundle['kyaStatus'] = 'unknown'
  // The platform now stores a fourth state, `unclaimed`: a record we built from someone
  // else's on-chain agent, which the controlling party has never claimed here. This tool's
  // published schema carries four values and the OKX.AI listings are registered against
  // it, so the state is narrowed HERE rather than widening the schema and resetting review.
  //
  // It narrows to `unverified`, the closest true statement in the existing vocabulary:
  // wallet control is not attested. Not `unknown`, which says we hold no record at all.
  // The narrowing loses a real distinction (unclaimed is weaker than unverified, because
  // the record is not even the caller's), so if this tool should ever report it, that is a
  // deliberate schema change and a re-registration, not a patch.
  if (platform) kyaStatus = platform.kya === 'unclaimed' ? 'unverified' : platform.kya
  else if (validation && Number((validation as { kyaCount?: number }).kyaCount ?? 0) > 0) kyaStatus = 'verified'
  const kyaVerified = kyaStatus === 'verified'

  // Tenure only from a timestamp WE can vouch for (platform-tracked creation). We do NOT
  // trust `identity.registeredAt`, which is read from the agent's own tokenURI JSON - a
  // counterparty could self-attest an ancient date to inflate tenure (worth up to 160
  // reputation points) and flip a DENY into a WARN. Unknown tenure -> 0, not self-reported.
  const createdAt = platform?.createdAt ?? null
  const createdMs = createdAt ? new Date(createdAt).getTime() : NaN
  const tenureDays = Number.isFinite(createdMs)
    ? Math.max(0, Math.floor((Date.now() - createdMs) / DAY_MS))
    : 0

  // Reputation: platform scorer when we have platform state (real settlement history);
  // else compute from the on-chain signals we can actually see (identity + tenure).
  let reputation: Bundle['reputation']
  if (platform) {
    const r = agentReputation(platform.id)
    if ('error' in r) {
      reputation = { ...computeAgentReputation({ settledCount: 0, rejected: 0, onchainRegistered: onchainVerified, createdAt: createdAt ?? new Date() }), basis: 'onchain-identity+tenure', behavioral: null, sybil: null }
    } else {
      reputation = { score: r.score, breakdown: r.breakdown, settledOnchain: r.settledOnchain, settledEffective: r.settledEffective, settledUsd: r.settledUsd, basis: 'platform-settlements+identity+tenure+behavior', behavioral: r.behavioral, sybil: r.sybil }
    }
  } else {
    reputation = {
      ...computeAgentReputation({ settledCount: 0, rejected: 0, onchainRegistered: onchainVerified, createdAt: createdAt ?? new Date() }),
      basis: onchainVerified ? 'onchain-identity+tenure (no platform settlement history)' : 'no verifiable signals',
      behavioral: null,
      sybil: null,
    }
  }

  return { agentId: q, platform, identity, tokenId, validation, reputation, onchainVerified, kyaVerified, kyaStatus, revoked: kyaStatus === 'revoked', tenureDays }
}

/**
 * "Registered != live" (REC 3a): pick the agent's registered public surface to probe.
 * Pure so it is unit-testable: a bare domain becomes https://<domain>/, an http(s)
 * registration URI is used as-is, and anything unsafe (SSRF guard) yields null.
 */
export function livenessTarget(domain: string | null | undefined, registrationUri: string | null | undefined): string | null {
  const d = domain?.trim()
  if (d) {
    const url = /^https?:\/\//i.test(d) ? d : `https://${d}/`
    if (isSafePublicHttpUrl(url)) return url
  }
  const uri = registrationUri?.trim()
  if (uri && isSafePublicHttpUrl(uri)) return uri
  return null
}

/** Probe result: informational only - liveness is surfaced, never scored into risk,
 *  so a transient outage can't flip a verdict. */
type Liveness = { checked: boolean; target: string | null; reachable: boolean | null; httpStatus: number | null; note: string }

/** Hard cap on the liveness probe so a paid call never hangs on a dead endpoint. */
const LIVENESS_TIMEOUT_MS = 3500

/**
 * Probe the agent's registered public endpoint (domain first, else the registration URI).
 * Most ERC-8004 registrations are never checked for liveness - a registered token proves
 * existence, not an operating agent. Any HTTP answer (including 3xx/4xx, unfollowed)
 * proves a listening server; redirects are NOT followed (SSRF: a public URL must not 30x
 * us into an internal target).
 */
async function checkLiveness(b: Bundle): Promise<Liveness> {
  const target = livenessTarget(b.identity?.domain, b.identity?.registrationUri)
  if (!target) {
    return {
      checked: false, target: null, reachable: null, httpStatus: null,
      note: 'No safe public endpoint registered to probe; on-chain registration proves existence, not liveness.',
    }
  }
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS), redirect: 'manual' })
    return {
      checked: true, target, reachable: true, httpStatus: res.status,
      note: 'The registered endpoint answered (any HTTP status proves a listening server). Informational: not scored into the risk verdict.',
    }
  } catch {
    return {
      checked: true, target, reachable: false, httpStatus: null,
      note: `The registered endpoint did not answer within ${LIVENESS_TIMEOUT_MS}ms; registered, but not verifiably live right now. Informational: not scored into the risk verdict.`,
    }
  }
}

/** Attached to every tool response so each paid call is self-documenting and points a
 *  caller (or a reviewer) at the verifiable proof + the exact scoring methodology. */
const TOOL_META = {
  service: 'A-Identity Trust Oracle',
  standard: 'ERC-8004',
  network: 'X Layer mainnet (eip155:196)',
  methodology: 'https://a-identity-asp.onrender.com/methodology',
  proof: 'https://a-identity-asp.onrender.com/proof',
  note: 'reputation is deterministic + unit-tested; identity/KYA read live on-chain (no LLM guess)',
}

// ── the four tools ────────────────────────────────────────────────────────────────

/** verify_agent - ERC-8004 identity + KYA status for an agent. */
export async function verifyAgent(agentId: string) {
  const b = await gather(agentId)
  const liveness = await checkLiveness(b)
  return {
    tool: 'verify_agent',
    _meta: TOOL_META,
    agentId: b.agentId,
    verified: b.onchainVerified,
    kya_status: b.kyaStatus,
    revoked: b.revoked,
    liveness,
    identity: b.identity
      ? {
          tokenId: b.identity.partial ? null : b.identity.tokenId,
          owner: b.identity.owner,
          chain: b.identity.chain,
          registrationUri: b.identity.registrationUri || null,
          domain: b.identity.domain || null,
          valid: b.identity.valid,
          registeredAt: b.identity.registeredAt || null,
          partial: b.identity.partial ?? false,
        }
      : null,
    kya_onchain: b.validation ?? null,
    platform: b.platform ? { id: b.platform.id, name: b.platform.name, onchain: b.platform.onchain, kya: b.platform.kya } : null,
    source: b.platform && b.identity ? 'platform+onchain' : b.identity ? 'onchain' : b.platform ? 'platform' : 'none',
    checkedAt: new Date().toISOString(),
  }
}

/** reputation_score - deterministic 0-1000 reputation from real signals. */
export async function reputationScore(agentId: string) {
  const b = await gather(agentId)
  return {
    tool: 'reputation_score',
    _meta: TOOL_META,
    agentId: b.agentId,
    name: b.platform?.name ?? null,
    score: b.reputation.score,
    breakdown: b.reputation.breakdown,
    behavioral: b.reputation.behavioral,
    sybil: b.reputation.sybil,
    settledOnchain: b.reputation.settledOnchain,
    settledEffective: b.reputation.settledEffective,
    settledUsd: b.reputation.settledUsd,
    // A1: the latest ERC-8004 on-chain anchor of this score (null if none published), so a
    // caller can verify the score on-chain instead of trusting this response.
    onchainAttestation: getReputationAttestation(b.tokenId),
    basis: b.reputation.basis,
    computedAt: new Date().toISOString(),
  }
}

/** risk_check - pre-transaction ALLOW/WARN/DENY over an agent's trust signals. */
export async function riskCheck(agentId: string, txContext: TxContext | null = null) {
  const b = await gather(agentId)
  const signals: RiskSignals = {
    onchainVerified: b.onchainVerified,
    kyaVerified: b.kyaVerified,
    reputationScore: b.reputation.score,
    tenureDays: b.tenureDays,
    revoked: b.revoked,
    sybil: b.reputation.sybil?.level,
  }
  const r = assessRisk(signals, txContext)
  return {
    tool: 'risk_check',
    _meta: TOOL_META,
    agentId: b.agentId,
    decision: r.decision,
    risk: r.risk,
    reasons: r.reasons,
    signals: r.signals,
    checkedAt: new Date().toISOString(),
  }
}

/** agent_passport - the full identity + reputation + validation + risk passport. */
export async function agentPassport(agentId: string) {
  const b = await gather(agentId)
  const liveness = await checkLiveness(b)
  const risk = assessRisk(
    { onchainVerified: b.onchainVerified, kyaVerified: b.kyaVerified, reputationScore: b.reputation.score, tenureDays: b.tenureDays, revoked: b.revoked, sybil: b.reputation.sybil?.level },
    null,
  )
  return {
    tool: 'agent_passport',
    _meta: TOOL_META,
    agentId: b.agentId,
    name: b.platform?.name ?? null,
    standard: 'ERC-8004',
    identity: b.identity
      ? { tokenId: b.identity.partial ? null : b.identity.tokenId, owner: b.identity.owner, chain: b.identity.chain, registrationUri: b.identity.registrationUri || null, domain: b.identity.domain || null, valid: b.identity.valid, registeredAt: b.identity.registeredAt || null, partial: b.identity.partial ?? false }
      : null,
    verified: b.onchainVerified,
    liveness,
    kya: { status: b.kyaStatus, revoked: b.revoked, onchain: b.validation ?? null },
    reputation: { score: b.reputation.score, breakdown: b.reputation.breakdown, behavioral: b.reputation.behavioral, sybil: b.reputation.sybil, settledOnchain: b.reputation.settledOnchain, settledEffective: b.reputation.settledEffective, settledUsd: b.reputation.settledUsd, onchainAttestation: getReputationAttestation(b.tokenId), basis: b.reputation.basis },
    risk: { decision: risk.decision, level: risk.risk, reasons: risk.reasons },
    platform: b.platform
      ? {
          id: b.platform.id,
          category: b.platform.category,
          capabilities: b.platform.capabilities,
          services: b.platform.services,
          walletAddress: b.platform.walletAddress,
          onchain: b.platform.onchain,
          onchainAgentId: b.platform.onchainAgentId ?? null,
          onchainExplorer: b.platform.onchainExplorer ?? null,
          followers: b.platform.followers.length,
        }
      : null,
    tenureDays: b.tenureDays,
    issuedAt: new Date().toISOString(),
  }
}

/**
 * Coarse public band for a 0-1000 score. The free tier deliberately returns a band, not
 * the exact score: bands align with the risk thresholds (DENY < 200, WARN 200-500), so a
 * free caller still gets an actionable signal while the exact score + breakdown stay a
 * paid read.
 */
export function scoreBand(score: number): 'very-low' | 'low' | 'medium' | 'high' {
  if (score < 200) return 'very-low'
  if (score < 500) return 'low'
  if (score < 700) return 'medium'
  return 'high'
}

/**
 * trust_preview - the FREE tier: real (never mocked) but deliberately coarse signals on
 * one agent, plus pointers to the paid depth. The adoption on-ramp: an agent can sanity-
 * check a counterparty for free, then pay per call when a decision actually needs the
 * exact score, the reasons, or the full passport.
 */
export async function trustPreview(agentId: string) {
  const b = await gather(agentId)
  const sybilLevel = b.reputation.sybil?.level ?? 'none'
  return {
    tool: 'trust_preview',
    _meta: TOOL_META,
    tier: 'free',
    agentId: b.agentId,
    verified: b.onchainVerified,
    kya_status: b.kyaStatus,
    scoreBand: scoreBand(b.reputation.score),
    flags: { revoked: b.revoked, sybilSuspected: sybilLevel === 'medium' || sybilLevel === 'high' },
    upgrade: {
      note: 'The free preview is coarse by design. Paid tools return the exact 0-1000 score with a full breakdown, an ALLOW/WARN/DENY verdict with reasons, and the complete passport.',
      tools: [
        { name: 'reputation_score', method: 'POST /tools/reputation_score', price: PRICES['POST /tools/reputation_score'] },
        { name: 'risk_check', method: 'POST /tools/risk_check', price: PRICES['POST /tools/risk_check'] },
        { name: 'counterparty_check', method: 'POST /tools/counterparty_check', price: PRICES['POST /tools/counterparty_check'] },
        { name: 'agent_passport', method: 'POST /tools/agent_passport', price: PRICES['POST /tools/agent_passport'] },
      ],
    },
    checkedAt: new Date().toISOString(),
  }
}

/**
 * guardrail_check ($0.005): does this agent operate under an ENFORCED policy, and does it
 * respect the verdicts?
 *
 * This is the paid product that fits the guardrail engine. The engine's own
 * `pre_action_check` is deliberately NOT sold: the payer there would be the owner, and
 * charging per check taxes safety while payment cannot prove ownership, so an x402 gate on
 * it would let a stranger probe someone's caps and holdings. Here the payer IS a stranger
 * asking about someone else, which is exactly what payment is good for.
 *
 * Bands only. Caps, allowlists, symbols, amounts, holdings and exact counts never leave
 * the owner's side; `compliance.test.ts` enforces that.
 */
export async function guardrailCheck(agentId: string) {
  // The ASP is a separate process that loads state at boot, so refresh (cached) before
  // reading the trail. Without this a paying caller could get a frozen answer.
  const stateFresh = await refreshGuardrailState()

  const q = agentId.trim()
  const agents = listPlatformAgents()

  // If we could not read state, say so. Answering "not registered" off an unreadable
  // store would be a confident wrong answer to someone who paid for it.
  if (!stateFresh) {
    return {
      tool: 'guardrail_check',
      _meta: TOOL_META,
      agentId: q,
      found: false,
      guardrails: unobservableProfile(),
      note: unobservableProfile().disclosure[0],
      checkedAt: new Date().toISOString(),
    }
  }
  // Same resolution order as gather(), so a buyer can pass the id they already use.
  const platform =
    agents.find((a) => a.id === q) ??
    agents.find((a) => a.onchainAgentId && (a.onchainAgentId === q || `#${a.onchainAgentId}` === q)) ??
    (isAddress(q) ? agents.find((a) => a.walletAddress?.toLowerCase() === q.toLowerCase()) : undefined) ??
    null

  // No platform match: if we can see a roster at all, this agent simply is not on it
  // (a real finding). If the roster is empty, we cannot see policy state (no finding).
  const result = platform
    ? agentGuardrailProfile(platform.id)
    : { found: false, agentId: q, profile: agents.length ? notRegisteredProfile() : unobservableProfile() }

  return {
    tool: 'guardrail_check',
    _meta: TOOL_META,
    agentId: q,
    found: result.found,
    guardrails: result.profile,
    note: result.found
      ? 'Bands describe policy discipline, not performance. A-Identity does not disclose the policy itself.'
      : result.profile.disclosure[0],
    checkedAt: new Date().toISOString(),
  }
}

/**
 * Cached state refresh: a full document read, so do it at most once per window. Returns
 * whether this process currently has a state view it can trust.
 *
 * Two things here are deliberate, because getting either wrong makes a PAID call return a
 * confidently wrong answer:
 *
 *  - The timestamp advances only on SUCCESS. Advancing it in a `finally` would pin a
 *    transient store error in place for the whole window, and every buyer in that window
 *    would be told an agent is not registered when we simply could not look.
 *  - Concurrent calls share one in-flight read instead of the second returning early off a
 *    not-yet-updated cache and reading a stale roster.
 */
const GUARDRAIL_STATE_TTL_MS = 60_000
let lastRefreshAt = 0
let lastRefreshOk = false
let refreshInFlight: Promise<void> | null = null

async function refreshGuardrailState(): Promise<boolean> {
  if (lastRefreshAt !== 0 && Date.now() - lastRefreshAt < GUARDRAIL_STATE_TTL_MS) return lastRefreshOk
  if (refreshInFlight) {
    await refreshInFlight
    return lastRefreshOk
  }
  refreshInFlight = (async () => {
    try {
      await refreshPlatformState()
      lastRefreshAt = Date.now()
      lastRefreshOk = true
    } catch {
      // Never throw into a call the buyer already paid for. The caller reports
      // `unavailable` instead, which is the honest answer.
      lastRefreshOk = false
    } finally {
      refreshInFlight = null
    }
  })()
  await refreshInFlight
  return lastRefreshOk
}

/** True when two DISTINCT agents are controlled by the same human owner (or share a
 *  settlement wallet) - i.e. paying one is paying yourself, which builds no independent trust. */
export function sameOperator(a: PlatformAgent | null, b: PlatformAgent | null): boolean {
  if (!a || !b || a.id === b.id) return false
  const ao = a.owner?.toLowerCase(); const bo = b.owner?.toLowerCase()
  if (ao && bo && ao === bo) return true
  const aw = a.walletAddress?.toLowerCase(); const bw = b.walletAddress?.toLowerCase()
  return Boolean(aw && bw && aw === bw)
}

/**
 * counterparty_check - a deal-specific verdict for a SPECIFIC payment between two agents:
 * "should `from` pay `to` (amount X, kind Y)?". It is risk_check on the counterparty (`to`)
 * PLUS a relationship signal risk_check alone cannot see: whether `to` is operated by the
 * same owner as `from` (a self-deal, which inflates no real reputation). A clean counterparty
 * still surfaces as ALLOW; a same-operator self-deal is downgraded to at least WARN.
 */
export async function counterpartyCheck(from: string, to: string, txContext: TxContext | null = null) {
  const [payer, cp] = await Promise.all([gather(from), gather(to)])
  const base = assessRisk(
    { onchainVerified: cp.onchainVerified, kyaVerified: cp.kyaVerified, reputationScore: cp.reputation.score, tenureDays: cp.tenureDays, revoked: cp.revoked, sybil: cp.reputation.sybil?.level },
    txContext,
  )
  const isSelfDeal = sameOperator(payer.platform, cp.platform)
  const reasons = [...base.reasons]
  let decision = base.decision
  let risk = base.risk
  if (isSelfDeal) {
    reasons.push('Counterparty is operated by the same owner as the payer (self-dealing); a settlement between them builds no independent reputation.')
    if (decision === 'ALLOW') { decision = 'WARN'; if (risk === 'low') risk = 'medium' }
  }
  return {
    tool: 'counterparty_check',
    _meta: TOOL_META,
    from: payer.agentId,
    to: cp.agentId,
    decision,
    risk,
    reasons,
    sameOperator: isSelfDeal,
    counterparty: {
      agentId: cp.agentId,
      name: cp.platform?.name ?? null,
      verified: cp.onchainVerified,
      kya_status: cp.kyaStatus,
      revoked: cp.revoked,
      reputation: cp.reputation.score,
      sybil: cp.reputation.sybil?.level ?? 'none',
    },
    payer: { agentId: payer.agentId, verified: payer.onchainVerified, kya_status: payer.kyaStatus },
    txContext: txContext ?? null,
    checkedAt: new Date().toISOString(),
  }
}

export type { TxContext }
