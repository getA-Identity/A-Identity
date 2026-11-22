import { encodeFunctionData } from 'viem'
import { provenanceFor } from './provenance.js'
import { getChainById } from './registry.js'
import type { ChainDescriptor } from './types.js'

/**
 * Our Celo ERC-8004 registration document, and the one write that points agent #9759 at it.
 *
 * Aigora (aigora.org, Trion Labs) lists Celo agents by scanning the canonical IdentityRegistry,
 * reading each tokenURI and keeping the documents that say `"onAigora": true`. Agent #9759's
 * tokenURI was the shared A2A agent card, which Arc Mainnet #0 and Robinhood Chain #0 also point
 * at and which is not an ERC-8004 registration-v1 document. So Celo got its own file,
 * public/.well-known/celo-8004.json, the way Stellar got stellar-8004.json, and only #9759 was
 * repointed. The other chains' tokenURIs are untouched. Read live 2026-11-22: tokenURI(9759)
 * is CELO_8004_URI and the agent is listed at
 * aigora.org/services/42220_<lowercase IdentityRegistry>_9759.
 *
 * The profile fields beyond the required ones (cover, service prices and descriptions, the
 * OASF carrier, categories, external_links) follow the document Aigora's own form builds,
 * read from its deployed build on 2026-11-22. The URI is an https address rather than a
 * pinned copy, so a change to the file needs no new transaction, but Aigora reads it when it
 * indexes, so a profile may show the old document until its next read.
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
/** A USDC display price: a plain decimal with at most six places, up to 1,000,000. */
const PRICE = /^\d+(\.\d{1,6})?$/
const SERVICE_DESCRIPTION_MAX = 256

/**
 * The fixed lists Aigora's form offers, read from its deployed build on 2026-11-22. Aigora
 * silently drops a category it does not know, so an unknown one is flagged here instead of
 * vanishing from the profile. `hackathon` is accepted by their builder but not offered in the
 * picker.
 */
export const AIGORA_CATEGORIES = new Set(['code', 'design', 'content', 'data', 'research', 'automation', 'trading', 'hackathon'])
export const AIGORA_LINK_PLATFORMS = new Set(['website', 'x', 'github', 'youtube', 'discord', 'telegram', 'linkedin', 'farcaster'])
const MAX_CATEGORIES = 8
const MAX_LINKS = 8
const MAX_OASF_SKILLS = 12
const MAX_OASF_DOMAINS = 8

type Service = { name?: unknown; endpoint?: unknown; version?: unknown; price?: unknown; description?: unknown }

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
    if (s?.price !== undefined) {
      if (typeof s.price !== 'string' || !PRICE.test(s.price)) issues.push('service_price_invalid')
      else if (Number(s.price) > 1_000_000) issues.push('service_price_too_high')
    }
    if (s?.description !== undefined) {
      if (typeof s.description !== 'string') issues.push('service_description_invalid')
      else if (s.description.length > SERVICE_DESCRIPTION_MAX) issues.push('service_description_too_long')
    }
  }

  const oasf = services.filter((s) => s?.name === 'OASF') as { skills?: unknown; domains?: unknown }[]
  for (const o of oasf) {
    if (Array.isArray(o.skills) && o.skills.length > MAX_OASF_SKILLS) issues.push('too_many_skills')
    if (Array.isArray(o.domains) && o.domains.length > MAX_OASF_DOMAINS) issues.push('too_many_domains')
  }

  if (d.categories !== undefined) {
    if (!Array.isArray(d.categories)) issues.push('categories_not_array')
    else {
      if (d.categories.length > MAX_CATEGORIES) issues.push('too_many_categories')
      if (d.categories.some((c) => typeof c !== 'string' || !AIGORA_CATEGORIES.has(c))) issues.push('category_unknown')
    }
  }

  if (d.external_links !== undefined) {
    const links = (Array.isArray(d.external_links) ? d.external_links : null) as { platform?: unknown; url?: unknown }[] | null
    if (!links) issues.push('links_not_array')
    else {
      if (links.length > MAX_LINKS) issues.push('too_many_links')
      for (const l of links) {
        if (typeof l?.platform !== 'string' || !AIGORA_LINK_PLATFORMS.has(l.platform)) issues.push('link_platform_invalid')
        if (!isUrl(l?.url, ['https:'])) issues.push('link_url_invalid')
      }
    }
  }

  // Claiming x402 is the one blocking exception to "liveness is advisory": Aigora requires at
  // least one priced web endpoint, and every priced web endpoint must pass its live, unsigned
  // 402 preflight. The document can only show the first half; the second is a live check, so it
  // lives in aigoraX402ChallengeIssues below and runs from scripts/celo-8004-aigora.mjs, never
  // in a unit test.
  if (d.x402Support === true) {
    if (x402PricedWebEndpoints(d).length === 0) issues.push('x402_endpoint_required')
  } else if (d.x402Support !== undefined && d.x402Support !== false) issues.push('x402_support_not_boolean')

  return issues
}

/**
 * The endpoints Aigora preflights when a document claims x402: every web row with a positive
 * display price. A browser page with a price fails that preflight, so a priced web row must be
 * an x402 route itself.
 */
export function x402PricedWebEndpoints(doc: unknown): string[] {
  const services = (doc as { services?: unknown } | null)?.services
  if (!Array.isArray(services)) return []
  return (services as Service[])
    .filter((s) => s?.name === 'web' && typeof s.price === 'string' && PRICE.test(s.price) && Number(s.price) > 0)
    .map((s) => s.endpoint)
    .filter((e): e is string => typeof e === 'string')
}

/** The origin Aigora's form runs its preflight from. */
export const AIGORA_ORIGIN = 'https://aigora.org'

/** The longest payment timeout Aigora accepts in a challenge, in seconds. */
const AIGORA_MAX_TIMEOUT_SECONDS = 600

type HeaderBag = { get(name: string): string | null }

const allowsOrigin = (h: HeaderBag) => {
  const allow = h.get('access-control-allow-origin')
  return allow === '*' || allow === AIGORA_ORIGIN
}

/**
 * Aigora's live x402 preflight, judged from the answers to one CORS preflight (OPTIONS) and one
 * unsigned POST sent from Aigora's origin. The rules are Aigora's published ones
 * (registration-fields.md, "x402 compatibility is a blocking exception", read 2026-11-22):
 * public HTTPS, CORS that lets Aigora's origin read the answer, no redirect, an HTTP 402 with an
 * x402 v2 challenge using `exact`, EIP-3009 and canonical USDC on Celo mainnet, the registering
 * wallet as payTo, the resource equal to the endpoint, a timeout of at most 600 seconds and no
 * legacy maxAmountRequired. Aigora publishes no codes for this check, so the codes are ours.
 * It reads what it is given and fetches nothing; the script does the fetching.
 */
export function aigoraX402ChallengeIssues(input: {
  url: string
  registeringWallet: string
  options: { status: number; headers: HeaderBag }
  post: { status: number; headers: HeaderBag }
}): string[] {
  const { url, registeringWallet, options, post } = input
  const issues: string[] = []
  if (!isUrl(url, ['https:'])) issues.push('x402_not_https')

  const methods = options.headers.get('access-control-allow-methods') ?? ''
  const allowHeaders = options.headers.get('access-control-allow-headers') ?? ''
  if (options.status >= 300 || !allowsOrigin(options.headers) || !/\bPOST\b/i.test(methods) || !/content-type/i.test(allowHeaders)) {
    issues.push('x402_cors_preflight')
  }

  if (post.status >= 300 && post.status < 400) issues.push('x402_redirect')
  if (post.status !== 402) {
    issues.push('x402_not_402')
    return issues
  }
  if (!allowsOrigin(post.headers) || !/payment-required/i.test(post.headers.get('access-control-expose-headers') ?? '')) {
    issues.push('x402_cors_response')
  }

  let challenge: {
    x402Version?: unknown
    resource?: { url?: unknown }
    accepts?: Record<string, unknown>[]
  } | null = null
  try {
    const raw = post.headers.get('payment-required')
    challenge = raw ? JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) : null
  } catch {
    challenge = null
  }
  if (!challenge || typeof challenge !== 'object') {
    issues.push('x402_challenge_missing')
    return issues
  }
  if (challenge.x402Version !== 2) issues.push('x402_not_v2')
  if (challenge.resource?.url !== url) issues.push('x402_resource_mismatch')

  const chain = celoChain()
  const usdc = chain.contracts.usdc?.toLowerCase()
  const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : []
  const celo = accepts.filter((a) => a?.network === chain.caip2)
  if (celo.length === 0) {
    issues.push('x402_no_celo_requirement')
    return issues
  }
  for (const a of celo) {
    const extra = a.extra as { name?: unknown; version?: unknown } | undefined
    if (a.scheme !== 'exact') issues.push('x402_scheme_not_exact')
    if (typeof a.asset !== 'string' || a.asset.toLowerCase() !== usdc) issues.push('x402_asset_not_usdc')
    if (typeof extra?.name !== 'string' || typeof extra?.version !== 'string') issues.push('x402_no_eip3009_domain')
    if (a.maxAmountRequired !== undefined) issues.push('x402_legacy_amount_field')
    if (typeof a.amount !== 'string' || !/^\d+$/.test(a.amount) || BigInt(a.amount) <= 0n) issues.push('x402_amount_invalid')
    if (typeof a.payTo !== 'string' || a.payTo.toLowerCase() !== registeringWallet.toLowerCase()) issues.push('x402_payto_not_registrant')
    if (typeof a.maxTimeoutSeconds !== 'number' || a.maxTimeoutSeconds > AIGORA_MAX_TIMEOUT_SECONDS) issues.push('x402_timeout_too_long')
  }
  return [...new Set(issues)]
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
