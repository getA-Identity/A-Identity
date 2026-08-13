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
  minValueUsd: 0.021,
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

/** The settlement token this rail uses on a chain: the one the env names, else the first
 *  EIP-3009 token the descriptor declares. A chain with none cannot host this rail. */
export function railToken(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): SettlementToken | null {
  const wanted = env.X402_3009_ASSET_SYMBOL?.trim()
  const usable = (chain.settlementTokens ?? []).filter((t) => t.authorization === 'eip3009')
  if (!usable.length) return null
  if (wanted) return usable.find((t) => t.symbol.toLowerCase() === wanted.toLowerCase()) ?? null
  return usable[0]
}

/**
 * Rail configuration. `configured` is true only when the network resolves to a registry
 * descriptor that declares an EIP-3009 settlement token AND an explicit payTo is set.
 * There is deliberately no fallback from payTo to a signer key: the receiving address
 * must be a decision, never an accident of which key happens to be present.
 */
export function railStatus(env: NodeJS.ProcessEnv = process.env): RailStatus {
  const requested = env.X402_3009_NETWORK?.trim() ?? ''
  const chain = requested ? (getChain(requested) ?? getChainById(requested) ?? null) : null
  const payToRaw = env.X402_3009_PAYTO?.trim() ?? ''
  const payTo = /^0x[0-9a-fA-F]{40}$/.test(payToRaw) ? payToRaw.toLowerCase() : null
  const settlementFeeUsd = num(env, 'X402_3009_SETTLEMENT_FEE_USD', DEFAULTS.settlementFeeUsd)
  const minValueUsd = num(env, 'X402_3009_MIN_VALUE_USD', DEFAULTS.minValueUsd)
  const maxValueUsd = num(env, 'X402_3009_MAX_VALUE_USD', DEFAULTS.maxValueUsd)
  const publicSettle = env.X402_3009_PUBLIC_SETTLE === 'true'
  const allowedPayTo = (env.X402_3009_ALLOWED_PAYTO ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s))
  const base = { network: requested, chain: chain?.id ?? null, token: null, payTo, settlementFeeUsd, minValueUsd, maxValueUsd, publicSettle, allowedPayTo }

  if (!requested) {
    return { ...base, configured: false, reason: 'x402-3009 rail not configured: set X402_3009_NETWORK to a CAIP-2 id of a chain that declares an EIP-3009 settlement token' }
  }
  if (!chain) {
    return { ...base, configured: false, reason: `X402_3009_NETWORK '${requested}' is not a chain in the registry` }
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
      accepts: [requirements],
      tool: {
        name: tool,
        price: { baseUsd: price.baseUsd, settlementFeeUsd: price.settlementFeeUsd, totalUsd: price.totalUsd },
        priceNote:
          'This rail is gasless for the buyer: you sign an EIP-3009 authorization and we broadcast it, paying the chain gas ourselves. The settlement fee covers that broadcast, measured at 102495 gas (about 0.0000046 ETH) on 2026-08-13, with headroom for gas and ETH price moves. The base price is identical on every rail we sell on.',
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

  const price = railPriceUsd(tool, status)
  const requirements = railRequirements(tool, status, domain.proven.decimals)
  const settled = await settlePayment({
    chain,
    token: status.token,
    requirements,
    payload,
    limits: railLimits(status, deps.env ?? process.env),
    deps: { ...deps, meta: { tool, baseUsd: price.baseUsd, feeUsd: price.settlementFeeUsd } },
  })

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
  recent: X402SettlementRecord[]
  note: string
}

/** Buyer wallets that are ours. Labeled, never filtered out: hiding our own traffic
 *  would overstate external demand, and removing it would understate that the rail
 *  actually works. Same decision the Celo rail records. */
export function internalPayers(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.X402_3009_INTERNAL_PAYERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s))
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
    recent: rows.slice(-50).reverse(),
    note: `Real settlements only, each recorded from an on-chain receipt plus a matching Transfer log. Payments from our own buyer wallets are labeled internal, never hidden. Totals cover the retained window (last ${X402_SETTLEMENTS_CAP}).`,
  }
}

/** USD value of a base-unit amount, for display next to a settlement. */
export function usdOf(record: X402SettlementRecord): number {
  return fromTokenUnits(record.assetDecimals, BigInt(record.value))
}
