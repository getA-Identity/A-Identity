/**
 * Platform core: shared domain types, the persisted state singleton, and the small
 * helpers every domain module leans on (ownership, daily spend, activity log).
 * Layering: core imports only flat mcp/src modules. Domain modules import core and
 * lower layers only. The barrel (../platform.ts) re-exports the public surface;
 * internal symbols (state, save, id, ownsAgent, repOf, isShowcase, syncVaultPolicy, ...)
 * must never be re-exported.
 */
import { loadState, saveState } from '../storage.js'
import type { ActionPolicy, AuditEntry, AgentMeter } from '../policy/index.js'
import type { Task } from '../marketplace.js'

// ── types ─────────────────────────────────────────────────────────────────────

export type Permissions = {
  dailyCapUsd: number
  autoApproveUnderUsd: number
  payeeAllowlist: string[]
  agentToAgent: boolean
  agentToHuman: boolean
  /** Emergency off switch: when true, every instruction pauses for a human. */
  frozen: boolean
  /**
   * D3 velocity circuit-breaker: at most `maxActions` settled/auto-approved actions per
   * rolling `windowMinutes` window. ABSENT (or null) by default, so existing agents keep
   * their exact behavior. When set, a burst past the limit is DENIED outright (status
   * `rejected`, denyCode `velocity_exceeded`) rather than paused: a compromised or looping
   * agent firing N under-cap payments is the case the daily cap cannot catch, and queueing
   * the flood for a human would invite approval fatigue. Server-side only; the on-chain
   * vault does not know this rule.
   */
  velocity?: VelocityPolicy | null
}

/** D3: the velocity circuit-breaker config. Positive integers, bounded (see sanitizeVelocity). */
export type VelocityPolicy = { maxActions: number; windowMinutes: number }

export type Service = { name: string; priceUsd: number; unit: string }

export type PlatformAgent = {
  id: string
  name: string
  description: string
  category: string
  capabilities: string[]
  /** What this agent sells on the marketplace (hire targets). */
  services: Service[]
  /** Where the external agent is reachable (declared at register; shown in its manifest). */
  endpoint?: string
  /** Optional square logo, stored as a small data: URL (uploaded at registration). */
  logoUrl?: string
  /** Optional card style preset the owner picked at registration: a whole number 1..6 the
   *  UI maps onto its six category tokens (--cat-1..--cat-6). Invalid input means unset. */
  cardStyle?: number
  permissions: Permissions
  walletAddress: string | null
  chain: 'arc'
  chainId: number
  /** KYA (Know Your Agent): 'verified' ONLY after the agent proves control of its wallet by
   *  signing a challenge. New agents start 'unverified'. 'revoked' = flagged as an incident. */
  kya: 'unverified' | 'verified' | 'revoked'
  /** How KYA was proven (the wallet-control signature). */
  kyaProof?: { address: string; at: string; method: 'wallet-signature' }
  /** Set once the KYA result is attested on the ERC-8004 ValidationRegistry (real tx). */
  kyaOnchainTx?: string
  kyaOnchainExplorer?: string
  kyaRequestHash?: string
  /** Set if KYA was revoked (the agent flagged as an incident). Cleared by re-verifying. */
  kyaRevoked?: { at: string; by: string; reason: string; onchainTx?: string; onchainExplorer?: string }
  /** Session email of the creator; agent-scoped mutations are restricted to them. */
  owner?: string
  onchain: 'queued' | 'registered'
  /** Set once the ERC-8004 identity is broadcast on Arc (real tx). */
  onchainTx?: string
  onchainExplorer?: string
  onchainAgentId?: string
  /** On-chain AgentSpendPolicy vault: enforces this agent's spend policy on Arc. */
  vaultAddress?: string
  vaultExplorer?: string
  /** The human owner the vault was deployed with (freeze/override/withdraw). Distinct
   *  from the operator so the on-chain owner≠operator separation is real. */
  vaultOwner?: string
  /** The operator (agent signer) that calls pay(); the server signer in this demo. */
  vaultOperator?: string
  /** Circle Agent Wallet (Developer-Controlled, ARC-TESTNET): Circle's hosted
   *  policy engine screens this wallet's transfers at the wallet layer. */
  circleWalletId?: string
  circleWalletAddress?: string
  circleWalletExplorer?: string
  /** Owner-authorized auto-yield: idle balance above capUsd is earmarked for USYC
   *  (Circle's yield-bearing token). Off by default; the owner turns it on. */
  treasury?: { autoYieldEnabled: boolean; capUsd: number; authorizedAt?: string }
  /**
   * Policy Engine v2 policy for the action surfaces (trade today, spend next). Distinct
   * from `permissions`, which is this agent's USDC payment policy on Arc: the two govern
   * different surfaces and merging them would put payee allowlists next to ticker
   * allowlists. Absent until the owner configures one, and `resolveActionPolicy` fills in
   * safe defaults meanwhile, so an unconfigured agent is never permissive.
   */
  actionPolicy?: ActionPolicy
  /** Set on agents created by the scheduled canary. Their activity is counted but kept OUT
   *  of every traction headline, so our own monitoring cannot inflate usage. */
  ci?: boolean
  /**
   * Whether the owner published their guardrail badge. Opt-in and default OFF: a badge is
   * a claim the owner chooses to make about themselves, and serving one for every agent by
   * default would publish guardrail state nobody asked us to publish (and undercut the
   * paid third-party pull, which is the product).
   */
  badgePublic?: boolean
  passport: {
    standard: 'ERC-8004'
    registrationJson: Record<string, unknown>
  }
  followers: string[]
  activity: { at: string; text: string }[]
  createdAt: string
  /** Cumulative USD committed today (UTC). Resets at 00:00 UTC. */
  spentTodayUsd?: number
  spendDate?: string
}

export type Wallet = {
  address: string
  agentId: string | null
  chain: 'arc-testnet'
  createdAt: string
}

export type InstructionType = 'payment' | 'purchase' | 'rental' | 'batch'

export type Instruction = {
  id: string
  agentId: string
  type: InstructionType
  amountUsd: number
  /** For batch: how many identical actions to run. */
  count: number
  payee: string
  memo: string
  status:
    | 'auto_approved'
    | 'pending_approval'
    | 'approved'
    | 'executed_simulated'
    | 'executed_onchain'
    | 'rejected'
  policyNote: string
  /** Machine-readable reason when the policy DENIED this instruction at creation time
   *  (today only the D3 velocity breaker hard-denies; other rules pause for a human). */
  denyCode?: 'velocity_exceeded'
  /** Set when the instruction was broadcast for real on Arc testnet. */
  txHash?: string
  explorerUrl?: string
  /** Which layer settled or blocked this: our server pre-check, Circle's hosted
   *  policy engine (Agent Wallet), or the trustless on-chain vault. */
  enforcedBy?: 'server' | 'circle-agent-stack' | 'onchain-vault' | 'session-key'
  /** Set when the settlement was wrapped through Arc's `Memo` precompile: the indexed
   *  on-chain memo id (recomputable from the instruction id) and the decoded reason
   *  payload emitted on-chain. Lets the UI link to an auditable "why" on arcscan. */
  memoId?: string
  memoReason?: string
  /**
   * The APP-LAYER audit record, for the settlement paths that cannot carry an on-chain
   * Memo: the AgentSpendPolicy vault (a contract cannot call Arc's Memo precompile), the
   * Circle Agent Wallet (Circle broadcasts from its own wallet), and batched
   * Multicall3From settlement (the batch itself is the contract call).
   *
   * Same structured payload as `memoReason`, written by THIS server after the receipt
   * rather than emitted on-chain, so it is not verifiable on arcscan and must never be
   * presented as if it were. That is why it is a separate pair of fields: `memoId` and
   * `memoReason` stay unset on these paths, and `offchainAuditId` is a plain app ref
   * rather than a bytes32 that would invite a memo lookup returning nothing.
   */
  offchainAuditId?: string
  offchainAuditReason?: string
  createdAt: string
}

export type State = {
  agents: PlatformAgent[]
  wallets: Wallet[]
  instructions: Instruction[]
  tasks: Task[]
  /** Policy Engine v2 decision trail, keyed by agent id. Bounded per agent
   *  (capAudits), because this whole state is persisted as one document. */
  audits: Record<string, AuditEntry[]>
  /** Monotonic per-agent counters. NOT trimmed, unlike `audits`: traction counted from
   *  capped rows would understate exactly the agents busy enough to matter. */
  meters: Record<string, AgentMeter>
  /** User ratings per agent (1-10 + comment), one entry per rater per agent. */
  feedback: Record<string, FeedbackEntry[]>
  /** Daily free-tier usage of the semantic search, keyed by caller. */
  semanticQuota: Record<string, { day: string; used: number }>
}

export type FeedbackEntry = {
  id: string
  agentId: string
  /** The verified session that rated (email/wallet subject). */
  rater: string
  /** 1..10, whole numbers. */
  score: number
  comment: string
  at: string
}

// ── persistence ───────────────────────────────────────────────────────────────

export const state: State = { agents: [], wallets: [], instructions: [], tasks: [], audits: {}, meters: {}, feedback: {}, semanticQuota: {} }

// Persistence is routed through this local wrapper so the TEST-ONLY reset below can turn
// it off: a unit test that seeds in-memory state must never overwrite the real persisted
// store (mcp/data/platform.json, or Postgres via DATABASE_URL). Production code never
// flips the flag; every existing call site keeps calling `save(state)` unchanged.
let persistEnabled = true
export const save = (s: State): void => {
  if (persistEnabled) saveState(s)
}

/**
 * TEST-ONLY: replace the in-memory state with a seed and DISABLE persistence for the rest
 * of the process, so tests can exercise the real aggregation code paths (marketplace,
 * platformStats, createAgent, feedback) without ever touching the persisted dev state.
 * Returns the live state object so a test can push tasks/instructions/feedback directly.
 */
export function __resetPlatformStateForTests(seed: Partial<State> = {}): State {
  persistEnabled = false
  state.agents = seed.agents ?? []
  state.wallets = seed.wallets ?? []
  state.instructions = seed.instructions ?? []
  state.tasks = seed.tasks ?? []
  state.audits = seed.audits ?? {}
  state.meters = seed.meters ?? {}
  state.feedback = seed.feedback ?? {}
  state.semanticQuota = seed.semanticQuota ?? {}
  return state
}

/**
 * Load persisted state (Postgres via DATABASE_URL, else the local JSON file) into
 * memory. Call once before serving requests.
 */
export async function initState() {
  const loaded = await loadState<State>()
  if (loaded) {
    state.agents = loaded.agents ?? []
    state.wallets = loaded.wallets ?? []
    state.instructions = loaded.instructions ?? []
    state.tasks = loaded.tasks ?? []
    // Older persisted documents predate the audit trail, so default it rather than
    // letting an undefined map reach the decision path.
    state.audits = loaded.audits ?? {}
    state.meters = loaded.meters ?? {}
    // Both maps postdate older persisted documents; default rather than crash.
    state.feedback = loaded.feedback ?? {}
    state.semanticQuota = loaded.semanticQuota ?? {}
  }
}

export const id = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/**
 * Reload persisted state into this process. The ASP gateway is a separate service that
 * calls initState() once at boot, so without this its view of the audit trail is frozen at
 * whatever the store held then. Callers should cache: this is a full document read.
 */
export async function refreshPlatformState(): Promise<void> {
  await initState()
}

/** Agent on-chain ops (anchor / vault deploy) in flight, so a client timeout-retry can't
 *  fire a second real broadcast for the same agent. Process-local (single-instance deploy). */
export const inFlightAgentOps = new Set<string>()

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Reset-aware daily spend: returns 0 once the UTC date rolls over. */
export function dailySpent(agent: PlatformAgent): number {
  return agent.spendDate === todayUTC() ? agent.spentTodayUsd ?? 0 : 0
}

export function addSpend(agent: PlatformAgent, amount: number) {
  const today = todayUTC()
  if (agent.spendDate !== today) {
    agent.spendDate = today
    agent.spentTodayUsd = 0
  }
  agent.spentTodayUsd = (agent.spentTodayUsd ?? 0) + amount
}

/** Next 00:00 UTC, for the UI "resets at" display. */
export function nextUtcMidnight(): string {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  ).toISOString()
}

/** True only if the caller is this agent's recorded owner. Fail closed: an agent with no
 *  owner is actable by NO ONE (previously any verified caller could act on an ownerless
 *  agent). Every API-created agent gets an owner (http.ts sets owner=callerId), so this
 *  just closes the latent authorization gap without affecting real agents. */
export function ownsAgent(agent: PlatformAgent, caller?: string): boolean {
  return Boolean(agent.owner) && agent.owner === caller
}

// ── helpers ───────────────────────────────────────────────────────────────────

export function pushActivity(agent: PlatformAgent, text: string) {
  agent.activity.push({ at: new Date().toISOString(), text })
  if (agent.activity.length > 50) agent.activity.splice(0, agent.activity.length - 50)
}

export const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`
export const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
