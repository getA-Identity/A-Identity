/**
 * The seller side of the self-facilitated EIP-3009 rail: configuration, prices, the 402
 * challenge, the paid-call path, and the proof aggregation behind it.
 *
 * Two things here differ from the Celo rail on purpose.
 *
 * 1. The 402 challenge carries a PROVEN EIP-712 domain (see domain.ts). If the domain
 *    cannot be proven we serve no challenge at all: inviting a buyer to sign against a
 *    guessed domain produces an authorization nobody can settle, and the buyer cannot
 *    tell whose fault that is.
 * 2. The price is split into a base price and a DISCLOSED settlement fee. On this rail we
 *    broadcast for the buyer, so a settlement costs us real gas - materially more than
 *    the cheapest tool's base price. Hiding that in a marked-up price would be the
 *    dishonest version of the same number; naming it is a facilitator fee. The base
 *    prices stay byte-identical to every other rail we sell on.
 *
 * The tools sold are the same pure exports of asp/tools.ts the other rails use, imported
 * read-only. No ASP route, gateway, price or schema is touched.
 */
import {
  getChain,
  getChainById,
  tokenUnits,
  fromTokenUnits,
  type ChainDescriptor,
  type SettlementToken,
} from '../chains/index.js'
import { verifyAgent, reputationScore, riskCheck, agentPassport, type TxContext } from '../asp/tools.js'
import { loadX402Settlements, X402_SETTLEMENTS_CAP, type X402SettlementRecord } from '../storage.js'
import { provenDomainCached } from './domain.js'
import { settlePayment, type Limits, type Requirements, type EngineDeps } from './engine.js'

type Hex = `0x${string}`

// ── the tools sold ────────────────────────────────────────────────────────────────

export const RAIL_TOOLS = ['verify_agent', 'reputation_score', 'risk_check', 'agent_passport'] as const
export type RailToolName = (typeof RAIL_TOOLS)[number]

/** Per-call BASE prices. The SAME numbers every other rail charges (asp/payment.ts
 *  PRICES and CELO_TOOL_PRICES_USD), pinned by the tests so the three cannot drift. */
export const RAIL_BASE_PRICES_USD: Record<RailToolName, number> = {
  verify_agent: 0.001,
  reputation_score: 0.002,
  risk_check: 0.005,
  agent_passport: 0.01,
}

const AGENT_ID_DOC = 'ERC-8004 token id ("#0"), a CAIP id, or a 0x owner address'

export const RAIL_TOOL_CARDS: Record<
  RailToolName,
  { description: string; input: Record<string, string>; example: Record<string, unknown> }
> = {
  verify_agent: {
    description: 'Verify an AI agent: ERC-8004 identity + KYA status + endpoint liveness.',
    input: { agentId: AGENT_ID_DOC },
    example: { agentId: '#0' },
  },
  reputation_score: {
    description: 'Deterministic 0-1000 reputation with a full breakdown, plus a live read of this chain\'s ERC-8004 registries for the agent.',
    input: { agentId: AGENT_ID_DOC },
    example: { agentId: '#0' },
  },
  risk_check: {
    description: 'Pre-transaction ALLOW / WARN / DENY verdict on a counterparty, with reasons.',
    input: { agentId: AGENT_ID_DOC, txContext: 'optional { amountUsd, chain, kind }' },
    example: { agentId: '#0', txContext: { amountUsd: 25 } },
  },
  agent_passport: {
    description: 'The full identity + reputation + risk passport in one JSON document.',
    input: { agentId: AGENT_ID_DOC },
    example: { agentId: '#0' },
  },
}

// ── configuration (fail-closed) ───────────────────────────────────────────────────

export type RailStatus = {
  configured: boolean
  /** CAIP-2 id of the settlement network. */
  network: string
  /** Registry slug of the resolved chain, null if unresolvable. */
  chain: string | null
  token: SettlementToken | null
  payTo: string | null
  settlementFeeUsd: number
  minValueUsd: number
  maxValueUsd: number
  /** True when a third-party payTo may use /settle. Off by default: we pay the gas. */
  publicSettle: boolean
  allowedPayTo: string[]
  reason?: string
}

const DEFAULTS = {
  settlementFeeUsd: 0.02,
  maxValueUsd: 1,
  expiryHeadroomSec: 60,
  /** ~0.0004 ETH at 0.05 gwei is far above one settlement and far below a wallet. */
  maxGasWei: 20_000_000_000_000n,
  dailyGasWei: 500_000_000_000_000n,
  timeoutMs: 60_000,
} as const

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function big(env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  try {
    const v = BigInt(raw)
    return v > 0n ? v : fallback
  } catch {
    return fallback
  }
}

/**
 * The settlement token this rail uses on a chain: the one the env names, else the first
 * EIP-3009 token the descriptor declares. A chain with none cannot host this rail.
 *
 * DO NOT loosen the `=== 'eip3009'` filter. It looks like an oversight now that
 * `authorization` also admits `'soroban-auth'`, and it is not: this whole module is
 * viem, EIP-712 typed data, secp256k1 recovery and ERC-20 `Transfer` log parsing. A
 * Soroban token reaching it would be signed against a domain that does not exist and
 * settled through a function the SEP-41 contract does not have. Being structurally
 * invisible here is what lets the Stellar rail land next door without any blast radius.
 * The Soroban equivalent lives in x402-stellar/ and filters for its own kind.
 */
export function railToken(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): SettlementToken | null {
  const wanted = env.X402_3009_ASSET_SYMBOL?.trim()
  const usable = (chain.settlementTokens ?? []).filter((t) => t.authorization === 'eip3009')
  if (!usable.length) return null
  if (wanted) return usable.find((t) => t.symbol.toLowerCase() === wanted.toLowerCase()) ?? null
  return usable[0]
}

/**
 * Every settlement network this rail is configured to sell on, in configured order.
 *
 * X402_3009_NETWORKS (comma-separated) is the multi-chain form; X402_3009_NETWORK stays
 * accepted as the single-chain form so an existing deployment keeps working untouched.
 * The first entry is the default when a request does not name one.
 */
export function railNetworks(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.X402_3009_NETWORKS?.trim() || env.X402_3009_NETWORK?.trim() || ''
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

/**
 * Resolve the rail's configuration for one network.
 *
 * `network` picks among the configured ones and accepts either spelling a buyer might
 * send, the CAIP-2 id or the registry slug. An unconfigured network resolves to nothing
 * rather than silently falling back, because settling on a chain the seller did not
 * choose would be worse than refusing.
 */
export function railStatus(env: NodeJS.ProcessEnv = process.env, network?: string): RailStatus {
  const configuredIds = railNetworks(env)
  const wanted = network?.trim()
  let requested = configuredIds[0] ?? ''
  if (wanted) {
    const match = configuredIds.find((id) => {
      const c = getChain(id) ?? getChainById(id)
      return id === wanted || c?.caip2 === wanted || c?.id === wanted
    })
    requested = match ?? wanted
  }
  const chain = requested ? (getChain(requested) ?? getChainById(requested) ?? null) : null
  const configuredHere = !wanted || configuredIds.some((id) => {
    const c = getChain(id) ?? getChainById(id)
    return c && chain && c.caip2 === chain.caip2
  })
  const payToRaw = env.X402_3009_PAYTO?.trim() ?? ''
  const payTo = /^0x[0-9a-fA-F]{40}$/.test(payToRaw) ? payToRaw.toLowerCase() : null
  // The measured fee travels with the token in the registry, so it cannot drift from
  // the chain it was measured on.
  const measured = chain ? railToken(chain, env)?.settlementFeeUsd : undefined
  // A single global fee across chains whose gas differs by an order of magnitude would
  // charge one chain's measured cost on another, which is precisely what the per-chain
  // measurement exists to prevent. The override is therefore honored only when this rail
  // sells on exactly one chain, where it cannot be applied to a chain it was not meant for.
  const singleChain = configuredIds.length <= 1
  const settlementFeeUsd = singleChain
    ? num(env, 'X402_3009_SETTLEMENT_FEE_USD', measured ?? DEFAULTS.settlementFeeUsd)
    : (measured ?? DEFAULTS.settlementFeeUsd)
  // The floor exists so every accepted settlement covers the gas we spend on it, and the
  // fee is what covers that gas. Deriving it from the cheapest thing we sell on THIS chain
  // means it cannot drift when a fee changes, and it cannot accidentally price out a chain
  // whose gas is cheaper - which is exactly what a hardcoded floor did the first time a
  // second chain was added.
  const cheapest = Math.min(...Object.values(RAIL_BASE_PRICES_USD))
  const minValueUsd = num(env, 'X402_3009_MIN_VALUE_USD', Number((cheapest + settlementFeeUsd).toFixed(6)))
  const maxValueUsd = num(env, 'X402_3009_MAX_VALUE_USD', DEFAULTS.maxValueUsd)
  const publicSettle = env.X402_3009_PUBLIC_SETTLE === 'true'
  const allowedPayTo = (env.X402_3009_ALLOWED_PAYTO ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s))
  const base = { network: requested, chain: chain?.id ?? null, token: null, payTo, settlementFeeUsd, minValueUsd, maxValueUsd, publicSettle, allowedPayTo }

  if (!requested) {
    return { ...base, configured: false, reason: 'x402-3009 rail not configured: set X402_3009_NETWORKS to one or more CAIP-2 ids of chains that declare an EIP-3009 settlement token' }
  }
  if (!configuredHere) {
    return { ...base, configured: false, reason: `this rail does not sell on '${requested}'. Configured networks: ${configuredIds.join(', ') || 'none'}` }
  }
  if (!chain) {
    return { ...base, configured: false, reason: `'${requested}' is not a chain in the registry` }
  }
  const token = railToken(chain, env)
  if (!token) {
    return {
      ...base,
      chain: chain.id,
      network: chain.caip2,
      configured: false,
      reason: `${chain.id} declares no EIP-3009 settlement token, so it cannot host a signed-transfer rail`,
    }
  }
  if (!payTo) {
    return { ...base, chain: chain.id, network: chain.caip2, token, configured: false, reason: 'x402-3009 rail not configured: set X402_3009_PAYTO (0x receiving address)' }
  }
  return { ...base, configured: true, chain: chain.id, network: chain.caip2, token, payTo }
}

/** Unconfigured means 501, never a free serve. */
export function railPaywallGate(
  status: RailStatus,
): { ok: true } | { ok: false; httpStatus: 501; body: { error: string; reason?: string } } {
  if (status.configured) return { ok: true }
  return { ok: false, httpStatus: 501, body: { error: 'x402-3009 rail not configured', ...(status.reason ? { reason: status.reason } : {}) } }
}

export function railLimits(status: RailStatus, env: NodeJS.ProcessEnv = process.env): Limits {
  const decimals = status.token?.decimals ?? 6
  return {
    minValue: tokenUnits(decimals, status.minValueUsd),
    maxValue: tokenUnits(decimals, status.maxValueUsd),
    expiryHeadroomSec: num(env, 'X402_3009_EXPIRY_HEADROOM_SEC', DEFAULTS.expiryHeadroomSec),
    maxGasWei: big(env, 'X402_3009_MAX_GAS_WEI', DEFAULTS.maxGasWei),
    dailyGasWei: big(env, 'X402_3009_DAILY_GAS_WEI', DEFAULTS.dailyGasWei),
  }
}

/** Total charged for a tool: base plus the disclosed settlement fee. */
export function railPriceUsd(tool: RailToolName, status: RailStatus): { baseUsd: number; settlementFeeUsd: number; totalUsd: number } {
  const baseUsd = RAIL_BASE_PRICES_USD[tool]
  const settlementFeeUsd = status.settlementFeeUsd
  return { baseUsd, settlementFeeUsd, totalUsd: Number((baseUsd + settlementFeeUsd).toFixed(6)) }
}

export function railResource(tool: RailToolName): string {
  return `/api/x402/tools/${tool}`
}

// ── the 402 challenge ─────────────────────────────────────────────────────────────

export type RailChallengeResult =
  | { httpStatus: 402; body: Record<string, unknown> }
  | { httpStatus: 501 | 503; body: { error: string; reason?: string } }

/**
 * Build the challenge for one tool. Returns 503 rather than 402 when the token's signing
 * domain cannot be proven: a challenge we cannot settle against is worse than no
 * challenge, because the buyer would sign and lose the round trip with no way to know why.
 */
export async function railChallenge(
  tool: RailToolName,
  status: RailStatus,
  deps: EngineDeps = {},
  verifyError?: string,
): Promise<RailChallengeResult> {
  // One entry per configured chain. `accepts` is an ARRAY in the x402 spec precisely so a
  // seller can offer several ways to pay and the buyer picks by paying one of them, which
  // is better than making the buyer guess a query parameter. A chain whose domain cannot
  // be proven right now is simply absent from the list rather than offered and unpayable.
  const others = railNetworks(deps.env ?? process.env).filter((n) => {
    const s = railStatus(deps.env ?? process.env, n)
    return s.configured && s.chain !== status.chain
  })
  const gate = railPaywallGate(status)
  if (!gate.ok) return { httpStatus: gate.httpStatus, body: gate.body }
  const chain = status.chain ? getChainById(status.chain) : undefined
  if (!chain || !status.token || !status.payTo) {
    return { httpStatus: 501, body: { error: 'x402-3009 rail not configured', reason: 'network descriptor missing from the registry' } }
  }
  const domain = await provenDomainCached(chain, status.token, deps)
  if (!domain.ok) {
    return {
      httpStatus: 503,
      body: { error: 'settlement token domain unproven', reason: domain.reason },
    }
  }
  const price = railPriceUsd(tool, status)
  const extraAccepts: Record<string, unknown>[] = []
  for (const n of others) {
    const alt = railStatus(deps.env ?? process.env, n)
    const altChain = alt.chain ? getChainById(alt.chain) : undefined
    if (!altChain || !alt.token || !alt.payTo) continue
    const altDomain = await provenDomainCached(altChain, alt.token, deps)
    if (!altDomain.ok) continue
    const altPrice = railPriceUsd(tool, alt)
    extraAccepts.push({
      scheme: 'exact',
      network: altChain.caip2,
      asset: alt.token.address,
      assetSymbol: altDomain.proven.symbol,
      decimals: altDomain.proven.decimals,
      payTo: alt.payTo,
      maxAmountRequired: tokenUnits(altDomain.proven.decimals, altPrice.totalUsd).toString(),
      resource: railResource(tool),
      description: `${RAIL_TOOL_CARDS[tool].description} Settled in ${altDomain.proven.symbol} on ${altChain.name}; you sign, we broadcast.`,
      mimeType: 'application/json',
      maxTimeoutSeconds: 600,
      extra: {
        ...altDomain.proven.domain,
        domainSeparator: altDomain.proven.domainSeparator,
        domainVerified: true,
        versionSource: altDomain.proven.versionSource,
        provenAt: altDomain.proven.provenAt,
      },
    })
  }
  const requirements = {
    scheme: 'exact' as const,
    network: chain.caip2,
    asset: status.token.address,
    assetSymbol: domain.proven.symbol,
    decimals: domain.proven.decimals,
    payTo: status.payTo,
    maxAmountRequired: tokenUnits(domain.proven.decimals, price.totalUsd).toString(),
    resource: railResource(tool),
    description: `${RAIL_TOOL_CARDS[tool].description} Settled in ${domain.proven.symbol} on ${chain.name}; you sign, we broadcast.`,
    mimeType: 'application/json' as const,
    maxTimeoutSeconds: 600,
    // The whole domain, plus the live separator it was proven against, so the buyer can
    // check our arithmetic without trusting us.
    extra: {
      ...domain.proven.domain,
      domainSeparator: domain.proven.domainSeparator,
      domainVerified: true,
      versionSource: domain.proven.versionSource,
      provenAt: domain.proven.provenAt,
    },
  }
  return {
    httpStatus: 402,
    body: {
      x402Version: 2,
      error: 'payment required',
      accepts: [requirements, ...extraAccepts],
      tool: {
        name: tool,
        price: { baseUsd: price.baseUsd, settlementFeeUsd: price.settlementFeeUsd, totalUsd: price.totalUsd },
        priceNote:
          `This rail is gasless for the buyer: you sign an EIP-3009 authorization and we broadcast it, paying the chain gas ourselves. The settlement fee covers that broadcast on THIS chain: ${status.token.feeBasis ?? 'measurement pending'} The base price is identical on every rail we sell on.`,
        ...RAIL_TOOL_CARDS[tool],
        method: `POST ${railResource(tool)}`,
        payment:
          'Sign an EIP-3009 TransferWithAuthorization for the asset above using the domain in `extra`, then POST with header X-PAYMENT: base64(JSON of {x402Version:2, scheme:"exact", network, payload:{signature, authorization}}).',
      },
      ...(verifyError ? { verifyError } : {}),
    },
  }
}

/** The exact Requirements object the engine verifies against. Built server-side from the
 *  registry, never taken from the client, so challenge and verification cannot disagree. */
export function railRequirements(tool: RailToolName, status: RailStatus, decimals: number): Requirements {
  if (!status.configured || !status.token || !status.payTo || !status.chain) {
    throw new Error('railRequirements requires a configured status (gate first)')
  }
  const chain = getChainById(status.chain)
  if (!chain) throw new Error(`unknown chain ${status.chain}`)
  return {
    scheme: 'exact',
    network: chain.caip2,
    asset: status.token.address as Hex,
    payTo: status.payTo as Hex,
    maxAmountRequired: tokenUnits(decimals, railPriceUsd(tool, status).totalUsd).toString(),
    resource: railResource(tool),
  }
}

// ── the paid call ─────────────────────────────────────────────────────────────────

export type RailToolInput = { agentId: string; txContext?: TxContext | null }

export type RailServeDeps = EngineDeps & {
  handlers?: Record<RailToolName, (input: RailToolInput) => Promise<unknown>>
}

function defaultHandlers(status: RailStatus): Record<RailToolName, (input: RailToolInput) => Promise<unknown>> {
  const meta = <T extends Record<string, unknown>>(result: T) => ({
    ...result,
    _meta: {
      ...((result._meta as Record<string, unknown>) ?? {}),
      settlement: {
        network: status.network,
        asset: status.token?.address,
        assetSymbol: status.token?.symbol,
        facilitator: 'first-party (we broadcast; the buyer pays no gas)',
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
 * The full paid-call path for one tool.
 *   501 - the rail is not configured (never a free serve)
 *   503 - the settlement token's domain cannot be proven right now
 *   402 - malformed X-PAYMENT, or the authorization does not verify (fresh challenge)
 *   502 - the settlement failed; the tool is NOT served and nothing is marked settled
 *   500 - settled, but the tool handler itself failed; the settlement is still recorded
 *         and the body names the tx so the buyer can chase it
 *   200 - settled and served
 */
export async function railServeTool(
  tool: RailToolName,
  input: RailToolInput,
  paymentHeader: string,
  status: RailStatus,
  deps: RailServeDeps = {},
): Promise<{ httpStatus: number; body: unknown }> {
  const gate = railPaywallGate(status)
  if (!gate.ok) return { httpStatus: gate.httpStatus, body: gate.body }
  const chain = status.chain ? getChainById(status.chain) : undefined
  if (!chain || !status.token) {
    return { httpStatus: 501, body: { error: 'x402-3009 rail not configured', reason: 'network descriptor missing from the registry' } }
  }

  const domain = await provenDomainCached(chain, status.token, deps)
  if (!domain.ok) return { httpStatus: 503, body: { error: 'settlement token domain unproven', reason: domain.reason } }

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
  } catch {
    const challenge = await railChallenge(tool, status, deps, 'X-PAYMENT is not base64-encoded JSON')
    return { httpStatus: challenge.httpStatus, body: challenge.body }
  }

  // The buyer chose which of the offered chains to pay on, so settle on THAT one. The
  // challenge is the menu; the payload names the dish. A network we do not sell on
  // resolves to an unconfigured status and is refused rather than quietly redirected.
  const paidNetwork = (payload as { network?: unknown })?.network
  if (typeof paidNetwork === 'string' && paidNetwork.trim()) {
    const chosen = railStatus(deps.env ?? process.env, paidNetwork)
    if (!chosen.configured) {
      const challenge = await railChallenge(tool, status, deps, chosen.reason ?? `this rail does not settle on '${paidNetwork}'`)
      return { httpStatus: challenge.httpStatus, body: challenge.body }
    }
    if (chosen.chain !== status.chain) {
      return railServeToolOn(tool, input, payload, chosen, deps)
    }
  }

  return railServeToolOn(tool, input, payload, status, deps)
}

/**
 * Settle and serve on ONE already-resolved chain. Split out of railServeTool so a buyer
 * who paid on a chain other than the default is handled by the same code path rather than
 * a parallel one, which is the only way two chains stay honest about the same rules.
 */
export async function railServeToolOn(
  tool: RailToolName,
  input: RailToolInput,
  payload: unknown,
  status: RailStatus,
  deps: RailServeDeps = {},
): Promise<{ httpStatus: number; body: unknown }> {
  const chain = status.chain ? getChainById(status.chain) : undefined
  if (!chain || !status.token) {
    return { httpStatus: 501, body: { error: 'x402-3009 rail not configured', reason: 'network descriptor missing from the registry' } }
  }
  const domain = await provenDomainCached(chain, status.token, deps)
  if (!domain.ok) return { httpStatus: 503, body: { error: 'settlement token domain unproven', reason: domain.reason } }

  const price = railPriceUsd(tool, status)
  const requirements = railRequirements(tool, status, domain.proven.decimals)
  // Settlement touches an RPC, a signer and durable storage, so it has more ways to fail
  // than it has branches. Anything unexpected becomes a 502 that names the cause: the one
  // outcome that must never happen is an exception escaping into the request handler,
  // where it would be an unhandled rejection rather than a failed payment.
  let settled: Awaited<ReturnType<typeof settlePayment>>
  try {
    settled = await settlePayment({
      chain,
      token: status.token,
      requirements,
      payload,
      limits: railLimits(status, deps.env ?? process.env),
      deps: { ...deps, meta: { tool, baseUsd: price.baseUsd, feeUsd: price.settlementFeeUsd } },
    })
  } catch (e) {
    return {
      httpStatus: 502,
      body: {
        error: 'settlement failed',
        code: 'unexpected',
        reason: e instanceof Error ? e.message : String(e),
        note: 'Nothing was served. If a transaction was broadcast before this failure it will appear in GET /api/facilitator/proof.',
      },
    }
  }

  if (!settled.success) {
    // A payment that is merely invalid gets a fresh challenge so the buyer can fix it.
    // Anything else is our side or the chain, and must not be retried blindly.
    const retryable: string[] = [
      'malformed_payload', 'requirements_mismatch', 'unsupported_asset', 'wrong_recipient', 'wrong_amount',
      'below_minimum', 'above_maximum', 'not_yet_valid', 'expired', 'expiring_too_soon', 'nonce_used',
      'already_redeemed', 'bad_signature', 'insufficient_funds',
    ]
    if (retryable.includes(settled.code)) {
      const challenge = await railChallenge(tool, status, deps, settled.errorReason)
      return { httpStatus: challenge.httpStatus, body: challenge.body }
    }
    return {
      httpStatus: 502,
      body: {
        error: 'settlement failed',
        code: settled.code,
        reason: settled.errorReason,
        ...(settled.transaction ? { transaction: settled.transaction } : {}),
        ...(settled.ambiguous ? { ambiguous: true, note: 'The transaction may still land. Nothing was served and the authorization was not marked spent.' } : {}),
      },
    }
  }

  const handlers = deps.handlers ?? defaultHandlers(status)
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

// ── proof ─────────────────────────────────────────────────────────────────────────

export type RailProof = {
  rail: 'x402-3009'
  configured: boolean
  network: string
  chain: string | null
  asset: string | null
  assetSymbol: string | null
  payTo: string | null
  totalSettlements: number
  totalUsd: number
  internalSettlements: number
  internalUsd: number
  externalSettlements: number
  externalUsd: number
  internalPayers: string[]
  reverted: number
  ambiguous: number
  gas: { totalWei: string; settles: number; note: string }
  byTool: Record<string, { count: number; usd: number }>
  /** Per-chain breakdown. Two chains summed into one figure is a number about nothing. */
  byNetwork: Record<string, { count: number; usd: number; assetSymbol: string }>
  recent: X402SettlementRecord[]
  note: string
}

/**
 * OUR OWN buyer wallets, hardcoded on purpose.
 *
 * The proof page labels these settlements internal so nobody can read our own traffic as
 * third-party demand. Hardcoding is the whole point: this list being an env var alone is
 * how a deployment ends up reporting its own demo payments as external demand, which is
 * exactly what happened the first time the deployed rail settled. A public address is not
 * a credential, and it cannot be quietly unset the way a variable can. Same decision the
 * Celo rail already records. X402_3009_INTERNAL_PAYERS adds more without a deploy.
 */
const KNOWN_INTERNAL_PAYERS = ['0x8c8d9cd12d8896a40cf2115ee731258bb4983349']

/** Buyer wallets that are ours. Labeled, never filtered out: hiding our own traffic would
 *  overstate external demand, and removing it would understate that the rail works. */
export function internalPayers(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.X402_3009_INTERNAL_PAYERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s))
  return [...new Set([...KNOWN_INTERNAL_PAYERS, ...extra])]
}

export async function railProof(
  status: RailStatus,
  deps: { load?: () => Promise<X402SettlementRecord[]>; env?: NodeJS.ProcessEnv } = {},
): Promise<RailProof> {
  const env = deps.env ?? process.env
  const rows = await (deps.load ?? loadX402Settlements)()
  const mine = new Set(internalPayers(env))
  const settled = rows.filter((r) => r.outcome === 'settled')
  const byTool: Record<string, { count: number; usd: number }> = {}
  const byNetwork: Record<string, { count: number; usd: number; assetSymbol: string }> = {}
  let totalUsd = 0
  let internalSettlements = 0
  let internalUsd = 0
  let gasTotal = 0n
  for (const r of rows) {
    if (r.gasWei) {
      try {
        gasTotal += BigInt(r.gasWei)
      } catch {
        /* a malformed row must not break the report */
      }
    }
  }
  for (const r of settled) {
    totalUsd += r.amountUsd
    const t = (byTool[r.tool] ??= { count: 0, usd: 0 })
    t.count += 1
    t.usd = Number((t.usd + r.amountUsd).toFixed(6))
    const n = (byNetwork[r.network] ??= { count: 0, usd: 0, assetSymbol: r.assetSymbol })
    n.count += 1
    n.usd = Number((n.usd + r.amountUsd).toFixed(6))
    if (mine.has(r.payer.toLowerCase())) {
      internalSettlements += 1
      internalUsd += r.amountUsd
    }
  }
  return {
    rail: 'x402-3009',
    configured: status.configured,
    network: status.network,
    chain: status.chain,
    asset: status.token?.address ?? null,
    assetSymbol: status.token?.symbol ?? null,
    payTo: status.payTo,
    totalSettlements: settled.length,
    totalUsd: Number(totalUsd.toFixed(6)),
    internalSettlements,
    internalUsd: Number(internalUsd.toFixed(6)),
    externalSettlements: settled.length - internalSettlements,
    externalUsd: Number((totalUsd - internalUsd).toFixed(6)),
    internalPayers: [...mine],
    reverted: rows.filter((r) => r.outcome === 'reverted').length,
    ambiguous: rows.filter((r) => r.outcome === 'ambiguous').length,
    gas: {
      totalWei: gasTotal.toString(),
      settles: rows.filter((r) => Boolean(r.gasWei)).length,
      note: 'Native units only. This chain has no price feed we verify, so no USD gas figure is asserted.',
    },
    byTool,
    byNetwork,
    recent: rows.slice(-50).reverse(),
    note: `Real settlements only, each recorded from an on-chain receipt plus a matching Transfer log. Payments from our own buyer wallets are labeled internal, never hidden. Totals cover the retained window (last ${X402_SETTLEMENTS_CAP}).`,
  }
}

/** USD value of a base-unit amount, for display next to a settlement. */
export function usdOf(record: X402SettlementRecord): number {
  return fromTokenUnits(record.assetDecimals, BigInt(record.value))
}
