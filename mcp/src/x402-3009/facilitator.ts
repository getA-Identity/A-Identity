/**
 * The public x402 facilitator for chains that have none.
 *
 * An x402 facilitator is the service a seller calls to check a payment (/verify) and to
 * make it happen (/settle). Robinhood Chain has no such service from anyone, which is
 * why a seller there cannot accept gasless x402 payments at all. We already had to build
 * verification and settlement for our own paywall, so exposing them costs us one route
 * group and gives the chain the missing piece of infrastructure.
 *
 * The honest boundary, stated in /supported rather than discovered the hard way:
 *   - /verify and /supported are OPEN. Verification is read-only and costs us nothing.
 *   - /settle is ALLOWLISTED. Settling means we broadcast and pay the gas, so an open
 *     endpoint is a gas faucet with our name on it. Anyone may ask to be added; the
 *     switch is configuration, not a rewrite. Opening it later is easy, and being
 *     drained is not reversible.
 *
 * Everything here is pure: handlers take a request body and return { httpStatus, body }.
 * The route file is a thin adapter, which keeps this testable without a server.
 */
import { CHAINS, getChain, getChainById, type ChainDescriptor } from '../chains/index.js'
import { provenDomainCached } from './domain.js'
import { verifyPayment, settlePayment, type Requirements, type EngineDeps } from './engine.js'
import { railStatus, railLimits, railToken, type RailStatus } from './rail.js'

type Handled = { httpStatus: number; body: Record<string, unknown> }

/**
 * Resolve the network a request names. Accepts BOTH the x402 v1 shape (a chain slug like
 * "rhchain") and the v2 shape (a CAIP-2 id like "eip155:4663"), because an off-the-shelf
 * client may send either, and both are unambiguous against the registry. Nothing is
 * guessed: a name that resolves to no descriptor is an error, not a default.
 */
export function resolveNetwork(name: unknown): ChainDescriptor | null {
  if (typeof name !== 'string' || !name.trim()) return null
  const raw = name.trim()
  return getChain(raw) ?? getChainById(raw) ?? null
}

/** Chains this facilitator can serve at all: any registry chain declaring an EIP-3009
 *  settlement token. Derived, so a new chain is a descriptor edit. */
export function facilitatorChains(env: NodeJS.ProcessEnv = process.env): ChainDescriptor[] {
  return CHAINS.filter((c) => Boolean(railToken(c, env)))
}

export type SupportedKind = {
  x402Version: 1 | 2
  scheme: 'exact'
  network: string
  asset: string
  assetSymbol: string
  decimals: number
  extra: Record<string, unknown>
  minAmountRequired: string
  maxAmountRequired: string
}

/**
 * GET /api/facilitator/supported - what a client can pay with here.
 *
 * A chain whose token domain cannot be proven right now is reported under `unavailable`
 * with the reason, never advertised as a kind. Advertising a kind we cannot honor would
 * send a buyer to sign something that can never settle.
 */
export async function supported(
  status: RailStatus,
  deps: EngineDeps = {},
): Promise<Handled> {
  const env = deps.env ?? process.env
  const kinds: SupportedKind[] = []
  const unavailable: { network: string; reason: string }[] = []

  for (const chain of facilitatorChains(env)) {
    const token = railToken(chain, env)
    if (!token) continue
    const domain = await provenDomainCached(chain, token, deps)
    if (!domain.ok) {
      unavailable.push({ network: chain.caip2, reason: domain.reason })
      continue
    }
    const extra = {
      ...domain.proven.domain,
      domainSeparator: domain.proven.domainSeparator,
      domainVerified: true,
      versionSource: domain.proven.versionSource,
      provenAt: domain.proven.provenAt,
    }
    const limits = railLimits({ ...status, token }, env)
    const shared = {
      scheme: 'exact' as const,
      asset: token.address,
      assetSymbol: domain.proven.symbol,
      decimals: domain.proven.decimals,
      extra,
      minAmountRequired: limits.minValue.toString(),
      maxAmountRequired: limits.maxValue.toString(),
    }
    // Both wire shapes, exactly as first-party facilitators on other chains publish them.
    kinds.push({ x402Version: 2, network: chain.caip2, ...shared })
    kinds.push({ x402Version: 1, network: chain.id, ...shared })
  }

  return {
    httpStatus: 200,
    body: {
      kinds,
      ...(unavailable.length ? { unavailable } : {}),
      facilitator: {
        operator: 'A-Identity',
        selfHosted: true,
        settle: {
          open: status.publicSettle,
          note: status.publicSettle
            ? 'Settlement is open to the payTo addresses on the allowlist.'
            : 'We broadcast and pay the gas, so /settle is limited to allowlisted payTo addresses. /verify and /supported are open to everyone.',
        },
        endpoints: { verify: '/api/facilitator/verify', settle: '/api/facilitator/settle', supported: '/api/facilitator/supported' },
      },
    },
  }
}

type FacilitatorRequest = {
  paymentPayload?: unknown
  paymentRequirements?: unknown
  x402Version?: number
}

function readRequest(body: unknown): { ok: true; chain: ChainDescriptor; requirements: Requirements; payload: unknown } | { ok: false; body: Record<string, unknown> } {
  const b = (body ?? {}) as FacilitatorRequest
  const req = b.paymentRequirements as Record<string, unknown> | undefined
  const payload = b.paymentPayload as Record<string, unknown> | undefined
  if (!req || !payload) {
    return { ok: false, body: { isValid: false, invalidReason: 'body needs { paymentPayload, paymentRequirements }', code: 'malformed_payload' } }
  }
  const chain = resolveNetwork(req.network ?? (payload as { network?: unknown }).network)
  if (!chain) {
    return { ok: false, body: { isValid: false, invalidReason: `unknown network '${String(req.network ?? '')}': use a registry slug or a CAIP-2 id`, code: 'unsupported_network' } }
  }
  const asset = String(req.asset ?? '')
  const payTo = String(req.payTo ?? '')
  if (!/^0x[0-9a-fA-F]{40}$/.test(asset) || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    return { ok: false, body: { isValid: false, invalidReason: 'paymentRequirements needs a 0x asset and a 0x payTo', code: 'malformed_payload' } }
  }
  return {
    ok: true,
    chain,
    payload,
    requirements: {
      scheme: 'exact',
      network: chain.caip2,
      asset: asset as `0x${string}`,
      payTo: payTo as `0x${string}`,
      maxAmountRequired: String(req.maxAmountRequired ?? '0'),
      resource: String(req.resource ?? '/api/facilitator/settle'),
    },
  }
}

/** POST /api/facilitator/verify - read-only, open, never broadcasts. */
export async function verify(body: unknown, deps: EngineDeps = {}): Promise<Handled> {
  const env = deps.env ?? process.env
  const parsed = readRequest(body)
  if (!parsed.ok) return { httpStatus: 400, body: parsed.body }
  const token = railToken(parsed.chain, env)
  if (!token) {
    return { httpStatus: 400, body: { isValid: false, code: 'unsupported_network', invalidReason: `${parsed.chain.id} declares no EIP-3009 settlement token` } }
  }
  const status = railStatus(env)
  const result = await verifyPayment({
    chain: parsed.chain,
    token,
    requirements: parsed.requirements,
    payload: parsed.payload,
    limits: railLimits({ ...status, token }, env),
    deps,
  })
  return result.isValid
    ? { httpStatus: 200, body: { isValid: true, payer: result.payer, network: parsed.chain.caip2 } }
    : { httpStatus: 200, body: { isValid: false, invalidReason: result.invalidReason, code: result.code, network: parsed.chain.caip2 } }
}

/**
 * POST /api/facilitator/settle - we broadcast and pay the gas.
 *
 * Allowlisted by payTo. That single check turns "anyone can make us spend gas" into
 * "anyone can send US money and make us spend gas", which is just business, and it is
 * why the other guards (minimum value, simulation, gas ceiling, daily budget) can stay
 * economic rather than adversarial.
 */
export async function settle(body: unknown, deps: EngineDeps = {}): Promise<Handled> {
  const env = deps.env ?? process.env
  const status = railStatus(env)
  if (!status.configured) {
    return { httpStatus: 501, body: { success: false, errorReason: status.reason ?? 'facilitator not configured', code: 'not_configured' } }
  }
  const parsed = readRequest(body)
  if (!parsed.ok) return { httpStatus: 400, body: { success: false, errorReason: String(parsed.body.invalidReason), code: 'malformed_payload' } }

  const payTo = parsed.requirements.payTo.toLowerCase()
  const allowed = payTo === status.payTo || status.allowedPayTo.includes(payTo)
  if (!allowed) {
    return {
      httpStatus: 403,
      body: {
        success: false,
        code: 'payto_not_allowlisted',
        errorReason: 'settle is allowlisted because we broadcast and pay the gas',
        note: '/verify and /supported are open to everyone. Ask for settle access if you are building on this chain.',
      },
    }
  }
  const token = railToken(parsed.chain, env)
  if (!token) {
    return { httpStatus: 400, body: { success: false, code: 'unsupported_network', errorReason: `${parsed.chain.id} declares no EIP-3009 settlement token` } }
  }

  const result = await settlePayment({
    chain: parsed.chain,
    token,
    requirements: parsed.requirements,
    payload: parsed.payload,
    limits: railLimits({ ...status, token }, env),
    deps: {
      ...deps,
      meta: {
        tool: 'facilitator',
        baseUsd: 0,
        feeUsd: 0,
        ...(payTo === status.payTo ? {} : { facilitatedFor: payTo }),
      },
    },
  })
  if (result.success) return { httpStatus: 200, body: { ...result, network: parsed.chain.caip2 } }
  const httpStatus = result.code === 'gas_budget_exhausted' ? 503 : result.code === 'no_signer' ? 501 : 502
  return { httpStatus, body: { ...result, network: parsed.chain.caip2 } }
}
