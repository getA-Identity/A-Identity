/**
 * Owner-attested Circle agent wallet policy.
 *
 * Circle's policy engine caps what an agent wallet may move (per transaction, per day,
 * week and month; recipient and contract allowlists), and it enforces those caps
 * MAINNET-only, behind the owner's OTP. There is no public API for another party to read
 * a wallet's policy, so the best a counterparty can ever have is the owner's word, signed.
 * This module makes that word checkable and keeps it honest:
 *
 *  - The owner pastes what `circle wallet limit --address <a> --chain <c> --output json`
 *    printed. We hash the exact text and derive BANDS from it. The text itself is never
 *    stored: caps and allowlists are the owner's private position.
 *  - The wallet signs a message carrying that hash and a fresh nonce. Key-held or contract
 *    account (ERC-1271) alike, through the same verifier KYA uses.
 *  - guardrail_check reports the attestation as owner-attested, bands only, and never as
 *    enforcement. The word enforced is reserved for the vault we can see refuse.
 *
 * Layering: L3 domain module; imports ./core.js and flat ../ modules only.
 */
import { createHash, randomBytes } from 'node:crypto'
import { state, save, ownsAgent, pushActivity, short, type PlatformAgent, type CapBand, type CirclePolicyBands, type CirclePolicyAttestation } from './core.js'
import { getChainById } from '../chains/registry.js'
import { verifyWalletSignature, type SignatureDeps } from '../erc1271.js'

const CHALLENGE_TTL_MS = 10 * 60 * 1000
const challenges = new Map<string, { nonce: string; policyHash: string; exp: number }>()

/** Circle CLI chain names for the chains our registry carries. Unknown names are not an
 *  error: the contract path then asks every EVM chain and the proof records which answered. */
const CIRCLE_CHAIN_TO_REGISTRY: Record<string, string> = { BASE: 'base', ARB: 'arbitrum', AVAX: 'avalanche' }

export function policyHashOf(policyText: string): string {
  return createHash('sha256').update(policyText, 'utf8').digest('hex')
}

/** The size of a cap as a band. Circle prints limits as decimal USDC strings. */
export function capBand(v: unknown): CapBand {
  if (v === undefined || v === null || v === '' || v === 'Uncapped') return 'uncapped'
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return 'uncapped'
  if (n < 1) return 'dust'
  if (n < 10) return 'small'
  if (n < 100) return 'moderate'
  return 'large'
}

type CliPolicy = {
  policyType?: unknown
  ruleType?: unknown
  perTxLimit?: unknown
  dailyLimit?: unknown
  weeklyLimit?: unknown
  monthlyLimit?: unknown
  addresses?: unknown
  origin?: unknown
}

/**
 * Bands from the JSON Circle CLI 1.0 prints for `wallet limit --output json`:
 * `{ walletId, blockchain, policies: [{ policyType, ruleType, perTxLimit?, dailyLimit?,
 * weeklyLimit?, monthlyLimit?, addresses?, origin, policyId? }] }` (shape read from the
 * CLI's own source, 2026-09-10). Anything else parses to `parsed: false` with every band
 * uncapped, so a wrong paste cannot dress itself up as a policy.
 */
export function bandsFromPolicy(policy: unknown): { bands: CirclePolicyBands; circleChain?: string } {
  const empty: CirclePolicyBands = {
    transferLimits: { perTx: 'uncapped', daily: 'uncapped', weekly: 'uncapped', monthly: 'uncapped' },
    recipientAllowlist: false,
    contractAllowlist: false,
    origin: 'unknown',
    parsed: false,
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return { bands: empty }
  const doc = policy as { blockchain?: unknown; policies?: unknown }
  if (!Array.isArray(doc.policies)) return { bands: empty }
  const rules = doc.policies.filter((p): p is CliPolicy => Boolean(p) && typeof p === 'object')
  const limits = { ...empty.transferLimits }
  let recipientAllowlist = false
  let contractAllowlist = false
  const origins = new Set<string>()
  const tighter = (a: CapBand, b: CapBand): CapBand => {
    const order: CapBand[] = ['dust', 'small', 'moderate', 'large', 'uncapped']
    return order.indexOf(a) <= order.indexOf(b) ? a : b
  }
  for (const r of rules) {
    const rule = String(r.ruleType ?? '').toUpperCase().replace(/-/g, '_')
    if (rule === 'TRANSFER_LIMIT') {
      limits.perTx = tighter(limits.perTx, capBand(r.perTxLimit))
      limits.daily = tighter(limits.daily, capBand(r.dailyLimit))
      limits.weekly = tighter(limits.weekly, capBand(r.weeklyLimit))
      limits.monthly = tighter(limits.monthly, capBand(r.monthlyLimit))
    } else if (rule === 'RECIPIENT_ALLOWLIST') {
      recipientAllowlist = Array.isArray(r.addresses) ? r.addresses.length > 0 : true
    } else if (rule === 'CONTRACT_ALLOWLIST') {
      contractAllowlist = Array.isArray(r.addresses) ? r.addresses.length > 0 : true
    }
    if (typeof r.origin === 'string') origins.add(r.origin.toUpperCase().includes('DEFAULT') ? 'default' : 'custom')
  }
  const origin: CirclePolicyBands['origin'] = origins.size === 0 ? 'unknown' : origins.size > 1 ? 'mixed' : ([...origins][0] as 'custom' | 'default')
  return {
    bands: { transferLimits: limits, recipientAllowlist, contractAllowlist, origin, parsed: true },
    ...(typeof doc.blockchain === 'string' ? { circleChain: doc.blockchain.toUpperCase() } : {}),
  }
}

/** Start: hash the pasted policy and hand back the message the wallet must sign. */
export function startCirclePolicyChallenge(
  agentId: string,
  policyText: string,
  caller?: string,
): { address: string; message: string; policyHash: string; bands: CirclePolicyBands; circleChain?: string } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  if (!agent.walletAddress) return { error: 'Agent has no wallet; assign the Circle agent wallet address first' }
  if (typeof policyText !== 'string' || !policyText.trim()) return { error: 'policy is required: paste the output of circle wallet limit --output json' }
  if (policyText.length > 64 * 1024) return { error: 'policy is too large' }
  let parsed: unknown
  try {
    parsed = JSON.parse(policyText)
  } catch {
    return { error: 'policy must be JSON: paste the output of circle wallet limit --output json unchanged' }
  }
  const { bands, circleChain } = bandsFromPolicy(parsed)
  const policyHash = policyHashOf(policyText)
  const nonce = randomBytes(16).toString('hex')
  challenges.set(agentId, { nonce, policyHash, exp: Date.now() + CHALLENGE_TTL_MS })
  const message =
    `A-Identity Circle policy attestation: I attest that Circle enforces the spending policy with sha256 ${policyHash} on wallet ${agent.walletAddress}\n` +
    `Agent: ${agentId}\nNonce: ${nonce}`
  return { address: agent.walletAddress, message, policyHash, bands, ...(circleChain ? { circleChain } : {}) }
}

export type AttestOptions = { chain?: string; deps?: SignatureDeps }

/** Finish: the same policy text, the message, and the wallet's signature over it. */
export async function attestCirclePolicy(
  agentId: string,
  policyText: string,
  message: string,
  signature: string,
  caller?: string,
  opts: AttestOptions = {},
): Promise<{ error: string } | { attestation: CirclePolicyAttestation }> {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  if (!agent.walletAddress) return { error: 'Agent has no wallet' }
  const challenge = challenges.get(agentId)
  if (challenge && challenge.exp <= Date.now()) challenges.delete(agentId)
  const live = challenge && challenge.exp > Date.now() ? challenge : undefined
  if (!live || !message.includes(live.nonce)) return { error: 'Stale or missing challenge; request a new one' }
  if (typeof policyText !== 'string' || policyHashOf(policyText) !== live.policyHash || !message.includes(live.policyHash)) {
    return { error: 'The policy text differs from the one the challenge was issued for; nothing was attested' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(policyText)
  } catch {
    return { error: 'policy must be JSON' }
  }
  const { bands, circleChain } = bandsFromPolicy(parsed)
  const chain = opts.chain ?? (circleChain ? CIRCLE_CHAIN_TO_REGISTRY[circleChain] : undefined)
  const verdict = await verifyWalletSignature(
    { address: agent.walletAddress, message, signature, chain: chain && getChainById(chain) ? chain : undefined },
    opts.deps,
  )
  if (!verdict.ok) return { error: 'Signature does not match the agent wallet (neither as a key signature nor as a contract account signature)' }

  challenges.delete(agentId)
  const attestation: CirclePolicyAttestation = {
    address: agent.walletAddress,
    at: new Date().toISOString(),
    policyHash: live.policyHash,
    method: verdict.method,
    ...(verdict.method === 'erc1271-signature' ? { chain: verdict.chain } : {}),
    ...(circleChain ? { circleChain } : {}),
    bands,
    message,
    signature,
  }
  agent.circlePolicyAttestation = attestation
  pushActivity(agent, `Circle policy attested by the owner (${short(agent.walletAddress)}): bands recorded, policy itself not stored`)
  save(state)
  return { attestation }
}

export function getCirclePolicyAttestation(agentId: string): { attestation: CirclePolicyAttestation | null } | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  return { attestation: agent.circlePolicyAttestation ?? null }
}

/** Which agent, if any, attested a Circle policy for this wallet address. For the
 *  console's wallet rows: the address is an ordinary EVM address, the attestation is
 *  what marks it as a Circle agent wallet. */
export function circleAgentWalletFor(address: string): { agentId: string; agentName: string; attestedAt: string; method: CirclePolicyAttestation['method'] } | null {
  const a = address.toLowerCase()
  const agent = state.agents.find((x) => x.circlePolicyAttestation && x.circlePolicyAttestation.address.toLowerCase() === a)
  if (!agent?.circlePolicyAttestation) return null
  return { agentId: agent.id, agentName: agent.name, attestedAt: agent.circlePolicyAttestation.at, method: agent.circlePolicyAttestation.method }
}

/** The third-party view of an attestation, for the guardrail profile: bands, day
 *  precision, and the sentence that keeps it from being read as enforcement. */
export function attestationForProfile(agent: PlatformAgent) {
  const att = agent.circlePolicyAttestation
  if (!att) return null
  return {
    source: 'circle-agent-wallet' as const,
    kind: 'owner-attested' as const,
    attestedOn: att.at.slice(0, 10),
    verifiedBy: att.method,
    ...(att.chain ? { chain: att.chain } : {}),
    bands: att.bands,
    disclosure:
      'Owner-attested Circle policy present: the wallet signed a hash of the policy Circle CLI reported for it. A-Identity cannot read Circle\'s policy engine and does not treat this as enforcement; only the vault it can watch refuse is called enforced. Bands only, and they describe the policy as pasted at attestation time, not the policy now.',
  }
}
