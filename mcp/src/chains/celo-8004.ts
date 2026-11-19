import { encodeFunctionData } from 'viem'
import { provenanceFor } from './provenance.js'
import { getChainById } from './registry.js'
import type { ChainDescriptor } from './types.js'

/**
 * Our Celo ERC-8004 registration document, and the one write that points agent #9759 at it.
 *
 * Aigora (aigora.org, Trion Labs) lists Celo agents by scanning the canonical IdentityRegistry,
 * reading each tokenURI and keeping the documents that say `"onAigora": true`. Agent #9759's
 * tokenURI is the shared A2A agent card, which Arc Mainnet #0 and Robinhood Chain #0 also point
 * at and which is not an ERC-8004 registration-v1 document. So Celo gets its own file,
 * public/.well-known/celo-8004.json, the way Stellar got stellar-8004.json, and only #9759 is
 * repointed. The other chains' tokenURIs are untouched.
 *
 * Nothing here signs. `setAgentUriCall` returns the exact call (target, calldata and a cast
 * line with an --account placeholder) for the person who holds the owner wallet to sign
 * themselves: prepared, never executed (CLAUDE.md, ground rule two and three).
 *
 * `aigoraRegistrationIssues` restates Aigora's BLOCKING validation rules from their published
 * field reference (trionlabs/agent-search-mcp-aigora, skills/aigora-register/references/
 * registration-fields.md, read 2026-11-19), using their error codes, so a bad document fails
 * our test suite instead of failing silently at their next scan. Their advisory checks
 * (endpoint reachability) are deliberately not restated: a live check does not belong in a
 * unit test. It is our copy of someone else's rules and can drift from theirs; the reference
 * says a deployed build may lag its own source too.
 */

/** Where the document is served. Vercel serves /.well-known/*.json as JSON with open CORS. */
export const CELO_8004_URI = 'https://a-identity.xyz/.well-known/celo-8004.json'

/** The repo path of the same file, for tests and scripts that read it from disk. */
export const CELO_8004_FILE = 'public/.well-known/celo-8004.json'

export const ERC8004_REGISTRATION_V1 = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'

/** The Celo chain descriptor. Throws only if the registry lost Celo, which is a build error. */
export function celoChain(): ChainDescriptor {
  const chain = getChainById('celo')
  if (!chain?.contracts.identityRegistry || chain.evmChainId === null) {
    throw new Error('the chain registry has no Celo descriptor with an IdentityRegistry')
  }
  return chain
}

/** Agent #9759, read from the provenance ledger rather than typed a second time. */
export function celoAgentId(): string {
  const id = provenanceFor('celo')?.agent?.tokenId
  if (!id) throw new Error('the provenance ledger records no agent of ours on Celo')
  return id
}

/** The ERC-8004 `agentRegistry` value for Celo: `eip155:<chainId>:<IdentityRegistry>`. */
export function celoAgentRegistry(): string {
  const chain = celoChain()
  return `${chain.caip2}:${chain.contracts.identityRegistry}`
}

const SERVICE_TYPES = new Set(['web', 'MCP', 'A2A'])
const MCP_VERSION = /^\d{4}-\d{2}-\d{2}$/
const A2A_VERSION = /^\d+\.\d+\.\d+$/
const VERSION = /^[A-Za-z0-9.+-]{1,32}$/

type Service = { name?: unknown; endpoint?: unknown; version?: unknown }

const isUrl = (v: unknown, schemes: string[]): boolean => {
  if (typeof v !== 'string') return false
  try {
    return schemes.includes(new URL(v).protocol)
  } catch {
    return false
  }
}

/**
 * Every Aigora blocking-rule violation in `doc`, as their error codes. Empty means it would
 * list. The service rows that carry OASF capability metadata (`name: "OASF"`) are not callable
 * endpoints and are skipped, as Aigora skips them.
 */
export function aigoraRegistrationIssues(doc: unknown): string[] {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return ['not_an_object']
  const d = doc as Record<string, unknown>
  const issues: string[] = []

  if (d.type !== ERC8004_REGISTRATION_V1) issues.push('type_invalid')
  // Aigora lists only on the boolean. The string "true" is a different value and does not list.
  if (d.onAigora !== true) issues.push('on_aigora_not_true')

  if (typeof d.name !== 'string' || !d.name.trim()) issues.push('name_required')
  else if (d.name.length > 64) issues.push('name_too_long')

  if (typeof d.description !== 'string' || !d.description.trim()) issues.push('description_required')
  else if (d.description.length < 50) issues.push('description_too_short')
  else if (d.description.length > 1024) issues.push('description_too_long')

  if (d.image !== undefined && !isUrl(d.image, ['https:', 'ipfs:'])) issues.push('image_invalid')
  if (d.cover !== undefined && !isUrl(d.cover, ['https:', 'ipfs:'])) issues.push('cover_invalid')

  const services = (Array.isArray(d.services) ? d.services : []) as Service[]
  const callable = services.filter((s) => s?.name !== 'OASF')
  if (callable.length === 0) issues.push('no_service')
  if (callable.length > 7) issues.push('too_many_services')
  const seen = new Set<string>()
  for (const s of callable) {
    const name = typeof s?.name === 'string' ? s.name : ''
    if (!SERVICE_TYPES.has(name)) issues.push('service_type_invalid')
    if (typeof s?.endpoint !== 'string' || !s.endpoint.trim()) issues.push('endpoint_invalid')
    else if (s.endpoint.length > 2048) issues.push('endpoint_too_long')
    const key = `${name} ${String(s?.endpoint)}`
    if (seen.has(key)) issues.push('service_dup')
    seen.add(key)
    if (s?.version !== undefined) {
      const v = s.version
      if (typeof v !== 'string' || !VERSION.test(v)) issues.push('service_version_invalid')
      else if (name === 'MCP' && !MCP_VERSION.test(v)) issues.push('mcp_version_invalid')
      else if (name === 'A2A' && !A2A_VERSION.test(v)) issues.push('a2a_version_invalid')
    }
  }

  // Claiming x402 is the one blocking exception to "liveness is advisory": Aigora requires a
  // priced web endpoint that passes its live, unsigned 402 preflight (x402 v2, exact, EIP-3009,
  // CORS for Aigora's origin, payTo equal to the registering wallet). None of that can be
  // proven from the document, so a claim is refused here until a live check exists for it.
  if (d.x402Support === true) issues.push('x402_claim_unverified')
  else if (d.x402Support !== undefined && d.x402Support !== false) issues.push('x402_support_not_boolean')

  return issues
}

/** The prepared `setAgentURI(agentId, uri)` call on Celo's IdentityRegistry. Signs nothing. */
export function setAgentUriCall(agentId: string, uri: string = CELO_8004_URI) {
  const chain = celoChain()
  const registry = chain.contracts.identityRegistry!
  const data = encodeFunctionData({
    abi: SET_AGENT_URI_ABI,
    functionName: 'setAgentURI',
    args: [BigInt(agentId), uri],
  })
  return {
    status: 'prepared' as const,
    chainId: chain.evmChainId!,
    to: registry,
    data,
    // The owner signs from their own keystore. Never a --private-key flag in a printed command.
    cast: `cast send ${registry} "setAgentURI(uint256,string)" ${agentId} "${uri}" --rpc-url ${chain.rpcUrls[0]} --account <KEYSTORE_NAME>`,
  }
}

export const SET_AGENT_URI_ABI = [
  {
    type: 'function',
    name: 'setAgentURI',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newURI', type: 'string' },
    ],
    outputs: [],
  },
] as const
