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
import { getChainById, usdcUnits, evmPublicClient, type ChainDescriptor } from './chains/index.js'
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

const AGENT_ID_DOC = 'ERC-8004 token id ("#1"), CAIP id ("eip155:42220:8004/1"), or 0x owner address'

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
  const payTo = /^0x[0-9a-fA-F]{40}$/.test(payToRaw) ? payToRaw.toLowerCase() : null
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

export type CeloPaymentRequirements = {
  scheme: 'exact'
  network: string
  asset: string
  payTo: string
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: 'application/json'
  maxTimeoutSeconds: number
  /** EIP-712 domain params of the asset, for the buyer's EIP-3009 signature. */
  extra: { name: string; version: string }
}

/** The x402 v2 paymentRequirements for one tool - the exact object we also hand the
 *  facilitator's /verify, so challenge and verification can never disagree. */
export function celoToolRequirements(tool: CeloToolName, status: CeloX402Status): CeloPaymentRequirements {
  const chain = status.chain ? getChainById(status.chain) : undefined
  if (!status.configured || !chain || !status.payTo) {
    throw new Error('celoToolRequirements requires a configured status (gate first)')
  }
  const usdc = chain.contracts.usdc
  if (!usdc) throw new Error(`chain ${chain.id} has no USDC contract in the registry`)
  return {
    scheme: 'exact',
    network: chain.caip2,
    asset: usdc,
    payTo: status.payTo,
    maxAmountRequired: usdcUnits(chain, CELO_TOOL_PRICES_USD[tool]).toString(),
    resource: `/api/celo/tools/${tool}`,
    description: `${CELO_TOOL_CARDS[tool].description} Settled in USDC on ${chain.name} via the Celo x402 facilitator.`,
    mimeType: 'application/json',
    maxTimeoutSeconds: 600,
    extra: { ...USDC_EIP712_DOMAIN },
  }
}

/** The full 402 body: x402 v2 challenge + the tool's calling contract, so a probing
 *  GET shows a buyer everything needed to pay and call correctly. */
export function celoChallenge(tool: CeloToolName, status: CeloX402Status, verifyError?: string) {
  return {
    x402Version: 2,
    error: 'payment required',
    accepts: [celoToolRequirements(tool, status)],
    tool: {
      name: tool,
      priceUsd: CELO_TOOL_PRICES_USD[tool],
      ...CELO_TOOL_CARDS[tool],
      method: `POST /api/celo/tools/${tool}`,
      payment:
        'Sign an EIP-3009 TransferWithAuthorization for the asset above (domain from `extra`), then POST with header X-PAYMENT: base64(JSON of {x402Version:2, scheme:"exact", network, payload:{signature, authorization}}).',
    },
    ...(verifyError ? { verifyError } : {}),
  }
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
 * Best-effort LIVE read of Celo's IdentityRegistry for an agent id, so a paid answer
 * about a Celo agent carries a CELO-side on-chain fact instead of only the oracle's
 * home-registry view. This exists because the trust body (identity/kya/reputation) is
 * resolved on the home registry, which is a different chain: without this field a Celo
 * buyer asking about a Celo agent id would get an answer that never touched Celo.
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

  // Same id grammar as the reputation read: a registry lookup needs a NUMERIC id.
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
  fetchImpl?: typeof fetch
  persist?: (rec: CeloSettlementRecord) => Promise<void>
  handlers?: Partial<Record<CeloToolName, (input: CeloToolInput) => Promise<unknown>>>
  env?: NodeJS.ProcessEnv
  now?: () => Date
}

/** Replace the ASP tool meta's OKX network line with this rail's, so a Celo buyer's
 *  receipt never claims it settled on X Layer. Everything else (methodology, the
 *  deterministic-score note) is the same product and stays.
 *
 *  HONEST SCOPE, and the reason this does more than overwrite one string: `network` is
 *  where the PAYMENT settled, which is Celo. The identity / KYA / reputation body below
 *  it is resolved on the oracle's HOME registry, which is a different chain - so the
 *  same agent id means a different agent there. Overwriting `network` alone read as if
 *  the whole verdict were a Celo fact. It now says both networks by name, and the
 *  Celo-side facts travel in the dedicated `celoIdentity` / `celoReputation` fields. */
function withCeloMeta<T extends { _meta?: Record<string, unknown> }>(result: T, status: CeloX402Status): T {
  const home = typeof result._meta?.network === 'string' ? result._meta.network : 'the oracle home registry'
  return {
    ...result,
    _meta: {
      ...(result._meta ?? {}),
      network: `Celo (${status.network})`,
      settlement: 'x402 v2 exact via the first-party Celo facilitator (EIP-3009 USDC)',
      proof: '/api/celo/proof',
      homeRegistryNetwork: home,
      scope: `payment settled on Celo (${status.network}); the identity, KYA and reputation body is resolved on ${home}; the celoIdentity and celoReputation fields are read live from Celo's own ERC-8004 registries for this agent id`,
    },
  }
}

function defaultHandlers(status: CeloX402Status): Record<CeloToolName, (input: CeloToolInput) => Promise<unknown>> {
  /** Every paid Celo answer carries a Celo-side identity read for the id it was asked
   *  about - otherwise a Celo buyer could pay a Celo rail and get back nothing that ever
   *  touched Celo. Runs concurrently with the base tool so it costs no extra latency. */
  const served = async <T extends { _meta?: Record<string, unknown> }>(base: Promise<T>, agentId: string) => {
    const [result, celoIdentity] = await Promise.all([base, celoIdentitySummary(agentId, status)])
    return { ...withCeloMeta(result, status), celoIdentity }
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
 * The full paid-call path for one tool. Returns { httpStatus, body } so the route stays
 * a thin adapter. Outcomes, in order:
 *   402 - malformed X-PAYMENT, or the facilitator says the payment is invalid
 *         (fresh challenge + verifyError; the client fixes its payment and retries)
 *   502 - the facilitator failed or answered ambiguously (verify OR settle). The tool
 *         is NOT served and the payment is NOT resubmitted: a repeated settle could
 *         double-spend the buyer's authorization, so the client retries with a fresh one.
 *   500 - settle succeeded but the tool handler itself failed. The settlement is still
 *         recorded (it happened) and the body says exactly that.
 *   200 - settled and served; the settlement is durably recorded for /api/celo/proof.
 */
export async function celoServeTool(
  tool: CeloToolName,
  input: CeloToolInput,
  paymentHeader: string,
  status: CeloX402Status,
  deps: CeloServeDeps = {},
): Promise<{ httpStatus: number; body: unknown }> {
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

  // 1. Decode the X-PAYMENT header (base64 JSON, x402 v2 exact payload).
  let paymentPayload: Record<string, unknown>
  try {
    const decoded = Buffer.from(paymentHeader, 'base64').toString('utf8')
    paymentPayload = JSON.parse(decoded) as Record<string, unknown>
    if (typeof paymentPayload !== 'object' || paymentPayload === null) throw new Error('not an object')
  } catch {
    return {
      httpStatus: 402,
      body: celoChallenge(tool, status, 'malformed X-PAYMENT header: expected base64-encoded x402 v2 JSON payload'),
    }
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
  const v1Payload = { ...paymentPayload, x402Version: 1, network: chain.id }
  const v1Requirements = { ...requirements, network: chain.id }
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
  if (verify.status !== 200 || !verify.json) {
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
    return { httpStatus: 402, body: celoChallenge(tool, status, reason) }
  }

  // 3. /settle - the facilitator broadcasts the EIP-3009 transfer. X-API-Key is OUR
  // seller credential; `network` uses the facilitator's v1 label, which its /supported
  // lists as exactly our registry slug ('celo' / 'celo-sepolia').
  let settle: { status: number; json: Record<string, unknown> | null }
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
    return {
      httpStatus: 502,
      body: {
        error: 'celo facilitator settle failed',
        reason: e instanceof Error ? e.message : 'network error',
        note: 'settlement is AMBIGUOUS and the money may have moved: the facilitator broadcasts before it answers, so a timeout here can still land the transfer on-chain. The tool was NOT served and this payment was NOT resubmitted (that could double-settle). Check the payTo address on the explorer before retrying, and retry only with a FRESH payment.',
      },
    }
  }
  if (
    settle.status !== 200 ||
    !settle.json ||
    (settle.json.success !== true && settle.json.settled !== true)
  ) {
    return {
      httpStatus: 502,
      body: {
        error: 'celo facilitator settle failed',
        reason:
          (typeof settle.json?.errorMessage === 'string' && settle.json.errorMessage) ||
          (typeof settle.json?.error === 'string' && settle.json.error) ||
          `facilitator answered ${settle.status} with success=${String(settle.json?.success)}`,
        note: 'the tool was not served. This payment was not resubmitted; retry with a fresh payment.',
      },
    }
  }
  const credits = typeof settle.json.credits === 'number' ? settle.json.credits : undefined
  const settleTx = typeof settle.json.transaction === 'string' && settle.json.transaction.startsWith('0x')
    ? settle.json.transaction
    : undefined

  // 4. Record the settlement durably, then serve. The record happens even if the
  // handler fails: the money moved, and the proof log must say so.
  const record: CeloSettlementRecord = {
    ts: now().toISOString(),
    tool,
    amountUsd: CELO_TOOL_PRICES_USD[tool],
    ...(payer ? { payer } : {}),
    ...(settleTx ? { tx: settleTx } : {}),
    network: status.network,
    ...(credits !== undefined ? { facilitatorCredits: credits } : {}),
  }
  await persist(record)

  const settlement = {
    settled: true,
    network: status.network,
    facilitator: status.facilitator,
    ...(settleTx ? { tx: settleTx } : {}),
    ...(payer ? { payer } : {}),
    ...(credits !== undefined ? { facilitatorCredits: credits } : {}),
    settledAt: record.ts,
  }

  const handler = deps.handlers?.[tool] ?? defaultHandlers(status)[tool]
  try {
    const result = await handler(input)
    return {
      httpStatus: 200,
      body: {
        paid: true,
        tool,
        priceUsd: CELO_TOOL_PRICES_USD[tool],
        settlement,
        result,
      },
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
    }
  }
}

// ── public status + proof documents ───────────────────────────────────────────────

/**
 * OUR OWN buyer wallets, published on purpose. /api/celo/proof marks their settlements
 * internal so nobody can read our own demo traffic as third-party demand - the honest
 * half of running a proof page at all. This is a public address, not a credential, and
 * hardcoding it is the point: it cannot be quietly unset the way an env var can.
 * CELO_INTERNAL_PAYERS (comma-separated) adds more without a deploy.
 */
const CELO_INTERNAL_PAYERS = ['0x8c8d9cd12d8896a40cf2115ee731258bb4983349']

function internalPayers(env: NodeJS.ProcessEnv): Set<string> {
  const extra = (env.CELO_INTERNAL_PAYERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s))
  return new Set([...CELO_INTERNAL_PAYERS, ...extra])
}

/** GET /api/celo/status body: rail config (fail-closed truth), registry facts for both
 *  Celo descriptors, and ERC-8004 resolver readiness. No external calls - this must be
 *  fast and honest even when RPCs are down. */
export function celoStatusReport(env: NodeJS.ProcessEnv = process.env) {
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
      // No ValidationRegistry exists on Celo (ERC-8004 spec revision pending), so KYA
      // anchoring is impossible there and this surface says so instead of faking it.
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
    chains: { celo: describe('celo'), 'celo-sepolia': describe('celo-sepolia') },
    kyaAnchoring: 'not possible on Celo: no ValidationRegistry is deployed there (spec revision pending)',
  }
}

/** GET /api/celo/proof body: the durable settlement log, aggregated. Honest zeros when
 *  nothing has settled; totals cover the retained window (last CELO_SETTLEMENTS_CAP). */
export async function celoProof(
  env: NodeJS.ProcessEnv = process.env,
  load: () => Promise<CeloSettlementRecord[]> = loadCeloSettlements,
) {
  const status = celoX402Status(env)
  const all = await load()
  const ours = internalPayers(env)
  const isInternal = (r: CeloSettlementRecord) => !!r.payer && ours.has(r.payer.toLowerCase())

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
    byTool,
    recent: all.slice(-50).reverse().map((r) => ({ ...r, internal: isInternal(r) })),
    note: `Real settlements only, recorded at settle time and durable across restarts; totals cover the retained window (last ${CELO_SETTLEMENTS_CAP}). Zeros mean nothing has settled yet, not a mock.`,
    internalNote:
      'Settlements from our own buyer wallets are marked internal: they are real on-chain payments used to exercise and demonstrate the rail, not third-party demand. They are labeled rather than hidden.',
  }
}
