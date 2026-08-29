/**
 * The Algorand (AVM) x402 rail: sell the four trust tools for USDC on Algorand,
 * mainnet and testnet, over x402 v2's "exact" scheme.
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
 *  - There is no settlement fee on top of the base price: the facilitator
 *    currently covers network fees, so charging one would be a markup wearing
 *    a cost's name.
 *
 * Env (all optional; unset means this rail is a labeled 501, never a mock):
 *   X402_ALGORAND_NETWORKS        CSV of CAIP-2 ids from the registry
 *   X402_ALGORAND_PAYTO           default receiving account (58-char address)
 *   X402_ALGORAND_MAINNET_PAYTO / X402_ALGORAND_TESTNET_PAYTO  per-network override
 *   X402_ALGORAND_FACILITATOR     default https://facilitator.goplausible.xyz
 *   X402_ALGORAND_TAG             optional challenge tag (e.g. x402-global-challenge)
 *   X402_ALGORAND_MIN_VALUE_USD / X402_ALGORAND_MAX_VALUE_USD  price rails
 */
import { CHAINS, getChain, getChainById } from '../chains/index.js'
import type { ChainDescriptor, SettlementToken } from '../chains/types.js'
import { isAlgorandAddress } from '../chains/algorand/ids.js'
import { agentPassport, reputationScore, riskCheck, verifyAgent, type TxContext } from '../asp/tools.js'
import { RAIL_BASE_PRICES_USD, RAIL_TOOLS, RAIL_TOOL_CARDS, type RailToolName } from '../x402-3009/rail.js'
import { loadAlgorandSettlements, type AlgorandSettlementRecord } from '../storage.js'
import { settleAlgorandPayment, type AlgorandRequirements, type AlgorandSettleDeps } from './settle.js'

export { RAIL_BASE_PRICES_USD, RAIL_TOOL_CARDS, RAIL_TOOLS }
export type { RailToolName }

export const DEFAULT_FACILITATOR = 'https://facilitator.goplausible.xyz'

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

export function algorandRailPriceUsd(tool: RailToolName): { baseUsd: number; totalUsd: number } {
  const baseUsd = RAIL_BASE_PRICES_USD[tool]
  // No settlement fee: the facilitator pays the network fee today. If that ever
  // changes, the fee belongs on the chain's settlement token with a measured
  // feeBasis, exactly as the EVM rails record theirs.
  return { baseUsd, totalUsd: baseUsd }
}

export function algorandAmountRaw(tool: RailToolName, token: SettlementToken): bigint {
  return BigInt(Math.round(algorandRailPriceUsd(tool).totalUsd * 10 ** token.decimals))
}

export function algorandRailResource(tool: RailToolName): string {
  return `https://a-identity-backend.onrender.com/api/x402/algorand/tools/${tool}`
}

/** The x402 v2 PaymentRequired object, served as JSON body AND (by the route)
 *  as a base64 PAYMENT-REQUIRED header, since v2 clients read the header and
 *  v1-era ones read the body. */
export function algorandRailChallenge(
  tool: RailToolName,
  status: AlgorandRailStatus,
  env: NodeJS.ProcessEnv = process.env,
): { httpStatus: number; body: Record<string, unknown> } {
  void env
  if (!status.configured || !status.token || !status.payTo || !status.facilitatorNetwork) {
    return {
      httpStatus: 501,
      body: { error: 'Algorand x402 rail not configured', reason: status.reason ?? 'unconfigured' },
    }
  }
  const amount = algorandAmountRaw(tool, status.token).toString()
  return {
    httpStatus: 402,
    body: {
      x402Version: 2,
      resource: {
        url: algorandRailResource(tool),
        description: RAIL_TOOL_CARDS[tool].description,
        mimeType: 'application/json',
      },
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

export type AlgorandRailToolInput = { agentId: string; txContext?: TxContext | null }
export type AlgorandRailServeDeps = AlgorandSettleDeps & {
  handlers?: Record<RailToolName, (input: AlgorandRailToolInput) => Promise<unknown>>
}

function algorandHandlers(status: AlgorandRailStatus): Record<RailToolName, (input: AlgorandRailToolInput) => Promise<unknown>> {
  const meta = <T extends Record<string, unknown>>(result: T) => ({
    ...result,
    _meta: {
      ...((result._meta as Record<string, unknown>) ?? {}),
      settlement: {
        network: status.network,
        asset: status.token?.address,
        assetSymbol: status.token?.symbol,
        facilitator:
          'the GoPlausible facilitator broadcast the atomic group and paid its pooled fee; ' +
          'we confirmed the transfer ourselves from an indexer before serving this answer',
      },
    },
  })
  return {
    verify_agent: async (i) => meta(await verifyAgent(i.agentId)),
    reputation_score: async (i) => meta(await reputationScore(i.agentId)),
    risk_check: async (i) => meta(await riskCheck(i.agentId, i.txContext ?? null)),
    agent_passport: async (i) => meta(await agentPassport(i.agentId)),
  }
}

/**
 * The full paid-call path for one tool. Same status contract as the Stellar rail:
 * 501 unconfigured, 402 fixable (fresh challenge), 502 our side, 202 unconfirmed,
 * 200 the money moved and we read it ourselves.
 */
export async function algorandRailServeTool(
  tool: RailToolName,
  input: AlgorandRailToolInput,
  paymentHeader: string,
  status: AlgorandRailStatus,
  deps: AlgorandRailServeDeps = {},
): Promise<{ httpStatus: number; body: unknown }> {
  const env = deps.env ?? process.env
  const gate = algorandRailPaywallGate(status)
  if (!gate.ok) return { httpStatus: gate.httpStatus, body: gate.body }

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
  } catch {
    const challenge = algorandRailChallenge(tool, status, env)
    return { httpStatus: challenge.httpStatus, body: { ...challenge.body, reason: 'the payment header is not base64-encoded JSON' } }
  }

  // A buyer who paid on one of the offered networks settles on THAT one; a
  // network we do not sell on is refused rather than silently redirected.
  const paidNetwork = (payload as { network?: unknown })?.network
  let chosen = status
  if (typeof paidNetwork === 'string' && paidNetwork.trim() && algorandCaip2Of(paidNetwork) !== status.network) {
    const s = algorandRailStatus(env, paidNetwork)
    if (!s.configured) {
      const challenge = algorandRailChallenge(tool, status, env)
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

  const price = algorandRailPriceUsd(tool)
  const requirements: AlgorandRequirements = {
    network: chain.caip2,
    facilitatorNetwork: chosen.facilitatorNetwork!,
    asset: chosen.token.address,
    payTo: chosen.payTo,
    amount: algorandAmountRaw(tool, chosen.token).toString(),
    resource: algorandRailResource(tool),
  }

  let settled: Awaited<ReturnType<typeof settleAlgorandPayment>>
  try {
    settled = await settleAlgorandPayment({
      chain,
      token: chosen.token,
      requirements,
      payload,
      facilitator: chosen.facilitator,
      deps: { ...deps, meta: { tool, baseUsd: price.baseUsd } },
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
    const retryable: string[] = [
      'malformed_payload', 'unsupported_network', 'unsupported_asset', 'wrong_recipient', 'wrong_amount',
      'wrong_transaction_type', 'unsafe_group', 'unsigned_payment', 'facilitator_rejected', 'already_redeemed',
    ]
    if (retryable.includes(settled.code)) {
      const challenge = algorandRailChallenge(tool, status, env)
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

  const handlers = deps.handlers ?? algorandHandlers(chosen)
  try {
    const body = await handlers[tool](input)
    return { httpStatus: 200, body: { ...(body as Record<string, unknown>), settlement: settled } }
  } catch (e) {
    return {
      httpStatus: 500,
      body: {
        error: 'tool failed after settlement',
        reason: e instanceof Error ? e.message : String(e),
        settlement: settled,
        note: 'Your payment settled on-chain and is recorded. This failure is on our side.',
      },
    }
  }
}

// ── proof ──────────────────────────────────────────────────────────────────────────

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
