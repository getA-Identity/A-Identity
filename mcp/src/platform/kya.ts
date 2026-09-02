/**
 * KYA (Know Your Agent): wallet-control challenges, verification and revocation,
 * with best-effort ERC-8004 attestations.
 * Layering: L2 domain module; imports ./core.js and flat ../ modules only.
 */
import { randomBytes } from 'node:crypto'
import { state, save, ownsAgent, pushActivity, short, type PlatformAgent } from './core.js'
import { recordValidationOnchain, readValidation } from '../arc-contracts.js'
import { readAgentTokenOwner, type ExplorerAgentLink } from '../chains/explorer-agent-url.js'
import { getChainById } from '../chains/registry.js'

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

  // Layer B - anchor the KYA result on the ERC-8004 ValidationRegistry (best-effort).
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
 * Revoke an agent's KYA - flag it as an incident (compromised key, repeated disputes, an owner
 * kill-switch). Owner-gated. Sets kya='revoked' (so it is no longer hireable AND risk_check
 * DENYs it), records the incident, and best-effort writes a NEGATIVE attestation (response=0,
 * tag "revoked") to the real ERC-8004 ValidationRegistry - the honest counterpart to the
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

// ── Claim: an imported record meets the party that actually controls it ──────────

/**
 * Claiming an `unclaimed` record.
 *
 * Quick register lets anyone build a record from someone else's on-chain agent. That
 * record is deliberately weak: `kya: 'unclaimed'`, not hireable, never in the showcase,
 * and it says on its face that we made it. This is the door out of that state, and it is
 * the only one: the party who controls the token proves it with a signature, and the
 * record becomes theirs.
 *
 * Two rules make the claim mean something.
 *
 * First, ownership is RE-READ from the chain at claim time. The import record only says
 * who held the token when we looked; a transfer between then and now would otherwise let
 * a former owner claim a token they have sold.
 *
 * Second, a successful claim sets `kya: 'verified'` rather than dropping to 'unverified'.
 * That is not a shortcut: the claimant signed a challenge with the wallet the chain names
 * as owner, which is exactly the wallet-control proof KYA asks for. The record's wallet
 * becomes that address, so the proof and the subject match.
 */
const CLAIM_CHALLENGE_TTL_MS = 10 * 60 * 1000
const claimChallenges = new Map<string, { nonce: string; exp: number }>()

/** What the claimant has to sign, and which address the chain says must sign it. */
export function startClaimChallenge(agentId: string): { message: string; tokenId: string; chain: string; ownerAtImport: string } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (agent.kya !== 'unclaimed' || !agent.importedFrom) {
    return { error: 'This agent is not an unclaimed import, so there is nothing to claim' }
  }
  const nonce = randomBytes(16).toString('hex')
  claimChallenges.set(agentId, { nonce, exp: Date.now() + CLAIM_CHALLENGE_TTL_MS })
  const { chain, tokenId, owner } = agent.importedFrom
  return {
    message:
      `A-Identity claim: prove you control agent #${tokenId} on ${chain}\n` +
      `Record: ${agentId}\nNonce: ${nonce}`,
    tokenId,
    chain,
    // What we recorded at import, shown so a claimant knows which wallet to reach for.
    // It is NOT what the claim is checked against; the live read below is.
    ownerAtImport: owner,
  }
}

export type ClaimDeps = { readOwner?: (link: ExplorerAgentLink) => Promise<{ owner: string } | { error: string }> }

/**
 * Settle a claim. The signature must verify for `address`, and `address` must be what the
 * chain says owns the token RIGHT NOW. Either failure claims nothing and changes nothing.
 */
export async function verifyAgentClaim(
  agentId: string,
  message: string,
  signature: string,
  address: string,
  caller?: string,
  deps: ClaimDeps = {},
): Promise<{ error: string } | { kya: 'verified'; claimProof: NonNullable<PlatformAgent['claimProof']>; owner?: string }> {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (agent.kya !== 'unclaimed' || !agent.importedFrom) {
    return { error: 'This agent is not an unclaimed import, so there is nothing to claim' }
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { error: 'address must be a 0x wallet address' }

  const challenge = claimChallenges.get(agentId)
  if (challenge && challenge.exp <= Date.now()) claimChallenges.delete(agentId)
  const nonce = challenge && challenge.exp > Date.now() ? challenge.nonce : undefined
  if (!nonce || !message.includes(nonce)) return { error: 'Stale or missing challenge; request a new one' }

  const { verifyMessage } = await import('viem')
  let signed = false
  try {
    signed = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` })
  } catch {
    signed = false
  }
  if (!signed) return { error: 'Signature does not match the address given' }

  // The live read. Deliberately after the signature check, so a failing RPC cannot be used
  // to probe which addresses would have been accepted.
  const { chain, tokenId, registry } = agent.importedFrom
  const descriptor = getChainById(chain)
  if (!descriptor) return { error: `The registry no longer carries ${chain}, so this claim cannot be checked` }
  const read = deps.readOwner ?? readAgentTokenOwner
  const live = await read({ chain: descriptor, tokenId: BigInt(tokenId), registry, explorer: 'claim' })
  if ('error' in live) return { error: live.error }
  if (live.owner.toLowerCase() !== address.toLowerCase()) {
    return {
      error:
        `the chain says agent #${tokenId} on ${descriptor.name} is owned by ${live.owner}, not ${address}. ` +
        'Nothing was claimed. If you have just acquired it, the transfer may not be indexed yet; if you sold it, the new owner claims it',
    }
  }

  claimChallenges.delete(agentId)
  const at = new Date().toISOString()
  agent.claimProof = { address, at, method: 'wallet-signature', tokenId, chain }
  // The claim IS a wallet-control proof, so the record carries it as one and the wallet it
  // proves becomes the record's wallet. Without that the two would disagree.
  agent.walletAddress = address
  agent.kyaProof = { address, at, method: 'wallet-signature' }
  agent.kya = 'verified'
  if (caller) agent.owner = caller
  pushActivity(agent, `Claimed by the on-chain owner of #${tokenId} on ${chain} (${short(address)}), and KYA proven by the same signature`)
  save(state)
  return { kya: 'verified', claimProof: agent.claimProof, ...(caller ? { owner: caller } : {}) }
}

/**
 * Mark a freshly-registered record as an unclaimed import.
 *
 * Called only when the chain actually told us who owns the token AND that is not the
 * caller. A read that failed leaves the record alone: "we could not check" is not
 * evidence that someone else owns it, and downgrading a record on a timeout would punish
 * an owner for our RPC having a bad minute.
 */
export function markImportedAgent(
  agentId: string,
  from: NonNullable<PlatformAgent['importedFrom']>,
): { kya: PlatformAgent['kya'] } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (agent.kya === 'verified' || agent.kya === 'revoked') return { kya: agent.kya }
  agent.importedFrom = from
  agent.kya = 'unclaimed'
  pushActivity(
    agent,
    `Imported from agent #${from.tokenId} on ${from.chain}, which is owned on chain by ${short(from.owner)}. ` +
      'Unclaimed until that owner proves control here.',
  )
  save(state)
  return { kya: agent.kya }
}
