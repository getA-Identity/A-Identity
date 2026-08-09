/**
 * Open ecosystem: the public per-agent manifest (AMP Discover) and external
 * agent self-registration.
 * Layering: L8 domain module; imports lower ./ modules and flat ../ modules only.
 */
import { state, type PlatformAgent, type Service } from './core.js'
import { createAgent } from './agents.js'
import { startKyaChallenge } from './kya.js'
import { provisionCircleWallet } from './vault.js'
import { repOf } from './reputation.js'
import { buildAgentManifest } from '../marketplace.js'

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
