/**
 * A-Identity platform backend: agents, wallets, instructions, marketplace.
 *
 * The write side of the product, kept honest:
 *  - Wallets: a real keypair is generated with viem; the PRIVATE KEY IS RETURNED
 *    ONCE and never stored. We keep only the address. No custody.
 *  - Balances: read live from the Arc testnet RPC (native USDC, 18 decimals).
 *  - Funding: via the Circle faucet (faucet.circle.com); we link, a human clicks.
 *  - On-chain registration: prepared and queued. Broadcasting a transaction
 *    needs a funded key and a human, so it stays human-on-the-loop.
 *  - Instructions (pay / purchase / rental / batch): checked against the agent's
 *    permission policy. Under the auto-approve line they auto-approve; above it
 *    they wait for a human. Execution on testnet is simulated until a signer
 *    exists, and marked as such.
 *
 * State persists to mcp/data/platform.json so restarts keep the demo alive.
 */
import { loadState, saveState } from './storage.js'
import { ARC_TESTNET } from './arc.js'
import { CHAINS } from './chains/index.js'
import { SETTLEMENTS } from './asp/settlements.js'
import { randomBytes } from 'node:crypto'
import {
  CONTRACTS,
  registerAgentOnchain, payUsdcOnchain, payUsdcWithMemoOnchain, ARC_EXPLORER,
  deployPolicyVault, policyPay, policyOwnerPay, readPolicyVault,
  policySetPolicy, policySetFrozen, policySetAllowed, policySetSessionExpiry,
  recordValidationOnchain, readValidation, runEscrowJobDemo,
  fundEscrowOnchain, completeEscrowOnchain, rejectJobOnchain,
} from './arc-contracts.js'
import { createAgentWallet, circlePay, readCircleWallet } from './circle-agent.js'
import { previewTreasury, startAutoYield, type TreasuryPreview, type TreasuryExecution } from './treasury.js'
import { computeAgentReputation } from './reputation.js'
import {
  applyPolicyPatch,
  buildAuditEntry,
  capAudits,
  evaluateAction,
  filterAudits,
  resolveActionPolicy,
  summarizeAudits,
  guardrailProfile,
  unobservableProfile,
  notRegisteredProfile,
  deriveBadges,
  badgeFor,
  SURFACES,
  meterDecision,
  meterOverrideAttempt,
  aggregateTraction,
  defaultActionPolicy,
  type AgentMeter,
  type Traction,
  type Badge,
  type AccountSnapshot,
  type ActionPolicy,
  type AuditEntry,
  type AuditOutcome,
  type Decision,
  type GuardrailProfile,
  type NormalizedIntent,
} from './policy/index.js'
import { classifySybil, type SybilSignals } from './asp/risk.js'
import { getReputationAttestation } from './asp/attestations.js'
import {
  type Task, type TaskStatus, type Review, type Bid,
  canTransition, normalizePriceUsd, normalizeDeadlineHours, deadlineFrom,
  sanitizeRating, aggregateRating, buildAgentManifest,
} from './marketplace.js'

// ── types ─────────────────────────────────────────────────────────────────────

export type Permissions = {
  dailyCapUsd: number
  autoApproveUnderUsd: number
  payeeAllowlist: string[]
  agentToAgent: boolean
  agentToHuman: boolean
  /** Emergency off switch: when true, every instruction pauses for a human. */
  frozen: boolean
}

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

const state: State = { agents: [], wallets: [], instructions: [], tasks: [], audits: {}, meters: {}, feedback: {}, semanticQuota: {} }

// Persistence is routed through this local wrapper so the TEST-ONLY reset below can turn
// it off: a unit test that seeds in-memory state must never overwrite the real persisted
// store (mcp/data/platform.json, or Postgres via DATABASE_URL). Production code never
// flips the flag; every existing call site keeps calling `save(state)` unchanged.
let persistEnabled = true
const save = (s: State): void => {
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

const id = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

// ── wallets ───────────────────────────────────────────────────────────────────

/**
 * Create a real Arc-testnet keypair. The private key is returned to the caller
 * exactly once and NOT stored anywhere on the server.
 */
export async function createWallet(): Promise<{ wallet: Wallet; privateKey: string; note: string }> {
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts')
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  const wallet: Wallet = {
    address: account.address,
    agentId: null,
    chain: 'arc-testnet',
    createdAt: new Date().toISOString(),
  }
  state.wallets.push(wallet)
  save(state)
  return {
    wallet,
    privateKey,
    note:
      'Save this private key now. It is shown once and never stored by A-Identity. ' +
      `Fund the address with testnet USDC at ${ARC_TESTNET.faucet}.`,
  }
}

/**
 * Record a wallet whose keypair was generated CLIENT-SIDE. The server only ever
 * sees the public address — the private key never leaves the browser. This is the
 * no-custody path, preferred over server-side key generation.
 */
export function recordWallet(address: string): { wallet: Wallet } {
  const existing = state.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())
  if (existing) return { wallet: existing }
  const wallet: Wallet = {
    address,
    agentId: null,
    chain: 'arc-testnet',
    createdAt: new Date().toISOString(),
  }
  state.wallets.push(wallet)
  save(state)
  return { wallet }
}

/**
 * Bind a recorded wallet to an agent. Owner-only: only the agent's recorded owner may
 * (re)point its wallet address — otherwise any verified caller could overwrite another
 * owner's agent walletAddress and redirect its agent-to-agent settlements. Mirrors the
 * `ownsAgent` gate every other agent-scoped mutation already enforces.
 */
export function assignWallet(address: string, agentId: string, caller?: string): Wallet | { error: string } {
  const wallet = state.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())
  const agent = state.agents.find((a) => a.id === agentId)
  if (!wallet) return { error: 'Unknown wallet' }
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  wallet.agentId = agentId
  agent.walletAddress = wallet.address
  pushActivity(agent, `Wallet ${short(wallet.address)} assigned`)
  save(state)
  return wallet
}

/** Live native-USDC balance from the Arc testnet RPC. Real read, no key needed. */
export async function getWalletBalance(address: string) {
  try {
    const { createPublicClient, http, formatUnits } = await import('viem')
    const client = createPublicClient({
      transport: http(ARC_TESTNET.rpc.primary, { timeout: 6000, retryCount: 0 }),
    })
    const wei = await client.getBalance({ address: address as `0x${string}` })
    return {
      address,
      chain: 'arc-testnet',
      balance: formatUnits(wei, ARC_TESTNET.nativeDecimals),
      symbol: 'USDC',
      source: 'live-rpc',
      faucet: ARC_TESTNET.faucet,
    }
  } catch (err) {
    return {
      address,
      chain: 'arc-testnet',
      balance: null,
      symbol: 'USDC',
      source: 'rpc-unreachable',
      faucet: ARC_TESTNET.faucet,
      note: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── agents ────────────────────────────────────────────────────────────────────

/** Card style presets the UI maps onto its six category tokens (--cat-1..--cat-6). */
const CARD_STYLE_MIN = 1
const CARD_STYLE_MAX = 6

/** A whole number 1..6 passes; anything else (non-integer, out of range, wrong type)
 *  means UNSET, no clamping, because a clamped value would be a choice the owner
 *  never made. */
function sanitizeCardStyle(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= CARD_STYLE_MIN && v <= CARD_STYLE_MAX
    ? v
    : undefined
}

export function createAgent(input: {
  name: string
  description: string
  category: string
  capabilities: string[]
  services?: Service[]
  permissions: Partial<Permissions>
  walletAddress?: string
  endpoint?: string
  logoUrl?: string
  /** Optional card style preset (whole 1..6); invalid input is dropped, not clamped. */
  cardStyle?: unknown
  owner?: string
}): PlatformAgent {
  const permissions: Permissions = {
    dailyCapUsd: input.permissions.dailyCapUsd ?? 50,
    autoApproveUnderUsd: input.permissions.autoApproveUnderUsd ?? 1,
    payeeAllowlist: input.permissions.payeeAllowlist ?? [],
    agentToAgent: input.permissions.agentToAgent ?? true,
    agentToHuman: input.permissions.agentToHuman ?? false,
    frozen: input.permissions.frozen ?? false,
  }

  // Bound stored strings/arrays so a large registration can't balloon the single
  // persisted state blob (which is serialized in full on every save).
  const clamp = (s: string, n: number) => (typeof s === 'string' ? s.slice(0, n) : '')
  const boundedCaps = input.capabilities.slice(0, 50).map((c) => clamp(String(c), 200))

  // Services the agent sells on the marketplace. Default: one per capability at a nominal
  // price, so a fresh agent is immediately hireable. Client-provided services are bounded
  // (count + name/price/unit) so a self-register can't balloon the persisted state blob.
  const services: Service[] =
    input.services && input.services.length > 0
      ? input.services
          .slice(0, 20)
          .map((s) => ({ name: clamp(String(s?.name ?? ''), 200), priceUsd: normalizePriceUsd(s?.priceUsd), unit: clamp(String(s?.unit ?? 'per action'), 40) || 'per action' }))
          .filter((s) => s.name)
      : boundedCaps.map((c) => ({ name: c, priceUsd: 1, unit: 'per action' }))

  const agent: PlatformAgent = {
    id: id('agent'),
    name: clamp(input.name, 200),
    description: clamp(input.description, 5000),
    category: clamp(input.category, 100),
    capabilities: boundedCaps,
    services,
    endpoint: input.endpoint ? clamp(String(input.endpoint), 500) : undefined,
    // Only small inline images: a data: URL under ~150KB. Anything else is dropped
    // rather than ballooning the single persisted state document.
    logoUrl:
      typeof input.logoUrl === 'string' && input.logoUrl.startsWith('data:image/') && input.logoUrl.length <= 150_000
        ? input.logoUrl
        : undefined,
    cardStyle: sanitizeCardStyle(input.cardStyle),
    permissions,
    walletAddress: input.walletAddress ?? null,
    chain: 'arc',
    chainId: ARC_TESTNET.id,
    kya: 'unverified',
    owner: input.owner,
    onchain: 'queued',
    passport: {
      standard: 'ERC-8004',
      registrationJson: {
        name: input.name,
        description: input.description,
        category: input.category,
        capabilities: input.capabilities,
        chain: `eip155:${ARC_TESTNET.id}`,
        registeredAt: new Date().toISOString().slice(0, 10),
      },
    },
    followers: [],
    activity: [{ at: new Date().toISOString(), text: 'Agent registered; KYA pending (prove wallet control), on-chain anchor queued' }],
    createdAt: new Date().toISOString(),
  }

  if (input.walletAddress) {
    const w = state.wallets.find(
      (x) => x.address.toLowerCase() === input.walletAddress!.toLowerCase(),
    )
    if (w) w.agentId = agent.id
  }

  state.agents.push(agent)
  save(state)
  return agent
}

export function listPlatformAgents(): PlatformAgent[] {
  return state.agents
}

/**
 * Anchor an existing platform agent on Arc: broadcast a real ERC-8004 registration
 * (server signer, env-gated behind ARC_SIGNER_KEY) and record the result on the agent.
 * Deliberate + human-triggered from the UI, so it stays human-on-the-loop. Without a
 * signer key it returns the exact prepared call and leaves the agent queued.
 */
/** Agent on-chain ops (anchor / vault deploy) in flight, so a client timeout-retry can't
 *  fire a second real broadcast for the same agent. Process-local (single-instance deploy). */
const inFlightAgentOps = new Set<string>()

export async function anchorAgentOnchain(agentId: string, caller?: string) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  // Idempotent: an already-anchored agent holds its ERC-8004 id — never register a duplicate.
  if (agent.onchain === 'registered' && agent.onchainTx) {
    return {
      agent: {
        id: agent.id, onchain: agent.onchain, onchainTx: agent.onchainTx,
        onchainExplorer: agent.onchainExplorer, onchainAgentId: agent.onchainAgentId,
      },
      result: { executed: false, reason: 'Agent is already anchored on-chain', alreadyAnchored: true },
    }
  }
  // Guard a concurrent double-broadcast (e.g. a client retrying after a timeout).
  const opKey = `anchor:${agentId}`
  if (inFlightAgentOps.has(opKey)) return { error: 'This agent is already being anchored on-chain' }
  inFlightAgentOps.add(opKey)
  try {
    const metadataUri =
      'data:application/json,' +
      encodeURIComponent(
        JSON.stringify({ name: agent.name, category: agent.category, standard: 'ERC-8004', app: 'A-Identity' }),
      )

    const result = await registerAgentOnchain(metadataUri)

    if (result.executed) {
      agent.onchain = 'registered'
      agent.onchainTx = result.txHash
      agent.onchainExplorer = result.explorerUrl
      agent.onchainAgentId = result.agentId
      pushActivity(agent, `Anchored on Arc: ERC-8004 id ${result.agentId ?? '?'} (tx ${short(result.txHash)})`)
      save(state)
    }

    return {
      agent: {
        id: agent.id,
        onchain: agent.onchain,
        onchainTx: agent.onchainTx,
        onchainExplorer: agent.onchainExplorer,
        onchainAgentId: agent.onchainAgentId,
      },
      result,
    }
  } finally {
    inFlightAgentOps.delete(opKey)
  }
}

// ── KYA (Know Your Agent): prove wallet control ──────────────────────────────────

/**
 * Ephemeral KYA challenges, keyed by agentId. In-memory + a short TTL, so a challenge
 * can't be signed forever and stale entries can't accumulate. This is correct for the
 * single backend instance we deploy; a horizontally-scaled deploy would move these to
 * shared storage (a challenge issued by instance A must be verifiable by instance B).
 */
const KYA_CHALLENGE_TTL_MS = 10 * 60 * 1000
const kyaChallenges = new Map<string, { nonce: string; exp: number }>()

/** Start a KYA challenge: the agent signs this to prove it controls its wallet. */
export function startKyaChallenge(
  agentId: string,
  caller?: string,
): { address: string; message: string } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  if (!agent.walletAddress) return { error: 'Agent has no wallet to prove; create or assign one first' }
  const nonce = randomBytes(16).toString('hex')
  kyaChallenges.set(agentId, { nonce, exp: Date.now() + KYA_CHALLENGE_TTL_MS })
  const message = `A-Identity KYA: prove control of ${agent.walletAddress}\nAgent: ${agentId}\nNonce: ${nonce}`
  return { address: agent.walletAddress, message }
}

/**
 * Finish KYA: verify the agent's wallet signed the challenge (viem verifyMessage). On
 * success sets kya='verified' + records the proof, then best-effort attests the result
 * on the real ERC-8004 ValidationRegistry (needs the agent anchored + a signer key; an
 * on-chain failure never undoes the cryptographically-proven 'verified' state).
 */
export async function verifyKya(
  agentId: string,
  message: string,
  signature: string,
  caller?: string,
): Promise<{ error: string } | { kya: 'verified'; kyaProof: PlatformAgent['kyaProof']; onchain: unknown }> {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  if (!agent.walletAddress) return { error: 'Agent has no wallet' }
  const challenge = kyaChallenges.get(agentId)
  if (challenge && challenge.exp <= Date.now()) kyaChallenges.delete(agentId)
  const nonce = challenge && challenge.exp > Date.now() ? challenge.nonce : undefined
  if (!nonce || !message.includes(nonce)) return { error: 'Stale or missing challenge; request a new one' }

  const { verifyMessage } = await import('viem')
  let ok = false
  try {
    ok = await verifyMessage({
      address: agent.walletAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
  } catch {
    ok = false
  }
  if (!ok) return { error: 'Signature does not match the agent wallet' }

  kyaChallenges.delete(agentId)
  agent.kya = 'verified'
  agent.kyaProof = { address: agent.walletAddress, at: new Date().toISOString(), method: 'wallet-signature' }
  pushActivity(agent, `KYA passed: wallet control proven (${short(agent.walletAddress)})`)

  // Layer B — anchor the KYA result on the ERC-8004 ValidationRegistry (best-effort).
  let onchain: unknown = null
  if (agent.onchainAgentId) {
    const requestUri =
      'data:application/json,' +
      encodeURIComponent(
        JSON.stringify({ kya: 'wallet-signature', agent: agent.id, address: agent.walletAddress, at: agent.kyaProof.at }),
      )
    const r = await recordValidationOnchain(BigInt(agent.onchainAgentId), requestUri)
    if (r.executed) {
      agent.kyaOnchainTx = r.txHash
      agent.kyaOnchainExplorer = r.explorerUrl
      agent.kyaRequestHash = r.requestHash
      pushActivity(agent, `KYA attested on-chain (ERC-8004 ValidationRegistry, tx ${short(r.txHash)})`)
      onchain = { txHash: r.txHash, explorerUrl: r.explorerUrl, requestHash: r.requestHash }
    } else {
      onchain = { prepared: true, reason: r.reason }
    }
  }
  save(state)
  return { kya: 'verified', kyaProof: agent.kyaProof, onchain }
}

/** Read an agent's KYA status + live on-chain validation (needs the agent anchored). */
export async function getAgentKya(agentId: string) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  const base = {
    kya: agent.kya,
    kyaProof: agent.kyaProof ?? null,
    kyaRevoked: agent.kyaRevoked ?? null,
    kyaOnchainTx: agent.kyaOnchainTx ?? null,
    kyaOnchainExplorer: agent.kyaOnchainExplorer ?? null,
  }
  if (!agent.onchainAgentId) return { ...base, onchain: null }
  return { ...base, onchain: await readValidation(BigInt(agent.onchainAgentId)) }
}

/**
 * Revoke an agent's KYA — flag it as an incident (compromised key, repeated disputes, an owner
 * kill-switch). Owner-gated. Sets kya='revoked' (so it is no longer hireable AND risk_check
 * DENYs it), records the incident, and best-effort writes a NEGATIVE attestation (response=0,
 * tag "revoked") to the real ERC-8004 ValidationRegistry — the honest counterpart to the
 * verify-time attestation. Re-proving wallet control (verifyKya) clears the flag to 'verified'.
 */
export async function revokeAgentKya(
  agentId: string,
  reason: string,
  caller?: string,
): Promise<{ error: string } | { kya: 'revoked'; kyaRevoked: NonNullable<PlatformAgent['kyaRevoked']>; onchain: unknown }> {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  const cleanReason = (typeof reason === 'string' ? reason.trim() : '').slice(0, 280) || 'Owner-initiated revocation'

  agent.kya = 'revoked'
  agent.kyaRevoked = { at: new Date().toISOString(), by: caller ?? 'owner', reason: cleanReason }
  pushActivity(agent, `KYA REVOKED (incident): ${cleanReason}`)

  // Best-effort negative attestation on the ERC-8004 ValidationRegistry (response=0, tag "revoked").
  let onchain: unknown = null
  if (agent.onchainAgentId) {
    const requestUri =
      'data:application/json,' +
      encodeURIComponent(JSON.stringify({ revoked: true, agent: agent.id, reason: cleanReason, at: agent.kyaRevoked.at }))
    const r = await recordValidationOnchain(BigInt(agent.onchainAgentId), requestUri, process.env, { response: 0, tag: 'revoked' })
    if (r.executed) {
      agent.kyaRevoked.onchainTx = r.txHash
      agent.kyaRevoked.onchainExplorer = r.explorerUrl
      pushActivity(agent, `Revocation attested on-chain (ERC-8004 ValidationRegistry, tx ${short(r.txHash)})`)
      onchain = { txHash: r.txHash, explorerUrl: r.explorerUrl, requestHash: r.requestHash }
    } else {
      onchain = { prepared: true, reason: r.reason }
    }
  }
  save(state)
  return { kya: 'revoked', kyaRevoked: agent.kyaRevoked, onchain }
}

// ── on-chain policy vault ────────────────────────────────────────────────────────

/**
 * Provision an on-chain AgentSpendPolicy vault for an agent: deploy a contract
 * that enforces the agent's daily cap + auto-approve ceiling on Arc, and
 * optionally fund it with USDC. Once set, this agent's address payments settle
 * through the vault (chain-enforced), with the server engine as the pre-check.
 * Owner-only; env-gated behind ARC_SIGNER_KEY.
 */
export async function provisionAgentVault(
  agentId: string,
  opts: { fundUsd?: number; caller?: string; ownerAddress?: string } = {},
) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, opts.caller)) return { error: 'Forbidden: not the agent owner' }
  if (agent.vaultAddress) return { error: 'Agent already has an on-chain policy vault', vaultAddress: agent.vaultAddress }

  // Human owner of the vault = a REAL wallet distinct from the server signer/operator,
  // so freeze/override/withdraw are owner-gated on-chain. Prefer an explicit address,
  // then the caller when they signed in with a wallet (SIWE → subject is a 0x addr),
  // then the agent's own (browser-held) wallet. Falls back to the signer only if none.
  const isAddr = (s?: string): s is string => !!s && /^0x[0-9a-fA-F]{40}$/.test(s)
  const ownerAddress = isAddr(opts.ownerAddress)
    ? opts.ownerAddress
    : isAddr(opts.caller)
      ? opts.caller
      : isAddr(agent.walletAddress ?? undefined)
        ? (agent.walletAddress as string)
        : undefined

  // Require a REAL human/Safe owner distinct from the server operator. Without one the
  // vault would deploy with owner == operator (the signer), so on-chain freeze/withdraw
  // would not be human-controlled and a signer compromise could drain every vault. Refuse
  // rather than silently collapse the two roles.
  if (!ownerAddress) {
    return {
      error:
        'Provide an ownerAddress (a human/Safe wallet distinct from the server operator): ' +
        'sign in with a wallet, pass ownerAddress, or give the agent a wallet first. The vault ' +
        'owner (freeze/withdraw) must not be the same key that operates it.',
    }
  }

  const opKey = `vault:${agentId}`
  if (inFlightAgentOps.has(opKey)) return { error: 'A vault is already being provisioned for this agent' }
  inFlightAgentOps.add(opKey)
  try {
  const dep = await deployPolicyVault({
    owner: ownerAddress,
    dailyCapUsd: agent.permissions.dailyCapUsd,
    autoApproveUsd: agent.permissions.autoApproveUnderUsd,
  })
  if (!dep.executed) return { error: dep.reason }

  agent.vaultAddress = dep.vault
  agent.vaultExplorer = `${ARC_EXPLORER}/address/${dep.vault}`
  agent.vaultOwner = dep.owner
  agent.vaultOperator = dep.operator
  const separated = dep.owner.toLowerCase() !== dep.operator.toLowerCase()
  pushActivity(
    agent,
    `On-chain policy vault deployed at ${short(dep.vault)} (tx ${short(dep.txHash)})` +
      (separated ? ` — human owner ${short(dep.owner)}, agent operator ${short(dep.operator)}` : ''),
  )

  let funding: unknown = null
  if (opts.fundUsd && opts.fundUsd > 0) {
    const f = await payUsdcOnchain(dep.vault, opts.fundUsd)
    funding = f.executed
      ? { amountUsd: opts.fundUsd, txHash: f.txHash, explorerUrl: f.explorerUrl }
      : { error: f.reason }
    if (f.executed) pushActivity(agent, `Funded vault with ${opts.fundUsd} USDC (tx ${short(f.txHash)})`)
  }
  save(state)
  return {
    vaultAddress: agent.vaultAddress,
    vaultExplorer: agent.vaultExplorer,
    owner: dep.owner,
    operator: dep.operator,
    ownerOperatorSeparated: separated,
    deployTx: dep.txHash,
    deployExplorer: dep.explorerUrl,
    funding,
  }
  } finally {
    inFlightAgentOps.delete(opKey)
  }
}

/** Read an agent's live on-chain vault policy + balance (no key needed). */
/** Circle's CLI names chains its own way; Arc Testnet is the one this product runs on. */
const CIRCLE_CLI_CHAIN = 'ARC-TESTNET'

/**
 * The agent's limits, compiled into the Circle CLI commands that reproduce them at
 * Circle's own wallet-policy layer. Read-only and generative: we never run the CLI,
 * because an Agent Wallet is user-controlled and applying a policy needs the owner's
 * interactive confirmation. See `circle-cli.ts` for why that matters.
 */
export async function getAgentCirclePolicyPlan(agentId: string, email?: string) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  const address = agent.walletAddress ?? agent.vaultAddress
  if (!address) return { error: 'This agent has no wallet address yet.' }
  const { compilePolicyPlan, bootstrapCommands } = await import('./circle-cli.js')
  return {
    bootstrap: bootstrapCommands(email),
    ...compilePolicyPlan({
      address,
      chain: CIRCLE_CLI_CHAIN,
      permissions: {
        dailyCapUsd: agent.permissions.dailyCapUsd,
        autoApproveUnderUsd: agent.permissions.autoApproveUnderUsd,
        payeeAllowlist: agent.permissions.payeeAllowlist,
        frozen: agent.permissions.frozen,
      },
      email,
    }),
  }
}

export async function getAgentVault(agentId: string) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!agent.vaultAddress) return { vaultAddress: null }
  const live = await readPolicyVault(agent.vaultAddress)
  return { vaultAddress: agent.vaultAddress, ...live }
}

/**
 * Grant / extend / revoke the agent's on-chain SESSION KEY: set the UNIX time after which
 * the agent's `pay` reverts (SessionKeyExpired). Owner-only on-chain; the server can sign it
 * only when it is the vault owner (owner==operator) — otherwise it's ownerGated (the human
 * signs from their own wallet), mirroring syncVaultPolicy. Revoke sets the expiry to now.
 */
export async function grantAgentSessionKey(
  agentId: string,
  input: { durationHours?: number; expiryUnix?: number; revoke?: boolean },
  caller?: string,
): Promise<{ granted: boolean; reason?: string; ownerGated?: boolean; sessionKeyExpiry?: number; expiresInSeconds?: number; txHash?: string; explorerUrl?: string }> {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { granted: false, reason: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { granted: false, reason: 'Forbidden: not the agent owner' }
  if (!agent.vaultAddress) return { granted: false, reason: 'Agent has no on-chain vault. Provision a vault first.' }

  const now = Math.floor(Date.now() / 1000)
  let expiry: number
  if (input.revoke) expiry = now
  else if (typeof input.expiryUnix === 'number' && input.expiryUnix >= 0) expiry = Math.floor(input.expiryUnix)
  else if (typeof input.durationHours === 'number' && input.durationHours > 0) expiry = now + Math.floor(input.durationHours * 3600)
  else return { granted: false, reason: 'Provide durationHours (>0), an expiryUnix, or revoke:true.' }

  const res = await policySetSessionExpiry(agent.vaultAddress, expiry)
  if (res.executed) {
    pushActivity(agent, input.revoke
      ? `Session key revoked on-chain (tx ${short(res.txHash)})`
      : `Session key granted, expires ${new Date(expiry * 1000).toISOString()} (tx ${short(res.txHash)})`)
    save(state)
    return { granted: true, sessionKeyExpiry: expiry, expiresInSeconds: input.revoke ? 0 : Math.max(0, expiry - now), txHash: res.txHash, explorerUrl: res.explorerUrl }
  }
  if (res.reverted && res.reason === 'NotOwner') {
    return { granted: false, ownerGated: true, sessionKeyExpiry: expiry, reason: 'The vault owner must sign this from their own wallet (owner ≠ operator).' }
  }
  return { granted: false, reason: res.reverted ? res.reason : (res.reason ?? 'no signer configured') }
}

export type VaultSyncResult = {
  synced: boolean
  reason?: string
  /** True when the on-chain change is owner-signed and the server can't sign it. */
  ownerGated?: boolean
  txs?: { setPolicy?: string; setFrozen?: string }
  /** The limits we wanted on-chain, so an owner can push them from their own wallet. */
  want?: { dailyCapUsd: number; autoApproveUsd: number; allowlistEnabled: boolean; frozen: boolean }
  note?: string
}

/** USDC micro-units, for exact (float-safe) on-chain vs off-chain comparisons. */
const micro = (n: number) => Math.round(n * 1e6)

/**
 * Push an agent's off-chain permissions onto its on-chain AgentSpendPolicy vault, so a
 * limit changed in the UI actually re-enforces on Arc — not only in the server pre-check.
 * setPolicy / setFrozen / setAllowed are owner-only; the server signer can sign them ONLY
 * when it is the vault owner (owner==operator). With the intended owner≠operator separation
 * the human owner must sign the change from their own wallet, so we say that plainly (and
 * return the target limits) instead of letting the chain-enforced policy silently drift from
 * the UI. Diffs against the live on-chain state first, so a change to off-chain-only fields
 * (e.g. agent-to-human) never spends gas. Best-effort: a failure never undoes the off-chain
 * update that already happened.
 */
async function syncVaultPolicy(agent: PlatformAgent): Promise<VaultSyncResult> {
  const vault = agent.vaultAddress
  if (!vault) return { synced: false, reason: 'Agent has no on-chain vault' }
  const p = agent.permissions
  const want = {
    dailyCapUsd: p.dailyCapUsd,
    autoApproveUsd: p.autoApproveUnderUsd,
    allowlistEnabled: p.payeeAllowlist.length > 0,
    frozen: p.frozen,
  }

  // Only write what actually changed on-chain. A read never needs a key.
  let live: Awaited<ReturnType<typeof readPolicyVault>> | null = null
  try { live = await readPolicyVault(vault) } catch { live = null }
  const policyDrift =
    !live ||
    micro(live.dailyCapUsd) !== micro(want.dailyCapUsd) ||
    micro(live.autoApproveUsd) !== micro(want.autoApproveUsd) ||
    live.allowlistEnabled !== want.allowlistEnabled
  const frozenDrift = !live || live.frozen !== want.frozen
  if (!policyDrift && !frozenDrift) return { synced: true, txs: {}, note: 'On-chain vault already matches these limits.' }

  // Owner-gated on-chain: the server can sign owner calls only when owner==operator.
  const serverIsOwner =
    !agent.vaultOwner || !agent.vaultOperator ||
    agent.vaultOwner.toLowerCase() === agent.vaultOperator.toLowerCase()
  if (!serverIsOwner) {
    return {
      synced: false,
      ownerGated: true,
      want,
      reason:
        'On-chain vault limits are owner-signed and this vault is owned by your own wallet ' +
        '(owner≠operator by design). Re-sign setPolicy from the owner wallet to push these limits ' +
        'on-chain; the server holds only the operator key. Off-chain policy is updated meanwhile.',
    }
  }

  try {
    const txs: { setPolicy?: string; setFrozen?: string } = {}
    if (policyDrift) {
      const sp = await policySetPolicy(vault, {
        dailyCapUsd: want.dailyCapUsd, autoApproveUsd: want.autoApproveUsd, allowlistEnabled: want.allowlistEnabled,
      })
      if (!sp.executed) return { synced: false, reason: `Vault setPolicy failed: ${sp.reason}` }
      txs.setPolicy = sp.txHash
    }
    if (frozenDrift) {
      const sf = await policySetFrozen(vault, want.frozen)
      if (sf.executed) txs.setFrozen = sf.txHash
    }
    // Mirror raw-address allowlist entries onto the vault (adds only; best-effort).
    for (const addr of p.payeeAllowlist.filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x))) {
      await policySetAllowed(vault, addr, true).catch(() => {})
    }
    pushActivity(
      agent,
      `On-chain vault policy synced (cap $${want.dailyCapUsd}, ceiling $${want.autoApproveUsd}${want.frozen ? ', frozen' : ''})`,
    )
    return { synced: true, txs }
  } catch (e) {
    return { synced: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

// ── Circle Agent Wallet (hosted, wallet-layer enforcement) ───────────────────────

/**
 * Provision a Circle Agent Wallet (Developer-Controlled EOA on ARC-TESTNET) for an
 * agent — the second, hosted enforcement layer alongside the on-chain vault. Once set,
 * this agent's address payments can settle THROUGH Circle, whose hosted policy engine
 * screens each transfer at the wallet layer (sanctions / allow-block / freeze). Owner-
 * only; credential-gated behind CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET (no-op without).
 */
export async function provisionCircleWallet(
  agentId: string,
  opts: { fund?: boolean; caller?: string } = {},
) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, opts.caller)) return { error: 'Forbidden: not the agent owner' }
  if (agent.circleWalletId)
    return { error: 'Agent already has a Circle Agent Wallet', circleWalletId: agent.circleWalletId }

  const res = await createAgentWallet(
    { name: agent.name, refId: agent.id, fund: opts.fund ?? true },
    process.env,
  )
  if (!res.provisioned) return { error: res.reason }

  agent.circleWalletId = res.walletId
  agent.circleWalletAddress = res.walletAddress
  agent.circleWalletExplorer = res.explorerUrl
  pushActivity(agent, `Circle Agent Wallet provisioned on Arc: ${short(res.walletAddress)}`)
  save(state)
  return {
    circleWalletId: res.walletId,
    circleWalletAddress: res.walletAddress,
    circleWalletExplorer: res.explorerUrl,
    blockchain: res.blockchain,
    funded: res.funded,
  }
}

/** Read an agent's live Circle Agent Wallet state + balances (needs creds). */
export async function getAgentCircleWallet(agentId: string) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!agent.circleWalletId) return { circleWalletId: null }
  const live = await readCircleWallet(agent.circleWalletId)
  return { circleWalletId: agent.circleWalletId, circleWalletAddress: agent.circleWalletAddress, ...live }
}

// ── treasury: idle-balance auto-yield into USYC (Circle's yield-bearing token) ────

/** Default working-capital cap: idle balance above this is what auto-yield would deploy. */
const DEFAULT_YIELD_CAP_USD = 25

/**
 * Live treasury view for an agent: real multi-asset balances (USDC/EURC/USYC) read
 * from Arc, the deployable idle amount above the cap, and the projected USYC earnings
 * the owner reviews before authorizing. Read-only, no key. Uses the saved cap if the
 * owner has one, else the query cap, else the default.
 */
export async function getAgentTreasury(
  agentId: string,
  capUsd?: number,
): Promise<{ error: string } | (TreasuryPreview & { autoYieldEnabled: boolean; authorizedAt?: string })> {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  // The agent's idle stablecoin lives in its own wallet, or in its Circle Agent Wallet
  // when that's the funded one. Read wherever the balance actually is.
  const address = agent.walletAddress ?? agent.circleWalletAddress
  if (!address) return { error: 'Agent has no wallet yet; create one or provision a Circle wallet first' }
  const cap = capUsd ?? agent.treasury?.capUsd ?? DEFAULT_YIELD_CAP_USD
  const preview = await previewTreasury(address, cap)
  return { ...preview, autoYieldEnabled: agent.treasury?.autoYieldEnabled ?? false, authorizedAt: agent.treasury?.authorizedAt }
}

/**
 * Owner authorizes auto-yield at a working-capital cap: persists the authorization
 * (enabled + cap) and returns the on-chain USYC deployment plan. The USDC->USYC mint is
 * gated on USYC allowlisting (like every other write here); the authorization + cap are
 * real state either way. Owner-only.
 */
export async function startAgentAutoYield(
  agentId: string,
  capUsd: number,
  caller?: string,
): Promise<{ error: string } | { treasury: PlatformAgent['treasury']; execution: TreasuryExecution }> {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  const address = agent.walletAddress ?? agent.circleWalletAddress
  if (!address) return { error: 'Agent has no wallet yet; create one or provision a Circle wallet first' }
  const cap = Math.max(0, capUsd)

  const execution = await startAutoYield(address, cap)
  agent.treasury = { autoYieldEnabled: true, capUsd: cap, authorizedAt: new Date().toISOString() }
  pushActivity(
    agent,
    `Auto-yield authorized: idle over $${cap} earmarked for USYC` +
      (execution.deployableUsd > 0 ? ` (~$${execution.projection.monthlyUsd}/mo projected on $${execution.deployableUsd})` : ''),
  )
  save(state)
  return { treasury: agent.treasury, execution }
}

/** Owner turns auto-yield off (leaves any USYC position untouched; just stops earmarking). */
export function stopAgentAutoYield(agentId: string, caller?: string): { error: string } | { treasury: PlatformAgent['treasury'] } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  agent.treasury = { autoYieldEnabled: false, capUsd: agent.treasury?.capUsd ?? DEFAULT_YIELD_CAP_USD, authorizedAt: agent.treasury?.authorizedAt }
  pushActivity(agent, 'Auto-yield turned off by a human')
  save(state)
  return { treasury: agent.treasury }
}

// ── policy / permissions ───────────────────────────────────────────────────────

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Reset-aware daily spend: returns 0 once the UTC date rolls over. */
function dailySpent(agent: PlatformAgent): number {
  return agent.spendDate === todayUTC() ? agent.spentTodayUsd ?? 0 : 0
}

function addSpend(agent: PlatformAgent, amount: number) {
  const today = todayUTC()
  if (agent.spendDate !== today) {
    agent.spendDate = today
    agent.spentTodayUsd = 0
  }
  agent.spentTodayUsd = (agent.spentTodayUsd ?? 0) + amount
}

/** Next 00:00 UTC, for the UI "resets at" display. */
function nextUtcMidnight(): string {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  ).toISOString()
}

/** True only if the caller is this agent's recorded owner. Fail closed: an agent with no
 *  owner is actable by NO ONE (previously any verified caller could act on an ownerless
 *  agent). Every API-created agent gets an owner (http.ts sets owner=callerId), so this
 *  just closes the latent authorization gap without affecting real agents. */
function ownsAgent(agent: PlatformAgent, caller?: string): boolean {
  return Boolean(agent.owner) && agent.owner === caller
}

/** Sanitize a client-supplied permissions patch: clamp numbers into a sane range (a
 *  1e308 auto-approve line would silently disable human approval), coerce booleans, and
 *  bound the allowlist. Only well-formed fields survive to be merged. */
function sanitizePermissions(partial: Partial<Permissions>): Partial<Permissions> {
  const out: Partial<Permissions> = {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1_000_000, Math.max(0, v)) : undefined)
  if (partial.dailyCapUsd !== undefined) { const n = num(partial.dailyCapUsd); if (n !== undefined) out.dailyCapUsd = n }
  if (partial.autoApproveUnderUsd !== undefined) { const n = num(partial.autoApproveUnderUsd); if (n !== undefined) out.autoApproveUnderUsd = n }
  if (partial.agentToAgent !== undefined) out.agentToAgent = Boolean(partial.agentToAgent)
  if (partial.agentToHuman !== undefined) out.agentToHuman = Boolean(partial.agentToHuman)
  if (partial.frozen !== undefined) out.frozen = Boolean(partial.frozen)
  if (Array.isArray(partial.payeeAllowlist)) {
    out.payeeAllowlist = partial.payeeAllowlist
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 100)
      .map((x) => x.slice(0, 100))
  }
  return out
}

export async function updateAgentPermissions(
  agentId: string,
  partial: Partial<Permissions>,
  caller?: string,
): Promise<(PlatformAgent & { vaultSync?: VaultSyncResult }) | { error: string }> {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  agent.permissions = { ...agent.permissions, ...sanitizePermissions(partial) }
  pushActivity(agent, 'Permissions updated by a human')

  // If the agent has an on-chain policy vault, push the new limits to it so the
  // chain-enforced policy tracks the UI instead of staying frozen at deploy time.
  const vaultSync = agent.vaultAddress ? await syncVaultPolicy(agent) : undefined
  save(state)
  return vaultSync ? { ...agent, vaultSync } : agent
}

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
 * The snapshot comes from the CALLER, and per docs/robinhood-intent-capture.md bypass 8
 * that caller must be the skill rather than the agent being policed: an agent that can
 * author its own snapshot can buy an ALLOW by lying about buying power. We cannot verify
 * that from here, so the audit entry records a hash of exactly what was used, which makes
 * a falsified snapshot detectable after the fact instead of invisible.
 */
export function checkAgentAction(
  agentId: string,
  input: { surface: string; intent: NormalizedIntent; snapshot?: AccountSnapshot },
  caller?: string,
): { decision: Decision; auditId: string; policyConfigured: boolean } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  if (!input?.intent || typeof input.intent !== 'object') return { error: 'intent required' }
  if (!input.surface) return { error: 'surface required' }

  const now = new Date().toISOString()
  const { policy, configured } = resolveActionPolicy(agent.actionPolicy, id('pol'), now)
  const decision = evaluateAction({
    surface: input.surface,
    policy,
    intent: input.intent,
    snapshot: input.snapshot,
    now: new Date(now),
  })

  const entry = buildAuditEntry({
    id: id('aud'),
    ts: now,
    agentId: agent.id,
    intent: input.intent,
    snapshot: input.snapshot,
    decision,
  })
  state.audits[agent.id] = capAudits([...(state.audits[agent.id] ?? []), entry])
  // Monotonic counters alongside the capped rows, so traction survives the audit cap.
  state.meters[agent.id] = meterDecision(state.meters[agent.id], {
    decision,
    notionalUsd: input.intent.notionalUsd,
    at: now,
  })
  // Only surface it on the agent's activity feed when the policy actually intervened;
  // an ALLOW on every routine action would drown the feed.
  if (decision.verdict !== 'ALLOW') {
    pushActivity(agent, `Policy ${decision.verdict} on a ${entry.intent.kind} action: ${decision.reasons[0] ?? ''}`.trim())
  }
  save(state)

  return { decision, auditId: entry.id, policyConfigured: configured }
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

/**
 * Reload persisted state into this process. The ASP gateway is a separate service that
 * calls initState() once at boot, so without this its view of the audit trail is frozen at
 * whatever the store held then. Callers should cache: this is a full document read.
 */
export async function refreshPlatformState(): Promise<void> {
  await initState()
}

/** Live policy view for one agent: limits + today's spend + reset time. */
export function agentPolicy(agentId: string) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  const spent = dailySpent(agent)
  return {
    agentId: agent.id,
    name: agent.name,
    permissions: agent.permissions,
    spentTodayUsd: spent,
    remainingTodayUsd: Math.max(0, agent.permissions.dailyCapUsd - spent),
    resetsAt: nextUtcMidnight(),
  }
}

// ── reputation (from real activity) ─────────────────────────────────────────────

/**
 * Reputation (0-1000) computed from the agent's REAL signals: on-chain USDC settlements,
 * a credit for holding a verified on-chain ERC-8004 identity, the clean (settled vs
 * rejected) ratio, and tenure. Every input is real and verifiable (settlements carry tx
 * hashes) — no mock history. The math lives in the pure, unit-tested `computeAgentReputation`
 * (reputation.ts), so the tested scorer and the production scorer are the same code.
 */
/**
 * Real behavioral signals from marketplace jobs where this agent was the WORKER: completed
 * (released) vs contested (refunded/disputed) outcomes, and the mean client star rating.
 * Every input is real and tracked in `state.tasks` (no mock, no self-attestation). Shared by
 * the scorer (repOf) and the display summary (agentReputation) so they can never drift.
 */
function behavioralSignals(agent: PlatformAgent) {
  const hired = state.tasks.filter((t) => t.agentId === agent.id)
  const completedTasks = hired.filter((t) => t.status === 'released').length
  const disputedTasks = hired.filter((t) => t.status === 'refunded' || t.status === 'disputed').length
  const ratings = hired
    .map((t) => t.review?.rating)
    .filter((r): r is number => typeof r === 'number' && Number.isFinite(r))
  const ratedCount = ratings.length
  const avgRating = ratedCount ? ratings.reduce((a, r) => a + r, 0) / ratedCount : undefined
  return { completedTasks, disputedTasks, ratedCount, avgRating }
}

/**
 * Real Sybil / wash-reputation signals from platform state: how many agents share this agent's
 * operator (owner), and how much of its hired work came from its OWN operator (self-dealing) vs
 * independent clients. Same-operator hiring inflates reputation without real demand. Honest by
 * design: cross-operator collusion is NOT detected here (it needs a funder-graph indexer).
 */
function sybilSignals(agent: PlatformAgent): SybilSignals {
  const owner = agent.owner
  const siblingCount = owner ? state.agents.filter((a) => a.owner === owner && a.id !== agent.id).length : 0
  const hired = state.tasks.filter(
    (t) => t.agentId === agent.id && t.status !== 'open' && t.status !== 'assigned' && t.status !== 'cancelled',
  )
  const jobs = hired.length
  const clients = hired.map((t) => t.client).filter((c): c is string => typeof c === 'string' && c.length > 0)
  const uniqueClients = new Set(clients).size
  const selfDealt = owner ? clients.filter((c) => c === owner).length : 0
  const selfDealRate = jobs ? selfDealt / jobs : 0
  const diversity = jobs ? uniqueClients / jobs : 1
  return { siblingCount, jobs, uniqueClients, selfDealt, selfDealRate, diversity }
}

/**
 * Real guardrail-discipline signals from this agent's own decision trail (Phase 5.1). Every
 * input is recorded, not self-reported: the audit entries come from actual checks.
 *
 * The block rate is deliberately NOT gathered. A high share of refusals is not evidence of a
 * bad agent, and scoring it would punish whoever configured themselves most carefully.
 */
function disciplineSignals(agent: PlatformAgent) {
  const entries = state.audits[agent.id] ?? []
  const { configured } = resolveActionPolicy(agent.actionPolicy, agent.id, agent.createdAt)
  const warns = entries.filter((e) => e.verdict === 'WARN')
  return {
    policyDecisions: entries.length,
    overrideAttempts: entries.reduce((a, e) => a + (e.overrideAttempts ?? 0), 0),
    unverifiableDecisions: entries.filter((e) => e.unverifiable).length,
    warnDecisions: warns.length,
    danglingApprovals: warns.filter((e) => e.outcome === 'awaiting_human' || e.outcome === 'abandoned').length,
    policyConfigured: configured,
  }
}

function repOf(agent: PlatformAgent) {
  const ixs = state.instructions.filter((i) => i.agentId === agent.id)
  const settled = ixs.filter((i) => i.status === 'executed_onchain')
  const rejected = ixs.filter((i) => i.status === 'rejected').length
  const settledUsd = settled.reduce((s, i) => s + i.amountUsd * i.count, 0)
  return computeAgentReputation({
    settledCount: settled.length,
    rejected,
    onchainRegistered: agent.onchain === 'registered',
    createdAt: agent.createdAt,
    settledUsd,
    // B3 recency decay: per-settlement timestamps so recent verified activity outweighs
    // ancient history (see reputation.ts HALF_LIFE_DAYS).
    settledAt: settled.map((i) => i.createdAt),
    ...behavioralSignals(agent),
    ...disciplineSignals(agent),
  })
}

export function agentReputation(agentId: string) {
  const q = agentId.trim()
  // Resolve by platform id, on-chain token id ("#849980" / "849980"), or owner address, so the
  // public get_reputation tool answers the same queries the trust explorer resolves identity with.
  const agent =
    state.agents.find((a) => a.id === q) ??
    state.agents.find((a) => a.onchainAgentId && (a.onchainAgentId === q || `#${a.onchainAgentId}` === q)) ??
    (/^0x[0-9a-fA-F]{40}$/.test(q) ? state.agents.find((a) => a.walletAddress?.toLowerCase() === q.toLowerCase()) : undefined)
  if (!agent) return { error: 'Unknown agent' }
  // A transparent echo of the behavioral inputs so a caller (or an OKX reviewer) sees WHY the
  // behavior band moved the score, not just the number. Every field is real, from state.tasks.
  const b = behavioralSignals(agent)
  const terminalHired = b.completedTasks + b.disputedTasks
  const behavioral = {
    completedJobs: b.completedTasks,
    contestedJobs: b.disputedTasks,
    disputeRate: terminalHired > 0 ? Math.round((b.disputedTasks / terminalHired) * 100) / 100 : 0,
    avgRating: b.avgRating != null ? Math.round(b.avgRating * 100) / 100 : null,
    ratedJobs: b.ratedCount,
  }
  // A transparent Sybil echo (level + the real signals behind it) so risk_check's DENY/WARN is
  // explainable — every field is computed from state.agents + state.tasks, no fabrication.
  const sig = sybilSignals(agent)
  const sybil = {
    level: classifySybil(sig),
    siblingCount: sig.siblingCount,
    jobs: sig.jobs,
    selfDealt: sig.selfDealt,
    selfDealRate: Math.round(sig.selfDealRate * 100) / 100,
    diversity: Math.round(sig.diversity * 100) / 100,
  }
  // A transparent echo of the guardrail-discipline inputs, so the discipline band is
  // explainable the same way behavior and Sybil are. The block rate is reported for context
  // but is NOT scored: a tight policy doing its job is indistinguishable from an agent
  // pushing at its limits, and penalizing it would punish the most careful users.
  const dsc = disciplineSignals(agent)
  const entries = state.audits[agent.id] ?? []
  const discipline = {
    decisions: dsc.policyDecisions,
    policyConfigured: dsc.policyConfigured,
    overrideAttempts: dsc.overrideAttempts,
    unverifiableDecisions: dsc.unverifiableDecisions,
    approvalsAwaited: dsc.warnDecisions,
    approvalsUnclosed: dsc.danglingApprovals,
    blockRate:
      dsc.policyDecisions > 0
        ? Math.round((entries.filter((e) => e.verdict === 'DENY').length / dsc.policyDecisions) * 100) / 100
        : 0,
    blockRateScored: false,
    excludesPnl: true,
  }
  // A1: the latest ERC-8004 on-chain attestation of this score (null until one is published),
  // so the public explorer / get_reputation can link the on-chain anchor, not just the number.
  const onchainAttestation = getReputationAttestation(agent.onchainAgentId ?? null)
  return { agentId: agent.id, name: agent.name, onchain: agent.onchain, kya: agent.kya, ...repOf(agent), behavioral, sybil, discipline, onchainAttestation, computedAt: new Date().toISOString() }
}

// ── instructions ──────────────────────────────────────────────────────────────

/** AgentSpendPolicy error names that are authoritative policy rejections (vs an
 *  infra error, which we fall back on rather than treat as a "no"). */
const VAULT_POLICY_ERRORS = new Set([
  'IsFrozen', 'SessionKeyExpired', 'PayeeNotAllowed', 'AboveAutoApprove', 'DailyCapExceeded', 'ZeroAddress', 'TransferFailed',
])

export function createInstruction(input: {
  agentId: string
  type: InstructionType
  amountUsd: number
  count?: number
  payee: string
  memo?: string
  caller?: string
}): Instruction | { error: string } {
  const agent = state.agents.find((a) => a.id === input.agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, input.caller)) return { error: 'Forbidden: not the agent owner' }
  // Defense in depth (the HTTP layer validates too): a non-finite/negative amount must never
  // reach the daily-cap math, where a negative would subtract from today's spend.
  if (!Number.isFinite(input.amountUsd) || input.amountUsd < 0) return { error: 'amountUsd must be a non-negative number' }

  const count = Math.min(1000, Math.max(1, Math.floor(input.count ?? 1)))
  const total = input.amountUsd * count
  const p = agent.permissions

  // Policy checks, in the order a bank would run them.
  let status: Instruction['status']
  let policyNote: string

  const payeeAllowed = p.payeeAllowlist.length === 0 || p.payeeAllowlist.includes(input.payee)
  const spentToday = dailySpent(agent)
  // A 0x… payee is a human wallet; anything else (agent://<id> or a bare agent id/name)
  // is another agent. The two toggles gate which of those the agent may pay on its own.
  // Undefined-safe: only an explicit `false` blocks, so older agents stay permissive.
  const isHumanPayee = /^0x[0-9a-fA-F]{40}$/.test(input.payee)
  const payeeTypeAllowed = isHumanPayee ? p.agentToHuman !== false : p.agentToAgent !== false

  if (p.frozen) {
    status = 'pending_approval'
    policyNote = 'Agent is frozen; all activity is paused. A human must unfreeze or approve.'
  } else if (!payeeTypeAllowed) {
    status = 'pending_approval'
    policyNote = isHumanPayee
      ? 'Agent-to-human payments are turned off for this agent; a human must approve.'
      : 'Agent-to-agent payments are turned off for this agent; a human must approve.'
  } else if (!payeeAllowed) {
    status = 'pending_approval'
    policyNote = `Payee not on the allowlist; a human must approve.`
  } else if (spentToday + total > p.dailyCapUsd) {
    status = 'pending_approval'
    policyNote = `Would exceed today's cap ($${spentToday.toFixed(2)} spent + $${total.toFixed(2)} > $${p.dailyCapUsd}); a human must approve.`
  } else if (total <= p.autoApproveUnderUsd) {
    status = 'auto_approved'
    policyNote = `Under the $${p.autoApproveUnderUsd} auto-approve line.`
  } else {
    status = 'pending_approval'
    policyNote = `Above the auto-approve line ($${p.autoApproveUnderUsd}); waiting for a human.`
  }

  // Auto-approved payments commit against today's cap immediately.
  if (status === 'auto_approved') addSpend(agent, total)

  const instruction: Instruction = {
    id: id('ix'),
    agentId: agent.id,
    type: input.type,
    amountUsd: input.amountUsd,
    count,
    payee: input.payee,
    memo: input.memo ?? '',
    status,
    policyNote,
    createdAt: new Date().toISOString(),
  }

  state.instructions.push(instruction)
  pushActivity(
    agent,
    `${cap(input.type)} instruction for $${total.toFixed(2)} (${count}x): ${status.replace('_', ' ')}`,
  )
  save(state)
  return instruction
}

/**
 * Reject a pending instruction.
 *
 * This is the cancel half of "edit a payment before approving it". Editing does not mutate
 * the original: the console rejects it and creates a replacement, so no record is ever
 * rewritten after the fact and the audit trail keeps both the thing that was proposed and
 * the thing that was actually authorised.
 *
 * Only `pending_approval` can be rejected, which is also why nothing has to be unwound
 * here: a pending instruction has never committed against the daily cap. Auto-approved and
 * approved instructions have, so they are deliberately not rejectable through this path.
 */
export function rejectInstruction(ixId: string, caller?: string, reason?: string): Instruction | { error: string } {
  const ix = state.instructions.find((i) => i.id === ixId)
  if (!ix) return { error: 'Unknown instruction' }
  const ag = state.agents.find((a) => a.id === ix.agentId)
  if (ag && !ownsAgent(ag, caller)) return { error: 'Forbidden: not the agent owner' }
  if (ix.status !== 'pending_approval') return { error: `Cannot reject from status ${ix.status}` }
  ix.status = 'rejected'
  ix.policyNote = reason?.trim() ? reason.trim().slice(0, 200) : 'Rejected by a human.'
  if (ag) pushActivity(ag, `Instruction ${ix.id} rejected by a human`)
  save(state)
  return ix
}

export function approveInstruction(ixId: string, caller?: string): Instruction | { error: string } {
  const ix = state.instructions.find((i) => i.id === ixId)
  if (!ix) return { error: 'Unknown instruction' }
  const ag = state.agents.find((a) => a.id === ix.agentId)
  if (ag && !ownsAgent(ag, caller)) return { error: 'Forbidden: not the agent owner' }
  if (ix.status !== 'pending_approval') return { error: `Cannot approve from status ${ix.status}` }
  ix.status = 'approved'
  ix.policyNote = 'Approved by a human.'
  const agent = state.agents.find((a) => a.id === ix.agentId)
  if (agent) {
    addSpend(agent, ix.amountUsd * ix.count)
    pushActivity(agent, `Instruction ${ix.id} approved by a human`)
  }
  save(state)
  return ix
}

/**
 * Resolve an instruction payee to a real Arc address to settle to, or null.
 *  - a 0x… address → itself
 *  - `agent://<idOrName>` (or a bare agent id/name) → THAT agent's wallet address,
 *    so agent-to-agent payments settle on-chain instead of falling back to simulated.
 */
function resolvePayeeAddress(payee: string): string | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(payee)) return payee
  const key = payee.replace(/^agent:\/\//i, '').trim()
  if (!key) return null
  const target = state.agents.find((a) => a.id === key || a.name.toLowerCase() === key.toLowerCase())
  return target?.walletAddress && /^0x[0-9a-fA-F]{40}$/.test(target.walletAddress) ? target.walletAddress : null
}

/**
 * Execute an approved or auto-approved instruction. When the agent has an
 * on-chain policy vault, address payments settle THROUGH it — the vault enforces
 * the daily cap / auto-approve ceiling / freeze on Arc, so a disallowed payment
 * reverts on-chain (the source of truth). The server engine stays the pre-check;
 * if the vault path hits an infra error (not a policy revert) we fall back to
 * direct settlement so a chain hiccup never blocks the flow. Without a signer
 * key, execution is SIMULATED and labeled as such; the trail stays honest.
 */
/** Instruction ids currently mid-execution, so a concurrent double-execute of the same
 *  instruction can't both settle (see the TOCTOU guard below). Process-local by design:
 *  it only serializes overlapping requests within this single server process. */
const executingIx = new Set<string>()

export async function executeInstruction(ixId: string, caller?: string): Promise<Instruction | { error: string }> {
  const ix = state.instructions.find((i) => i.id === ixId)
  if (!ix) return { error: 'Unknown instruction' }
  if (ix.status !== 'approved' && ix.status !== 'auto_approved')
    return { error: `Cannot execute from status ${ix.status}` }
  const agent = state.agents.find((a) => a.id === ix.agentId)
  if (agent && !ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  // TOCTOU guard: the status flip to executed_* happens only AFTER the awaited on-chain
  // settle, so two overlapping executes of the same id could both pay. Claim the id
  // synchronously (check-and-add is atomic in single-threaded JS) and hold it across the
  // awaits; the finally at the end releases it.
  if (executingIx.has(ixId)) return { error: 'This instruction is already being executed' }
  executingIx.add(ixId)
  try {
  const total = ix.amountUsd * ix.count
  const fmt = (n: number) => (n < 0.01 ? n.toFixed(4) : n.toFixed(2))
  // Where this actually settles on-chain: a 0x… payee, or an agent:// payee
  // resolved to that agent's wallet. null → nothing to send to → simulated.
  const settleTo = resolvePayeeAddress(ix.payee)

  // On-chain policy vault: the chain enforces the policy. Agent-initiated
  // (auto-approved) payments go through pay(); human-approved ones through
  // ownerPay() (override). A policy revert is an authoritative rejection; an
  // infra error falls through to direct settlement below.
  // A human override uses the owner-only ownerPay(), which the SERVER can only sign
  // when the vault owner is the server signer (== operator). When owner is the human's
  // own wallet (the intended separation), the server can't sign as owner, so a human
  // override can't settle through the vault here — it falls through to direct settlement
  // below (an owner-signed ownerPay would come from the human's wallet client-side).
  const serverCanOwnerPay =
    !agent?.vaultOwner || !agent?.vaultOperator || agent.vaultOwner.toLowerCase() === agent.vaultOperator.toLowerCase()
  if (settleTo && agent?.vaultAddress && !(ix.status === 'approved' && !serverCanOwnerPay)) {
    const humanApproved = ix.status === 'approved'
    const res = humanApproved
      ? await policyOwnerPay(agent.vaultAddress, settleTo, total)
      : await policyPay(agent.vaultAddress, settleTo, total)
    if (res.executed) {
      ix.status = 'executed_onchain'
      ix.txHash = res.txHash
      ix.explorerUrl = res.explorerUrl
      ix.enforcedBy = 'onchain-vault'
      ix.policyNote = `Settled ${fmt(total)} USDC through the on-chain policy vault (${humanApproved ? 'human override' : 'agent, within policy'}).`
      pushActivity(agent, `On-chain vault settled ${fmt(total)} USDC to ${short(settleTo)} (tx ${short(res.txHash)})`)
      save(state)
      return ix
    }
    if (res.reverted && VAULT_POLICY_ERRORS.has(res.reason)) {
      ix.status = 'pending_approval'
      ix.enforcedBy = 'onchain-vault'
      ix.policyNote = `On-chain policy vault rejected this (${res.reason}); a human must intervene.`
      pushActivity(agent, `On-chain vault rejected ${fmt(total)} USDC to ${short(settleTo)}: ${res.reason}`)
      save(state)
      return ix
    }
    // Not a policy revert (no key / infra error) — fall through to direct settlement.
  }

  // Circle Agent Wallet: the agent's USDC lives in a Circle-managed wallet whose
  // hosted policy engine screens every transfer at the wallet layer (sanctions /
  // allow-block / freeze). A screening DENY is an authoritative rejection (like a
  // vault revert); no creds / infra / timeout falls through to direct settlement.
  // Vault-first by design: an agent with a vault settles there; this runs when the
  // agent has a Circle wallet (and, as a resilience bonus, if the vault infra-failed).
  if (settleTo && agent?.circleWalletId) {
    const res = await circlePay(agent.circleWalletId, settleTo, total)
    if (res.executed) {
      ix.status = 'executed_onchain'
      ix.txHash = res.txHash
      ix.explorerUrl = res.explorerUrl
      ix.enforcedBy = 'circle-agent-stack'
      ix.policyNote = `Settled ${fmt(total)} USDC through the Circle Agent Wallet (hosted policy screened + approved).`
      pushActivity(agent, `Circle Agent Wallet settled ${fmt(total)} USDC to ${short(settleTo)} (tx ${short(res.txHash)})`)
      save(state)
      return ix
    }
    if (res.rejected) {
      ix.status = 'pending_approval'
      ix.enforcedBy = 'circle-agent-stack'
      ix.policyNote = `Circle's hosted policy rejected this (${res.reason}); a human must intervene.`
      pushActivity(agent, `Circle Agent Wallet rejected ${fmt(total)} USDC to ${short(settleTo)}: ${res.reason}`)
      save(state)
      return ix
    }
    // Not a policy rejection (no creds / infra) — fall through to direct settlement.
  }

  // Direct settlement when we have a resolved Arc address and a signer is configured.
  // The server signer is an EOA, so this path (unlike the vault, a smart contract) can
  // route the transfer through Arc's `Memo` precompile — attaching an on-chain,
  // indexable audit trail of WHY the agent paid. On a chain without a Memo precompile,
  // payUsdcWithMemoOnchain degrades cleanly to a bare transfer.
  if (settleTo) {
    const res = await payUsdcWithMemoOnchain(settleTo, total, {
      agentId: ix.agentId,
      instructionId: ix.id,
      service: ix.type,
      policyDecision: ix.status,
    })
    if (res.executed) {
      ix.status = 'executed_onchain'
      ix.txHash = res.txHash
      ix.explorerUrl = res.explorerUrl
      ix.enforcedBy = 'server'
      ix.memoId = res.memoId
      ix.memoReason = res.memo
      ix.policyNote = res.memoId
        ? `Settled ${fmt(total)} USDC on Arc with an on-chain Memo audit trail (why: ${ix.type}, ${short(res.memoId)}).`
        : `Settled ${fmt(total)} USDC on Arc.`
      if (agent) pushActivity(agent, `Settled ${total.toFixed(4)} USDC on Arc to ${short(settleTo)} (tx ${short(res.txHash)})${res.memoId ? ` · memo ${short(res.memoId)}` : ''}`)
      save(state)
      return ix
    }
    // The settlement was BROADCAST but reverted on-chain (e.g. insufficient balance) — never
    // mark it executed. Kick it back to the human, exactly like an on-chain policy rejection.
    if ('reverted' in res && res.reverted) {
      ix.status = 'pending_approval'
      ix.enforcedBy = 'server'
      ix.policyNote = `On-chain settlement reverted (${res.reason}); a human must intervene.`
      if (agent) pushActivity(agent, `Settlement reverted on Arc to ${short(settleTo)}: ${res.reason}`)
      save(state)
      return ix
    }
    ix.policyNote = 'No signer configured; settlement simulated.'
  }

  ix.status = 'executed_simulated'
  if (!settleTo) ix.policyNote = 'Executed as a testnet simulation (payee has no Arc address to settle to).'
  if (agent) pushActivity(agent, `Executed (simulated) ${ix.type} of $${total.toFixed(2)}`)
  save(state)
  return ix
  } finally {
    executingIx.delete(ixId)
  }
}

export function listInstructions(agentId?: string): Instruction[] {
  return agentId ? state.instructions.filter((i) => i.agentId === agentId) : state.instructions
}

/** Instructions across every agent the caller owns (for the unscoped list read). */
export function listInstructionsForOwner(caller?: string): Instruction[] {
  if (!caller) return []
  const mine = new Set(state.agents.filter((a) => a.owner === caller).map((a) => a.id))
  return state.instructions.filter((i) => mine.has(i.agentId))
}

/** Read-access decision for an agent-scoped GET: only the owner may read its private
 *  config (policy, vault, treasury, Circle wallet, payment history). Public reads
 *  (identity resolve, reputation, marketplace) do NOT go through this. */
export function agentAccess(agentId: string, caller?: string): 'ok' | 'unknown' | 'forbidden' {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return 'unknown'
  return ownsAgent(agent, caller) ? 'ok' : 'forbidden'
}

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
 *  KYA before it could act"), so the showcase can't contradict it. Nothing is deleted —
 *  unverified / thin-description rows stay reachable via `includeAll` (the "Show all
 *  (including pending)" toggle / ?all=1). */
function isShowcase(a: PlatformAgent): boolean {
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
export function feedbackSummary(agentId: string): { avg: number | null; count: number } {
  const rows = state.feedback[agentId] ?? []
  if (rows.length === 0) return { avg: null, count: 0 }
  const avg = rows.reduce((t, r) => t + r.score, 0) / rows.length
  return { avg: Math.round(avg * 10) / 10, count: rows.length }
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
  }
  const rows = (state.feedback[agentId] ?? []).filter((r) => r.rater !== rater)
  rows.push(entry)
  state.feedback[agentId] = rows.slice(-FEEDBACK_PER_AGENT)
  a.activity.push({ at: entry.at, text: `Rated ${s}/10 by a verified user` })
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
      kya: a.kya,
      onchain: a.onchain,
      onchainTx: a.onchainTx,
      onchainExplorer: a.onchainExplorer,
      onchainAgentId: a.onchainAgentId,
      // The ERC-8004 registration document itself. Public by design: it restates fields
      // already on this card (name/description/category/capabilities/chain) plus the
      // registration date — no owner, wallet, or policy data ever lands in it.
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
 * Same showcase filter as the feed — an agent that has not passed KYA cannot place.
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
  // signer key) count as executed; withTxHash separates the ones with a real Arc tx.
  const executed = state.instructions.filter(
    (i) => i.status === 'executed_onchain' || i.status === 'executed_simulated',
  )

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
      onchainSettled: state.tasks.filter((t) => t.settlement === 'onchain').length,
    },
    settlements: {
      instructionsExecuted: executed.length,
      instructionsUsd: round2(executed.reduce((s, i) => s + i.amountUsd * i.count, 0)),
      withTxHash: executed.filter((i) => Boolean(i.txHash)).length,
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

// ── marketplace tasks: hire a verified worker, escrow-settled on release ───────────
//
// A client hires a KYA-verified agent for a service; the task runs off-chain through its
// lifecycle (funded -> delivered -> released | refunded) and SETTLES on-chain via the existing
// ERC-8183 escrow (runEscrowJobDemo) at release/dispute. Honest by design: 'onchain' settlement
// carries a real tx only with a signer key; without one it settles 'simulated' (no fake tx).
// In this build the platform signer drives the ERC-8183 escrow roles (create/fund/submit/
// complete); worker-signed, multi-party settlement is the roadmap. The escrow lifecycle IS real
// on Arc, so every task carries a real jobId + tx.

/** Testnet signer safety: the shared server key funds the escrow, so cap a task's on-chain
 *  settlement (mirrors MAX_DEMO_USD on the HTTP demo endpoints). */
const MARKETPLACE_MAX_TASK_USD = 5

function transitionTask(task: Task, to: TaskStatus): boolean {
  if (!canTransition(task.status, to)) return false
  task.status = to
  task.updatedAt = new Date().toISOString()
  return true
}

/**
 * Best-effort: lock a task's escrow ON-CHAIN at hire via the granular ERC-8183 flow (createJob
 * -> setBudget -> approve -> fund). On success the task carries a real jobId + fund tx (funds
 * genuinely held in the contract, verifiable on arcscan). ANY failure (no key, RPC, revert)
 * leaves the task off-chain funded so a hire never breaks. This is the "funds lock on-chain at
 * hire" path; the platform signer is the escrow party in this build (per-party wallet signing is
 * the remaining roadmap piece). Release completes it via completeEscrowOnchain.
 */
async function tryOnchainFund(task: Task, agent?: PlatformAgent): Promise<void> {
  try {
    const esc = await fundEscrowOnchain({ budgetUsd: task.priceUsd, description: `A-Identity marketplace task ${task.id}: ${task.service}` })
    if (esc.executed) {
      task.jobId = esc.jobId
      const fund = esc.steps.find((s) => s.step === 'fund') ?? esc.steps[esc.steps.length - 1]
      task.escrowTx = fund?.txHash
      task.escrowExplorer = fund?.explorerUrl
      if (agent) pushActivity(agent, `Escrow locked on-chain at hire (ERC-8183 job ${esc.jobId}, tx ${short(task.escrowTx ?? '')})`)
    }
  } catch {
    /* off-chain funded fallback — never blocks the hire */
  }
}

/**
 * Hire a verified worker agent. Trusted-marketplace rule: only a KYA-verified agent can be
 * hired. Creates a task in 'funded' (the client commits; the ERC-8183 escrow settles on
 * release). The price is clamped to the testnet settlement cap so the shared signer is safe.
 */
export async function hireAgent(input: {
  agentId: string
  service: string
  priceUsd: number
  description?: string
  deadlineHours?: number
  client?: string
}): Promise<Task | { error: string }> {
  if (!input.client) return { error: 'Forbidden: sign in with a verified session to hire' }
  const agent = state.agents.find((a) => a.id === input.agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (agent.kya !== 'verified') return { error: 'Only KYA-verified agents can be hired (the trusted-marketplace rule)' }
  const service = String(input.service ?? '').slice(0, 200).trim()
  if (!service) return { error: 'service required' }
  // The service must be one the agent actually offers (when it lists any).
  if (agent.services.length > 0 && !agent.services.some((s) => s.name === service)) {
    return { error: `Agent does not offer service "${service}"` }
  }
  const priceUsd = Math.min(normalizePriceUsd(input.priceUsd), MARKETPLACE_MAX_TASK_USD)
  if (priceUsd <= 0) return { error: 'priceUsd must be a positive number' }
  const now = new Date().toISOString()
  const task: Task = {
    id: id('task'),
    client: input.client,
    agentId: agent.id,
    service,
    priceUsd,
    description: String(input.description ?? '').slice(0, 2000),
    status: 'funded',
    createdAt: now,
    updatedAt: now,
    deadlineAt: deadlineFrom(now, normalizeDeadlineHours(input.deadlineHours)),
  }
  state.tasks.push(task)
  // Best-effort: lock the escrow on-chain at hire (real ERC-8183 fund). Falls back to
  // off-chain funded on any failure, so a hire never breaks.
  await tryOnchainFund(task, agent)
  pushActivity(
    agent,
    task.jobId
      ? `Hired for "${service}" ($${priceUsd.toFixed(2)}); escrow locked on-chain (task ${task.id})`
      : `Hired for "${service}" ($${priceUsd.toFixed(2)}); escrow committed (task ${task.id})`,
  )
  save(state)
  return task
}

/**
 * Post an OPEN task without choosing a worker: verified agents bid, the client picks one. The
 * budget caps what any bid may charge. Client-only (any verified session).
 */
export function postOpenTask(input: {
  service: string
  budgetUsd: number
  description?: string
  deadlineHours?: number
  client?: string
}): Task | { error: string } {
  if (!input.client) return { error: 'Forbidden: sign in with a verified session to post a task' }
  const service = String(input.service ?? '').slice(0, 200).trim()
  if (!service) return { error: 'service required' }
  const budget = Math.min(normalizePriceUsd(input.budgetUsd), MARKETPLACE_MAX_TASK_USD)
  if (budget <= 0) return { error: 'budgetUsd must be a positive number' }
  const now = new Date().toISOString()
  const task: Task = {
    id: id('task'),
    client: input.client,
    agentId: '',
    service,
    priceUsd: budget,
    description: String(input.description ?? '').slice(0, 2000),
    status: 'open',
    bids: [],
    createdAt: now,
    updatedAt: now,
    deadlineAt: deadlineFrom(now, normalizeDeadlineHours(input.deadlineHours)),
  }
  state.tasks.push(task)
  save(state)
  return task
}

/** A verified agent bids on an open task (bid ≤ the task budget). Bidder = the agent owner. */
export function bidOnTask(taskId: string, input: { agentId: string; priceUsd: number }, caller?: string): Task | { error: string } {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return { error: 'Unknown task' }
  if (task.status !== 'open') return { error: `Cannot bid on a task in status ${task.status}` }
  const agent = state.agents.find((a) => a.id === input.agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  if (agent.kya !== 'verified') return { error: 'Only KYA-verified agents can bid' }
  if (agent.services.length > 0 && !agent.services.some((s) => s.name === task.service)) {
    return { error: `Agent does not offer service "${task.service}"` }
  }
  const priceUsd = Math.min(normalizePriceUsd(input.priceUsd), task.priceUsd)
  if (priceUsd <= 0) return { error: 'bid priceUsd must be positive and no greater than the budget' }
  const bid: Bid = { agentId: agent.id, agentName: agent.name, priceUsd, at: new Date().toISOString() }
  task.bids = (task.bids ?? []).filter((b) => b.agentId !== agent.id)
  task.bids.push(bid)
  task.updatedAt = bid.at
  pushActivity(agent, `Bid $${priceUsd.toFixed(2)} on open task ${task.id}`)
  save(state)
  return task
}

/** The client accepts a bid: the task is assigned to that agent and its escrow is committed. */
export async function acceptBid(taskId: string, agentId: string, caller?: string): Promise<Task | { error: string }> {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return { error: 'Unknown task' }
  if (task.client !== caller) return { error: 'Forbidden: only the client who posted can accept a bid' }
  if (task.status !== 'open') return { error: `Task is not open (status ${task.status})` }
  const bid = (task.bids ?? []).find((b) => b.agentId === agentId)
  if (!bid) return { error: 'No such bid on this task' }
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent || agent.kya !== 'verified') return { error: 'The bidding agent is no longer verified' }
  task.agentId = agentId
  task.priceUsd = bid.priceUsd
  transitionTask(task, 'assigned')
  transitionTask(task, 'funded')
  await tryOnchainFund(task, agent) // lock the escrow on-chain on accept (best-effort)
  pushActivity(agent, `Won open task ${task.id} at $${bid.priceUsd.toFixed(2)}; escrow ${task.jobId ? 'locked on-chain' : 'committed'}`)
  save(state)
  return task
}

/** Public list of open tasks awaiting bids (minimal, no client PII). */
export function listOpenTasks() {
  return {
    tasks: state.tasks
      .filter((t) => t.status === 'open')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((t) => ({ id: t.id, service: t.service, budgetUsd: t.priceUsd, description: t.description, bids: (t.bids ?? []).length, createdAt: t.createdAt, deadlineAt: t.deadlineAt })),
  }
}

/** The hired agent's owner delivers a result. funded -> delivered. */
export function deliverTask(taskId: string, deliverable: string, caller?: string): Task | { error: string } {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return { error: 'Unknown task' }
  const agent = state.agents.find((a) => a.id === task.agentId)
  if (!agent || !ownsAgent(agent, caller)) return { error: 'Forbidden: only the hired agent owner can deliver' }
  if (!canTransition(task.status, 'delivered')) return { error: `Cannot deliver from status ${task.status}` }
  task.deliverable = String(deliverable ?? '').slice(0, 5000)
  transitionTask(task, 'delivered')
  pushActivity(agent, `Delivered task ${task.id}`)
  save(state)
  return task
}

/**
 * The client approves and RELEASES the escrow: runs the real ERC-8183 lifecycle
 * (createJob -> fund -> submit -> complete), paying the worker. With a signer key it is a
 * real on-chain settlement (jobId + tx); without one it settles 'simulated' (honest, no
 * fake tx). An optional review is recorded. delivered | funded -> released.
 */
export async function releaseTask(
  taskId: string,
  input: { rating?: number; review?: string } = {},
  caller?: string,
): Promise<Task | { error: string }> {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return { error: 'Unknown task' }
  if (task.client !== caller) return { error: 'Forbidden: only the hiring client can release' }
  if (!canTransition(task.status, 'released')) return { error: `Cannot release from status ${task.status}` }
  const agent = state.agents.find((a) => a.id === task.agentId)

  // Escrow was locked on-chain at hire (has a jobId): complete THAT job on-chain, no new job.
  if (task.jobId) {
    const done = await completeEscrowOnchain(BigInt(task.jobId))
    if (!done.executed) {
      return { error: `On-chain escrow release failed (${done.reason}); the funds remain in escrow — retry, or dispute to refund.` }
    }
    const c = done.steps.find((s) => s.step === 'complete') ?? done.steps[done.steps.length - 1]
    task.releaseTx = c?.txHash
    task.escrowExplorer = c?.explorerUrl
    task.settlement = 'onchain'
    if (input.rating !== undefined || (typeof input.review === 'string' && input.review.trim())) {
      task.review = { by: caller!, rating: sanitizeRating(input.rating ?? 5), text: String(input.review ?? '').slice(0, 1000), at: new Date().toISOString() }
    }
    transitionTask(task, 'released')
    if (agent) pushActivity(agent, `Task ${task.id} released: escrow completed on-chain (job ${task.jobId}, tx ${short(task.releaseTx ?? '')})`)
    save(state)
    return task
  }

  const escrow = await runEscrowJobDemo({
    budgetUsd: task.priceUsd,
    description: `A-Identity marketplace task ${task.id}: ${task.service}`,
    outcome: 'complete',
  })
  if (escrow.executed) {
    // executed:true can still be a partial/failed lifecycle (failedAt set, status 'Reverted'):
    // never mark a task released off a broken settlement. Honesty over optimism.
    if (escrow.failedAt || escrow.status === 'Reverted')
      return { error: `On-chain escrow did not complete (${escrow.failedAt ?? escrow.status}): ${escrow.reason ?? 'reverted'}` }
    const done = escrow.steps.find((s) => s.step === 'complete') ?? escrow.steps[escrow.steps.length - 1]
    task.jobId = escrow.jobId
    task.releaseTx = done?.txHash
    task.escrowExplorer = done?.explorerUrl
    task.settlement = 'onchain'
  } else {
    task.settlement = 'simulated'
  }
  if (input.rating !== undefined || (typeof input.review === 'string' && input.review.trim())) {
    task.review = {
      by: caller!,
      rating: sanitizeRating(input.rating ?? 5),
      text: String(input.review ?? '').slice(0, 1000),
      at: new Date().toISOString(),
    }
  }
  transitionTask(task, 'released')
  if (agent)
    pushActivity(
      agent,
      task.settlement === 'onchain'
        ? `Task ${task.id} released: escrow paid on-chain (ERC-8183 job ${task.jobId ?? '?'}, tx ${short(task.releaseTx ?? '')})`
        : `Task ${task.id} released (simulated settlement; no signer key)`,
    )
  save(state)
  return task
}

/**
 * The client disputes the deliverable: runs the real ERC-8183 refund lifecycle (the escrow
 * is refunded to the client in the same reject tx). Real on-chain with a key, 'simulated'
 * without. funded | delivered -> refunded (buyer protection).
 */
export async function disputeTask(taskId: string, reason: string, caller?: string): Promise<Task | { error: string }> {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return { error: 'Unknown task' }
  if (task.client !== caller) return { error: 'Forbidden: only the hiring client can dispute' }
  if (!canTransition(task.status, 'refunded')) return { error: `Cannot dispute from status ${task.status}` }
  const agent = state.agents.find((a) => a.id === task.agentId)

  // Escrow locked on-chain at hire: reject the job on-chain (refunds the client in the same tx).
  if (task.jobId) {
    const rej = await rejectJobOnchain(BigInt(task.jobId), String(reason ?? '').slice(0, 200))
    if (!rej.executed) {
      return { error: `On-chain dispute failed (${rej.reason}); retry.` }
    }
    task.refundTx = rej.txHash
    task.escrowExplorer = rej.explorerUrl
    task.settlement = 'onchain'
    transitionTask(task, 'refunded')
    if (agent) pushActivity(agent, `Task ${task.id} disputed: escrow refunded on-chain (tx ${short(task.refundTx ?? '')})`)
    save(state)
    return task
  }

  const escrow = await runEscrowJobDemo({
    budgetUsd: task.priceUsd,
    description: `A-Identity marketplace dispute ${task.id}: ${String(reason ?? '').slice(0, 200)}`,
    outcome: 'refund',
  })
  if (escrow.executed) {
    if (escrow.failedAt || escrow.status === 'Reverted')
      return { error: `On-chain refund did not complete (${escrow.failedAt ?? escrow.status}): ${escrow.reason ?? 'reverted'}` }
    const rej = escrow.steps.find((s) => s.step === 'reject') ?? escrow.steps[escrow.steps.length - 1]
    task.jobId = escrow.jobId
    task.refundTx = rej?.txHash
    task.escrowExplorer = rej?.explorerUrl
    task.settlement = 'onchain'
  } else {
    task.settlement = 'simulated'
  }
  transitionTask(task, 'refunded')
  if (agent)
    pushActivity(
      agent,
      task.settlement === 'onchain'
        ? `Task ${task.id} disputed: escrow refunded to client on-chain (tx ${short(task.refundTx ?? '')})`
        : `Task ${task.id} disputed (simulated refund; no signer key)`,
    )
  save(state)
  return task
}

/** Read one task; only a party to it (the client or the hired agent's owner) may read. */
export function getTask(taskId: string, caller?: string): Task | { error: string } {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return { error: 'Unknown task' }
  const agent = state.agents.find((a) => a.id === task.agentId)
  const isParty = task.client === caller || (agent ? ownsAgent(agent, caller) : false)
  if (!isParty) return { error: 'Forbidden: not a party to this task' }
  return task
}

/** Tasks a client has opened (the "my hires" view). */
export function listTasksForClient(caller?: string): Task[] {
  return caller ? state.tasks.filter((t) => t.client === caller) : []
}

/** Tasks assigned to an agent (the worker "my jobs" view). Owner-only. */
export function listTasksForAgent(agentId: string, caller?: string): Task[] | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  return state.tasks.filter((t) => t.agentId === agentId)
}

/**
 * The public service catalog (the card grid): every verified showcase agent's services with
 * an aggregated rating + review count + completed-task count from real tasks. Best-rated first.
 */
export function marketplaceCatalog() {
  const services = state.agents.filter(isShowcase).flatMap((agent) =>
    agent.services.map((svc) => {
      const svcTasks = state.tasks.filter((t) => t.agentId === agent.id && t.service === svc.name)
      const reviews = svcTasks.map((t) => t.review).filter((r): r is Review => !!r)
      const rating = aggregateRating(reviews)
      return {
        agentId: agent.id,
        agentName: agent.name,
        category: agent.category,
        kya: agent.kya,
        onchain: agent.onchain,
        walletAddress: agent.walletAddress,
        service: svc.name,
        priceUsd: svc.priceUsd,
        unit: svc.unit,
        rating: rating.average,
        reviews: rating.count,
        completed: svcTasks.filter((t) => t.status === 'released').length,
      }
    }),
  )
  services.sort((a, b) => b.rating - a.rating || b.reviews - a.reviews || b.completed - a.completed)
  return { services, total: services.length }
}

// ── open ecosystem: per-agent manifest (AMP Discover) + external self-register ─────

/**
 * The public per-agent manifest (AMP Discover): ERC-8004 identity + services + how to hire,
 * with reputation from real activity. This is what an external project or the SDK reads to
 * find and hire an agent. Public read.
 */
export function agentManifest(agentId: string, baseUrl = ''): ReturnType<typeof buildAgentManifest> | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  return buildAgentManifest(
    {
      id: agent.id,
      onchainAgentId: agent.onchainAgentId,
      chainId: agent.chainId,
      name: agent.name,
      description: agent.description,
      category: agent.category,
      capabilities: agent.capabilities,
      walletAddress: agent.walletAddress,
      kya: agent.kya,
      onchain: agent.onchain,
      endpoint: agent.endpoint,
      services: agent.services,
    },
    repOf(agent).score,
    baseUrl,
  )
}

/**
 * The open front door: an external framework's agent self-registers. Creates the agent
 * (owner = the verified caller), records its endpoint + wallet, and hands back the manifest
 * plus a KYA challenge to prove wallet control next (only a KYA-verified agent is hireable).
 * Honest by design: nothing is verified until the wallet signature is proven.
 */
export async function registerExternalAgent(
  input: {
    name?: string
    description?: string
    category?: string
    capabilities?: string[]
    services?: Service[]
    walletAddress?: string
    endpoint?: string
    owner?: string
  },
  baseUrl = '',
): Promise<{ agent: PlatformAgent; manifest: unknown; manifestUrl: string; kya: unknown; circleWallet: unknown } | { error: string }> {
  if (!input.name || !String(input.name).trim()) return { error: 'name required' }
  const agent = createAgent({
    name: input.name,
    description: input.description ?? '',
    category: input.category ?? 'Other',
    capabilities: Array.isArray(input.capabilities) ? input.capabilities : [],
    services: input.services,
    permissions: {},
    walletAddress: input.walletAddress,
    endpoint: input.endpoint,
    owner: input.owner,
  })
  // Best-effort: open a Circle Developer-Controlled (MPC) wallet for the agent at register.
  // Credential-gated (CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET); a clean no-op reason without them,
  // so registration always succeeds. This is the "a wallet opens at register" step.
  let circleWallet: unknown
  try {
    const cw = await provisionCircleWallet(agent.id, { caller: input.owner })
    circleWallet = 'error' in cw ? { provisioned: false, reason: cw.error } : { provisioned: true, ...cw }
  } catch (e) {
    circleWallet = { provisioned: false, reason: e instanceof Error ? e.message : String(e) }
  }

  const manifestUrl = `${baseUrl}/api/v1/agents/manifest?agentId=${agent.id}`
  // The next step to become hireable: prove wallet control (KYA).
  let kya: unknown = { status: 'unverified', nextStep: 'Assign a wallet, then POST /api/agents/kya/challenge to prove control.' }
  if (agent.walletAddress) {
    const ch = startKyaChallenge(agent.id, input.owner)
    kya = 'error' in ch
      ? { status: 'unverified', nextStep: ch.error }
      : { status: 'unverified', challenge: ch, nextStep: 'Sign this message with the agent wallet, then POST /api/agents/kya/verify.' }
  }
  return { agent, manifest: agentManifest(agent.id, baseUrl), manifestUrl, kya, circleWallet }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function pushActivity(agent: PlatformAgent, text: string) {
  agent.activity.push({ at: new Date().toISOString(), text })
  if (agent.activity.length > 50) agent.activity.splice(0, agent.activity.length - 50)
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
