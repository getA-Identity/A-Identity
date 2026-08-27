/**
 * The seller side of the Stellar x402 rail.
 *
 * Sibling of x402-3009/, not a fork of it. What is shared is imported; what is different
 * is different because the platform is, and each difference is named rather than left as
 * an apparent omission.
 *
 * ## Three things this rail does NOT have, and why
 *
 * **No domain proving.** x402-3009/domain.ts exists because an EIP-3009 token carries its
 * own EIP-712 domain, some tokens will not tell you their `version()`, and signing against
 * a guessed domain produces an authorization nobody can settle. None of that exists here.
 * The buyer signs a Soroban authorization ENTRY, whose preimage is fixed by the protocol
 * rather than by the token, so there is nothing per-token to prove and no 503 branch for
 * an unprovable domain. Its absence is a property of the chain, not an unfinished job.
 *
 * **No settlement fee, and this is a CHOICE rather than a free lunch.** The EIP-3009 rails
 * charge a disclosed fee because broadcasting costs real gas: 0.0000046 ETH on Robinhood
 * Chain, 0.00000207 on Arbitrum One. A Stellar settlement measured 22,973 stroops, or
 * 0.0022973 XLM (tx 37d52f31..., testnet).
 *
 * An earlier version of this comment called that "several orders of magnitude under the
 * cheapest thing we sell" and an adversarial review took it apart, correctly. Do the
 * arithmetic instead of the adjective: the cheapest tool is verify_agent at $0.001, so the
 * BREAK-EVEN is XLM at $0.4353. At $0.30 a settlement already costs 69 percent of that
 * sale. XLM has traded above the break-even before, so this is a price move rather than a
 * hypothetical. "Several orders of magnitude" would need XLM near $0.0004.
 *
 * And a second correction on top of the first. The original said "we have no price feed we
 * verify and will not invent one", two lines before asserting a USD ratio, which is the
 * same claim in disguise. Worse, the premise was wrong: there IS a price feed we can
 * verify, and it is on the very ledger this rail settles on. The Stellar DEX order book for
 * XLM against Circle's USDC, read from pubnet Horizon on 2026-08-15, had a best bid of
 * 0.1587048 USDC per XLM. That makes one settlement $0.000365, which is 36 percent of a
 * $0.001 sale. Same order of magnitude, not several.
 *
 * We still charge nothing, for a reason that survives being stated plainly: the absolute
 * amount is a third of a cent, we are absorbing it deliberately, and a per-call line item
 * on a sub-cent sale costs more in explanation than it recovers. What we may not do is tell
 * a buyer it is negligible, and what we may not do now that we know the feed exists is
 * claim we cannot price it. If XLM approaches $0.4353 this decision gets revisited rather
 * than discovered.
 *
 * **A minimum value floor, and a smaller one than the EVM rails carry.** This paragraph
 * used to say there was none, on the reasoning that a floor exists to cover gas and there is
 * no fee to cover here. Both halves were wrong. There IS a fee, we simply absorb it, as the
 * paragraph above now says; and a floor is configured, enforced, and published. It defaults
 * to 0.0001 USD, refuses with `below_minimum`, and appears in the facilitator's /supported
 * body as minAmountRequired. What is true is that it sits far below the cheapest thing we
 * sell rather than at the settlement cost, which is a decision about dust and not about gas.
 *
 * ## What is shared
 *
 * The four base prices are IMPORTED from x402-3009/rail.js rather than restated. Three
 * rails already sell these tools and the prices are pinned across them by test; a fourth
 * copy would be a fourth thing that must agree.
 */
import { getChain, getChainById, tokenUnits, type ChainDescriptor, type SettlementToken } from '../chains/index.js'
import type { StellarLimits, StellarRequirements, StellarSettleDeps } from './settle.js'
import { redeemStellarPayment, schemeOf, settleStellarPayment } from './settle.js'
import { loadStellarSettlements, type StellarSettlementRecord } from '../storage.js'
import { agentPassport, reputationScore, riskCheck, verifyAgent, type TxContext } from '../asp/tools.js'
import { feePayerEnvVar, stellarFeePayer, networkPassphrase } from '../chains/stellar/client.js'
import { isAccountId, isContractId } from '../chains/stellar/strkey.js'
import { RAIL_BASE_PRICES_USD, RAIL_TOOLS, RAIL_TOOL_CARDS, type RailToolName } from '../x402-3009/rail.js'

export { RAIL_BASE_PRICES_USD, RAIL_TOOL_CARDS, RAIL_TOOLS }
export type { RailToolName }

/**
 * Which party assembles the transaction, pays the network fee, and submits it.
 *
 * `buyer` is not a configurable choice like the other two: it is what a settlement records
 * when the payment arrived already made, from a vault or a wallet that broadcast it itself.
 * It lives in the same union so the proof page cannot report a fee we did not pay.
 */
export type Broadcaster = 'self' | 'oz' | 'buyer'

/** The two a rail can be CONFIGURED to use. `buyer` is observed, never chosen. */
export type ConfigurableBroadcaster = 'self' | 'oz'

export type StellarRailStatus = {
  configured: boolean
  /** CAIP-2 of the settlement network. */
  network: string
  /** Registry slug, null when unresolvable. */
  chain: string | null
  token: SettlementToken | null
  /** The G... account that receives payment. */
  payTo: string | null
  broadcaster: Broadcaster
  /** True when the chosen broadcaster actually has what it needs to broadcast. */
  broadcasterReady: boolean
  /** When true, /settle accepts any payTo. Off by default: settling costs us the fee. */
  publicSettle: boolean
  /** G... accounts we will settle for besides our own. Lowercasing would corrupt a
   *  StrKey, so unlike the EVM allowlist these are compared exactly as written. */
  allowedPayTo: string[]
  reason?: string
}

/**
 * Every network this rail is configured to sell on, in configured order. The first is the
 * default when a request names none. Mirrors X402_3009_NETWORKS deliberately: an operator
 * who has configured one rail should be able to guess the other.
 */
export function stellarRailNetworks(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.X402_STELLAR_NETWORKS?.trim() || env.X402_STELLAR_NETWORK?.trim() || ''
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

/** The SEP-41 token this rail settles in on a chain. */
export function stellarRailToken(
  chain: ChainDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): SettlementToken | null {
  const wanted = env.X402_STELLAR_ASSET_SYMBOL?.trim()
  const usable = (chain.settlementTokens ?? []).filter((t) => t.authorization === 'soroban-auth')
  if (!usable.length) return null
  if (wanted) return usable.find((t) => t.symbol.toLowerCase() === wanted.toLowerCase()) ?? null
  return usable[0]
}

/** Which broadcaster is configured, and whether it can actually broadcast. */
export function stellarBroadcaster(
  chain: ChainDescriptor | null,
  env: NodeJS.ProcessEnv = process.env,
): { broadcaster: Broadcaster; ready: boolean; reason?: string } {
  const asked = env.X402_STELLAR_FACILITATOR?.trim().toLowerCase()
  // Resolved through the SAME function the signing path uses, not by testing a string for
  // emptiness. The previous version reported ready:true for any non-empty value, so an
  // EVM hex key in the Stellar variable made the rail sell and then fail to settle every
  // sale: readiness and signing were answering different questions.
  const feePayer = chain ? stellarFeePayer(chain, env) : null
  const feePayerVar = chain ? feePayerEnvVar(chain) : 'the fee payer'
  const ozKey = chain ? ozApiKey(chain, env) : null

  if (asked === 'oz') {
    return ozKey
      ? { broadcaster: 'oz', ready: true }
      : { broadcaster: 'oz', ready: false, reason: `X402_STELLAR_FACILITATOR=oz but ${ozKeyVar(chain)} is unset` }
  }
  if (asked === 'self') {
    return feePayer
      ? { broadcaster: 'self', ready: true }
      : {
          broadcaster: 'self',
          ready: false,
          reason: `X402_STELLAR_FACILITATOR=self but no usable fee payer is configured. Set ${feePayerVar} or ${chain?.signerEnvVar ?? 'the chain signer'} to a Stellar S... secret seed; a value that is present but malformed counts as absent.`,
        }
  }

  // Unset: prefer running the rail ourselves, because that is the product claim on every
  // other chain. Fall back to OZ only when we genuinely cannot broadcast.
  if (feePayer) return { broadcaster: 'self', ready: true }
  if (ozKey) return { broadcaster: 'oz', ready: true }
  return {
    broadcaster: 'self',
    ready: false,
    reason: 'no fee payer and no OpenZeppelin Channels key, so nothing can broadcast',
  }
}

/** Which variable holds the OZ key for this network. Two, never one plus a switch. */
export function ozKeyVar(chain: ChainDescriptor | null): string {
  return chain?.caip2 === 'stellar:pubnet' ? 'X402_STELLAR_PUBNET_OZ_KEY' : 'X402_STELLAR_TESTNET_OZ_KEY'
}

export function ozApiKey(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): string | null {
  return env[ozKeyVar(chain)]?.trim() || null
}

/** The OZ Channels endpoint for this network, when that path is in use. */
export function ozFacilitatorUrl(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.X402_STELLAR_OZ_URL?.trim()
  if (override) return override
  return chain.caip2 === 'stellar:pubnet'
    ? 'https://channels.openzeppelin.com/x402'
    : 'https://channels.openzeppelin.com/x402/testnet'
}

/**
 * Resolve the rail for one network.
 *
 * A network we do not sell on resolves to unconfigured rather than falling back silently:
 * settling on a chain the seller did not choose would be worse than refusing.
 */
export function stellarRailStatus(
  env: NodeJS.ProcessEnv = process.env,
  network?: string,
): StellarRailStatus {
  const configuredIds = stellarRailNetworks(env)
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

  const payToRaw = env.X402_STELLAR_PAYTO?.trim() ?? ''
  const payTo = isAccountId(payToRaw) ? payToRaw : null
  const b = stellarBroadcaster(chain, env)
  const base = {
    network: requested,
    chain: chain?.id ?? null,
    token: null,
    payTo,
    broadcaster: b.broadcaster,
    broadcasterReady: b.ready,
    publicSettle: env.X402_STELLAR_PUBLIC_SETTLE === 'true',
    // Split and trimmed, never lowercased. A StrKey is case-significant base32 and
    // .toLowerCase() would turn every allowlisted account into a string that matches
    // nothing, which is the kind of guard that looks present and does nothing.
    allowedPayTo: (env.X402_STELLAR_ALLOWED_PAYTO ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter((a) => isAccountId(a)),
  }

  if (!requested) {
    return {
      ...base,
      configured: false,
      reason:
        'Stellar x402 rail not configured: set X402_STELLAR_NETWORKS to one or more CAIP-2 ids of Stellar chains that declare a soroban-auth settlement token',
    }
  }
  if (!configuredHere) {
    return {
      ...base,
      configured: false,
      reason: `this rail does not sell on '${requested}'. Configured networks: ${configuredIds.join(', ') || 'none'}`,
    }
  }
  if (!chain) return { ...base, configured: false, reason: `'${requested}' is not a chain in the registry` }
  if (chain.ecosystem !== 'stellar') {
    return {
      ...base,
      chain: chain.id,
      network: chain.caip2,
      configured: false,
      reason: `${chain.id} is an ${chain.ecosystem} chain. The EIP-3009 rail serves those; this one is Soroban only.`,
    }
  }

  const token = stellarRailToken(chain, env)
  if (!token) {
    return {
      ...base,
      chain: chain.id,
      network: chain.caip2,
      configured: false,
      reason: `${chain.id} declares no soroban-auth settlement token, so it cannot host this rail`,
    }
  }
  if (!isContractId(token.address)) {
    return {
      ...base,
      chain: chain.id,
      network: chain.caip2,
      token,
      configured: false,
      reason: `${chain.id}'s settlement token address is not a Soroban contract id, so nothing may be signed against it`,
    }
  }
  if (!payTo) {
    return {
      ...base,
      chain: chain.id,
      network: chain.caip2,
      token,
      configured: false,
      reason: 'Stellar x402 rail not configured: set X402_STELLAR_PAYTO to a G... account that already holds a trustline for the settlement asset',
    }
  }
  if (!b.ready) {
    return { ...base, chain: chain.id, network: chain.caip2, token, configured: false, reason: b.reason }
  }
  return { ...base, configured: true, chain: chain.id, network: chain.caip2, token, payTo }
}

/** Unconfigured means 501, never a free serve. Same rule as every other rail here. */
export function stellarRailPaywallGate(
  status: StellarRailStatus,
): { ok: true } | { ok: false; httpStatus: 501; body: { error: string; reason?: string } } {
  if (status.configured) return { ok: true }
  return {
    ok: false,
    httpStatus: 501,
    body: { error: 'Stellar x402 rail not configured', ...(status.reason ? { reason: status.reason } : {}) },
  }
}

/**
 * The economic guards, in the units Stellar actually uses.
 *
 * Stroops, not wei, and LEDGERS, not seconds. A Soroban fee is quoted by the simulation
 * itself, so unlike the EVM rail there is no gas price to multiply and no estimate to be
 * wrong about: the ceiling compares a real number against a real number.
 *
 * The defaults are sized against a measurement rather than a guess. One settlement on
 * stellar:testnet cost 22,973 stroops, so a 1,000,000 stroop ceiling (0.1 XLM) is about
 * 43 times a normal settlement, high enough that ordinary variation never trips it and low
 * enough that a runaway costs a tenth of an XLM. The daily budget is 100 of those.
 */
export function stellarRailLimits(
  status: StellarRailStatus,
  env: NodeJS.ProcessEnv = process.env,
): StellarLimits {
  const decimals = status.token?.decimals ?? 7
  return {
    minValue: tokenUnits(decimals, num(env, 'X402_STELLAR_MIN_VALUE_USD', STELLAR_DEFAULTS.minValueUsd)),
    maxValue: tokenUnits(decimals, num(env, 'X402_STELLAR_MAX_VALUE_USD', STELLAR_DEFAULTS.maxValueUsd)),
    expiryHeadroomLedgers: Math.round(
      num(env, 'X402_STELLAR_EXPIRY_HEADROOM_LEDGERS', STELLAR_DEFAULTS.expiryHeadroomLedgers),
    ),
    maxFeeStroops: big(env, 'X402_STELLAR_MAX_FEE_STROOPS', STELLAR_DEFAULTS.maxFeeStroops),
    dailyFeeStroops: big(env, 'X402_STELLAR_DAILY_FEE_STROOPS', STELLAR_DEFAULTS.dailyFeeStroops),
  }
}

const STELLAR_DEFAULTS = {
  /** Base units, so a payment cannot be smaller than the fee it costs us to settle. */
  minValueUsd: 0.0001,
  maxValueUsd: 1,
  /** About a minute of ledgers. In ledgers because the field is a ledger number. */
  expiryHeadroomLedgers: 12,
  maxFeeStroops: 1_000_000n,
  dailyFeeStroops: 100_000_000n,
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
    return v >= 0n ? v : fallback
  } catch {
    return fallback
  }
}

/** The price of a tool on this rail: the base price, and nothing added to it. */
export function stellarRailPriceUsd(tool: RailToolName): { baseUsd: number; totalUsd: number } {
  const baseUsd = RAIL_BASE_PRICES_USD[tool]
  return { baseUsd, totalUsd: baseUsd }
}

export function stellarRailResource(tool: RailToolName): string {
  return `/api/x402/stellar/tools/${tool}`
}

/** Base units of the settlement token for a USD price. Stellar SACs are 7 decimals. */
export function stellarAmountRaw(tool: RailToolName, token: SettlementToken): bigint {
  return tokenUnits(token.decimals, stellarRailPriceUsd(tool).totalUsd)
}

/**
 * The 402 challenge for one tool.
 *
 * `accepts` is an array in the x402 spec so a seller can offer several ways to pay and the
 * buyer picks by paying one. Every configured Stellar network appears, each with its own
 * asset and payTo. There is no per-network price difference here, because there is no
 * per-network fee.
 */
export function stellarRailChallenge(
  tool: RailToolName,
  status: StellarRailStatus,
  env: NodeJS.ProcessEnv = process.env,
): { httpStatus: 402; body: Record<string, unknown> } | { httpStatus: 501; body: { error: string; reason?: string } } {
  const gate = stellarRailPaywallGate(status)
  if (!gate.ok) return { httpStatus: gate.httpStatus, body: gate.body }

  const accepts: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const id of [status.network, ...stellarRailNetworks(env)]) {
    const s = id === status.network ? status : stellarRailStatus(env, id)
    if (!s.configured || !s.token || !s.payTo || !s.chain || seen.has(s.network)) continue
    seen.add(s.network)
    const chain = getChainById(s.chain)
    accepts.push({
      scheme: 'exact',
      network: s.network,
      asset: s.token.address,
      assetSymbol: s.token.symbol,
      decimals: s.token.decimals,
      payTo: s.payTo,
      maxAmountRequired: stellarAmountRaw(tool, s.token).toString(),
      amount: stellarAmountRaw(tool, s.token).toString(),
      resource: stellarRailResource(tool),
      description: `${RAIL_TOOL_CARDS[tool].description} Settled in ${s.token.symbol} on ${chain?.name ?? s.chain}; you sign an authorization entry, we broadcast.`,
      mimeType: 'application/json',
      maxTimeoutSeconds: 600,
      extra: {
        // What the buyer actually signs. Not an EIP-712 domain: a Soroban authorization
        // entry for one specific call, whose preimage the protocol fixes.
        authorization: 'soroban-auth',
        contract: s.token.address,
        function: 'transfer',
        args: ['from (your G... account)', `to (${s.payTo})`, 'amount (i128 base units)'],
        // Derived, not inlined. This was a `pubnet ? A : B` ternary, which means an
        // unrecognised network silently got the TESTNET passphrase handed to a buyer, and
        // the passphrase is inside the signed preimage: a signature made against the wrong
        // one is a payment nobody can spend. `networkPassphrase` throws instead, which is
        // the behaviour `chains/stellar/client.ts` was written to guarantee and which the
        // facilitator already used. Latent today because only two Stellar descriptors
        // exist; latent is not the same as absent.
        networkPassphrase: networkPassphrase(chain!),
        broadcaster: s.broadcaster,
      },
    })
  }

  return {
    httpStatus: 402,
    body: {
      x402Version: 2,
      error: 'payment required',
      // v2 hoists the resource out of each accepts entry into one object on the challenge.
      // The per-entry string stays for v1 clients; it is the same field in both places.
      resource: { url: stellarRailResource(tool), description: RAIL_TOOL_CARDS[tool].description, mimeType: 'application/json' },
      accepts,
      tool: {
        name: tool,
        price: { baseUsd: stellarRailPriceUsd(tool).baseUsd, totalUsd: stellarRailPriceUsd(tool).totalUsd },
        priceNote:
          'The buyer pays no network fee on this rail: you sign a Soroban authorization entry ' +
          'and we assemble, pay the fee and submit. Unlike our EVM rails we add no settlement ' +
          'fee on top of the base price. That is us absorbing a real cost rather than there ' +
          'being none: a settlement measured 22,973 stroops (0.0022973 XLM) on stellar:testnet, ' +
          'about $0.000365 at the XLM/USDC price on Stellar\'s own order book. The base price is ' +
          'identical on every rail we sell on.',
        ...RAIL_TOOL_CARDS[tool],
        method: `POST ${stellarRailResource(tool)}`,
        payment:
          'Sign a Soroban authorization entry for the `transfer` call described in `extra`, then POST with header X-PAYMENT: base64(JSON of {x402Version:2, scheme:"exact", network, payload:{authEntryXdr}}).',
        // The second shape exists for agents whose spending is bounded on chain. Our own
        // Soroban spend policy cannot sign an authorization entry (it has no __check_auth,
        // deliberately), so without this there would be no way to pay for a tool through a
        // vault at all. Published in the challenge rather than left as private knowledge.
        alsoAccepted: {
          scheme: 'settled',
          when: 'You already paid by calling pay() on an on-chain spend policy that gated the payment before it existed.',
          payload: '{txHash, from} where from is the CONTRACT the transfer came from',
          contractPayersOnly:
            'from must be a Soroban contract id. An account can sign an authorization entry and should: that path costs you no network fee and binds to this exact purchase. This one exists only for agents whose spending a contract already bounds, because such a contract cannot sign.',
          youPayTheFee: true,
          binding:
            'The transaction hash, not an authorization nonce. We can prove the payment happened and that nobody has redeemed it here before. We cannot prove it was made for this particular purchase rather than another of the same price, and we cannot prove you are the party that made it: a landed transaction is public, so present your hash promptly. That is why this is the second shape and not the default.',
        },
      },
    },
  }
}

// ── serving a paid tool ───────────────────────────────────────────────────────────

export type StellarRailToolInput = { agentId: string; txContext?: TxContext | null }

export type StellarRailServeDeps = StellarSettleDeps & {
  handlers?: Record<RailToolName, (input: StellarRailToolInput) => Promise<unknown>>
}

/**
 * The four trust tools, answered identically to every other rail.
 *
 * Identical is the point: what a buyer gets for $0.25 must not depend on which chain they
 * paid on. Only `_meta.settlement` differs, and it differs by telling the truth about how
 * the payment was made.
 */
function stellarHandlers(
  status: StellarRailStatus,
  /**
   * Who ACTUALLY broadcast the settlement that just paid for this call.
   *
   * Passed in rather than read off the status, which is the fix: the first version derived
   * this sentence from the CONFIGURED broadcaster, so a payment made through the on-chain
   * vault (where the agent broadcast it and paid the fee itself) was answered with "we
   * assemble and pay the network fee; the buyer pays none". That is a false statement about
   * a transaction the buyer can look up, in the response to that very transaction.
   */
  broadcaster: Broadcaster,
): Record<RailToolName, (input: StellarRailToolInput) => Promise<unknown>> {
  const FACILITATOR: Record<Broadcaster, string> = {
    self: 'first-party (we assembled it and paid the network fee; you paid none)',
    oz: 'OpenZeppelin Channels broadcast it; we confirmed the transfer ourselves',
    buyer: 'you broadcast it and paid its network fee; we confirmed the transfer ourselves',
  }
  const meta = <T extends Record<string, unknown>>(result: T) => ({
    ...result,
    _meta: {
      ...((result._meta as Record<string, unknown>) ?? {}),
      settlement: {
        network: status.network,
        asset: status.token?.address,
        assetSymbol: status.token?.symbol,
        facilitator: FACILITATOR[broadcaster],
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
 *
 *   501  the rail is not configured. Never a free serve.
 *   402  malformed X-PAYMENT, or an authorization the buyer can fix. A fresh challenge.
 *   502  settlement failed on our side or the chain's. Nothing served.
 *   202  broadcast but unconfirmed. Nothing served, nothing marked spent, and explicitly
 *        not a failure: the transaction may still land.
 *   200  the money moved, we read it, and here is the answer.
 *
 * The 202 is the branch the EVM rail does not have, because there it collapses into 502
 * with an `ambiguous` flag. Here it gets its own status, since the distinction between
 * "your payment failed" and "we cannot see your payment yet" is the whole posture.
 */
export async function stellarRailServeTool(
  tool: RailToolName,
  input: StellarRailToolInput,
  paymentHeader: string,
  status: StellarRailStatus,
  deps: StellarRailServeDeps = {},
): Promise<{ httpStatus: number; body: unknown }> {
  const env = deps.env ?? process.env
  const gate = stellarRailPaywallGate(status)
  if (!gate.ok) return { httpStatus: gate.httpStatus, body: gate.body }

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
  } catch {
    const challenge = stellarRailChallenge(tool, status, env)
    return { httpStatus: challenge.httpStatus, body: { ...challenge.body, reason: 'X-PAYMENT is not base64-encoded JSON' } }
  }

  // The challenge is the menu and the payload names the dish. A buyer who paid on one of
  // the offered networks gets settled on THAT one, and a network we do not sell on is
  // refused rather than quietly redirected to the default.
  const paidNetwork = (payload as { network?: unknown })?.network
  let chosen = status
  if (typeof paidNetwork === 'string' && paidNetwork.trim()) {
    const s = stellarRailStatus(env, paidNetwork)
    if (!s.configured) {
      const challenge = stellarRailChallenge(tool, status, env)
      return {
        httpStatus: challenge.httpStatus,
        body: { ...challenge.body, reason: s.reason ?? `this rail does not settle on '${paidNetwork}'` },
      }
    }
    chosen = s
  }
  return stellarRailServeToolOn(tool, input, payload, chosen, deps)
}

/**
 * Settle and serve on one already-resolved network.
 *
 * Split out for the same reason the EIP-3009 rail splits it: a buyer who paid on a network
 * other than the default must go through the SAME code, not a parallel path. Two paths is
 * how two networks stop agreeing about the rules.
 */
export async function stellarRailServeToolOn(
  tool: RailToolName,
  input: StellarRailToolInput,
  payload: unknown,
  status: StellarRailStatus,
  deps: StellarRailServeDeps = {},
): Promise<{ httpStatus: number; body: unknown }> {
  const env = deps.env ?? process.env
  const chain = status.chain ? getChainById(status.chain) : undefined
  if (!chain || !status.token || !status.payTo) {
    return { httpStatus: 501, body: { error: 'Stellar x402 rail not configured', reason: 'network descriptor missing from the registry' } }
  }

  const price = stellarRailPriceUsd(tool)
  const requirements: StellarRequirements = {
    network: chain.caip2,
    asset: status.token.address,
    payTo: status.payTo,
    maxAmountRequired: stellarAmountRaw(tool, status.token).toString(),
    resource: stellarRailResource(tool),
  }

  // Settlement touches an RPC, a signer and durable storage, so it has more ways to fail
  // than branches. Anything unexpected becomes a named 502 rather than an exception
  // escaping into the request handler as an unhandled rejection.
  const inner = ((payload as { payload?: unknown })?.payload ?? payload) as Record<string, unknown>
  const scheme = schemeOf(inner)
  if (!scheme.ok) {
    const challenge = stellarRailChallenge(tool, status, env)
    return { httpStatus: challenge.httpStatus, body: { ...challenge.body, reason: scheme.reason } }
  }

  let settled: Awaited<ReturnType<typeof settleStellarPayment>>
  try {
    settled =
      scheme.scheme === 'settled'
        ? await redeemStellarPayment({
            chain,
            token: status.token,
            requirements,
            txHash: String(inner.txHash ?? '').trim().toLowerCase(),
            // Who the transfer must come from. Declared by the buyer because on this scheme
            // it is a vault or wallet WE do not own, and then checked against the ledger:
            // a `from` that did not actually send this transfer fails confirmation.
            from: String(inner.from ?? '').trim(),
            deps: { ...deps, meta: { tool, baseUsd: price.baseUsd } },
          })
        : await settleStellarPayment({
            chain,
            token: status.token,
            requirements,
            payload: inner,
            limits: stellarRailLimits(status, env),
            deps: { ...deps, meta: { tool, baseUsd: price.baseUsd } },
          })
  } catch (e) {
    return {
      httpStatus: 502,
      body: {
        error: 'settlement failed',
        code: 'unexpected',
        reason: e instanceof Error ? e.message : String(e),
        note: 'Nothing was served. If a transaction was broadcast before this failure it will appear in GET /api/x402/stellar/proof.',
      },
    }
  }

  if (!settled.success) {
    // A payment the buyer can fix gets a fresh challenge. Anything else is us or the
    // chain, and must not be retried blindly.
    const retryable: string[] = [
      'malformed_payload', 'unsupported_network', 'unsupported_asset', 'wrong_invocation', 'wrong_recipient',
      'wrong_amount', 'below_minimum', 'above_maximum', 'source_account_credentials', 'expired',
      'expiring_too_soon', 'bad_signature', 'already_redeemed', 'payment_not_found',
    ]
    if (retryable.includes(settled.code)) {
      const challenge = stellarRailChallenge(tool, status, env)
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
              note: 'The transaction may still land. Nothing was served, and the authorization was NOT marked spent, so a retry once it confirms is safe. This is not a statement that your payment failed.',
            }
          : {}),
      },
    }
  }

  // Derived from the settlement that happened, never from configuration.
  const handlers = deps.handlers ?? stellarHandlers(status, settled.broadcaster)
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

export type StellarRailProof = {
  rail: 'x402-stellar'
  configured: boolean
  network: string
  chain: string | null
  asset: string | null
  assetSymbol: string | null
  payTo: string | null
  totalSettlements: number
  totalUsd: number
  reverted: number
  /** Broadcast but never confirmed by us. Counted apart from both, because it is both. */
  ambiguous: number
  byTool: Record<string, { count: number; usd: number }>
  byNetwork: Record<string, { count: number; usd: number; assetSymbol: string }>
  /** Who actually moved each settled payment. The number that makes the claim checkable. */
  byBroadcaster: Record<Broadcaster, number>
  fees: { totalStroops: string; settles: number; note: string }
  recent: StellarSettlementRecord[]
  note: string
}

/**
 * The durable settlement log, aggregated.
 *
 * `byBroadcaster` is here because it is the only number that makes the product claim
 * checkable. Saying "we run our own facilitator" while OZ moved every payment would be
 * true about the code and false about the deployment, and this is the field that would
 * show it.
 */
export async function stellarRailProof(
  status: StellarRailStatus,
  deps: { load?: () => Promise<StellarSettlementRecord[]> } = {},
): Promise<StellarRailProof> {
  const rows = await (deps.load ?? loadStellarSettlements)()
  const settled = rows.filter((r) => r.outcome === 'settled')
  const byTool: Record<string, { count: number; usd: number }> = {}
  const byNetwork: Record<string, { count: number; usd: number; assetSymbol: string }> = {}
  const byBroadcaster: Record<Broadcaster, number> = { self: 0, oz: 0, buyer: 0 }
  let totalUsd = 0
  let feeTotal = 0n
  for (const r of rows) {
    if (r.feeStroops) {
      try {
        feeTotal += BigInt(r.feeStroops)
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
    byBroadcaster[r.broadcaster] += 1
  }
  return {
    rail: 'x402-stellar',
    configured: status.configured,
    network: status.network,
    chain: status.chain,
    asset: status.token?.address ?? null,
    assetSymbol: status.token?.symbol ?? null,
    payTo: status.payTo,
    totalSettlements: settled.length,
    totalUsd: Number(totalUsd.toFixed(6)),
    reverted: rows.filter((r) => r.outcome === 'reverted').length,
    ambiguous: rows.filter((r) => r.outcome === 'ambiguous').length,
    byTool,
    byNetwork,
    byBroadcaster,
    fees: {
      totalStroops: feeTotal.toString(),
      settles: rows.filter((r) => Boolean(r.feeStroops)).length,
      note: 'What WE paid in network fees so the buyer paid none. Stroops, not USD: the XLM price moves after a row is written, and the order book to price it with is on the ledger these settled on.',
    },
    recent: rows.slice(-25).reverse(),
    note:
      'Rows counted as settled were confirmed by our own read of the SEP-41 transfer event, ' +
      'whoever broadcast it. HOW each was bound differs and the difference matters: a row with ' +
      'broadcaster self or oz was matched to the buyer\'s authorization nonce, so it can only ' +
      'have paid for this purchase. A row with broadcaster buyer arrived on the settled scheme ' +
      'and is bound to the transaction hash alone, which proves the payment happened and was ' +
      'not redeemed here before, not that it was made for this purchase rather than another of ' +
      'the same price. `recent` also carries reverted and ambiguous rows, which were NOT ' +
      'confirmed and are not counted in totalSettlements; read outcome, not the array length.',
  }
}
