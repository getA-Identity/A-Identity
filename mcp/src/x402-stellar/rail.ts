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
 * **No settlement fee.** The EIP-3009 rails charge a disclosed fee because broadcasting
 * costs real gas: measured at 0.0000046 ETH on Robinhood Chain and 0.00000207 ETH on
 * Arbitrum One, which is material against a $0.001 tool. A Stellar settlement measured
 * 22,973 stroops, or 0.0023 XLM (tx 37d52f31..., testnet). We do not publish a USD figure
 * for that because we have no price feed we verify and will not invent one, but it is
 * several orders of magnitude under the cheapest thing we sell, so charging a line item to
 * cover it would be a markup wearing an explanation. The base prices stand alone.
 *
 * **No minimum value floor.** The floor on the other rails exists so a settlement covers
 * the gas it costs. With no fee to cover, a floor would only price out small payments.
 *
 * ## What is shared
 *
 * The four base prices are IMPORTED from x402-3009/rail.js rather than restated. Three
 * rails already sell these tools and the prices are pinned across them by test; a fourth
 * copy would be a fourth thing that must agree.
 */
import { getChain, getChainById, tokenUnits, type ChainDescriptor, type SettlementToken } from '../chains/index.js'
import { isAccountId, isContractId } from '../chains/stellar/strkey.js'
import { RAIL_BASE_PRICES_USD, RAIL_TOOL_CARDS, type RailToolName } from '../x402-3009/rail.js'

export { RAIL_BASE_PRICES_USD, RAIL_TOOL_CARDS }
export type { RailToolName }

/** Which party assembles the transaction, pays the network fee, and submits it. */
export type Broadcaster = 'self' | 'oz'

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
  const feePayer = env.X402_STELLAR_SIGNER_SECRET?.trim() || (chain?.signerEnvVar ? env[chain.signerEnvVar]?.trim() : '')
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
          reason: `X402_STELLAR_FACILITATOR=self but no fee payer is configured (set X402_STELLAR_SIGNER_SECRET or ${chain?.signerEnvVar ?? 'the chain signer'})`,
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
        networkPassphrase:
          s.network === 'stellar:pubnet'
            ? 'Public Global Stellar Network ; September 2015'
            : 'Test SDF Network ; September 2015',
        broadcaster: s.broadcaster,
      },
    })
  }

  return {
    httpStatus: 402,
    body: {
      x402Version: 2,
      error: 'payment required',
      accepts,
      tool: {
        name: tool,
        price: { baseUsd: stellarRailPriceUsd(tool).baseUsd, totalUsd: stellarRailPriceUsd(tool).totalUsd },
        priceNote:
          'This rail is gasless for the buyer: you sign a Soroban authorization entry and we ' +
          'assemble, pay the network fee and submit. Unlike our EVM rails there is no ' +
          'settlement fee added, because there is nothing meaningful to cover: a settlement ' +
          'here measured 22,973 stroops (0.0023 XLM). We publish no USD figure for that, ' +
          'having no price feed we verify. The base price is identical on every rail we sell on.',
        ...RAIL_TOOL_CARDS[tool],
        method: `POST ${stellarRailResource(tool)}`,
        payment:
          'Sign a Soroban authorization entry for the `transfer` call described in `extra`, then POST with header X-PAYMENT: base64(JSON of {x402Version:2, scheme:"exact", network, payload:{authEntryXdr}}).',
      },
    },
  }
}
