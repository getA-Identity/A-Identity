/**
 * The Algorand (AVM) x402 rail: sell the trust tools for USDC on Algorand, mainnet and
 * testnet, over x402 v2's "exact" scheme.
 *
 * How this rail differs from the other two, stated up front:
 *
 *  - It does NOT self-broadcast. Settlement goes through the GoPlausible
 *    facilitator, the rail this ecosystem standardized on (and the one its
 *    Global x402 Challenge requires). The buyer signs an ASA transfer with fee
 *    ZERO, the facilitator signs the fee-paying transaction into the same
 *    atomic group and submits it; Algorand only checks the group's POOLED fee.
 *  - What stays ours is the discipline: the paymentGroup is decoded and checked
 *    LOCALLY before the facilitator sees it (asset, recipient, amount, no
 *    rekey, no close-to), and no payment counts as settled until we have read
 *    the transfer back from an indexer ourselves. A facilitator's success
 *    response is a claim; the ledger is the record.
 *  - The answer is produced BEFORE the payment is submitted and released only after the
 *    transfer is confirmed. A tool that cannot answer therefore costs the buyer nothing.
 *  - It has its own price list, ten times the shared base list the other rails and the
 *    OKX listings keep, plus a batch audit sold only here. There is no settlement fee on
 *    top: the facilitator covers network fees, so charging one would be a markup wearing
 *    a cost's name.
 *
 * Env (all optional; unset means this rail is a labeled 501, never a mock):
 *   X402_ALGORAND_NETWORKS        CSV of CAIP-2 ids from the registry
 *   X402_ALGORAND_PAYTO           default receiving account (58-char address)
 *   X402_ALGORAND_MAINNET_PAYTO / X402_ALGORAND_TESTNET_PAYTO  per-network override
 *   X402_ALGORAND_FACILITATOR     default https://facilitator.goplausible.xyz
 *   X402_ALGORAND_TAG             optional challenge tag (e.g. x402-global-challenge)
 *   X402_ALGORAND_RESOURCE_ORIGIN public https origin the resources are served from
 *                                 (default https://a-identity.xyz, which proxies /api here)
 *   X402_ALGORAND_MIN_VALUE_USD / X402_ALGORAND_MAX_VALUE_USD  price rails
 */
import { CHAINS, getChain, getChainById } from '../chains/index.js'
import type { ChainDescriptor, SettlementToken } from '../chains/types.js'
import { isAlgorandAddress } from '../chains/algorand/ids.js'
import { agentPassport, reputationScore, riskCheck, verifyAgent, type TxContext } from '../asp/tools.js'
import { RAIL_BASE_PRICES_USD, RAIL_TOOLS, RAIL_TOOL_CARDS, type RailToolName } from '../x402-3009/rail.js'
import { loadAlgorandSettlements, type AlgorandSettlementRecord } from '../storage.js'
import { BATCH_MAX_AGENTS, runBatchAudit } from './batch.js'
import { settleAlgorandPayment, type AlgorandRequirements, type AlgorandSettleDeps } from './settle.js'

export { RAIL_BASE_PRICES_USD, RAIL_TOOL_CARDS, RAIL_TOOLS }
export type { RailToolName }

/** The batch audit: sold on this rail only, priced per agent. */
export const ALGORAND_BATCH_TOOL = 'agent_batch_audit' as const
export type AlgorandToolName = RailToolName | typeof ALGORAND_BATCH_TOOL
export const ALGORAND_TOOLS: readonly AlgorandToolName[] = [...RAIL_TOOLS, ALGORAND_BATCH_TOOL]

export function isAlgorandTool(name: string): name is AlgorandToolName {
  return (ALGORAND_TOOLS as readonly string[]).includes(name)
}

export const DEFAULT_FACILITATOR = 'https://facilitator.goplausible.xyz'

/**
 * The public origin the resources are named under. The Bazaar enriches a merchant from
 * its resource domain (title, description, logo, well-known files), and the site origin is
 * the one that carries all of that; it proxies /api to this backend. The Render hostname
 * this rail first shipped with carries none of it, which is why the merchant showed up as a
 * bare address with no logo.
 */
export const DEFAULT_RESOURCE_ORIGIN = 'https://a-identity.xyz'

/** A malformed override is treated as unset, the same rule the payTo follows. */
export function algorandResourceOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.X402_ALGORAND_RESOURCE_ORIGIN ?? '').trim()
  if (!raw) return DEFAULT_RESOURCE_ORIGIN
  try {
    const u = new URL(raw)
    const bare = (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash
    return u.protocol === 'https:' && bare ? u.origin : DEFAULT_RESOURCE_ORIGIN
  } catch {
    return DEFAULT_RESOURCE_ORIGIN
  }
}

/**
 * Registry CAIP-2 id <-> the facilitator's network string.
 *
 * The registry carries the REGISTERED CAIP-2 form (32-char truncated base64
 * genesis prefix; '=' and '/' are not legal CAIP-2 reference characters). The
 * facilitator speaks the full padded base64 genesis hash. Same chain, two
 * spellings; this is the one place that maps them, both directions.
 */
const FACILITATOR_NETWORK: Record<string, string> = {
  'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k': 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
  'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe': 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
}

export function facilitatorNetworkFor(caip2: string): string | null {
  return FACILITATOR_NETWORK[caip2] ?? null
}

/** Resolve either spelling (or a registry slug) back to the registry CAIP-2 id. */
export function algorandCaip2Of(network: string): string | null {
  const n = network.trim()
  if (FACILITATOR_NETWORK[n]) return n
  const byFull = Object.entries(FACILITATOR_NETWORK).find(([, full]) => full === n)
  if (byFull) return byFull[0]
  const byId = getChainById(n)
  if (byId?.ecosystem === 'algorand') return byId.caip2
  return null
}

export type AlgorandRailStatus = {
  configured: boolean
  /** Registry CAIP-2 id of the network this status describes. */
  network: string
  /** The facilitator's spelling of the same network. */
  facilitatorNetwork: string | null
  chain: string | null
  token: SettlementToken | null
  payTo: string | null
  facilitator: string
  tag: string | null
  reason?: string
}

export function algorandRailNetworks(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.X402_ALGORAND_NETWORKS ?? '').trim()
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function payToFor(chain: ChainDescriptor, env: NodeJS.ProcessEnv): string | null {
  const perNet = chain.testnet ? env.X402_ALGORAND_TESTNET_PAYTO : env.X402_ALGORAND_MAINNET_PAYTO
  const raw = (perNet ?? env.X402_ALGORAND_PAYTO ?? '').trim()
  if (!raw) return null
  return isAlgorandAddress(raw) ? raw : null
}

export function algorandRailStatus(env: NodeJS.ProcessEnv = process.env, wantedNetwork?: string): AlgorandRailStatus {
  const facilitator = (env.X402_ALGORAND_FACILITATOR ?? DEFAULT_FACILITATOR).trim()
  const tag = (env.X402_ALGORAND_TAG ?? '').trim() || null
  const networks = algorandRailNetworks(env)
  const requested = wantedNetwork ? algorandCaip2Of(wantedNetwork) : null
  if (wantedNetwork && !requested) {
    return {
      configured: false, network: wantedNetwork, facilitatorNetwork: null, chain: null, token: null,
      payTo: null, facilitator, tag,
      reason: `'${wantedNetwork}' is not an Algorand network this registry knows.`,
    }
  }
  const caip2 = requested ?? networks[0] ?? null
  if (!caip2) {
    return {
      configured: false, network: 'algorand:unset', facilitatorNetwork: null, chain: null, token: null,
      payTo: null, facilitator, tag,
      reason: 'X402_ALGORAND_NETWORKS is not set, so this rail sells on no network. Unset means off, never a default.',
    }
  }
  const chain = getChain(caip2)
  if (!chain || chain.ecosystem !== 'algorand') {
    return {
      configured: false, network: caip2, facilitatorNetwork: null, chain: null, token: null,
      payTo: null, facilitator, tag,
      reason: `'${caip2}' is not an Algorand chain in the registry.`,
    }
  }
  if (requested && networks.length && !networks.includes(caip2)) {
    return {
      configured: false, network: caip2, facilitatorNetwork: facilitatorNetworkFor(caip2), chain: chain.id,
      token: null, payTo: null, facilitator, tag,
      reason: `this rail is not configured to sell on ${caip2}; X402_ALGORAND_NETWORKS names [${networks.join(', ')}].`,
    }
  }
  const token = (chain.settlementTokens ?? []).find((t) => t.authorization === 'algorand-group') ?? null
  if (!token) {
    return {
      configured: false, network: caip2, facilitatorNetwork: facilitatorNetworkFor(caip2), chain: chain.id,
      token: null, payTo: null, facilitator, tag,
      reason: `${chain.name} declares no algorand-group settlement token in the registry.`,
    }
  }
  const payTo = payToFor(chain, env)
  if (!payTo) {
    return {
      configured: false, network: caip2, facilitatorNetwork: facilitatorNetworkFor(caip2), chain: chain.id,
      token, payTo: null, facilitator, tag,
      reason:
        'No valid payTo account is set (X402_ALGORAND_PAYTO or the per-network variant). ' +
        'A malformed address is treated as unset: refusing beats receiving into a typo.',
    }
  }
  return {
    configured: true, network: caip2, facilitatorNetwork: facilitatorNetworkFor(caip2), chain: chain.id,
    token, payTo, facilitator, tag,
  }
}

/** Every Algorand chain in the registry, for the status route's per-network view. */
export function algorandChains(): ChainDescriptor[] {
  return CHAINS.filter((c) => c.ecosystem === 'algorand')
}

/**
 * Whether the payTo account is opted in to the settlement ASA, read live from
 * algod. The one Algorand prerequisite with no EVM analogue: an un-opted-in
 * payTo makes every settlement fail with a receiver error that reads as our
 * bug rather than the missing 0.1 ALGO opt-in it actually is.
 */
export async function payToOptInCheck(
  status: AlgorandRailStatus,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<{ checked: boolean; optedIn?: boolean; reason?: string }> {
  if (!status.configured || !status.chain || !status.payTo || !status.token) {
    return { checked: false, reason: 'rail not configured' }
  }
  const chain = getChainById(status.chain)
  if (!chain) return { checked: false, reason: 'chain missing from registry' }
  const rpc = (env[chain.rpcEnvVar ?? ''] || chain.rpcUrls[0] || '').replace(/\/$/, '')
  try {
    const res = await fetcher(`${rpc}/v2/accounts/${status.payTo}/assets/${status.token.address}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return { checked: true, optedIn: false, reason: 'payTo holds no opt-in for the settlement ASA' }
    if (!res.ok) return { checked: false, reason: `algod answered HTTP ${res.status}` }
    return { checked: true, optedIn: true }
  } catch (e) {
    return { checked: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

// ── pricing and the challenge ──────────────────────────────────────────────────────

/**
 * Algorand's own price list: ten times the shared base list. The shared list stays where it
 * is on purpose, because the X Layer ASP, the EIP-3009 rails, Stellar and the Gateway rail
 * charge it and the OKX listings are registered against it. On Algorand the leaderboard the
 * challenge is judged by counts USDC processed, and a tenth of a cent per verdict made every
 * real call nearly invisible there. The test suite pins both lists.
 */
export const ALGORAND_PRICES_USD: Record<RailToolName, number> = {
  verify_agent: 0.01,
  reputation_score: 0.02,
  risk_check: 0.05,
  agent_passport: 0.1,
}

/** Per agent in a batch audit: a fifth under a single risk_check, for buying in bulk. */
export const ALGORAND_BATCH_PER_AGENT_USD = 0.04
export const ALGORAND_BATCH_MAX_AGENTS = BATCH_MAX_AGENTS
/** The size a batch challenge is quoted at when the caller names none. */
export const ALGORAND_BATCH_DEFAULT_QUOTE = 10

export function clampBatchCount(count: unknown): number {
  const n = Math.floor(Number(count))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, ALGORAND_BATCH_MAX_AGENTS)
}

export type AlgorandPrice = { baseUsd: number; totalUsd: number; unitUsd?: number; count?: number }

export function algorandRailPriceUsd(tool: AlgorandToolName, count: number = 1): AlgorandPrice {
  if (tool === ALGORAND_BATCH_TOOL) {
    const n = clampBatchCount(count)
    const total = Math.round(ALGORAND_BATCH_PER_AGENT_USD * n * 1e6) / 1e6
    return { baseUsd: total, totalUsd: total, unitUsd: ALGORAND_BATCH_PER_AGENT_USD, count: n }
  }
  // No settlement fee: the facilitator pays the network fee today. If that ever
  // changes, the fee belongs on the chain's settlement token with a measured
  // feeBasis, exactly as the EVM rails record theirs.
  const baseUsd = ALGORAND_PRICES_USD[tool]
  return { baseUsd, totalUsd: baseUsd }
}

export function algorandAmountRaw(tool: AlgorandToolName, token: SettlementToken, count: number = 1): bigint {
  return BigInt(Math.round(algorandRailPriceUsd(tool, count).totalUsd * 10 ** token.decimals))
}

export function algorandRailResource(tool: AlgorandToolName, env: NodeJS.ProcessEnv = process.env): string {
  return `${algorandResourceOrigin(env)}/api/x402/algorand/tools/${tool}`
}

// ── discovery: what the Bazaar catalog and the agents browsing it see ──────────────────

type AlgorandListing = {
  /** Shown in the Bazaar catalog, so it names what the caller receives, not the topic. */
  description: string
  /** A valid example request body. */
  body: Record<string, unknown>
  /** JSON Schema of the request body. */
  bodySchema: Record<string, unknown>
  /** Illustrative response: the field names are the live response's, the values are examples. */
  example: Record<string, unknown>
}

const AGENT_ID_SCHEMA = { type: 'string', minLength: 1, description: RAIL_TOOL_CARDS.verify_agent.input.agentId }
const AGENT_ONLY_BODY = { type: 'object', properties: { agentId: AGENT_ID_SCHEMA }, required: ['agentId'] }
const TX_CONTEXT_SCHEMA = {
  type: 'object',
  description: 'Optional deal context the verdict is sized to.',
  properties: { amountUsd: { type: 'number', minimum: 0 }, chain: { type: 'string' }, kind: { type: 'string' } },
}
const EXAMPLE_TIME = '2026-09-12T00:00:00.000Z'

export const ALGORAND_LISTINGS: Record<AlgorandToolName, AlgorandListing> = {
  verify_agent: {
    description:
      'Verify an AI agent before you pay it: whether its ERC-8004 on-chain identity resolves, its KYA ' +
      '(Know Your Agent) status, whether it has been revoked, and a live probe of its endpoint. POST a JSON body with agentId.',
    body: { agentId: '#0' },
    bodySchema: AGENT_ONLY_BODY,
    example: {
      tool: 'verify_agent', agentId: '#0', verified: true, kya_status: 'verified', revoked: false,
      liveness: { checked: true, reachable: true, httpStatus: 200 },
      identity: { tokenId: '0', chain: 'rhchain', valid: true, partial: false },
      source: 'onchain', checkedAt: EXAMPLE_TIME,
    },
  },
  reputation_score: {
    description:
      'Reputation of an AI agent as a deterministic 0-1000 score, with the breakdown behind it (settlements, ' +
      'validations, tenure, behavior, discipline), a Sybil signal, and the latest on-chain attestation of the score. POST a JSON body with agentId.',
    body: { agentId: '#0' },
    bodySchema: AGENT_ONLY_BODY,
    example: {
      tool: 'reputation_score', agentId: '#0', score: 612,
      breakdown: { settlement: 240, validation: 150, tenure: 90, behavior: 92, discipline: 40 },
      sybil: { level: 'low' }, settledOnchain: 12, settledUsd: 3.4, basis: 'on-chain settlements and validations',
      computedAt: EXAMPLE_TIME,
    },
  },
  risk_check: {
    description:
      'Pre-payment ALLOW / WARN / DENY verdict on an AI agent counterparty, with the reasons and the signals ' +
      'behind it. Add txContext.amountUsd to size the check to the deal. POST a JSON body with agentId.',
    body: { agentId: '#0', txContext: { amountUsd: 25 } },
    bodySchema: {
      type: 'object',
      properties: { agentId: AGENT_ID_SCHEMA, txContext: TX_CONTEXT_SCHEMA },
      required: ['agentId'],
    },
    example: {
      tool: 'risk_check', agentId: '#0', decision: 'ALLOW', risk: 'low', reasons: [],
      signals: { onchainVerified: true, kyaVerified: true, reputationScore: 612, tenureDays: 41, revoked: false, txContext: { amountUsd: 25 } },
      checkedAt: EXAMPLE_TIME,
    },
  },
  agent_passport: {
    description:
      'Full trust passport for an AI agent in one JSON document: on-chain identity, KYA status, 0-1000 ' +
      'reputation with its breakdown, and the ALLOW / WARN / DENY risk verdict. POST a JSON body with agentId.',
    body: { agentId: '#0' },
    bodySchema: AGENT_ONLY_BODY,
    example: {
      tool: 'agent_passport', agentId: '#0', standard: 'ERC-8004', verified: true,
      kya: { status: 'verified', revoked: false },
      reputation: { score: 612 },
      risk: { decision: 'ALLOW', level: 'low', reasons: [] },
      tenureDays: 41, issuedAt: EXAMPLE_TIME,
    },
  },
  agent_batch_audit: {
    description:
      `Batch trust audit for up to ${BATCH_MAX_AGENTS} AI agents in one paid call: an ALLOW / WARN / DENY verdict, ` +
      'risk level, reasons and reputation score for every agent, plus a summary count. ' +
      `${ALGORAND_BATCH_PER_AGENT_USD} USDC per agent; quote a size with ?count=N, then POST a JSON body with agentIds.`,
    body: { agentIds: ['#0', '#1'], txContext: { amountUsd: 25 } },
    bodySchema: {
      type: 'object',
      properties: {
        agentIds: { type: 'array', minItems: 1, maxItems: BATCH_MAX_AGENTS, items: AGENT_ID_SCHEMA },
        txContext: TX_CONTEXT_SCHEMA,
      },
      required: ['agentIds'],
    },
    example: {
      tool: 'agent_batch_audit', count: 2, summary: { ALLOW: 1, WARN: 0, DENY: 1 },
      results: [
        { agentId: '#0', decision: 'ALLOW', risk: 'low', reasons: [], reputationScore: 612, onchainVerified: true, kyaVerified: true, revoked: false },
        {
          agentId: '#1', decision: 'DENY', risk: 'high', reasons: ['No verifiable on-chain identity (ERC-8004) found for this agent'],
          reputationScore: 0, onchainVerified: false, kyaVerified: false, revoked: false,
        },
      ],
      checkedAt: EXAMPLE_TIME,
    },
  },
}

/** The x402 v2 resource object for one tool. */
export function algorandResourceInfo(tool: AlgorandToolName, env: NodeJS.ProcessEnv = process.env): { url: string; description: string; mimeType: string } {
  return { url: algorandRailResource(tool, env), description: ALGORAND_LISTINGS[tool].description, mimeType: 'application/json' }
}

/**
 * The Bazaar discovery declaration, in the exact shape @x402-avm/extensions builds for a
 * JSON-body route after the resource server has stamped the method on it. The facilitator
 * validates `info` against `schema` with Ajv and silently drops a declaration that fails, so
 * the test suite runs the same validation rather than trusting the shape by eye.
 */
export function algorandDiscoveryExtension(tool: AlgorandToolName): Record<string, unknown> {
  const listing = ALGORAND_LISTINGS[tool]
  return {
    bazaar: {
      info: {
        input: { type: 'http', method: 'POST', bodyType: 'json', body: listing.body },
        output: { type: 'json', example: listing.example },
      },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'http' },
              method: { type: 'string', enum: ['POST'] },
              bodyType: { type: 'string', enum: ['json'] },
              body: listing.bodySchema,
            },
            required: ['type', 'method', 'bodyType', 'body'],
            additionalProperties: false,
          },
          output: {
            type: 'object',
            properties: { type: { type: 'string' }, example: { type: 'object' } },
            required: ['type'],
          },
        },
        required: ['input'],
      },
    },
  }
}

/** The x402 v2 PaymentRequired object, served as JSON body AND (by the route)
 *  as a base64 PAYMENT-REQUIRED header, since v2 clients read the header and
 *  v1-era ones read the body. A batch challenge is quoted for `count` agents. */
export function algorandRailChallenge(
  tool: AlgorandToolName,
  status: AlgorandRailStatus,
  env: NodeJS.ProcessEnv = process.env,
  quote: { count?: number } = {},
): { httpStatus: number; body: Record<string, unknown> } {
  if (!status.configured || !status.token || !status.payTo || !status.facilitatorNetwork) {
    return {
      httpStatus: 501,
      body: { error: 'Algorand x402 rail not configured', reason: status.reason ?? 'unconfigured' },
    }
  }
  const isBatch = tool === ALGORAND_BATCH_TOOL
  const count = isBatch ? clampBatchCount(quote.count ?? ALGORAND_BATCH_DEFAULT_QUOTE) : 1
  const price = algorandRailPriceUsd(tool, count)
  const amount = algorandAmountRaw(tool, status.token, count).toString()
  return {
    httpStatus: 402,
    body: {
      x402Version: 2,
      resource: algorandResourceInfo(tool, env),
      accepts: [
        {
          scheme: 'exact',
          network: status.facilitatorNetwork,
          amount,
          // Emitted alongside `amount` for pre-v2 clients that still read it.
          maxAmountRequired: amount,
          asset: status.token.address,
          payTo: status.payTo,
          maxTimeoutSeconds: 120,
          extra: {
            decimals: status.token.decimals,
            ...(status.tag ? { tag: status.tag } : {}),
          },
        },
      ],
      // The Bazaar reads this back from the buyer's payment payload; the settle path also
      // forwards it itself, so a buyer that does not echo extensions still gets us listed.
      extensions: algorandDiscoveryExtension(tool),
      ...(isBatch
        ? {
            pricing: {
              unitUsd: price.unitUsd,
              count: price.count,
              totalUsd: price.totalUsd,
              maxAgents: ALGORAND_BATCH_MAX_AGENTS,
              note:
                'Quoted for `count` agents (?count=N, 1 to 50). A paid call is priced by the number of distinct ' +
                'agentIds it sends: paying for at least that many is accepted, paying for fewer is refused with a fresh quote.',
            },
          }
        : {}),
      error: 'payment required',
      facilitator: status.facilitator,
      note:
        'Sign an ASA transfer of `amount` base units of the asset to payTo with fee 0, group it ' +
        'with an unsigned fee-payer transaction per the AVM exact scheme, and POST with the ' +
        'PAYMENT-SIGNATURE header (X-PAYMENT is accepted as the legacy alias).',
    },
  }
}

export function algorandRailPaywallGate(status: AlgorandRailStatus): { ok: true } | { ok: false; httpStatus: number; body: unknown } {
  if (status.configured) return { ok: true }
  return {
    ok: false,
    httpStatus: 501,
    body: {
      error: 'Algorand x402 rail not configured',
      reason: status.reason ?? 'unconfigured',
      note: 'Fail-closed on purpose: an unconfigured paywall refuses rather than serving free.',
    },
  }
}

export function algorandRailLimits(status: AlgorandRailStatus, env: NodeJS.ProcessEnv = process.env): { minValueUsd: number; maxValueUsd: number } {
  void status
  const min = Number(env.X402_ALGORAND_MIN_VALUE_USD ?? '0.001')
  const max = Number(env.X402_ALGORAND_MAX_VALUE_USD ?? '5')
  return {
    minValueUsd: Number.isFinite(min) && min > 0 ? min : 0.001,
    maxValueUsd: Number.isFinite(max) && max > 0 ? max : 5,
  }
}

// ── serving a paid call ────────────────────────────────────────────────────────────

export type AlgorandRailToolInput = { agentId: string; txContext?: TxContext | null; agentIds?: string[] }
export type AlgorandRailHandlers = Record<AlgorandToolName, (input: AlgorandRailToolInput) => Promise<unknown>>
export type AlgorandRailServeDeps = AlgorandSettleDeps & {
  handlers?: AlgorandRailHandlers
}

function algorandHandlers(status: AlgorandRailStatus): AlgorandRailHandlers {
  const meta = <T extends Record<string, unknown>>(result: T) => ({
    ...result,
    _meta: {
      ...((result._meta as Record<string, unknown>) ?? {}),
      settlement: {
        network: status.network,
        asset: status.token?.address,
        assetSymbol: status.token?.symbol,
        facilitator:
          'the answer was produced before the payment was submitted; the GoPlausible facilitator broadcast ' +
          'the atomic group and paid its pooled fee, and we confirmed the transfer from an indexer before releasing it',
      },
    },
  })
  return {
    verify_agent: async (i) => meta(await verifyAgent(i.agentId)),
    reputation_score: async (i) => meta(await reputationScore(i.agentId)),
    risk_check: async (i) => meta(await riskCheck(i.agentId, i.txContext ?? null)),
    agent_passport: async (i) => meta(await agentPassport(i.agentId)),
    agent_batch_audit: async (i) => {
      const audit = await runBatchAudit(i.agentIds ?? [], i.txContext ?? null)
      if (!audit.ok) throw new Error(audit.reason)
      return meta(audit.result)
    },
  }
}

/**
 * The full paid-call path for one tool. Status contract: 501 unconfigured, 402 fixable
 * (fresh challenge), 503 the tool could not answer so nothing was settled, 502 our side,
 * 202 unconfirmed, 200 the money moved, we read it ourselves, and the answer is attached.
 */
export async function algorandRailServeTool(
  tool: AlgorandToolName,
  input: AlgorandRailToolInput,
  paymentHeader: string,
  status: AlgorandRailStatus,
  deps: AlgorandRailServeDeps = {},
): Promise<{ httpStatus: number; body: unknown }> {
  const env = deps.env ?? process.env
  const gate = algorandRailPaywallGate(status)
  if (!gate.ok) return { httpStatus: gate.httpStatus, body: gate.body }

  const isBatch = tool === ALGORAND_BATCH_TOOL
  const count = isBatch ? (input.agentIds?.length ?? 0) : 1
  if (isBatch && (count < 1 || count > ALGORAND_BATCH_MAX_AGENTS)) {
    return { httpStatus: 400, body: { error: `agentIds must name 1 to ${ALGORAND_BATCH_MAX_AGENTS} agents`, received: count } }
  }
  const quote = { count }

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
  } catch {
    const challenge = algorandRailChallenge(tool, status, env, quote)
    return { httpStatus: challenge.httpStatus, body: { ...challenge.body, reason: 'the payment header is not base64-encoded JSON' } }
  }

  // A buyer who paid on one of the offered networks settles on THAT one; a
  // network we do not sell on is refused rather than silently redirected.
  const paidNetwork = (payload as { network?: unknown })?.network
  let chosen = status
  if (typeof paidNetwork === 'string' && paidNetwork.trim() && algorandCaip2Of(paidNetwork) !== status.network) {
    const s = algorandRailStatus(env, paidNetwork)
    if (!s.configured) {
      const challenge = algorandRailChallenge(tool, status, env, quote)
      return {
        httpStatus: challenge.httpStatus,
        body: { ...challenge.body, reason: s.reason ?? `this rail does not settle on '${paidNetwork}'` },
      }
    }
    chosen = s
  }

  const chain = chosen.chain ? getChainById(chosen.chain) : undefined
  if (!chain || !chosen.token || !chosen.payTo) {
    return { httpStatus: 501, body: { error: 'Algorand x402 rail not configured', reason: 'network descriptor missing from the registry' } }
  }

  const price = algorandRailPriceUsd(tool, count)
  const requirements: AlgorandRequirements = {
    network: chain.caip2,
    facilitatorNetwork: chosen.facilitatorNetwork!,
    asset: chosen.token.address,
    payTo: chosen.payTo,
    amount: algorandAmountRaw(tool, chosen.token, count).toString(),
    resource: algorandRailResource(tool, env),
    // What the facilitator attributes and catalogs the sale by. The tag used to stop at the
    // 402: the settle body carried only decimals, so every sale landed in the leaderboard's
    // "direct" bucket instead of the challenge one.
    tag: chosen.tag,
    resourceInfo: algorandResourceInfo(tool, env),
    extensions: algorandDiscoveryExtension(tool),
  }

  // The answer is produced after the facilitator verified the payment and before anything is
  // submitted, then released only once the transfer is confirmed. A tool that fails here, or a
  // batch that misses its deadline, costs the buyer nothing.
  const handlers = deps.handlers ?? algorandHandlers(chosen)
  const produced: { body?: unknown } = {}
  const beforeSettle = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    try {
      produced.body = await handlers[tool](input)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  let settled: Awaited<ReturnType<typeof settleAlgorandPayment>>
  try {
    settled = await settleAlgorandPayment({
      chain,
      token: chosen.token,
      requirements,
      payload,
      facilitator: chosen.facilitator,
      deps: { ...deps, beforeSettle, meta: { tool, baseUsd: price.baseUsd } },
    })
  } catch (e) {
    return {
      httpStatus: 502,
      body: {
        error: 'settlement failed',
        code: 'unexpected',
        reason: e instanceof Error ? e.message : String(e),
        note: 'Nothing was served. Any settlement that did land will appear in GET /api/x402/algorand/proof.',
      },
    }
  }

  if (!settled.success) {
    if (settled.code === 'service_unavailable') {
      return {
        httpStatus: 503,
        body: {
          error: 'the answer could not be produced, so nothing was settled',
          code: settled.code,
          reason: settled.errorReason,
          note:
            'The tool runs before the payment is submitted. Your signed payment was never broadcast and no money ' +
            "moved; the same payment can be retried until its group's lastValid round passes." +
            (isBatch ? ' A batch that keeps missing its deadline will fit with fewer agentIds.' : ''),
        },
      }
    }
    const retryable: string[] = [
      'malformed_payload', 'unsupported_network', 'unsupported_asset', 'wrong_recipient', 'wrong_amount',
      'wrong_transaction_type', 'unsafe_group', 'unsigned_payment', 'facilitator_rejected', 'already_redeemed',
    ]
    if (retryable.includes(settled.code)) {
      const challenge = algorandRailChallenge(tool, status, env, quote)
      return { httpStatus: challenge.httpStatus, body: { ...challenge.body, reason: settled.errorReason } }
    }
    return {
      httpStatus: settled.ambiguous ? 202 : 502,
      body: {
        error: settled.ambiguous ? 'settlement not confirmed' : 'settlement failed',
        code: settled.code,
        reason: settled.errorReason,
        ...(settled.transaction ? { transaction: settled.transaction } : {}),
        ...(settled.ambiguous
          ? {
              ambiguous: true,
              note:
                'The facilitator reported the group submitted, but we could not read the transfer back ' +
                'from an indexer inside the window. Nothing was served and nothing was marked spent. ' +
                'Check the transaction first: if it landed, this same signed group cannot land twice ' +
                '(the protocol deduplicates transaction ids), so being served needs a fresh challenge, ' +
                'which is a second payment. If it never landed, retrying this request is safe until the ' +
                "group's lastValid round passes.",
            }
          : {}),
      },
    }
  }

  return { httpStatus: 200, body: { ...((produced.body ?? {}) as Record<string, unknown>), settlement: settled } }
}

// ── proof ──────────────────────────────────────────────────────────────────────────

/**
 * What the Global x402 Challenge needs from this rail, stated from the code's side only.
 * Whether the facilitator actually attributed the traffic is ITS record, not ours: read it
 * with mcp/scripts/algo-challenge-check.mjs rather than inferring it from this block.
 */
export function algorandChallengeReadiness(status: AlgorandRailStatus, env: NodeJS.ProcessEnv = process.env) {
  return {
    tag: status.tag,
    tagSentToFacilitator: status.tag !== null,
    discovery: 'every tool declares a Bazaar discovery extension in its 402, and the settle path forwards it with each payment',
    resourceOrigin: algorandResourceOrigin(env),
    resources: ALGORAND_TOOLS.map((t) => algorandRailResource(t, env)),
    prices: {
      ...ALGORAND_PRICES_USD,
      agent_batch_audit: { perAgentUsd: ALGORAND_BATCH_PER_AGENT_USD, maxAgents: ALGORAND_BATCH_MAX_AGENTS },
    },
    shape: 'composite: every tool settles to the one payTo above',
    attribution: "decided by the facilitator's leaderboard, not by this backend; read it with mcp/scripts/algo-challenge-check.mjs",
  }
}

export type AlgorandRailProof = {
  rail: 'x402-algorand'
  configured: boolean
  network: string
  chain: string | null
  asset: string | null
  assetSymbol: string | null
  payTo: string | null
  facilitator: string
  totalSettlements: number
  totalUsd: number
  ambiguous: number
  byTool: Record<string, { count: number; usd: number }>
  byNetwork: Record<string, { count: number; usd: number; assetSymbol: string }>
  recent: AlgorandSettlementRecord[]
  note: string
}

export async function algorandRailProof(
  status: AlgorandRailStatus,
  deps: { load?: () => Promise<AlgorandSettlementRecord[]> } = {},
): Promise<AlgorandRailProof> {
  const rows = await (deps.load ?? loadAlgorandSettlements)()
  const settledRows = rows.filter((r) => r.outcome === 'settled')
  const byTool: Record<string, { count: number; usd: number }> = {}
  const byNetwork: Record<string, { count: number; usd: number; assetSymbol: string }> = {}
  for (const r of settledRows) {
    byTool[r.tool] = { count: (byTool[r.tool]?.count ?? 0) + 1, usd: (byTool[r.tool]?.usd ?? 0) + r.amountUsd }
    byNetwork[r.network] = {
      count: (byNetwork[r.network]?.count ?? 0) + 1,
      usd: (byNetwork[r.network]?.usd ?? 0) + r.amountUsd,
      assetSymbol: r.assetSymbol,
    }
  }
  return {
    rail: 'x402-algorand',
    configured: status.configured,
    network: status.network,
    chain: status.chain,
    asset: status.token?.address ?? null,
    assetSymbol: status.token?.symbol ?? null,
    payTo: status.payTo,
    facilitator: status.facilitator,
    totalSettlements: settledRows.length,
    totalUsd: Number(settledRows.reduce((s, r) => s + r.amountUsd, 0).toFixed(6)),
    ambiguous: rows.filter((r) => r.outcome === 'ambiguous').length,
    byTool,
    byNetwork,
    recent: rows.slice(-25),
    note:
      'Every settled row was confirmed by our own indexer read of the ASA transfer, never by the ' +
      "facilitator's word alone. An empty log on a configured rail means nothing has sold here yet, " +
      'and this rail would rather show you zero than a simulation.',
  }
}
