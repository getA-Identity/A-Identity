/**
 * The seller side of the Circle Gateway batched rail (Nanopayments): configuration, the
 * six paid trust tools and the free preview, the 402 challenge, the paid-call path, and
 * the proof behind it.
 *
 * What is different from the EIP-3009 rail next door, and why.
 *
 * - The buyer does not sign against the token. It signs an EIP-3009 authorization against
 *   Circle's GatewayWalletBatched domain, spending a balance it deposited into the
 *   GatewayWallet once. We broadcast nothing and pay no gas: Gateway nets thousands of
 *   authorizations into one on-chain batch. So there is no settlement fee here, and the
 *   price is the base price, byte-identical to the OKX listing it is read from.
 * - The receipt is Gateway's, not the chain's, at first. A settled call is confirmed by
 *   reading the transfer back from Gateway's transfers API (nonce, payTo, amount) before
 *   it is recorded or served; the on-chain batch hash arrives later and is attached by a
 *   bounded refresh. The proof says which rows have one and which are still credits.
 * - Sold as a second distribution channel next to OKX.AI, on a mainnet Gateway chain
 *   chosen from the registry (Base first). The OKX surface in asp/ is imported read-only
 *   and byte-for-byte untouched; the Arc-testnet demo in nanopay.ts is not repointed.
 */
import { getChain, getChainById, tokenUnits, fromTokenUnits, type ChainDescriptor } from '../chains/index.js'
import { txUrl } from '../chains/explorer.js'
import { PRICES } from '../asp/payment.js'
import {
  verifyAgent,
  reputationScore,
  riskCheck,
  counterpartyCheck,
  agentPassport,
  guardrailCheck,
  trustPreview,
  type TxContext,
} from '../asp/tools.js'
import {
  loadGatewaySettlements,
  persistGatewaySettlement,
  updateGatewaySettlement,
  GATEWAY_SETTLEMENTS_CAP,
  type GatewaySettlementRecord,
} from '../storage.js'
import { gatewayCalls, provenKind, readBackTransfer, type GatewayDeps, type GatewayRequirements, type ProvenKind } from './facilitator.js'

// ── the tools sold ────────────────────────────────────────────────────────────────

export const GATEWAY_TOOLS = ['verify_agent', 'reputation_score', 'risk_check', 'counterparty_check', 'agent_passport', 'guardrail_check'] as const
export type GatewayToolName = (typeof GATEWAY_TOOLS)[number]
export const GATEWAY_FREE_TOOL = 'trust_preview' as const

/**
 * Per-call prices, READ from the OKX listing's table rather than restated. One product,
 * one price list; a second copy is a second place to be wrong. `$0.001` -> 0.001.
 */
export function toolPriceUsd(tool: GatewayToolName): number {
  const raw = PRICES[`POST /tools/${tool}`]
  if (!raw) throw new Error(`no price listed for ${tool} in asp/payment.ts`)
  const n = Number(raw.replace(/^\$/, ''))
  if (!Number.isFinite(n) || n <= 0) throw new Error(`unparseable price '${raw}' for ${tool}`)
  return n
}

const AGENT_ID_DOC = 'ERC-8004 token id ("#73232"), a CAIP id ("eip155:<chain>:8004/<token>"), or a 0x owner address'
const TX_CONTEXT_DOC = 'optional object: { "amountUsd": number, "payee": "0x address" }'

export type ToolCard = { description: string; input: Record<string, string>; required: string[]; example: Record<string, unknown> }

export const GATEWAY_TOOL_CARDS: Record<GatewayToolName | typeof GATEWAY_FREE_TOOL, ToolCard> = {
  verify_agent: {
    description: 'Verify an AI agent: ERC-8004 identity + KYA status + endpoint liveness.',
    input: { agentId: AGENT_ID_DOC },
    required: ['agentId'],
    example: { agentId: '#73232' },
  },
  reputation_score: {
    description: 'Deterministic 0-1000 reputation with a full breakdown and its on-chain attestation.',
    input: { agentId: AGENT_ID_DOC },
    required: ['agentId'],
    example: { agentId: '#73232' },
  },
  risk_check: {
    description: 'Pre-transaction ALLOW / WARN / DENY verdict on a counterparty, with reasons.',
    input: { agentId: AGENT_ID_DOC, txContext: TX_CONTEXT_DOC },
    required: ['agentId'],
    example: { agentId: '#73232', txContext: { amountUsd: 25 } },
  },
  counterparty_check: {
    description: 'Deal-specific verdict between two agents: counterparty risk + same-operator self-deal detection.',
    input: { from: `the paying agent: ${AGENT_ID_DOC}`, to: `the counterparty: ${AGENT_ID_DOC}`, txContext: TX_CONTEXT_DOC },
    required: ['from', 'to'],
    example: { from: '#73232', to: '#1259', txContext: { amountUsd: 25 } },
  },
  agent_passport: {
    description: 'The full trust passport: identity + KYA + reputation + risk in one call.',
    input: { agentId: AGENT_ID_DOC },
    required: ['agentId'],
    example: { agentId: '#73232' },
  },
  guardrail_check: {
    description:
      'Does this agent operate under an enforced spend/trade policy, and does it respect the verdicts? Returns bands only: no caps, allowlists, symbols, amounts or holdings are ever disclosed.',
    input: { agentId: AGENT_ID_DOC },
    required: ['agentId'],
    example: { agentId: '#73232' },
  },
  trust_preview: {
    description: 'Free tier: coarse trust band + flags for an agent, and the price list of the paid tools.',
    input: { agentId: AGENT_ID_DOC },
    required: ['agentId'],
    example: { agentId: '#73232' },
  },
}

// ── configuration (fail-closed) ───────────────────────────────────────────────────

export type GatewayRailStatus = {
  configured: boolean
  /** CAIP-2 id of the settlement network. */
  network: string
  chain: string | null
  payTo: string | null
  facilitator: string | null
  /** The GatewayWallet the registry expects, before proof. */
  wallet: string | null
  reason?: string
}

/** Every network this rail is configured to sell on: X402_GATEWAY_NETWORKS, CAIP-2 ids. */
export function railNetworks(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.X402_GATEWAY_NETWORKS?.trim() ?? ''
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

export function railStatus(env: NodeJS.ProcessEnv = process.env, network?: string): GatewayRailStatus {
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
  const configuredHere =
    !wanted ||
    configuredIds.some((id) => {
      const c = getChain(id) ?? getChainById(id)
      return c && chain && c.caip2 === chain.caip2
    })
  const payToRaw = env.X402_GATEWAY_PAYTO?.trim() ?? ''
  const payTo = /^0x[0-9a-fA-F]{40}$/.test(payToRaw) ? payToRaw.toLowerCase() : null
  const base: GatewayRailStatus = {
    configured: false,
    network: requested,
    chain: chain?.id ?? null,
    payTo,
    facilitator: chain?.gateway?.facilitator ?? null,
    wallet: chain?.gateway?.wallet ?? null,
  }
  if (!requested) {
    return { ...base, reason: 'x402-gateway rail not configured: set X402_GATEWAY_NETWORKS to one or more CAIP-2 ids of chains that declare a Circle Gateway in the registry' }
  }
  if (!configuredHere) {
    return { ...base, reason: `this rail does not sell on '${requested}'. Configured networks: ${configuredIds.join(', ') || 'none'}` }
  }
  if (!chain) return { ...base, reason: `'${requested}' is not a chain in the registry` }
  if (!chain.gateway) return { ...base, network: chain.caip2, reason: `${chain.id} declares no Circle Gateway in the registry, so it cannot host the batched rail` }
  if (!chain.contracts.usdc) return { ...base, network: chain.caip2, reason: `${chain.id} declares no canonical USDC; Gateway settles USDC only` }
  if (!payTo) return { ...base, network: chain.caip2, reason: 'x402-gateway rail not configured: set X402_GATEWAY_PAYTO (0x receiving address)' }
  return { ...base, configured: true, network: chain.caip2 }
}

/** Unconfigured means 501, never a free serve. */
export function railPaywallGate(status: GatewayRailStatus): { ok: true } | { ok: false; httpStatus: 501; body: { error: string; reason?: string } } {
  if (status.configured) return { ok: true }
  return { ok: false, httpStatus: 501, body: { error: 'x402-gateway rail not configured', ...(status.reason ? { reason: status.reason } : {}) } }
}

export function railResource(tool: string): string {
  return `/api/x402/gateway/tools/${tool}`
}

/** The absolute URL Gateway's settle endpoint wants in `resource.url`. Relative when the
 *  caller gives no origin, which only happens in tests. */
export function resourceUrl(tool: string, origin?: string): string {
  return `${(origin ?? '').replace(/\/$/, '')}${railResource(tool)}`
}

// ── the 402 challenge ─────────────────────────────────────────────────────────────

export type RailDeps = GatewayDeps & {
  /** Scheme + host the rail is served from, for absolute resource URLs. */
  origin?: string
  handlers?: Partial<Record<GatewayToolName, (input: GatewayToolInput) => Promise<unknown>>>
  load?: () => Promise<GatewaySettlementRecord[]>
  persist?: (rec: GatewaySettlementRecord) => Promise<void>
  update?: (authNonce: string, patch: Parameters<typeof updateGatewaySettlement>[1]) => Promise<void>
}

export type RailChallengeResult =
  | { httpStatus: 402; body: Record<string, unknown> }
  | { httpStatus: 501 | 503; body: { error: string; reason?: string } }

function acceptsEntry(chain: ChainDescriptor, proven: ProvenKind, payTo: string, tool: GatewayToolName, origin?: string): GatewayRequirements & Record<string, unknown> {
  const amount = tokenUnits(proven.asset.decimals, toolPriceUsd(tool)).toString()
  return {
    scheme: 'exact',
    network: chain.caip2,
    asset: proven.asset.address,
    amount,
    // The older Coinbase name, emitted with the same value for clients that read it.
    maxAmountRequired: amount,
    payTo,
    // Gateway's own minimum validity window (minValiditySeconds) is what the buyer SDK
    // signs with; this is the resource server's timeout, unrelated to that.
    maxTimeoutSeconds: 3600,
    resource: resourceUrl(tool, origin),
    description: `${GATEWAY_TOOL_CARDS[tool].description} Gasless: settled in ${proven.asset.symbol} through Circle Gateway on ${chain.name}.`,
    mimeType: 'application/json',
    extra: {
      ...proven.kind.extra,
      // What was checked and when, so a buyer can see the domain was matched against the
      // registry's expectation rather than copied from the facilitator unread.
      registryWallet: chain.gateway!.wallet,
      domainVerified: true,
      provenAt: proven.provenAt,
    },
  }
}

/**
 * Build the challenge for one tool: one accepts entry per configured chain whose kind is
 * proven right now. 503 rather than 402 when none is, because a challenge we cannot
 * settle is worse than none.
 */
export async function railChallenge(tool: GatewayToolName, status: GatewayRailStatus, deps: RailDeps = {}, verifyError?: string): Promise<RailChallengeResult> {
  const gate = railPaywallGate(status)
  if (!gate.ok) return { httpStatus: gate.httpStatus, body: gate.body }
  const env = deps.env ?? process.env
  const ordered = [status.network, ...railNetworks(env).filter((n) => n !== status.network)]
  const accepts: Record<string, unknown>[] = []
  const unproven: string[] = []
  for (const n of ordered) {
    const s = n === status.network ? status : railStatus(env, n)
    const chain = s.chain ? getChainById(s.chain) : undefined
    if (!s.configured || !chain || !s.payTo) continue
    const proof = await provenKind(chain, deps)
    if (!proof.ok) {
      unproven.push(`${chain.caip2}: ${proof.reason}`)
      continue
    }
    accepts.push(acceptsEntry(chain, proof.proven, s.payTo, tool, deps.origin))
  }
  if (!accepts.length) {
    return { httpStatus: 503, body: { error: 'Gateway kind unproven', reason: unproven.join('; ') || 'no configured chain could be proven' } }
  }
  const price = toolPriceUsd(tool)
  return {
    httpStatus: 402,
    body: {
      x402Version: 2,
      error: 'payment required',
      resource: { url: resourceUrl(tool, deps.origin), description: GATEWAY_TOOL_CARDS[tool].description, mimeType: 'application/json' },
      accepts,
      tool: {
        name: tool,
        price: { totalUsd: price, settlementFeeUsd: 0 },
        priceNote:
          'Gasless for the buyer and for us: you sign an EIP-3009 authorization against Circle Gateway\'s GatewayWalletBatched domain from your Gateway balance, Gateway credits it instantly and batches the on-chain settlement. No settlement fee is added; the price is identical on every rail we sell on.',
        ...GATEWAY_TOOL_CARDS[tool],
        method: `POST ${railResource(tool)} (JSON body) or GET with query parameters`,
        payment:
          'Sign with @circle-fin/x402-batching (BatchEvmScheme) or Circle CLI (circle services pay), then retry with header PAYMENT-SIGNATURE: base64(JSON of {x402Version:2, accepted, payload:{signature, authorization}}).',
        freeTier: `GET ${railResource(GATEWAY_FREE_TOOL)}?agentId=... (no payment, rate-limited): coarse band + flags`,
      },
      ...(verifyError ? { verifyError } : {}),
    },
  }
}

// ── the paid call ─────────────────────────────────────────────────────────────────

export type GatewayToolInput = { agentId?: string; from?: string; to?: string; txContext?: TxContext | null }

/** The buyer's credential, under either header name (v2 PAYMENT-SIGNATURE, v1 X-PAYMENT). */
export function railPaymentHeader(headers: Record<string, string | string[] | undefined>): string {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
  return (one(headers['payment-signature']) || one(headers['x-payment'])).trim()
}

type ParsedPayload = {
  x402Version?: number
  accepted?: { network?: string; payTo?: string; amount?: string; asset?: string } | null
  network?: string
  payload?: { signature?: string; authorization?: { from?: string; to?: string; value?: string; validAfter?: string; validBefore?: string; nonce?: string } }
}

export function railPaidNetwork(payload: unknown): string | undefined {
  const p = payload as ParsedPayload | null
  const top = typeof p?.network === 'string' ? p.network.trim() : ''
  if (top) return top
  const accepted = typeof p?.accepted?.network === 'string' ? p.accepted.network.trim() : ''
  return accepted || undefined
}

export type RailServeResult = { httpStatus: number; body: unknown; headers?: Record<string, string> }

function defaultHandlers(status: GatewayRailStatus, proven: ProvenKind): Record<GatewayToolName, (input: GatewayToolInput) => Promise<unknown>> {
  const meta = <T extends Record<string, unknown>>(result: T) => ({
    ...result,
    _meta: {
      ...((result._meta as Record<string, unknown>) ?? {}),
      settlement: {
        rail: 'x402-gateway',
        network: status.network,
        asset: proven.asset.address,
        assetSymbol: proven.asset.symbol,
        facilitator: 'Circle Gateway (batched; the buyer pays no gas and neither do we)',
      },
    },
  })
  const need = (v: string | undefined, name: string): string => {
    if (!v) throw new Error(`${name} is required`)
    return v
  }
  return {
    verify_agent: async (i) => meta(await verifyAgent(need(i.agentId, 'agentId'))),
    reputation_score: async (i) => meta(await reputationScore(need(i.agentId, 'agentId'))),
    risk_check: async (i) => meta(await riskCheck(need(i.agentId, 'agentId'), i.txContext ?? null)),
    counterparty_check: async (i) => meta(await counterpartyCheck(need(i.from, 'from'), need(i.to, 'to'), i.txContext ?? null)),
    agent_passport: async (i) => meta(await agentPassport(need(i.agentId, 'agentId'))),
    guardrail_check: async (i) => meta(await guardrailCheck(need(i.agentId, 'agentId'))),
  }
}

/** The free tool, served without a payment. */
export async function railFreeTool(input: GatewayToolInput): Promise<unknown> {
  if (!input.agentId) throw new Error('agentId is required')
  return trustPreview(input.agentId)
}

/** The input fields a tool needs, checked before any money moves. */
export function railInputError(tool: GatewayToolName, input: GatewayToolInput): string | null {
  for (const k of GATEWAY_TOOL_CARDS[tool].required) {
    if (typeof (input as Record<string, unknown>)[k] !== 'string' || !(input as Record<string, string>)[k]) return `${k} is required`
  }
  return null
}

export function railPaymentResponseHeader(settled: GatewaySettlementRecord): string {
  return Buffer.from(
    JSON.stringify({
      success: true,
      transaction: settled.tx ?? settled.transferId ?? '',
      network: settled.network,
      payer: settled.payer,
      amount: settled.value,
    }),
  ).toString('base64')
}

/**
 * The full paid-call path for one tool.
 *   501 - the rail is not configured (never a free serve)
 *   503 - Gateway's kind for the chain cannot be proven right now
 *   400 - the tool's input is missing (checked BEFORE settling, so no money moves)
 *   402 - malformed PAYMENT-SIGNATURE, wrong recipient or amount, or Gateway refused
 *   502 - Gateway said success but the transfer could not be read back; NOT served
 *   500 - credited and recorded, but the tool handler failed; the body names the transfer
 *   200 - credited, recorded, served
 */
export async function railServeTool(
  tool: GatewayToolName,
  input: GatewayToolInput,
  paymentHeader: string,
  status: GatewayRailStatus,
  deps: RailDeps = {},
): Promise<RailServeResult> {
  const gate = railPaywallGate(status)
  if (!gate.ok) return { httpStatus: gate.httpStatus, body: gate.body }
  const env = deps.env ?? process.env

  const inputError = railInputError(tool, input)
  if (inputError) {
    return { httpStatus: 400, body: { error: inputError, input: GATEWAY_TOOL_CARDS[tool].input, example: GATEWAY_TOOL_CARDS[tool].example } }
  }

  let payload: ParsedPayload
  try {
    payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')) as ParsedPayload
  } catch {
    const c = await railChallenge(tool, status, deps, 'PAYMENT-SIGNATURE is not base64-encoded JSON')
    return { httpStatus: c.httpStatus, body: c.body }
  }

  // The buyer picked a chain out of `accepts`; settle on THAT one, refusing any chain the
  // seller did not configure rather than falling back to the default.
  let chosen = status
  const paidNetwork = railPaidNetwork(payload)
  if (paidNetwork) {
    chosen = railStatus(env, paidNetwork)
    if (!chosen.configured) {
      const c = await railChallenge(tool, status, deps, chosen.reason ?? `this rail does not settle on '${paidNetwork}'`)
      return { httpStatus: c.httpStatus, body: c.body }
    }
  }
  const chain = chosen.chain ? getChainById(chosen.chain) : undefined
  if (!chain || !chosen.payTo || !chain.gateway) return { httpStatus: 501, body: { error: 'x402-gateway rail not configured', reason: 'network descriptor missing from the registry' } }

  const proof = await provenKind(chain, deps)
  if (!proof.ok) return { httpStatus: 503, body: { error: 'Gateway kind unproven', reason: proof.reason } }
  const proven = proof.proven

  const auth = payload.payload?.authorization
  const priceUnits = tokenUnits(proven.asset.decimals, toolPriceUsd(tool)).toString()
  const refuse = async (why: string) => {
    const c = await railChallenge(tool, chosen, deps, why)
    return { httpStatus: c.httpStatus, body: c.body }
  }
  if (!auth || typeof payload.payload?.signature !== 'string') return refuse('payload.authorization and payload.signature are required')
  if (!auth.to || auth.to.toLowerCase() !== chosen.payTo.toLowerCase()) return refuse(`authorization.to must be ${chosen.payTo}`)
  if (String(auth.value) !== priceUnits) return refuse(`authorization.value must be exactly ${priceUnits} (${toolPriceUsd(tool)} ${proven.asset.symbol})`)
  if (!auth.nonce || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) return refuse('authorization.nonce must be a 32-byte hex value')
  if (!auth.from || !/^0x[0-9a-fA-F]{40}$/.test(auth.from)) return refuse('authorization.from must be a 0x address')

  const requirements: GatewayRequirements = {
    scheme: 'exact',
    network: chain.caip2,
    asset: proven.asset.address,
    amount: priceUnits,
    payTo: chosen.payTo,
    maxTimeoutSeconds: 3600,
    extra: proven.kind.extra,
  }
  const resource = { url: resourceUrl(tool, deps.origin), description: GATEWAY_TOOL_CARDS[tool].description, mimeType: 'application/json' }

  const calls = gatewayCalls(deps)
  let settle: Awaited<ReturnType<typeof calls.settle>>
  try {
    settle = await calls.settle(chain.gateway.facilitator, { resource, ...payload, accepted: payload.accepted ?? requirements }, requirements)
  } catch (e) {
    settle = { success: false, errorReason: e instanceof Error ? e.message : String(e) }
  }
  if (!settle.success) return refuse(`Gateway refused the payment: ${settle.errorReason ?? settle.message ?? 'settlement failed'}`)

  // Read the credit back before anything is recorded or served.
  const back = await readBackTransfer(chain, { nonce: auth.nonce, payTo: chosen.payTo, value: priceUnits, payer: auth.from, transferId: settle.transaction }, deps)
  const persist = deps.persist ?? persistGatewaySettlement
  const base = {
    ts: new Date(calls.now()).toISOString(),
    tool,
    resource: railResource(tool),
    network: chain.caip2,
    asset: proven.asset.address,
    assetSymbol: proven.asset.symbol,
    assetDecimals: proven.asset.decimals,
    value: priceUnits,
    amountUsd: toolPriceUsd(tool),
    payer: auth.from.toLowerCase(),
    payTo: chosen.payTo,
    authNonce: auth.nonce.toLowerCase(),
    confirmedBy: 'gateway-transfers-api' as const,
    facilitator: chain.gateway.facilitator,
  }
  if (!back.transfer) {
    const rec: GatewaySettlementRecord = { ...base, outcome: 'unconfirmed', ...(settle.transaction ? { transferId: settle.transaction } : {}) }
    await persist(rec)
    return {
      httpStatus: 502,
      body: {
        error: 'settlement unconfirmed',
        reason: back.reason,
        transferId: settle.transaction ?? null,
        note: 'Gateway answered success but its transfers API returned no matching transfer inside the window. Nothing was served and nothing is counted as revenue; the row is recorded as unconfirmed on GET /api/x402/gateway/proof so it can be resolved.',
      },
    }
  }
  const t = back.transfer
  const completed = t.status === 'completed' && typeof t.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t.txHash)
  const rec: GatewaySettlementRecord = {
    ...base,
    outcome: t.status === 'failed' ? 'failed' : completed ? 'completed' : 'credited',
    transferId: t.id,
    gatewayStatus: t.status,
    ...(completed ? { tx: t.txHash, explorerUrl: txUrl(chain, t.txHash as string) } : {}),
  }
  await persist(rec)
  if (rec.outcome === 'failed') {
    return { httpStatus: 502, body: { error: 'settlement failed', reason: 'Gateway reports the transfer as failed', transferId: t.id, settlement: rec } }
  }

  const handlers = { ...defaultHandlers(chosen, proven), ...(deps.handlers ?? {}) }
  try {
    const body = await handlers[tool](input)
    return {
      httpStatus: 200,
      body: { ...(body as Record<string, unknown>), settlement: rec },
      headers: { 'PAYMENT-RESPONSE': railPaymentResponseHeader(rec) },
    }
  } catch (e) {
    return {
      httpStatus: 500,
      body: {
        error: 'tool failed after settlement',
        reason: e instanceof Error ? e.message : String(e),
        settlement: rec,
        note: 'Your payment was credited by Gateway and is recorded. This failure is on our side.',
      },
    }
  }
}

// ── proof ─────────────────────────────────────────────────────────────────────────

/**
 * OUR OWN buyer wallets, hardcoded on purpose so the proof page can never report our
 * own test traffic as external demand (the same decision the other rails record).
 * X402_GATEWAY_INTERNAL_PAYERS adds more without a deploy. The first entry is the owner
 * wallet that paid the first testnet call through this rail on 2026-09-10; the Circle
 * agent wallet that makes the first mainnet call joins it with that receipt's commit.
 */
const KNOWN_INTERNAL_PAYERS = ['0xd305607510e0db2c95807173c7a05bea53c1ed36']

export function internalPayers(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.X402_GATEWAY_INTERNAL_PAYERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s))
  return [...new Set([...KNOWN_INTERNAL_PAYERS, ...extra])]
}

export type GatewayRailProof = {
  rail: 'x402-gateway'
  configured: boolean
  network: string
  chain: string | null
  payTo: string | null
  facilitator: string | null
  /** Rows Gateway credited: the seller balance holds the money. */
  credited: number
  /** Of those, rows whose on-chain batch has landed, with a hash. */
  onChain: number
  totalUsd: number
  internalSettlements: number
  internalUsd: number
  externalSettlements: number
  externalUsd: number
  internalPayers: string[]
  failed: number
  unconfirmed: number
  byTool: Record<string, { count: number; usd: number }>
  byNetwork: Record<string, { count: number; usd: number; assetSymbol: string }>
  recent: GatewaySettlementRecord[]
  note: string
}

const SETTLED = new Set<GatewaySettlementRecord['outcome']>(['credited', 'completed'])

export async function railProof(status: GatewayRailStatus, deps: RailDeps = {}): Promise<GatewayRailProof> {
  const env = deps.env ?? process.env
  const rows = await (deps.load ?? loadGatewaySettlements)()
  const mine = new Set(internalPayers(env))
  const settled = rows.filter((r) => SETTLED.has(r.outcome))
  const byTool: Record<string, { count: number; usd: number }> = {}
  const byNetwork: Record<string, { count: number; usd: number; assetSymbol: string }> = {}
  let totalUsd = 0
  let internalSettlements = 0
  let internalUsd = 0
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
    rail: 'x402-gateway',
    configured: status.configured,
    network: status.network,
    chain: status.chain,
    payTo: status.payTo,
    facilitator: status.facilitator,
    credited: settled.length,
    onChain: settled.filter((r) => r.outcome === 'completed').length,
    totalUsd: Number(totalUsd.toFixed(6)),
    internalSettlements,
    internalUsd: Number(internalUsd.toFixed(6)),
    externalSettlements: settled.length - internalSettlements,
    externalUsd: Number((totalUsd - internalUsd).toFixed(6)),
    internalPayers: [...mine],
    failed: rows.filter((r) => r.outcome === 'failed').length,
    unconfirmed: rows.filter((r) => r.outcome === 'unconfirmed').length,
    byTool,
    byNetwork,
    recent: rows.slice(-50).reverse(),
    note: `Each row was read back from Circle Gateway's transfers API for the authorization's nonce before it was recorded; "credited" means Gateway holds it for us and the on-chain batch has not landed yet, "completed" means it has and the batch hash is attached. Payments from our own buyer wallets are labeled internal, never hidden. Sub-cent infrastructure, not revenue. Totals cover the retained window (last ${GATEWAY_SETTLEMENTS_CAP}).`,
  }
}

/**
 * Attach batch hashes to credited rows once Gateway reports them. Bounded: at most
 * `limit` rows, one read each, run in parallel, so a proof page load stays quick and a
 * Gateway outage costs nothing but a stale status word.
 */
export async function refreshCreditedRows(deps: RailDeps = {}, limit = 25): Promise<{ checked: number; upgraded: number }> {
  const rows = await (deps.load ?? loadGatewaySettlements)()
  const update = deps.update ?? updateGatewaySettlement
  const calls = gatewayCalls(deps)
  const pending = rows.filter((r) => r.outcome === 'credited').slice(-limit)
  let upgraded = 0
  await Promise.all(
    pending.map(async (r) => {
      const chain = getChain(r.network)
      if (!chain?.gateway) return
      try {
        const found = await calls.searchTransfers(chain.gateway.facilitator, { network: r.network, nonce: r.authNonce })
        const t = found.find((x) => x.toAddress.toLowerCase() === r.payTo.toLowerCase() && String(x.amount) === r.value)
        if (!t) return
        if (t.status === 'failed') {
          await update(r.authNonce, { outcome: 'failed', gatewayStatus: t.status, transferId: t.id })
          upgraded += 1
        } else if (t.status === 'completed' && typeof t.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t.txHash)) {
          await update(r.authNonce, { outcome: 'completed', gatewayStatus: t.status, tx: t.txHash, explorerUrl: txUrl(chain, t.txHash), transferId: t.id })
          upgraded += 1
        } else if (t.status !== r.gatewayStatus) {
          await update(r.authNonce, { outcome: 'credited', gatewayStatus: t.status, transferId: t.id })
        }
      } catch {
        /* a refresh that fails leaves the row as it was, which is still true */
      }
    }),
  )
  return { checked: pending.length, upgraded }
}

/** USD value of a base-unit amount, for display next to a settlement. */
export function usdOf(record: GatewaySettlementRecord): number {
  return fromTokenUnits(record.assetDecimals, BigInt(record.value))
}

// ── OpenAPI, the listing prerequisite ─────────────────────────────────────────────

/** An OpenAPI 3.0 document for the paid tools, generated from the same cards the 402
 *  serves so it cannot drift from them. Circle's marketplace asks for one. */
export function openApiDocument(status: GatewayRailStatus, origin: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {}
  const schemaFor = (card: ToolCard) => ({
    type: 'object',
    properties: Object.fromEntries(Object.entries(card.input).map(([k, v]) => [k, k === 'txContext' ? { type: 'object', description: v } : { type: 'string', description: v }])),
    required: card.required,
    example: card.example,
  })
  const paid = (tool: GatewayToolName) => {
    const card = GATEWAY_TOOL_CARDS[tool]
    return {
      post: {
        operationId: tool,
        summary: card.description,
        description: `Paid: ${PRICES[`POST /tools/${tool}`]} per call in USDC through Circle Gateway nanopayments (x402 v2, scheme exact, GatewayWalletBatched). Unpaid requests answer 402 with the payment requirements in the body and the PAYMENT-REQUIRED header.`,
        'x-price-usd': toolPriceUsd(tool),
        'x-payment': { protocol: 'x402', version: 2, scheme: 'exact', facilitator: 'circle-gateway', network: status.network },
        requestBody: { required: true, content: { 'application/json': { schema: schemaFor(card) } } },
        responses: {
          '200': { description: 'The tool result plus a `settlement` record (Gateway transfer id, status, batch hash when landed).' },
          '402': { description: 'Payment required. Body and PAYMENT-REQUIRED header carry x402 v2 requirements.' },
          '400': { description: 'Missing input; checked before any payment is taken.' },
        },
      },
      get: {
        operationId: `${tool}_get`,
        summary: `${card.description} (query-parameter form)`,
        parameters: Object.keys(card.input).map((k) => ({ name: k, in: 'query', required: card.required.includes(k), schema: { type: 'string' } })),
        responses: { '200': { description: 'Same as POST.' }, '402': { description: 'Payment required.' } },
      },
    }
  }
  for (const tool of GATEWAY_TOOLS) paths[railResource(tool)] = paid(tool)
  const free = GATEWAY_TOOL_CARDS[GATEWAY_FREE_TOOL]
  paths[railResource(GATEWAY_FREE_TOOL)] = {
    get: {
      operationId: GATEWAY_FREE_TOOL,
      summary: free.description,
      parameters: [{ name: 'agentId', in: 'query', required: true, schema: { type: 'string', description: free.input.agentId } }],
      responses: { '200': { description: 'Coarse band, flags and the paid price list. Free, rate-limited.' } },
    },
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'A-Identity trust tools (Circle Gateway nanopayments)',
      version: '1.0.0',
      description:
        'Know-your-agent trust tools for AI agents: ERC-8004 identity, KYA, deterministic reputation, ALLOW/WARN/DENY risk verdicts and policy guardrail bands. Paid per call in USDC through Circle Gateway (gasless, batched). Source: https://github.com/getA-Identity/A-Identity',
      contact: { email: 'aybars.dorman@gmail.com' },
    },
    servers: [{ url: origin.replace(/\/$/, '') }],
    paths,
  }
}
