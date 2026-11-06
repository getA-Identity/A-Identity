/**
 * Agent and wallet lifecycle: create/record/assign wallets, agent registration and
 * the on-chain ERC-8004 anchor. Also the profile photo of the PERSON signed in, which
 * lives here for one reason: the image sanitizer and its size bound are in this file, and
 * a second definition of "an acceptable image" is how one surface starts accepting what
 * another refuses.
 * Layering: L4 domain module; imports ./core.js, ./permissions.js and flat ../ modules only.
 */
import {
  state, save, id, ownsAgent, ownsUser, normalizeSubject, pushActivity, short, inFlightAgentOps,
  canRememberProvenAddress, rememberProvenAddress, MAX_FORMER_PROVEN_WALLETS,
  type PlatformAgent, type PlatformUser, type LinkedWallet, type Wallet, type Permissions, type Service,
} from './core.js'
import { sanitizeVelocity } from './permissions.js'
import { agentReputation } from './reputation.js'
import { adverseRecordFrom } from '../asp/risk.js'
import { addressInQuery, recordNamedBy } from '../agent-query.js'
import { ARC_TESTNET } from '../arc.js'
import { registerAgentOnchain } from '../arc-contracts.js'
import { normalizePriceUsd } from '../marketplace.js'

// ── wallets ───────────────────────────────────────────────────────────────────

/** asp/risk.ts's high-value line: under this, evidence on a record denies a payment over 100 USD. */
const EVIDENCE_DENIES_BELOW = 400

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
  const moving = agent.walletAddress?.toLowerCase() !== wallet.address.toLowerCase()
  const hadProof = agent.kya === 'verified' && moving
  // Whatever this record ever proved stays proven when it leaves, revoked or not: see formerProvenWallets.
  const leaving = moving && agent.walletAddress && (hadProof || everProved(agent, agent.walletAddress)) ? agent.walletAddress : null
  if (leaving && !canRememberProvenAddress(agent, leaving)) {
    return { error: `This record has already moved across ${MAX_FORMER_PROVEN_WALLETS} proven wallets, and a proven address is never forgotten, so it cannot move again` }
  }
  wallet.agentId = agentId
  agent.walletAddress = wallet.address
  if (leaving) rememberProvenAddress(agent, leaving)
  if (hadProof) {
    agent.kya = 'unverified'
    delete agent.kyaProof
    delete agent.kyaOnchainTx
    delete agent.kyaOnchainExplorer
    delete agent.kyaRequestHash
    pushActivity(agent, 'KYA reset to unverified: the wallet it proved control of was replaced')
  }
  // The policy attestation is about the old wallet's Circle policy; it goes with it.
  if (agent.circlePolicyAttestation && agent.circlePolicyAttestation.address.toLowerCase() !== wallet.address.toLowerCase()) {
    delete agent.circlePolicyAttestation
    pushActivity(agent, 'Circle policy attestation dropped: it named the wallet that was replaced')
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
    // Says what exists: a platform record. Nothing anchors it by itself; the owner does, from
    // the console, and until then `onchain` stays 'queued'.
    activity: [{ at: new Date().toISOString(), text: `Agent registered on the platform; KYA pending (prove wallet control); not on chain until the owner anchors it on ${ARC_TESTNET.name}` }],
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

type AddressFacts = Pick<PlatformAgent, 'walletAddress' | 'kya' | 'kyaProof' | 'claimProof' | 'formerProvenWallets'>

const sameAddress = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

/** Did this record ever prove control of this address? A proof names its address, so it covers that one and no other. */
function everProved(a: AddressFacts, address: string): boolean {
  return sameAddress(a.kyaProof?.address, address) || sameAddress(a.claimProof?.address, address) || (a.formerProvenWallets ?? []).some((w) => sameAddress(w, address))
}

/**
 * Has this record proved control of the wallet it names? A walletAddress is a free text claim at
 * registration, so anyone can name anyone's wallet. `verified` always means the current wallet:
 * assignWallet resets it when the wallet changes, and a claim writes the wallet it proved.
 *
 * `revoked` counts only at an address the record proved, because assignWallet keeps a revoked
 * record's status and its old proof when the wallet changes. Counting any proof at all would let
 * someone prove their own wallet, revoke the record, assign a vendor's wallet and force DENY on
 * the vendor. This gives up nothing: a revoked operator who wants to dodge DENY can use any fresh
 * address anyway, so DENY on an address it merely named adds no safety. The limit, stated rather
 * than implied: a revoked record binds the addresses it proved, every one of them, and no other.
 */
export function walletControlProven(a: AddressFacts): boolean {
  if (!a.walletAddress) return false
  return a.kya === 'verified' || (a.kya === 'revoked' && everProved(a, a.walletAddress))
}

/** Is this address the wallet this record has control of proven for right now? */
const provenNow = (a: AddressFacts, address: string): boolean => sameAddress(a.walletAddress, address) && walletControlProven(a)

/**
 * An address this record proved control of and has no current proof for. Usually one it moved off,
 * and also one it moved back to and has not proved again: assigning wallet B and then wallet A takes
 * two unsigned calls, and if A stopped being proved by coming back, those two calls would clear a
 * DENY at A. Being its wallet again does not undo what it proved there.
 */
export function formerlyProvenAddress(a: AddressFacts, address: string): boolean {
  return !provenNow(a, address) && everProved(a, address)
}

/** Has this record proved control of this address, now or before? */
export function recordProvesAddress(a: AddressFacts, address: string): boolean {
  return provenNow(a, address) || everProved(a, address)
}

/**
 * Which platform record speaks for a payee ADDRESS, the one reading a trust verdict gives it.
 *
 *   - record: the record that proved control of this address. A revoked one comes first and one
 *     holding evidence next, so a clean twin registered later cannot shadow it: an agent with
 *     evidence gets its DENY at every address it proved, whichever record there is the newest.
 *     currentWallet says whether it is still its wallet.
 *   - claim: a record that names this address without proof. It is not this payee's record,
 *     because a free registration can name a real vendor's wallet, and counting it would let a
 *     stranger turn that vendor's WARN into a DENY. It is returned so the reasons can say so.
 *
 * Deliberately not read: state.wallets[].agentId and importedFrom.owner (anyone can write them,
 * by recording a wallet or importing a token), and an account's linked wallets (proven, but an
 * account holds many agents, so a record against one is not evidence about that wallet).
 */
export function recordAtAddress<T extends AddressFacts>(agents: T[], address: string, holdsEvidence: (a: T) => boolean = () => false): { record: T | null; currentWallet: boolean; claim: T | null } {
  const atWallet = agents.filter((a) => sameAddress(a.walletAddress, address))
  const proven = atWallet.filter(walletControlProven)
  const former = agents.filter((a) => formerlyProvenAddress(a, address))
  const eligible = [...proven, ...former]
  const record = eligible.find((a) => a.kya === 'revoked') ?? eligible.find(holdsEvidence) ?? proven[0] ?? former[0] ?? null
  return { record, currentWallet: record !== null && proven.includes(record), claim: record ? null : (atWallet[0] ?? null) }
}

/**
 * Whether this record's own reputation answer can force a DENY at some amount: Sybil high, or
 * evidence on the record with a score under the 400 line. This is what recordAtAddress is told, so
 * that picking between two records at one address picks the one risk_check has to answer for.
 */
export function recordHoldsEvidence(a: Pick<PlatformAgent, 'id'>): boolean {
  const r = agentReputation(a.id)
  if ('error' in r) return false
  return r.sybil.level === 'high' || (adverseRecordFrom(r) === true && r.score < EVIDENCE_DENIES_BELOW)
}

/**
 * The reputation a free read answers for a query, the same reading risk_check gives it. An address,
 * in any of its forms, speaks for the record that proved it and no other, so a registration that names
 * a vendor's wallet is no answer about that wallet, revoked or not. A record that has moved off the
 * address can count against it, and does not vouch for it: KYA attests the wallet it uses now. A token
 * speaks for the record anchored at it, on the chain it names (see agent-query.ts).
 *
 * provenWallet is the wallet the record has control of proven for right now, or null. It is how a
 * reader finds the on-chain identity of a record with no token anchored: a wallet a record merely
 * names is not offered, because a free registration could name anyone's and borrow their identity.
 */
export function reputationForQuery(query: string) {
  const q = query.trim()
  const address = addressInQuery(q)
  const at = address ? recordAtAddress(state.agents, address, recordHoldsEvidence) : null
  const record = address ? at?.record : recordNamedBy(state.agents, q)
  if (!record) return { error: 'Unknown agent' as const }
  const view = agentReputation(record.id)
  if ('error' in view) return { error: 'Unknown agent' as const }
  const provenWallet = record.walletAddress && provenNow(record, record.walletAddress) ? record.walletAddress : null
  const kya = at && !at.currentWallet && view.kya === 'verified' ? ('unverified' as const) : view.kya
  return { ...view, kya, provenWallet }
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

// ── users (the PERSON signed in, not the agents they own) ─────────────────────

/**
 * A row with nothing in it is not worth persisting: it would be a key and two timestamps
 * inside a document that is serialized in full on every save. Grows as PlatformUser grows.
 */
function userIsEmpty(u: PlatformUser): boolean {
  return u.avatarUrl === undefined && (u.wallets === undefined || u.wallets.length === 0)
}

/** The wallets a person has linked to their account by signature; [] when none. Caller-scoped. */
export function getUserWallets(subject: string | undefined): LinkedWallet[] {
  const key = normalizeSubject(subject)
  return key ? [...(state.users[key]?.wallets ?? [])] : []
}

/**
 * Link a wallet the caller has just proven control of (the route verified the signature
 * before calling this; this function trusts nothing else). One row per address: linking
 * the same address twice updates its timestamp rather than duplicating it. A wallet that
 * is some OTHER account's session subject or linked wallet is refused, because one wallet
 * vouching for two accounts is exactly the ambiguity the link exists to remove.
 */
export function linkUserWallet(
  subject: string | undefined,
  wallet: { ecosystem: LinkedWallet['ecosystem']; address: string; wallet?: string },
  caller?: string,
): { wallets: LinkedWallet[]; linked: 'added' | 'updated'; note: string } | { error: string } {
  const key = normalizeSubject(subject)
  if (!key) return { error: 'Unknown account: no subject was given and the session carried none' }
  if (!ownsUser(key, caller)) return { error: 'Forbidden: you may only link wallets to your own account' }
  const address = wallet.address.trim()
  if (!address) return { error: 'address required' }
  const addrKey = normalizeSubject(address)
  if (addrKey === key) return { error: 'That wallet is already this account: it is the wallet you signed in with' }
  for (const [otherKey, u] of Object.entries(state.users)) {
    if (otherKey === key) continue
    if (otherKey === addrKey || (u.wallets ?? []).some((w) => normalizeSubject(w.address) === addrKey)) {
      return { error: 'Forbidden: that wallet already belongs to another account' }
    }
  }
  const now = new Date().toISOString()
  const row: PlatformUser = state.users[key] ?? { subject: key, createdAt: now, updatedAt: now }
  row.wallets = row.wallets ?? []
  const existing = row.wallets.find((w) => normalizeSubject(w.address) === addrKey)
  let linked: 'added' | 'updated'
  if (existing) {
    existing.linkedAt = now
    if (wallet.wallet) existing.wallet = wallet.wallet.slice(0, 40)
    linked = 'updated'
  } else {
    if (row.wallets.length >= 20) return { error: 'At most 20 linked wallets per account' }
    row.wallets.push({ ecosystem: wallet.ecosystem, address, wallet: wallet.wallet?.slice(0, 40), linkedAt: now, method: 'wallet-signature' })
    linked = 'added'
  }
  row.updatedAt = now
  state.users[key] = row
  save(state)
  return {
    wallets: [...row.wallets],
    linked,
    note: linked === 'added' ? `${wallet.ecosystem} wallet ${short(address)} linked to your account.` : `${short(address)} was already linked; its proof was refreshed.`,
  }
}

/**
 * Every account subject a wallet address vouches for: the account whose session subject IS
 * this address (a wallet sign-in), and every account that linked it by signature. Public
 * lookup by design and safe to be one, because it answers only "which subjects" and never
 * returns a wallet list, a key or anything else about those accounts. Subjects come back
 * normalized, the way `agent.owner` compares.
 */
export function subjectsLinkedToWallet(address: string): string[] {
  const key = normalizeSubject(address)
  if (!key) return []
  const out = new Set<string>()
  for (const [subject, u] of Object.entries(state.users)) {
    if (subject === key || (u.wallets ?? []).some((w) => normalizeSubject(w.address) === key)) out.add(subject)
  }
  // A wallet session that never linked anything has no user row at all, and it is still an
  // account: an agent whose `owner` is this very address is bound to it.
  out.add(key)
  return [...out]
}

/** Remove a linked wallet. Removing one that is not linked is a clean no-op. */
export function unlinkUserWallet(subject: string | undefined, address: string, caller?: string): { wallets: LinkedWallet[]; removed: boolean } | { error: string } {
  const key = normalizeSubject(subject)
  if (!key) return { error: 'Unknown account: no subject was given and the session carried none' }
  if (!ownsUser(key, caller)) return { error: 'Forbidden: you may only unlink wallets from your own account' }
  const row = state.users[key]
  if (!row?.wallets) return { wallets: [], removed: false }
  const addrKey = normalizeSubject(address)
  const before = row.wallets.length
  row.wallets = row.wallets.filter((w) => normalizeSubject(w.address) !== addrKey)
  const removed = row.wallets.length !== before
  if (removed) {
    row.updatedAt = new Date().toISOString()
    if (row.wallets.length === 0) delete row.wallets
    if (userIsEmpty(row)) delete state.users[key]
    save(state)
  }
  return { wallets: [...(row.wallets ?? [])], removed }
}

/**
 * Read one person's own profile row, or null when they have never stored anything.
 *
 * Takes the subject the caller already resolved from their session, so there is no lookup
 * by anyone else's key: a route hands this `callerId` and gets back that person and only
 * that person. Signed out (no subject) is a normal answer, not an error.
 */
export function getUserProfile(subject: string | undefined): PlatformUser | null {
  const key = normalizeSubject(subject)
  return key ? state.users[key] ?? null : null
}

/**
 * Set, replace or remove the profile photo of the person signed in.
 *
 * Deliberately the same shape as `updateAgentLogo` and deliberately the same sanitizer:
 * `sanitizeLogoUrl` and `MAX_LOGO_DATA_URL_CHARS` are the single definition of an
 * acceptable inline image on this platform, and an avatar the agent path accepts and the
 * account path refuses (or the other way round) is drift nobody notices until a user
 * reports it. That shared bound is also what keeps a photo from ballooning the persisted
 * state document.
 *
 * Ownership is `ownsUser`, the user-scoped twin of the `ownsAgent` gate every agent-scoped
 * mutation enforces: a caller may only ever write their OWN row, and there is no admin
 * path that says otherwise. The HTTP surface additionally sits behind the verified-session
 * gate in http.ts, so a guest token cannot reach this at all.
 *
 * `null` is the remove signal and, exactly as on the agent path, is distinct from "no
 * field sent": the caller has to say it wants the photo gone. Removing a photo nobody set
 * is a clean no-op rather than an error, so a double-click cannot fail. A removal that
 * empties the row deletes it outright rather than leaving a husk behind.
 */
export function updateUserAvatar(
  subject: string | undefined,
  avatarUrl: string | null,
  caller?: string,
):
  | { user: { subject: string; avatarUrl?: string }; avatar: 'set' | 'removed' | 'unchanged'; note: string }
  | { error: string } {
  const key = normalizeSubject(subject)
  if (!key) return { error: 'Unknown account: no subject was given and the session carried none' }
  if (!ownsUser(key, caller)) return { error: 'Forbidden: you may only change your own profile photo' }

  const existing = state.users[key]
  const now = new Date().toISOString()

  if (avatarUrl === null) {
    if (!existing?.avatarUrl) {
      return { user: { subject: key }, avatar: 'unchanged', note: 'You had no profile photo; nothing to remove.' }
    }
    delete existing.avatarUrl
    existing.updatedAt = now
    if (userIsEmpty(existing)) delete state.users[key]
    save(state)
    return { user: { subject: key }, avatar: 'removed', note: 'Profile photo removed. Your initials are shown instead.' }
  }

  const clean = sanitizeLogoUrl(avatarUrl)
  if (!clean) {
    return {
      error: `avatarUrl must be an inline data:image/... URL of at most ${MAX_LOGO_DATA_URL_CHARS} characters, or null to remove it`,
    }
  }
  const replaced = Boolean(existing?.avatarUrl)
  const row: PlatformUser = existing ?? { subject: key, createdAt: now, updatedAt: now }
  row.avatarUrl = clean
  row.updatedAt = now
  state.users[key] = row
  save(state)
  return {
    user: { subject: key, avatarUrl: clean },
    avatar: 'set',
    note: replaced ? 'Profile photo replaced.' : 'Profile photo set.',
  }
}
