/**
 * Celo x402 rail - facilitator-settled pay-per-call trust tools.
 *
 * A DIFFERENT settlement model than the Arc rail (x402.ts). Arc is self-verifying:
 * the client broadcasts a USDC transfer itself and this server reads the chain to
 * verify it. On Celo the buyer signs an EIP-3009 `TransferWithAuthorization` for
 * Celo-native USDC (buyer pays no gas) and Celo's FIRST-PARTY x402 facilitator
 * (api.x402.celo.org, verified live 2026-08-09 via GET /supported) verifies and
 * broadcasts it. This server never holds the payment tx: it asks the facilitator to
 * /verify, then to /settle with our API key, and serves the tool only on settled:true.
 *
 * FAIL-CLOSED by construction: without CELO_PAYTO + CELO_X402_API_KEY the paid
 * endpoints answer 501 and nothing is ever served free (mirrors the Arc rail's
 * x402PayTo()/501 behavior, and is the opposite of the monitored ASP fail-open).
 * A facilitator error is a 502 - also never a free serve, and never a resubmit:
 * settle is not idempotent from our side, so an ambiguous failure returns 502 and
 * the client retries with a FRESH payment rather than us double-settling this one.
 *
 * Tools and prices are the same trust suite the OKX ASP sells (asp/payment.ts):
 * the handlers are the pure exports of asp/tools.ts (imported read-only - no ASP
 * route/gateway code), so a Celo buyer gets byte-for-byte the same trust product.
 * Chain constants (USDC address, decimals, CAIP-2 ids, RPCs) come from the chain
 * registry - nothing here restates them.
 */
import { getChain, getChainByEvmId, getChainById, nearTargetOf, usdcUnits, evmPublicClient, type ChainDescriptor } from './chains/index.js'
import { FORMER_CELO_PAYTO, isRetired, retiredPayToRefusal, retiredPublic } from './chains/retired.js'
import { verifyAgent, reputationScore, riskCheck, agentPassport, type TxContext } from './asp/tools.js'
import {
  loadCeloSettlements,
  persistCeloSettlement,
  CELO_SETTLEMENTS_CAP,
  type CeloSettlementRecord,
} from './storage.js'

// ── facilitator endpoints (service URLs, not chain constants) ─────────────────────
// First-party Celo facilitators, both verified live 2026-08-09: GET /supported returns
// kinds [{x402Version:2, scheme:'exact', network:'eip155:42220'}, {x402Version:1,
// scheme:'exact', network:'celo'}] (and the sepolia pair on the testnet host). The
// default follows the resolved network's testnet flag so a testnet rail can never point
// at the mainnet facilitator by omission; CELO_X402_FACILITATOR overrides either.
const FACILITATOR_MAINNET = 'https://api.x402.celo.org'
const FACILITATOR_TESTNET = 'https://api.x402.sepolia.celo.org'

/**
 * Hard caps on the facilitator round-trips, deliberately DIFFERENT. /verify is a pure
 * signature check and 8s is generous. /settle broadcasts a transaction and waits on the
 * relayer, so the same 8s produced the one outcome this rail must avoid: a timeout on
 * our side while the payment lands on-chain anyway. Measured on a 620-call sweep on
 * 2026-08-09, ~16% of settles tripped the 8s cap and the buyer's USDC left the wallet
 * for every one of them, unserved and unrecorded. 20s stays inside the buyer script's
 * own 30s ceiling while giving the relayer room.
 */
const FACILITATOR_VERIFY_TIMEOUT_MS = 8000
const FACILITATOR_SETTLE_TIMEOUT_MS = 20000

// ── the settlement pause ──────────────────────────────────────────────────────────

/**
 * The facilitator settles on credit: each mainnet settlement is charged to OUR seller
 * account (gas at cost plus 0.3% of the payment, per its /api/config read on 2026-11-11),
 * and when that balance is empty /settle answers 402 insufficient_credits and broadcasts
 * nothing. The first outside buyer of /check/celo met exactly that on 2026-11-11, after a
 * signature that was then good for nothing. Until the account is topped up at
 * x402.celo.org every attempt ends the same way, so the rail pauses itself for a while
 * after such an answer: the challenge and the paid call both answer 503 with the reason,
 * and no buyer signs for nothing. Nothing here can read the balance, so the pause expires
 * on its own; the next attempt after it either settles or re-arms it.
 */
const SETTLEMENT_PAUSE_MS = 15 * 60_000
let settlementPause: { since: Date; reason: string } | null = null

const TOP_UP_NOTE =
  'Our settlement balance at the Celo facilitator (x402.celo.org) is empty, so it refuses to broadcast: nothing is served and nothing is charged until it is topped up. The rail answers 503 for 15 minutes after such a refusal, then tries again.'

export type CeloSettlementPause = { paused: false } | { paused: true; since: string; until: string; reason: string }

/** Whether the rail is holding off on settlements right now, and why. */
export function celoSettlementPause(now: Date = new Date()): CeloSettlementPause {
  if (!settlementPause) return { paused: false }
  const until = settlementPause.since.getTime() + SETTLEMENT_PAUSE_MS
  if (now.getTime() >= until) {
    settlementPause = null
    return { paused: false }
  }
  return { paused: true, since: settlementPause.since.toISOString(), until: new Date(until).toISOString(), reason: settlementPause.reason }
}

/** The 503 the rail answers while paused, for the challenge and the paid call alike; null when it is not paused. */
export function celoPauseResponse(now: Date = new Date()): { httpStatus: 503; body: Record<string, unknown> } | null {
  const p = celoSettlementPause(now)
  if (!p.paused) return null
  return {
    httpStatus: 503,
    body: { error: 'celo settlement paused', reason: p.reason, since: p.since, until: p.until, charged: false, note: TOP_UP_NOTE },
  }
}

/** Tests arm and clear the pause through this; nothing in production calls it. */
export function _setCeloSettlementPauseForTests(p: { since: Date; reason: string } | null): void {
  settlementPause = p
}

/** EIP-3009 on Circle's USDC: whether an authorizer's nonce has been spent. Read live on
 *  Celo on 2026-11-11: false for a fresh nonce, true for the nonce of a 2026-08-09 settlement. */
const USDC_AUTHORIZATION_ABI = [
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

/** Whether the buyer's authorization is spent on-chain: the fact that settles what a failed
 *  /settle leaves open. Null when the chain could not be read, never a guess. */
async function readAuthorizationUsed(chain: ChainDescriptor, payer: string, nonce: string): Promise<boolean | null> {
  const usdc = chain.contracts.usdc
  if (!usdc || !/^0x[0-9a-fA-F]{40}$/.test(payer) || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null
  try {
    const client = await evmPublicClient(chain)
    const used = await raceTimeout(
      client.readContract({
        address: usdc as `0x${string}`,
        abi: USDC_AUTHORIZATION_ABI,
        functionName: 'authorizationState',
        args: [payer as `0x${string}`, nonce as `0x${string}`],
      }),
      CELO_READ_TIMEOUT_MS,
    )
    return typeof used === 'boolean' ? used : null
  } catch {
    return null
  }
}

/** The facilitator's own record of one authorization (GET /settle/status, live on
 *  2026-11-11: status "unspent" or "consumed", source "chain", transaction when it has it).
 *  Used for the hash after a read-back; null when it does not answer. */
async function readSettleStatus(
  fetchImpl: typeof fetch,
  facilitator: string,
  asset: string,
  payer: string,
  nonce: string,
): Promise<{ status: string | null; tx: string | null } | null> {
  try {
    const url = `${facilitator}/settle/status?asset=${encodeURIComponent(asset)}&payer=${encodeURIComponent(payer)}&nonce=${encodeURIComponent(nonce)}`
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) })
    const json = (await res.json()) as Record<string, unknown> | null
    if (res.status !== 200 || !json || typeof json !== 'object') return null
    return {
      status: typeof json.status === 'string' ? json.status : null,
      tx: typeof json.transaction === 'string' && json.transaction.startsWith('0x') ? json.transaction : null,
    }
  } catch {
    return null
  }
}

/** EIP-712 domain of Celo USDC, read live from BOTH networks' contracts on 2026-08-09
 *  (name() = "USDC", version() = "2"). Part of the challenge so a buyer can sign the
 *  EIP-3009 authorization without an extra on-chain read. */
const USDC_EIP712_DOMAIN = { name: 'USDC', version: '2' }

// ── the tools sold ────────────────────────────────────────────────────────────────

export const CELO_TOOLS = ['verify_agent', 'reputation_score', 'risk_check', 'agent_passport'] as const
export type CeloToolName = (typeof CELO_TOOLS)[number]

/** Per-call USD prices - the SAME numbers the OKX trust suite charges (asp/payment.ts
 *  PRICES). Pinned by celo-x402.test.ts so the two rails cannot drift apart silently. */
export const CELO_TOOL_PRICES_USD: Record<CeloToolName, number> = {
  verify_agent: 0.001,
  reputation_score: 0.002,
  risk_check: 0.005,
  agent_passport: 0.01,
}

const AGENT_ID_DOC =
  'ERC-8004 token id ("#1" is Celo\'s token 1 here: each chain numbers its own agents), a CAIP id ("eip155:42220:8004/1"), or a 0x owner address'

/**
 * The id a paid call on this rail is answered for. Every chain's ERC-8004 registry mints its own
 * token ids, so a bare one ("#9759" or "9759") names no agent until a chain is named, and the
 * shared resolver answers it with the first chain in registry order that has it: "#9759" read
 * that way was Arc Mainnet's token 9759, someone else's agent, under a receipt for a Celo check.
 * On this rail a bare id means the rail's own chain (Celo mainnet, or Celo Sepolia on a testnet
 * rail), so it becomes that chain's CAIP-10 id before any tool sees it, the same id the
 * celoIdentity read already used. Every other form (a 0x address, any CAIP id, a platform id) is
 * passed unchanged, so nothing the trust tools do for those inputs moves.
 */
export function celoScopedAgentId(agentId: string, chain: Pick<ChainDescriptor, 'caip2'>): string {
  const bare = /^#?(\d{1,78})$/.exec(agentId.trim())
  return bare ? `${chain.caip2}:8004/${BigInt(bare[1])}` : agentId
}

/**
 * A CAIP-10 token id that names another chain than `chain`, as that chain's CAIP-2 id, or null.
 * Its number is that chain's token: the same number in Celo's registry is an unrelated agent, so
 * the Celo-side reads below decline it rather than report a stranger's agent under its id.
 */
function otherChainOf(agentId: string, chain: ChainDescriptor): string | null {
  const caip = /^eip155:(\d+):8004\/\d{1,78}$/i.exec(agentId.trim())
  return caip && Number(caip[1]) !== chain.evmChainId ? `eip155:${caip[1]}` : null
}

/** The machine-readable calling contract served inside the 402 challenge, so a buyer
 *  agent knows the method, fields and an example BEFORE paying (same idea as the ASP
 *  gateway's unpaid response body). */
export const CELO_TOOL_CARDS: Record<
  CeloToolName,
  { description: string; input: Record<string, string>; example: Record<string, unknown> }
> = {
  verify_agent: {
    description: 'Verify an AI agent: ERC-8004 identity + KYA status + endpoint liveness.',
    input: { agentId: AGENT_ID_DOC },
    example: { agentId: '#1' },
  },
  reputation_score: {
    description:
      'Deterministic 0-1000 reputation with a full breakdown, PLUS a live read of Celo\'s on-chain ReputationRegistry summary for the agent.',
    input: { agentId: AGENT_ID_DOC },
    example: { agentId: '#1' },
  },
  risk_check: {
    description: 'Pre-transaction ALLOW / WARN / DENY verdict on a counterparty, with reasons.',
    input: { agentId: AGENT_ID_DOC, txContext: 'optional object: { "amountUsd": number, "payee": "0x address" }' },
    example: { agentId: '#1', txContext: { amountUsd: 25 } },
  },
  agent_passport: {
    description: 'The full identity + reputation + risk passport in one JSON document.',
    input: { agentId: AGENT_ID_DOC },
    example: { agentId: '#1' },
  },
}

// ── configuration status (fail-closed) ────────────────────────────────────────────

export type CeloX402Status = {
  configured: boolean
  /** CAIP-2 id of the settlement network (e.g. 'eip155:42220'). */
  network: string
  /** Registry slug of the resolved chain ('celo' | 'celo-sepolia'), null if unresolvable. */
  chain: string | null
  payTo: string | null
  facilitator: string
  reason?: string
}

/** Resolve which Celo-family descriptor the rail settles on. CELO_X402_NETWORK (a CAIP-2
 *  id) selects it; unset means mainnet. Only descriptors in the registry qualify - an
 *  unknown network is a configuration error, not a guess. */
function resolveCeloChain(env: NodeJS.ProcessEnv): { chain: ChainDescriptor | null; requested: string } {
  const mainnet = getChainById('celo')
  const testnet = getChainById('celo-sepolia')
  const requested = env.CELO_X402_NETWORK?.trim() || mainnet?.caip2 || ''
  const chain = [mainnet, testnet].find((c) => c && c.caip2 === requested) ?? null
  return { chain, requested }
}

/**
 * The rail's configuration status. `configured` is true ONLY when a valid payTo address
 * and the facilitator API key are both present and the network resolves to a registry
 * descriptor. There is deliberately NO fallback from payTo to any signer key: the
 * receiving address must be an explicit decision, never an accident of which key is set.
 */
export function celoX402Status(env: NodeJS.ProcessEnv = process.env): CeloX402Status {
  const { chain, requested } = resolveCeloChain(env)
  const payToRaw = env.CELO_PAYTO?.trim() ?? ''
  // A retired address (chains/retired.ts) is never a pay-to: someone else holds its key, so the rail
  // fails closed as not configured and never names it.
  const payToRetired = retiredPayToRefusal('CELO_PAYTO', payToRaw)
  const payTo = !payToRetired && /^0x[0-9a-fA-F]{40}$/.test(payToRaw) ? payToRaw.toLowerCase() : null
  const apiKey = env.CELO_X402_API_KEY?.trim() ?? ''
  const facilitator =
    env.CELO_X402_FACILITATOR?.trim() || (chain?.testnet ? FACILITATOR_TESTNET : FACILITATOR_MAINNET)

  if (!chain) {
    return {
      configured: false,
      network: requested,
      chain: null,
      payTo,
      facilitator,
      reason: `CELO_X402_NETWORK '${requested}' is not a Celo network in the chain registry (use the celo or celo-sepolia CAIP-2 id)`,
    }
  }
  if (payToRetired) {
    return { configured: false, network: chain.caip2, chain: chain.id, payTo, facilitator, reason: `celo x402 not configured: ${payToRetired}` }
  }
  const missing: string[] = []
  if (!payTo) missing.push('CELO_PAYTO (0x receiving address)')
  if (!apiKey) missing.push('CELO_X402_API_KEY (facilitator settle key from x402.celo.org)')
  if (missing.length) {
    return {
      configured: false,
      network: chain.caip2,
      chain: chain.id,
      payTo,
      facilitator,
      reason: `celo x402 not configured: set ${missing.join(' and ')}`,
    }
  }
  return { configured: true, network: chain.caip2, chain: chain.id, payTo, facilitator }
}

/** The pure paywall decision the routes apply: unconfigured means 501, NEVER a free
 *  serve. (The ASP's fail-open x402 is the documented exception on OKX; this rail is
 *  fail-closed on purpose, and the tests pin it.) */
export function celoPaywallGate(
  status: CeloX402Status,
): { ok: true } | { ok: false; httpStatus: 501; body: { error: string; reason?: string } } {
  if (status.configured) return { ok: true }
  return {
    ok: false,
    httpStatus: 501,
    body: { error: 'celo x402 not configured', ...(status.reason ? { reason: status.reason } : {}) },
  }
}

// ── the 402 challenge ─────────────────────────────────────────────────────────────
//
// The client-facing interface is x402 v2 over HTTP, as coinbase/x402 specifies it (read
// 2026-11-18: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md and
// https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md):
//  - "The `PAYMENT-REQUIRED` header is the canonical HTTP transport location for the
//    `PaymentRequired` object", base64 of its JSON, on a 402.
//  - PaymentRequired is { x402Version: 2, error?, resource: { url, description?, mimeType? },
//    accepts: [PaymentRequirements] }, and each accepts entry is { scheme, network (CAIP-2),
//    amount ("Required payment amount in atomic token units"), asset, payTo,
//    maxTimeoutSeconds, extra? }. The v1 names (maxAmountRequired, a per-entry resource,
//    description and mimeType) are not part of it.
//  - "Clients send payment data using the `PAYMENT-SIGNATURE` HTTP header", base64 of a
//    PaymentPayload { x402Version: 2, resource?, accepted: <the entry chosen>, payload }.
//  - "Servers communicate payment settlement results using the `PAYMENT-RESPONSE` header",
//    base64 of a SettlementResponse { success, transaction, network, payer?, amount? }.
// The facilitator leg is NOT that interface and did not change: see celoFacilitatorRequirements.

/**
 * The site's own origin. It proxies /api to this backend (vercel.json), so it is the public home
 * of every Celo tool URL, and the origin a challenge names when the caller does not say which
 * host the request reached (a direct caller of these functions, a test).
 */
export const CELO_PUBLIC_ORIGIN = 'https://a-identity.xyz'

/** Where one tool is served, relative to the backend. */
export function celoToolPath(tool: CeloToolName): string {
  return `/api/celo/tools/${tool}`
}

/**
 * The absolute URL of one tool, which x402 v2 carries in `resource.url`: on the origin the request
 * reached (the route passes it, so a call through a-identity.xyz is named there and a call to the
 * backend host is named on that host), else on the site's own origin. Anything that is not a plain
 * http(s) origin falls back to the site's, so the field is always an absolute URL.
 */
export function celoToolUrl(tool: CeloToolName, origin?: string): string {
  try {
    const u = new URL(origin || CELO_PUBLIC_ORIGIN)
    if (u.protocol === 'https:' || u.protocol === 'http:') return `${u.origin}${celoToolPath(tool)}`
  } catch {
    /* not an origin at all: the site's own, below */
  }
  return `${CELO_PUBLIC_ORIGIN}${celoToolPath(tool)}`
}

/** How long a signed authorization may stay valid, in seconds: 600 since the rail opened. */
const CELO_MAX_TIMEOUT_SECONDS = 600

/**
 * One x402 v2 PaymentRequirements entry, with exactly the fields the spec defines for `accepts`.
 * A v2 buyer signs against it and sends it back unchanged as `accepted`.
 */
export type CeloPaymentRequirements = {
  scheme: 'exact'
  /** CAIP-2, e.g. 'eip155:42220'. */
  network: string
  /** Atomic units of the asset, at the registry's USDC decimals. */
  amount: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
  /** EIP-712 domain params of the asset, for the buyer's EIP-3009 signature. */
  extra: { name: string; version: string }
}

/** The descriptor a configured status settles on. Routes gate first, so a throw here is a bug. */
function railChain(status: CeloX402Status): ChainDescriptor {
  const chain = status.chain ? getChainById(status.chain) : undefined
  if (!status.configured || !chain || !status.payTo) {
    throw new Error('celoToolRequirements requires a configured status (gate first)')
  }
  return chain
}

function celoToolDescription(tool: CeloToolName, chain: ChainDescriptor): string {
  return `${CELO_TOOL_CARDS[tool].description} Settled in USDC on ${chain.name} via the Celo x402 facilitator.`
}

/** The x402 v2 requirements for one tool: the entry the 402 offers, and what an `accepted` is held to. */
export function celoToolRequirements(tool: CeloToolName, status: CeloX402Status): CeloPaymentRequirements {
  const chain = railChain(status)
  const usdc = chain.contracts.usdc
  if (!usdc) throw new Error(`chain ${chain.id} has no USDC contract in the registry`)
  return {
    scheme: 'exact',
    network: chain.caip2,
    amount: usdcUnits(chain, CELO_TOOL_PRICES_USD[tool]).toString(),
    asset: usdc,
    payTo: status.payTo as string,
    maxTimeoutSeconds: CELO_MAX_TIMEOUT_SECONDS,
    extra: { ...USDC_EIP712_DOMAIN },
  }
}

/**
 * What the facilitator verifies and settles against: x402 v1 requirements with the registry slug
 * as the network, the only shape api.x402.celo.org accepted when this rail was built (see the
 * wire-shape note in celoServeTool). Field for field, in the same order, the object this rail has
 * always sent it, v1 names and relative resource included; it is derived from the v2 entry above,
 * so the price, asset and payTo a buyer is quoted and the ones the facilitator checks cannot differ.
 */
export function celoFacilitatorRequirements(tool: CeloToolName, status: CeloX402Status) {
  const chain = railChain(status)
  const r = celoToolRequirements(tool, status)
  return {
    scheme: r.scheme,
    network: chain.id,
    asset: r.asset,
    payTo: r.payTo,
    maxAmountRequired: r.amount,
    resource: celoToolPath(tool),
    description: celoToolDescription(tool, chain),
    mimeType: 'application/json' as const,
    maxTimeoutSeconds: r.maxTimeoutSeconds,
    extra: { ...r.extra },
  }
}

/** The x402 v2 PaymentRequired object: what PAYMENT-REQUIRED carries, and what the 402 body leads with. */
export type CeloPaymentRequired = {
  x402Version: 2
  error: string
  resource: { url: string; description: string; mimeType: 'application/json' }
  accepts: CeloPaymentRequirements[]
}

/**
 * The PaymentRequired object for one tool. `error` is "payment required" when nothing was
 * presented, and the reason when a payment was presented and refused.
 */
export function celoPaymentRequired(
  tool: CeloToolName,
  status: CeloX402Status,
  opts: { origin?: string; refusal?: string } = {},
): CeloPaymentRequired {
  const chain = railChain(status)
  return {
    x402Version: 2,
    error: opts.refusal || 'payment required',
    resource: { url: celoToolUrl(tool, opts.origin), description: celoToolDescription(tool, chain), mimeType: 'application/json' },
    accepts: [celoToolRequirements(tool, status)],
  }
}

/** base64 of the JSON, the encoding the v2 HTTP transport uses for all three of its headers. */
export function celoBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

const CELO_PAYMENT_HOWTO =
  'Sign an EIP-3009 TransferWithAuthorization for the accepts entry above (the token domain is in its extra), then send the same POST with header PAYMENT-SIGNATURE: base64(JSON of {x402Version:2, accepted:<that entry, unchanged>, payload:{signature, authorization}}), the x402 v2 payment payload. The x402 v1 header name X-PAYMENT is still accepted, and so is the earlier payload shape {x402Version:2, scheme:"exact", network, payload:{signature, authorization}}.'

/**
 * The full 402 body: the PaymentRequired object, then the tool's calling contract, so a probing
 * client sees everything needed to pay and call correctly, and `verifyError` when a presented
 * payment was refused (the field this rail's own page reads).
 *
 * TRANSITIONAL, for one release: each accepts entry in the BODY also names the price under the
 * x402 v1 name maxAmountRequired, equal to amount. A /check/celo tab loaded before the v2 change
 * reads the price under that name and would otherwise refuse every quote until it is reloaded.
 * The PAYMENT-REQUIRED header, which v2 clients read first, carries the pure v2 object. A v2
 * payment that echoes the field back under `accepted` still matches (acceptedMismatch compares the
 * v2 fields only). Remove it in the release after this one.
 */
export function celoChallenge(tool: CeloToolName, status: CeloX402Status, verifyError?: string, origin?: string) {
  const required = celoPaymentRequired(tool, status, { origin, refusal: verifyError })
  return {
    ...required,
    accepts: required.accepts.map((entry) => ({ ...entry, maxAmountRequired: entry.amount })),
    tool: {
      name: tool,
      priceUsd: CELO_TOOL_PRICES_USD[tool],
      ...CELO_TOOL_CARDS[tool],
      method: `POST ${celoToolPath(tool)}`,
      payment: CELO_PAYMENT_HOWTO,
    },
    ...(verifyError ? { verifyError } : {}),
  }
}

/**
 * A 402 as the route sends it: the challenge in the body, and the PaymentRequired object alone,
 * base64, in the PAYMENT-REQUIRED header, where a stock v2 client reads it. The header carries
 * the spec object and nothing else; the body adds the tool card (and, for one release, the v1
 * price name in each accepts entry: see celoChallenge).
 */
export function celoChallengeResponse(
  tool: CeloToolName,
  status: CeloX402Status,
  opts: { origin?: string; refusal?: string } = {},
): { httpStatus: 402; body: ReturnType<typeof celoChallenge>; headers: Record<string, string> } {
  return {
    httpStatus: 402,
    body: celoChallenge(tool, status, opts.refusal, opts.origin),
    headers: { 'PAYMENT-REQUIRED': celoBase64Json(celoPaymentRequired(tool, status, opts)) },
  }
}

/**
 * The buyer's payment, under either name: PAYMENT-SIGNATURE is the x402 v2 request header, and
 * X-PAYMENT the v1 name this rail asked for until 2026-11-18, still read. The v2 name wins when a
 * request carries both. node:http lower-cases incoming header names.
 */
export function celoPaymentHeader(headers: Record<string, string | string[] | undefined>): string {
  const one = (v: string | string[] | undefined) => ((Array.isArray(v) ? v[0] : v) ?? '').trim()
  return one(headers['payment-signature']) || one(headers['x-payment'])
}

/**
 * A v2 payment names the offer it was signed for under `accepted`, and that has to be the one this
 * resource asks for: the fields a reference x402 server compares, addresses in any case. Checked
 * before the facilitator is asked anything, and the refusal names the field. Whether the signature
 * pays exactly that is the facilitator's check, against the requirements built here.
 */
function acceptedMismatch(payment: Record<string, unknown>, req: CeloPaymentRequirements): string | null {
  if (payment.x402Version !== 2) {
    return `a payment that names accepted is x402 v2, and this one says x402Version ${JSON.stringify(payment.x402Version ?? null)}`
  }
  const a = payment.accepted
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'accepted must be the accepts entry of this 402 that the payment was signed for'
  const got = a as Record<string, unknown>
  for (const field of ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds'] as const) {
    const want = req[field]
    const same =
      field === 'asset' || field === 'payTo'
        ? typeof got[field] === 'string' && (got[field] as string).toLowerCase() === String(want).toLowerCase()
        : got[field] === want
    if (!same) return `accepted.${field} is ${JSON.stringify(got[field] ?? null)}, and this resource asks for exactly ${JSON.stringify(want)}`
  }
  return null
}

// ── on-chain Celo reputation read (the extra value in reputation_score) ───────────

/** Minimal ABI for the deployed ERC-8004 ReputationRegistry reads, verified against the
 *  live Celo contract on 2026-08-09: getClients(1) returned 12 real feedback clients and
 *  getSummary(1, clients, '', '') decoded to (count 14, averageScore 88). getSummary
 *  REQUIRES a non-empty clientAddresses array (it reverts with 'clientAddresses
 *  required'), which is why the read goes getClients first. */
const CELO_REPUTATION_ABI = [
  {
    type: 'function',
    name: 'getClients',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getSummary',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'averageScore', type: 'int128' },
    ],
  },
] as const

/** Minimal ABI for the deployed ERC-8004 IdentityRegistry reads (it exposes the ERC-721
 *  surface), verified against the live Celo contract on 2026-08-09: ownerOf(9759)
 *  returned our payTo wallet and tokenURI(9759) our agent card URL. There is no
 *  totalSupply() on it, so an id is probed by ownerOf reverting for an unminted one. */
const CELO_IDENTITY_ABI = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
] as const

/** A tokenURI can be a multi-kilobyte inline data: URI (several live Celo agents pin the
 *  whole agent.json that way). A paid response quotes the head of it and says so rather
 *  than shipping kilobytes of base64 into every receipt. */
const CELO_TOKEN_URI_MAX = 200

export type CeloOnchainIdentity =
  | {
      read: true
      registry: string
      network: string
      agentId: string
      owner: string
      /** Truncated at CELO_TOKEN_URI_MAX; `tokenUriTruncated` says when that happened. */
      tokenURI: string | null
      tokenUriTruncated: boolean
      explorer: string
    }
  | { read: false; reason: string }

/** Injectable read so the identity path unit-tests without an RPC, same convention as
 *  CeloServeDeps. Defaults to a live viem client for the resolved Celo descriptor. */
export type CeloIdentityDeps = {
  readContract?: (functionName: 'ownerOf' | 'tokenURI', tokenId: bigint) => Promise<unknown>
}

export type CeloOnchainReputation =
  | {
      read: true
      registry: string
      network: string
      agentId: string
      feedbackClients: number
      feedbackCount: number
      /** 0-100 average per the ERC-8004 convention; null when no feedback exists yet. */
      averageScore: number | null
      note?: string
    }
  | { read: false; reason: string }

/** Cap on the paid on-chain read so a slow RPC degrades the extra field, not the call. */
const CELO_READ_TIMEOUT_MS = 6000

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc read timed out after ${ms}ms`)), ms)
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as unknown as { unref: () => void }).unref()
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Best-effort LIVE read of Celo's ReputationRegistry summary for an agent, so a paid
 * reputation_score answer carries real on-chain Celo data next to our deterministic
 * score. Degrades to { read: false, reason } - never throws into a paid call.
 */
export async function celoReputationSummary(
  agentId: string,
  status: CeloX402Status = celoX402Status(),
): Promise<CeloOnchainReputation> {
  const chain = status.chain ? getChainById(status.chain) : getChainById('celo')
  if (!chain) return { read: false, reason: 'no celo descriptor in the chain registry' }
  const registry = chain.contracts.reputationRegistry
  if (!registry) return { read: false, reason: `no reputationRegistry address for ${chain.id} in the registry` }

  // A summary read needs a NUMERIC ERC-8004 agent id ("#1", "1", or a CAIP id ending in
  // /1). An owner address can't be summarized without an id, and saying so beats guessing.
  // Another chain's CAIP id is that chain's token, so Celo's summary is not read for it.
  const other = otherChainOf(agentId, chain)
  if (other) return { read: false, reason: `${agentId.trim()} names a token on ${other}, not on ${chain.name} (${chain.caip2}); the same number here is another agent` }
  const m = agentId.trim().match(/^#?(\d{1,78})$/) ?? agentId.trim().match(/:8004\/(\d{1,78})$/)
  if (!m) {
    return { read: false, reason: 'on-chain summary needs a numeric ERC-8004 agent id (e.g. "#1" or a CAIP …:8004/1 id)' }
  }
  const tokenId = BigInt(m[1])

  try {
    const client = await evmPublicClient(chain)
    const clients = (await raceTimeout(
      client.readContract({
        address: registry as `0x${string}`,
        abi: CELO_REPUTATION_ABI,
        functionName: 'getClients',
        args: [tokenId],
      }),
      CELO_READ_TIMEOUT_MS,
    )) as readonly `0x${string}`[]
    if (clients.length === 0) {
      return {
        read: true,
        registry,
        network: chain.caip2,
        agentId: `${chain.caip2}:8004/${tokenId}`,
        feedbackClients: 0,
        feedbackCount: 0,
        averageScore: null,
        note: 'no feedback recorded for this agent on Celo yet (honest zero, not an error)',
      }
    }
    const [count, averageScore] = (await raceTimeout(
      client.readContract({
        address: registry as `0x${string}`,
        abi: CELO_REPUTATION_ABI,
        functionName: 'getSummary',
        args: [tokenId, clients, '', ''],
      }),
      CELO_READ_TIMEOUT_MS,
    )) as readonly [bigint, bigint]
    return {
      read: true,
      registry,
      network: chain.caip2,
      agentId: `${chain.caip2}:8004/${tokenId}`,
      feedbackClients: clients.length,
      feedbackCount: Number(count),
      averageScore: Number(averageScore),
    }
  } catch (e) {
    return { read: false, reason: e instanceof Error ? e.message : 'celo rpc read failed' }
  }
}

/**
 * Best-effort LIVE read of Celo's IdentityRegistry for an agent id, so a paid answer about a
 * Celo agent carries the Celo-side facts a buyer can check for themselves: the owner, the
 * tokenURI and a Celoscan link. It was added when the trust body (identity/kya/reputation)
 * answered a bare id from whichever chain the shared resolver matched first, so a Celo buyer
 * could pay for an answer that never touched Celo. celoScopedAgentId now sends a bare id to
 * Celo's registry, and this read stays as the direct, linkable record. Another chain's CAIP id
 * is declined, never read here under its number.
 * Degrades to { read: false, reason } - never throws into a paid call.
 */
export async function celoIdentitySummary(
  agentId: string,
  status: CeloX402Status = celoX402Status(),
  deps: CeloIdentityDeps = {},
): Promise<CeloOnchainIdentity> {
  const chain = status.chain ? getChainById(status.chain) : getChainById('celo')
  if (!chain) return { read: false, reason: 'no celo descriptor in the chain registry' }
  const registry = chain.contracts.identityRegistry
  if (!registry) return { read: false, reason: `no identityRegistry address for ${chain.id} in the registry` }

  // Same id grammar as the reputation read: a registry lookup needs a NUMERIC id, and another
  // chain's CAIP id is that chain's token, never a reason to report Celo's token of that number.
  const other = otherChainOf(agentId, chain)
  if (other) return { read: false, reason: `${agentId.trim()} names a token on ${other}, not on ${chain.name} (${chain.caip2}); the same number here is another agent` }
  const m = agentId.trim().match(/^#?(\d{1,78})$/) ?? agentId.trim().match(/:8004\/(\d{1,78})$/)
  if (!m) {
    return { read: false, reason: 'a Celo identity read needs a numeric ERC-8004 agent id (e.g. "#9759" or a CAIP …:8004/9759 id)' }
  }
  const tokenId = BigInt(m[1])

  try {
    const read =
      deps.readContract ??
      (await (async () => {
        const client = await evmPublicClient(chain)
        return (fn: string) =>
          client.readContract({
            address: registry as `0x${string}`,
            abi: CELO_IDENTITY_ABI,
            functionName: fn as 'ownerOf' | 'tokenURI',
            args: [tokenId],
          })
      })())
    const owner = (await raceTimeout(read('ownerOf', tokenId), CELO_READ_TIMEOUT_MS)) as `0x${string}`

    // tokenURI is a second call and a softer fact: a missing/reverting URI still leaves a
    // real owner, so it degrades to null rather than failing the whole read.
    let tokenURI: string | null = null
    try {
      tokenURI = (await raceTimeout(read('tokenURI', tokenId), CELO_READ_TIMEOUT_MS)) as string
    } catch {
      /* owner is the fact that matters; the URI stays null */
    }
    const truncated = typeof tokenURI === 'string' && tokenURI.length > CELO_TOKEN_URI_MAX
    return {
      read: true,
      registry,
      network: chain.caip2,
      agentId: `${chain.caip2}:8004/${tokenId}`,
      owner,
      tokenURI: truncated ? `${tokenURI!.slice(0, CELO_TOKEN_URI_MAX)}…` : tokenURI,
      tokenUriTruncated: truncated,
      explorer: `${chain.explorer}/nft/${registry}/${tokenId}`,
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : 'celo rpc read failed'
    // An unminted id is the common case and is NOT an error: ownerOf reverts for it.
    const unminted = /revert/i.test(raw)
    return {
      read: false,
      reason: unminted
        ? `no agent #${tokenId} in the Celo identity registry ${registry} (ownerOf reverted)`
        : raw,
    }
  }
}

// ── serving a paid call (verify -> settle -> serve -> record) ────────────────────────

export type CeloToolInput = { agentId: string; txContext?: TxContext | null }

/** Injectable dependencies so the whole redemption path unit-tests without network. */
export type CeloServeDeps = {
  /** Scheme and host the request reached, for the absolute resource URL in a fresh challenge. */
  origin?: string
  fetchImpl?: typeof fetch
  persist?: (rec: CeloSettlementRecord) => Promise<void>
  handlers?: Partial<Record<CeloToolName, (input: CeloToolInput) => Promise<unknown>>>
  env?: NodeJS.ProcessEnv
  now?: () => Date
  /** Whether the buyer's EIP-3009 nonce is spent on-chain (USDC authorizationState): the read
   *  that settles what a failed /settle left open. Null when the chain could not be read. */
  authorizationUsed?: (payer: string, nonce: string) => Promise<boolean | null>
  /** The facilitator's own view of one authorization (GET /settle/status), for the hash after a read-back. */
  settleStatus?: (payer: string, nonce: string) => Promise<{ status: string | null; tx: string | null } | null>
}

/**
 * "Celo mainnet (eip155:42220)", "Celo Sepolia testnet (eip155:11142220)": the registry's name for
 * a chain and its CAIP-2 id, saying mainnet or testnet where the name does not.
 */
function chainLabel(c: ChainDescriptor): string {
  const name = c.name.replace(/\s*\((?:mainnet|testnet)\)$/i, '')
  const kind = /mainnet|testnet/i.test(name) ? '' : c.testnet ? ' testnet' : ' mainnet'
  return `${name}${kind} (${c.caip2})`
}

/** What the labels say when the call does not name the chain that answered. */
const RESOLVED_UNNAMED = 'every registry our resolver reads (this answer does not name the one that matched)'

/**
 * The chain the trust body of a paid answer was resolved against, named from what the call
 * itself carries, never assumed:
 *  - A CAIP-10 token id names its chain, and the shared resolver reads that chain's registry
 *    and no other. After celoScopedAgentId every bare id on this rail is one of these, on Celo.
 *  - A NEAR testnet account (nearTargetOf, the one NEAR routing rule) is answered from NEAR testnet.
 *  - Any other form (an address, a platform id) is matched across every chain the resolver
 *    reads, so only an identity the tool returns can name the chain that answered: verify_agent
 *    and agent_passport return one, risk_check and reputation_score do not, and then this says so.
 */
function resolvedOn(agentId: string, result: Record<string, unknown>): string {
  const caip = /^eip155:(\d+):8004\/\d{1,78}$/i.exec(agentId.trim())
  if (caip) {
    const c = getChainByEvmId(Number(caip[1]))
    if (!c) return `eip155:${caip[1]}, a chain our registry does not know, so no registry was read for it`
    return c.contracts.identityRegistry ? chainLabel(c) : `${chainLabel(c)}, where we wire no ERC-8004 identity registry, so none was read`
  }
  const near = nearTargetOf(agentId)
  if (near) {
    const c = getChain(near.network)
    return c ? chainLabel(c) : near.network
  }
  const identity = result.identity as { chain?: unknown } | null | undefined
  if (identity && typeof identity.chain === 'string') {
    const c = getChainById(identity.chain)
    return c ? chainLabel(c) : identity.chain
  }
  return RESOLVED_UNNAMED
}

/**
 * This rail's labels on a paid answer. They replace the ASP tool meta's network line, which
 * names X Layer (where the OKX listings settled), so a Celo buyer's receipt never claims a
 * chain it did not touch. Everything else in that meta (methodology, the deterministic-score
 * note) is the same product and stays.
 *
 * HONEST SCOPE: two chains, each said by name. `network` is where the PAYMENT settled, this
 * Celo rail. `homeRegistryNetwork` is where the identity, KYA and reputation body was resolved
 * (resolvedOn above): the field keeps its name, but it used to copy the ASP meta's X Layer line
 * whatever chain the resolver had read, and now names the one it read. The Celo-side facts
 * travel in the dedicated `celoIdentity` / `celoReputation` fields. Applied to every answer the
 * rail serves, whichever handler produced it.
 */
/** The registry chain an ERC-8004 CAIP-10 agent id (eip155:<chain>:8004/<n>) names, or null for any other form. */
function chainOfAgentId(agentId: string): string | null {
  const m = /^eip155:(\d+):8004\/\d{1,78}$/i.exec(agentId.trim())
  return m ? (getChainByEvmId(Number(m[1]))?.id ?? null) : null
}

/**
 * Upstream, a reputation anchor is matched on the token number alone, so an answer about a Celo token
 * could carry the anchor another chain holds for the same number (Celo #1259 is a stranger's, Arbitrum
 * #1259 is ours). An anchor whose chain is not the chain the id names is dropped here, on this rail only.
 */
function dropForeignAnchor(value: unknown, chainId: string): unknown {
  if (!value || typeof value !== 'object') return value
  const chain = (value as { chain?: unknown }).chain
  return typeof chain === 'string' && chain !== chainId ? null : value
}

function withCeloMeta(result: Record<string, unknown>, status: CeloX402Status, agentId: string): Record<string, unknown> {
  const prior = result._meta && typeof result._meta === 'object' ? (result._meta as Record<string, unknown>) : {}
  const home = resolvedOn(agentId, result)
  const named = chainOfAgentId(agentId)
  if (named) {
    if ('onchainAttestation' in result) result = { ...result, onchainAttestation: dropForeignAnchor(result.onchainAttestation, named) }
    const rep = result.reputation
    if (rep && typeof rep === 'object' && 'onchainAttestation' in rep) {
      result = { ...result, reputation: { ...(rep as Record<string, unknown>), onchainAttestation: dropForeignAnchor((rep as Record<string, unknown>).onchainAttestation, named) } }
    }
  }
  return {
    ...result,
    _meta: {
      ...prior,
      network: `Celo (${status.network})`,
      settlement: 'x402 v2 exact via the first-party Celo facilitator (EIP-3009 USDC)',
      proof: '/api/celo/proof',
      homeRegistryNetwork: home,
      scope: `payment settled on Celo (${status.network}); the identity, KYA and reputation body is resolved against ${home}; the celoIdentity and celoReputation fields are read live from Celo's own ERC-8004 registries when the id names a Celo token`,
    },
  }
}

function defaultHandlers(status: CeloX402Status): Record<CeloToolName, (input: CeloToolInput) => Promise<unknown>> {
  /** Every paid Celo answer carries a Celo-side identity read for the id it was asked
   *  about - otherwise a Celo buyer could pay a Celo rail and get back nothing that ever
   *  touched Celo. Runs concurrently with the base tool so it costs no extra latency. */
  const served = async <T extends object>(base: Promise<T>, agentId: string) => {
    const [result, celoIdentity] = await Promise.all([base, celoIdentitySummary(agentId, status)])
    return { ...result, celoIdentity }
  }
  return {
    verify_agent: async (i) => served(verifyAgent(i.agentId), i.agentId),
    reputation_score: async (i) => {
      const [base, celoReputation] = await Promise.all([
        served(reputationScore(i.agentId), i.agentId),
        celoReputationSummary(i.agentId, status),
      ])
      return { ...base, celoReputation }
    },
    risk_check: async (i) => served(riskCheck(i.agentId, i.txContext ?? null), i.agentId),
    agent_passport: async (i) => served(agentPassport(i.agentId), i.agentId),
  }
}

/** POST a JSON body to the facilitator with a hard timeout. Throws on network failure. */
async function facilitatorPost(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs: number = FACILITATOR_VERIFY_TIMEOUT_MS,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json: Record<string, unknown> | null = null
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    /* non-JSON answer: treated by callers as a facilitator failure */
  }
  return { status: res.status, json }
}

/**
 * The full paid-call path for one tool. Returns { httpStatus, body, headers } so the route stays
 * a thin adapter. Outcomes, in order:
 *   402 - a payment header that does not decode, a v2 payment whose `accepted` is not this
 *         resource's offer, or the facilitator says the payment is invalid (fresh challenge +
 *         verifyError, with PAYMENT-REQUIRED; the client fixes its payment and retries).
 *         Also a settlement the facilitator refused outright while the chain shows the
 *         authorization unspent: PAYMENT-RESPONSE with success false, a fresh PAYMENT-REQUIRED,
 *         and charged: false in the body.
 *   502 - the facilitator failed or answered ambiguously (verify OR settle). The tool
 *         is NOT served and the payment is NOT resubmitted: a repeated settle could
 *         double-spend the buyer's authorization, so the client retries with a fresh one.
 *         After a failed settle the body's `charged` is false (the authorization reads
 *         unspent on-chain, and the facilitator named no transaction and no pending one)
 *         or 'unknown', with `tx` when the facilitator named the transfer to check.
 *   500 - settle succeeded but the tool handler itself failed. The settlement is still
 *         recorded (it happened) and the body says exactly that.
 *   200 - settled and served; the settlement is durably recorded for /api/celo/proof.
 * A settled answer (200, or the 500 after settlement) carries the v2 receipt in PAYMENT-RESPONSE
 * when its transaction hash is known.
 * The tool is asked about celoScopedAgentId(input.agentId): a bare token id is Celo's here.
 */
export async function celoServeTool(
  tool: CeloToolName,
  input: CeloToolInput,
  paymentHeader: string,
  status: CeloX402Status,
  deps: CeloServeDeps = {},
): Promise<{ httpStatus: number; body: unknown; headers?: Record<string, string> }> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const persist = deps.persist ?? persistCeloSettlement
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const chain = status.chain ? getChainById(status.chain) : undefined
  if (!status.configured || !chain) {
    // Defense in depth: routes gate first, but a direct caller must hit the same wall.
    const gate = celoPaywallGate(status)
    return gate.ok
      ? { httpStatus: 501, body: { error: 'celo x402 not configured', reason: 'network descriptor missing from the registry' } }
      : { httpStatus: gate.httpStatus, body: gate.body }
  }
  // While the rail is paused (the facilitator refused to settle for us), a paid call is not
  // attempted: the routes refuse first, and a direct caller meets the same wall here.
  const pausedNow = celoPauseResponse(now())
  if (pausedNow) return pausedNow

  // A bare token id ("#9759", from the page, the buyer script or any agent) is this chain's:
  // the tools are asked about the Celo agent the buyer paid this rail to check, never about
  // whichever chain's token of that number the shared resolver would match first.
  const asked: CeloToolInput = { ...input, agentId: celoScopedAgentId(input.agentId, chain) }

  // A refused payment gets a fresh challenge naming why, in the body and in PAYMENT-REQUIRED.
  const refuse = (reason: string) => celoChallengeResponse(tool, status, { origin: deps.origin, refusal: reason })

  // 1. Decode the payment header (base64 JSON): an x402 v2 PaymentPayload, or the earlier flat shape.
  let paymentPayload: Record<string, unknown>
  try {
    const decoded = Buffer.from(paymentHeader, 'base64').toString('utf8')
    paymentPayload = JSON.parse(decoded) as Record<string, unknown>
    if (typeof paymentPayload !== 'object' || paymentPayload === null || Array.isArray(paymentPayload)) throw new Error('not an object')
  } catch {
    return refuse('malformed payment header (PAYMENT-SIGNATURE or X-PAYMENT): expected base64 of an x402 v2 payment payload in JSON')
  }
  const authorization =
    (paymentPayload.payload as Record<string, unknown> | undefined)?.authorization as
      | Record<string, unknown>
      | undefined
  const payer = typeof authorization?.from === 'string' ? authorization.from.toLowerCase() : undefined

  const requirements = celoToolRequirements(tool, status)

  // 2. /verify - the facilitator checks the signature, asset, amount and recipient.
  // Wire-shape note (verified against the live facilitator on 2026-08-09): /supported
  // advertises an x402Version 2 kind under the CAIP-2 network id, but /verify only
  // accepts the v1 shape with the slug network label; the v2/CAIP-2 body answers
  // "unsupported_scheme". So we normalize OUR client-facing v2 payload to the v1 slug
  // shape here, at the facilitator boundary, and nowhere else: the public 402
  // challenge stays v2/CAIP-2.
  // Two client shapes reach this point, and both become the same facilitator body. A v2
  // PaymentPayload names its offer under `accepted` (checked against this resource first) and
  // carries scheme and network only there, so its v1 form is built from its parts. The earlier
  // flat shape ({x402Version, scheme, network, payload}) is converted exactly as it always was.
  // For the same signature the two produce byte-identical /verify and /settle bodies.
  let v1Payload: Record<string, unknown>
  if ('accepted' in paymentPayload) {
    const mismatch = acceptedMismatch(paymentPayload, requirements)
    if (mismatch) return refuse(mismatch)
    v1Payload = { x402Version: 1, scheme: requirements.scheme, network: chain.id, payload: paymentPayload.payload }
  } else {
    v1Payload = { ...paymentPayload, x402Version: 1, network: chain.id }
  }
  const v1Requirements = celoFacilitatorRequirements(tool, status)
  let verify: { status: number; json: Record<string, unknown> | null }
  try {
    verify = await facilitatorPost(fetchImpl, `${status.facilitator}/verify`, {
      x402Version: 1,
      paymentPayload: v1Payload,
      paymentRequirements: v1Requirements,
    })
  } catch (e) {
    return {
      httpStatus: 502,
      body: {
        error: 'celo facilitator verify failed',
        reason: e instanceof Error ? e.message : 'network error',
        note: 'the tool was not served and nothing was charged; retry in a moment',
      },
    }
  }
  const isValid = verify.json?.isValid === true || verify.json?.valid === true
  // The live facilitator refuses a payment with HTTP 400 and a verdict, { isValid: false,
  // invalidReason } (read 2026-11-18 with an unfunded test key: insufficient_funds, and
  // recipient_mismatch for a wrong payee). That is a payment the buyer has to fix, so it is the
  // 402 below, as x402 maps a failed verification, and not a facilitator failure to retry.
  // Any other status that is not a 200 still is one.
  const refusedOn400 = verify.status === 400 && (verify.json?.isValid === false || verify.json?.valid === false)
  if ((verify.status !== 200 && !refusedOn400) || !verify.json) {
    return {
      httpStatus: 502,
      body: {
        error: 'celo facilitator verify failed',
        reason: `facilitator answered ${verify.status}`,
        note: 'the tool was not served and nothing was charged; retry in a moment',
      },
    }
  }
  if (!isValid) {
    const reason =
      (typeof verify.json.invalidReason === 'string' && verify.json.invalidReason) ||
      (typeof verify.json.reason === 'string' && verify.json.reason) ||
      'payment did not verify'
    return refuse(reason)
  }

  // 3. /settle - the facilitator broadcasts the EIP-3009 transfer. X-API-Key is OUR
  // seller credential; `network` uses the facilitator's v1 label, which its /supported
  // lists as exactly our registry slug ('celo' / 'celo-sepolia').
  // The two reads that settle what a failed /settle leaves open: whether the buyer's nonce
  // is spent on-chain (the fact), and the facilitator's own record of it (the hash).
  const authorizationUsed = deps.authorizationUsed ?? ((p: string, n: string) => readAuthorizationUsed(chain, p, n))
  const settleStatus = deps.settleStatus ?? ((p: string, n: string) => readSettleStatus(fetchImpl, status.facilitator, requirements.asset, p, n))
  const nonce = typeof authorization?.nonce === 'string' ? authorization.nonce : null

  // 4. Record the settlement durably, then serve. The record happens even if the
  // handler fails: the money moved, and the proof log must say so. `confirmedBy` says who
  // established that: the facilitator's answer, or the chain read after it failed to answer.
  const serveSettled = async (s: { settleTx?: string; credits?: number; confirmedBy: 'facilitator' | 'read-back'; facilitatorAnswer?: string }) => {
    const record: CeloSettlementRecord = {
      ts: now().toISOString(),
      tool,
      amountUsd: CELO_TOOL_PRICES_USD[tool],
      ...(payer ? { payer } : {}),
      ...(s.settleTx ? { tx: s.settleTx } : {}),
      network: status.network,
      ...(s.credits !== undefined ? { facilitatorCredits: s.credits } : {}),
    }
    await persist(record)

    const settlement = {
      settled: true,
      network: status.network,
      facilitator: status.facilitator,
      ...(s.settleTx ? { tx: s.settleTx } : {}),
      ...(payer ? { payer } : {}),
      ...(s.credits !== undefined ? { facilitatorCredits: s.credits } : {}),
      settledAt: record.ts,
      confirmedBy: s.confirmedBy,
      ...(s.facilitatorAnswer
        ? {
            facilitatorAnswer: s.facilitatorAnswer,
            note: "the facilitator did not confirm this settlement, but the buyer's authorization is spent on-chain, so the payment is real: recorded and served",
          }
        : {}),
    }

    // The v2 receipt: the SettlementResponse fields the spec defines, base64, beside the fuller
    // settlement object the body carries. It is sent only with the transaction hash. The spec reads
    // an empty `transaction` as "no transaction was broadcast" (x402-specification-v2.md 5.3.2),
    // which a settled EIP-3009 payment never is, so a confirmation that named no hash, or a
    // read-back the facilitator's record could not name, gets no PAYMENT-RESPONSE: the body's
    // settlement says it settled and who confirmed it (confirmedBy). The hash has to be one (32
    // bytes, hex) to go in a receipt. `amount` is what the signed authorization moves, the units
    // EIP-3009 transfers exactly.
    const value = typeof authorization?.value === 'string' && /^\d+$/.test(authorization.value) ? authorization.value : undefined
    const receiptTx = s.settleTx && /^0x[0-9a-fA-F]{64}$/.test(s.settleTx) ? s.settleTx : undefined
    const headers: Record<string, string> = receiptTx
      ? {
          'PAYMENT-RESPONSE': celoBase64Json({
            success: true,
            transaction: receiptTx,
            network: status.network,
            ...(payer ? { payer } : {}),
            ...(value ? { amount: value } : {}),
          }),
        }
      : {}

    const handler = deps.handlers?.[tool] ?? defaultHandlers(status)[tool]
    try {
      const answer = await handler(asked)
      const result =
        answer && typeof answer === 'object' && !Array.isArray(answer) ? withCeloMeta(answer as Record<string, unknown>, status, asked.agentId) : answer
      return {
        httpStatus: 200,
        body: {
          paid: true,
          tool,
          priceUsd: CELO_TOOL_PRICES_USD[tool],
          settlement,
          result,
        },
        headers,
      }
    } catch (e) {
      return {
        httpStatus: 500,
        body: {
          error: 'tool execution failed after settlement',
          reason: e instanceof Error ? e.message : 'handler error',
          settlement,
          note: 'the payment DID settle and is recorded in /api/celo/proof; contact the operator with the settledAt timestamp',
        },
        headers,
      }
    }
  }

  let settle: { status: number; json: Record<string, unknown> | null } | null = null
  let settleError: string | null = null
  try {
    settle = await facilitatorPost(
      fetchImpl,
      `${status.facilitator}/settle`,
      // Same body shape as /verify (proven against the live facilitator on
      // 2026-08-09: the landing page's {payment, network} example answers
      // unsupported_scheme; the verify-shaped body settles and returns
      // {success, payer, transaction, network}).
      { x402Version: 1, paymentPayload: v1Payload, paymentRequirements: v1Requirements },
      { 'X-API-Key': env.CELO_X402_API_KEY?.trim() ?? '' },
      FACILITATOR_SETTLE_TIMEOUT_MS,
    )
  } catch (e) {
    settleError = e instanceof Error ? e.message : 'network error'
  }
  if (settle && settle.status === 200 && settle.json && (settle.json.success === true || settle.json.settled === true)) {
    const credits = typeof settle.json.credits === 'number' ? settle.json.credits : undefined
    const settleTx = typeof settle.json.transaction === 'string' && settle.json.transaction.startsWith('0x') ? settle.json.transaction : undefined
    return serveSettled({ settleTx, credits, confirmedBy: 'facilitator' })
  }

  // The facilitator did not confirm a settlement. What that means for the buyer's money is
  // read from the chain rather than guessed: a spent nonce is a payment that landed (served
  // and recorded, whatever the facilitator said), an unspent one is a payment that never
  // happened, and a chain that cannot be read leaves the honest maybe.
  const said = settle?.json ?? null
  const reason =
    settleError ??
    ((typeof said?.errorMessage === 'string' && said.errorMessage) ||
      (typeof said?.error === 'string' && said.error) ||
      `facilitator answered ${settle?.status} with success=${String(said?.success)}`)
  const used = payer && nonce ? await authorizationUsed(payer, nonce) : null
  if (used === true) {
    const st = payer && nonce ? await settleStatus(payer, nonce) : null
    return serveSettled({ settleTx: st?.tx ?? undefined, confirmedBy: 'read-back', facilitatorAnswer: reason })
  }
  const outOfCredits = said?.error === 'insufficient_credits' || /insufficient_credits|settlement funds/i.test(reason)
  if (outOfCredits) {
    settlementPause = { since: now(), reason }
    const paused = celoPauseResponse(now())
    return {
      httpStatus: 503,
      body: {
        ...(paused?.body ?? { error: 'celo settlement paused', reason }),
        charged: used === false ? false : 'unknown',
        note:
          used === false
            ? `the facilitator refused before broadcasting and the buyer's authorization is unspent on-chain: nothing was charged and nothing was served. ${TOP_UP_NOTE}`
            : `the facilitator refused to settle; the chain could not be read to confirm that nothing moved, so check the payTo address on the explorer. ${TOP_UP_NOTE}`,
      },
    }
  }
  // A settlement that failed outright: the facilitator answered with a verdict (HTTP 200 or 4xx,
  // success false), named no transaction it broadcast and no pending one, and the chain shows the
  // buyer's nonce unspent. x402 v2 maps that to a 402 ("Payment Failed | 402 | Payment verification
  // or settlement failed", in the HTTP transport spec linked at "the 402 challenge" above), whose
  // failure example, like the reference server's settlement-failure response, carries
  // PAYMENT-RESPONSE { success: false, errorReason, transaction: "", network, payer }. A fresh
  // PAYMENT-REQUIRED rides along, since the buyer may pay again with a new authorization. Only this
  // case: a timeout, a facilitator 5xx, or an answer that names a broadcast or pending transaction
  // is no verdict that nothing was broadcast, so those stay the 502s below with no receipt and no
  // fresh price. A failure receipt there could send a stock client to pay again while the first
  // transfer may still land.
  // The transaction the facilitator says it broadcast, when it names one.
  const namedTx = typeof said?.transaction === 'string' && said.transaction.startsWith('0x') ? said.transaction : null
  const pending = said?.errorReason === 'settlement_pending' || said?.error === 'settlement_pending'
  const refusedOutright =
    settleError === null &&
    settle !== null &&
    (settle.status === 200 || (settle.status >= 400 && settle.status < 500)) &&
    (said?.success === false || said?.settled === false) &&
    namedTx === null &&
    !pending
  if (used === false && refusedOutright) {
    // A spec error code ("insufficient_funds", "invalid_exact_evm_payload_authorization_valid_before")
    // when the facilitator gave one; the full sentence stays in the body's reason.
    const errorReason =
      [said?.errorReason, said?.error].find((v): v is string => typeof v === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(v)) ??
      'unexpected_settle_error'
    return {
      httpStatus: 402,
      body: {
        error: 'celo facilitator settle failed',
        reason,
        charged: false,
        note: "the facilitator refused to settle and the buyer's authorization is unspent on-chain, so nothing was charged. The tool was not served and this payment was not resubmitted; retry with a fresh payment.",
      },
      headers: {
        'PAYMENT-RESPONSE': celoBase64Json({
          success: false,
          errorReason,
          transaction: '',
          network: status.network,
          ...(payer ? { payer } : {}),
        }),
        'PAYMENT-REQUIRED': celoBase64Json(
          celoPaymentRequired(tool, status, {
            origin: deps.origin,
            refusal: `settlement failed (${errorReason}); the authorization is unspent on-chain, so nothing was charged. Pay again with a fresh authorization.`,
          }),
        ),
      },
    }
  }
  // settlement_pending is not a failure: the facilitator broadcast the transfer and could not see it
  // confirm, and the spec calls it non-terminal ("the transaction may still confirm on chain"). An
  // unspent nonce read a moment later says only that it has not landed yet, so nothing here may say
  // that nothing was charged.
  if (pending) {
    return {
      httpStatus: 502,
      body: {
        error: 'celo facilitator settle failed',
        reason,
        charged: 'unknown',
        ...(namedTx ? { tx: namedTx } : {}),
        note: 'settlement is PENDING and the money may still move: the facilitator broadcast the transfer and could not confirm it, and a pending transfer can still land. The tool was NOT served and this payment was NOT resubmitted (that could double-settle). Check the payTo address on the explorer before retrying, and retry only with a FRESH payment.',
      },
    }
  }
  // An answer that names a transaction and is not pending (success false with
  // invalid_transaction_state and a hash, or a 5xx that carries one) is no verdict that nothing
  // moved either: the facilitator says it broadcast that transfer, and a broadcast transfer can still
  // land after the buyer's nonce reads unspent, or while the chain cannot be read at all. So it is
  // the conservative answer, whatever the nonce read said: the 502 with no receipt and no fresh
  // price, the money unknown, and the hash to look up before paying again. Never "nothing was charged".
  if (namedTx) {
    return {
      httpStatus: 502,
      body: {
        error: 'celo facilitator settle failed',
        reason,
        charged: 'unknown',
        tx: namedTx,
        note: `settlement is UNCONFIRMED and the money may still move: the facilitator named transaction ${namedTx} without confirming that it settled, and a broadcast transfer can still land even while the buyer's authorization reads unspent. The tool was NOT served and this payment was NOT resubmitted (that could double-settle). Check that transaction on the explorer before paying again, and retry only with a FRESH payment.`,
      },
    }
  }
  if (used === false) {
    return {
      httpStatus: 502,
      body: {
        error: 'celo facilitator settle failed',
        reason,
        charged: false,
        note: "the buyer's authorization is unspent on-chain, so nothing was charged. The tool was not served and this payment was not resubmitted; retry with a fresh payment.",
      },
    }
  }
  if (settleError !== null) {
    return {
      httpStatus: 502,
      body: {
        error: 'celo facilitator settle failed',
        reason,
        charged: 'unknown',
        note: 'settlement is AMBIGUOUS and the money may have moved: the facilitator broadcasts before it answers, so a timeout here can still land the transfer on-chain, and the chain could not be read to tell. The tool was NOT served and this payment was NOT resubmitted (that could double-settle). Check the payTo address on the explorer before retrying, and retry only with a FRESH payment.',
      },
    }
  }
  return {
    httpStatus: 502,
    body: {
      error: 'celo facilitator settle failed',
      reason,
      charged: 'unknown',
      note: 'the tool was not served. This payment was not resubmitted; retry with a fresh payment. The chain could not be read to confirm that nothing moved.',
    },
  }
}

// ── public status + proof documents ───────────────────────────────────────────────

/**
 * OUR OWN wallets, published on purpose. /api/celo/proof marks their settlements
 * internal so nobody can read our own demo traffic as third-party demand - the honest
 * half of running a proof page at all. These are public addresses, not credentials, and
 * hardcoding them is the point: they cannot be quietly unset the way an env var can.
 * CELO_INTERNAL_PAYERS (comma-separated) adds more without a deploy.
 */
const CELO_INTERNAL_PAYERS = [
  // Our buyer wallet until 2026-11-17 (CELO_BUYER_KEY), replaced then as a precaution and still ours: every
  // settlement it paid stays internal. Lowercase on purpose, because payers are compared lowercased.
  '0x8c8d9cd12d8896a40cf2115ee731258bb4983349',
  // Our buyer wallet since 2026-11-17 (CELO_BUYER_KEY), listed before it paid anything.
  '0x312963475c508eff66951b77989ca459ca41268f',
  // The co-founder's wallet: the Self Agent ID human address, the KarmaGAP owner and the Celo
  // grant payout address. Listed 2026-11-17 so a check it pays never reads as external demand.
  '0x9ec344badf764ecc38518d48991961254584f8cc',
  // The founder's wallet that holds our Celo x402 facilitator account at x402.celo.org. Listed
  // 2026-11-17 for the same reason.
  '0xe3130ca9061fc911b7f05e66d76ff44761fefb7e',
]

/** Ours only: an env entry that names a retired address (chains/retired.ts) is not ours, and is dropped. */
function internalPayers(env: NodeJS.ProcessEnv): Set<string> {
  const extra = (env.CELO_INTERNAL_PAYERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s) && !isRetired(s))
  return new Set([...CELO_INTERNAL_PAYERS, ...extra])
}

/** GET /api/celo/status body: rail config (fail-closed truth), registry facts for both
 *  Celo descriptors, and ERC-8004 resolver readiness. No external calls - this must be
 *  fast and honest even when RPCs are down. */
export function celoStatusReport(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()) {
  const status = celoX402Status(env)
  const describe = (id: string) => {
    const c = getChainById(id)
    if (!c) return null
    return {
      id: c.id,
      caip2: c.caip2,
      name: c.name,
      status: c.status,
      testnet: c.testnet,
      explorer: c.explorer,
      usdc: c.contracts.usdc ?? null,
      identityRegistry: c.contracts.identityRegistry ?? null,
      reputationRegistry: c.contracts.reputationRegistry ?? null,
      // A ValidationRegistry proxy is deployed on Celo but not wired into the descriptor,
      // so this reads null and KYA is not anchored there; the surface says so instead of
      // faking it.
      validationRegistry: c.contracts.validationRegistry ?? null,
      // The shared resolver derives its client list from descriptors that carry an
      // identityRegistry, so this flag IS the readiness signal.
      erc8004ResolverWired: Boolean(c.contracts.identityRegistry),
      rpcEnvVar: c.rpcEnvVar ?? null,
    }
  }
  return {
    rail: 'celo-x402',
    ...status,
    tools: CELO_TOOLS.map((t) => ({ name: t, priceUsd: CELO_TOOL_PRICES_USD[t], method: `POST /api/celo/tools/${t}` })),
    // Whether settlements are being attempted right now: false after the facilitator
    // refused to settle for us (an empty settlement balance), for 15 minutes.
    settlement: celoSettlementPause(now),
    chains: { celo: describe('celo'), 'celo-sepolia': describe('celo-sepolia') },
    kyaAnchoring: 'not wired on Celo: a ValidationRegistry proxy is deployed there (read live 2026-10-11), but the descriptor does not set it, so KYA is not anchored on-chain',
  }
}

/**
 * Where Celo payments went before the pay-to address in CELO_PAYTO, newest first. Rows carry no
 * pay-to of their own, so this is how a settlement recorded before a switch stays attributed to the
 * address it was actually paid to. 0xF43F...742D was the Celo pay-to until 01:04 UTC on 2026-11-11.
 * A-Identity retired it that day because someone else holds its key (chains/retired.ts), so nothing
 * is ever paid to it.
 */
export const CELO_PREVIOUS_PAYTO: readonly { address: string; until: string; note: string }[] = [
  {
    address: FORMER_CELO_PAYTO.address,
    until: '2026-11-11T01:04:32Z',
    note: "The Celo pay-to until 2026-11-11 01:04 UTC, retired that day: someone else holds its key and it is not A-Identity's. Do not pay it.",
  },
]

/** GET /api/celo/proof body: the durable settlement log, aggregated. Honest zeros when
 *  nothing has settled; totals cover the retained window (last CELO_SETTLEMENTS_CAP). */
export async function celoProof(
  env: NodeJS.ProcessEnv = process.env,
  load: () => Promise<CeloSettlementRecord[]> = loadCeloSettlements,
) {
  const status = celoX402Status(env)
  const all = await load()
  const ours = internalPayers(env)
  // A retired payer is not ours, and still never external demand.
  const isInternal = (r: CeloSettlementRecord) => !!r.payer && (ours.has(r.payer.toLowerCase()) || isRetired(r.payer))

  const byTool: Record<string, { count: number; usd: number }> = {}
  let totalUsd = 0
  let internalCount = 0
  let internalUsd = 0
  for (const r of all) {
    totalUsd += r.amountUsd
    const t = (byTool[r.tool] ??= { count: 0, usd: 0 })
    t.count += 1
    t.usd = Math.round((t.usd + r.amountUsd) * 1e6) / 1e6
    if (isInternal(r)) {
      internalCount += 1
      internalUsd += r.amountUsd
    }
  }
  const round = (n: number) => Math.round(n * 1e6) / 1e6
  return {
    network: status.network,
    payTo: status.payTo,
    previousPayTo: CELO_PREVIOUS_PAYTO,
    configured: status.configured,
    totalSettlements: all.length,
    totalUsd: round(totalUsd),
    // The sybil-review deal: our OWN buyer wallets are named in the open and their
    // settlements are counted separately, so the headline can never be read as demand
    // it is not. Labeled, never filtered out - the money did move either way.
    internalSettlements: internalCount,
    internalUsd: round(internalUsd),
    externalSettlements: all.length - internalCount,
    externalUsd: round(totalUsd - internalUsd),
    internalPayers: [...ours],
    // Not ours: addresses A-Identity retired because someone else holds their keys. What they paid counts as internal.
    retiredPayers: retiredPublic(),
    byTool,
    recent: all.slice(-50).reverse().map((r) => ({ ...r, internal: isInternal(r) })),
    note: `Real settlements only, recorded at settle time and durable across restarts; totals cover the retained window (last ${CELO_SETTLEMENTS_CAP}). Zeros mean nothing has settled yet, not a mock.`,
    internalNote:
      'Settlements from wallets of ours are marked internal (our buyer wallets, the co-founder\'s wallet and the founder\'s wallet that holds our facilitator account; internalPayers lists every one): they are real on-chain payments used to exercise and demonstrate the rail, not third-party demand. They are labeled rather than hidden. A settlement from an address under retiredPayers is marked internal too: A-Identity retired those addresses because someone else holds their keys, so they are not ours, and what they paid is never counted as external demand.',
  }
}
