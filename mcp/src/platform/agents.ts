/**
 * Agent and wallet lifecycle: create/record/assign wallets, agent registration and
 * the on-chain ERC-8004 anchor.
 * Layering: L4 domain module; imports ./core.js, ./permissions.js and flat ../ modules only.
 */
import {
  state, save, id, ownsAgent, pushActivity, short, inFlightAgentOps,
  type PlatformAgent, type Wallet, type Permissions, type Service,
} from './core.js'
import { sanitizeVelocity } from './permissions.js'
import { ARC_TESTNET } from '../arc.js'
import { registerAgentOnchain } from '../arc-contracts.js'
import { normalizePriceUsd } from '../marketplace.js'

// ── wallets ───────────────────────────────────────────────────────────────────

// There is deliberately no server-side `createWallet` here. It used to generate a keypair
// and return the private key over HTTP; `POST /api/wallets` stopped calling it, but an
// exported function is one call site away from re-opening a custody path the project
// forbids. The keypair is generated in the browser and the server only ever sees the
// address: see `recordWallet` below.

/**
 * Record a wallet whose keypair was generated CLIENT-SIDE. The server only ever
 * sees the public address - the private key never leaves the browser. This is the
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
 * (re)point its wallet address - otherwise any verified caller could overwrite another
 * owner's agent walletAddress and redirect its agent-to-agent settlements. Mirrors the
 * `ownsAgent` gate every other agent-scoped mutation already enforces.
 */
export function assignWallet(address: string, agentId: string, caller?: string): Wallet | { error: string } {
  const wallet = state.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())
  const agent = state.agents.find((a) => a.id === agentId)
  if (!wallet) return { error: 'Unknown wallet' }
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  // KYA proves control of ONE wallet, and this changes which wallet that is. Leaving the
  // flag alone meant an agent verified against wallet A kept reading `kya: 'verified'`
  // after being pointed at wallet B, which nobody had proved anything about. That is not a
  // stale field, it is the product's central claim being false: verify_agent sells exactly
  // this answer, and the KYA proof it cites named the old address.
  //
  // Reset rather than revoked. `revoked` is an incident, written by an owner who is saying
  // something went wrong, and it carries a reason into the ValidationRegistry. Changing
  // wallets is routine, so it drops back to `unverified`: re-sign the challenge with the
  // new key and it verifies again. The old proof goes with it, because a proof about an
  // address this agent no longer uses is worse than no proof.
  const hadProof = agent.kya === 'verified' && agent.walletAddress?.toLowerCase() !== wallet.address.toLowerCase()
  wallet.agentId = agentId
  agent.walletAddress = wallet.address
  if (hadProof) {
    agent.kya = 'unverified'
    delete agent.kyaProof
    delete agent.kyaOnchainTx
    delete agent.kyaOnchainExplorer
    delete agent.kyaRequestHash
    pushActivity(agent, 'KYA reset to unverified: the wallet it proved control of was replaced')
  }
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

/**
 * The one size bound on a stored logo. Only small INLINE images are kept: a data: URL
 * under ~150KB. Anything larger would balloon the single persisted state document, which
 * is serialized in full on every save.
 *
 * Exported because registration is no longer the only writer: the dashboard can set or
 * replace the image after the fact, and two copies of "150_000" in two files is a drift
 * waiting to happen. One constant, one predicate, both paths.
 */
export const MAX_LOGO_DATA_URL_CHARS = 150_000

/** A small inline `data:image/...` URL passes; anything else (remote URL, wrong type,
 *  oversized) means UNSET. Dropped rather than rejected on the registration path, which
 *  is why this returns undefined instead of throwing; the update path turns the same
 *  undefined into a 400 so an owner is never told "saved" about a logo we discarded. */
export function sanitizeLogoUrl(v: unknown): string | undefined {
  return typeof v === 'string' && v.startsWith('data:image/') && v.length <= MAX_LOGO_DATA_URL_CHARS
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
  // D3 velocity is optional and OFF by default; a registration may set it, but only a
  // well-formed config survives (same sanitizer the permissions update path uses).
  const velocity = sanitizeVelocity(input.permissions.velocity)
  const permissions: Permissions = {
    dailyCapUsd: input.permissions.dailyCapUsd ?? 50,
    autoApproveUnderUsd: input.permissions.autoApproveUnderUsd ?? 1,
    payeeAllowlist: input.permissions.payeeAllowlist ?? [],
    agentToAgent: input.permissions.agentToAgent ?? true,
    agentToHuman: input.permissions.agentToHuman ?? false,
    frozen: input.permissions.frozen ?? false,
    ...(velocity ? { velocity } : {}),
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
    // Only small inline images (see sanitizeLogoUrl); anything else is dropped rather
    // than ballooning the single persisted state document.
    logoUrl: sanitizeLogoUrl(input.logoUrl),
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
 * Set, replace or remove an agent's profile image AFTER registration.
 *
 * Owner-only, the same `ownsAgent` gate every other agent-scoped mutation enforces, and
 * the same `sanitizeLogoUrl` bound registration applies, so the two write paths cannot
 * drift apart on what counts as an acceptable image.
 *
 * `null` is the remove signal and is deliberately distinct from "no field sent": the
 * caller has to say it wants the image gone. Removing an image that was never there is a
 * clean no-op rather than an error, so a double-click cannot fail.
 */
export function updateAgentLogo(
  agentId: string,
  logoUrl: string | null,
  caller?: string,
):
  | { agent: { id: string; logoUrl?: string }; logo: 'set' | 'removed' | 'unchanged'; note: string }
  | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }

  if (logoUrl === null) {
    if (!agent.logoUrl) {
      return { agent: { id: agent.id }, logo: 'unchanged', note: 'This agent had no profile image; nothing to remove.' }
    }
    agent.logoUrl = undefined
    pushActivity(agent, 'Profile image removed')
    save(state)
    return { agent: { id: agent.id }, logo: 'removed', note: 'Profile image removed. The agent falls back to the default mark.' }
  }

  const clean = sanitizeLogoUrl(logoUrl)
  if (!clean) {
    return {
      error: `logoUrl must be an inline data:image/... URL of at most ${MAX_LOGO_DATA_URL_CHARS} characters, or null to remove it`,
    }
  }
  const replaced = Boolean(agent.logoUrl)
  agent.logoUrl = clean
  pushActivity(agent, replaced ? 'Profile image replaced' : 'Profile image set')
  save(state)
  return {
    agent: { id: agent.id, logoUrl: clean },
    logo: 'set',
    note: replaced ? 'Profile image replaced.' : 'Profile image set.',
  }
}

/**
 * Anchor an existing platform agent on Arc: broadcast a real ERC-8004 registration
 * (server signer, env-gated behind ARC_SIGNER_KEY) and record the result on the agent.
 * Deliberate + human-triggered from the UI, so it stays human-on-the-loop. Without a
 * signer key it returns the exact prepared call and leaves the agent queued.
 */

export async function anchorAgentOnchain(agentId: string, caller?: string) {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  // Idempotent: an already-anchored agent holds its ERC-8004 id - never register a duplicate.
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
