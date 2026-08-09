/**
 * KYA (Know Your Agent): wallet-control challenges, verification and revocation,
 * with best-effort ERC-8004 attestations.
 * Layering: L2 domain module; imports ./core.js and flat ../ modules only.
 */
import { randomBytes } from 'node:crypto'
import { state, save, ownsAgent, pushActivity, short, type PlatformAgent } from './core.js'
import { recordValidationOnchain, readValidation } from '../arc-contracts.js'

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
