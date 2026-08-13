/**
 * The self-facilitated EIP-3009 rail and the public facilitator built on it.
 *
 * Two audiences share one route group. `/api/x402/tools/*` is our own paywall: an
 * anonymous buyer agent pays and gets a trust answer. `/api/facilitator/*` is the piece
 * of infrastructure the chain was missing, usable by anyone selling anything there.
 *
 * Thin adapters only. Every decision - the fail-closed gate, the proven domain, verify,
 * settle, the allowlist, the proof aggregation - lives in ../x402-3009/ where it is
 * unit-tested without a network.
 *
 * The tool endpoints are PAYMENT-gated, not session-gated, for the same reason the Celo
 * rail's are: the buyer's authorization IS the settled payment. http.ts exempts them
 * from the verified-session mutation gate, and the rail answers 501 when unconfigured,
 * so the exemption can never free-serve anything.
 */
import {
  railNetworks,
  RAIL_TOOLS,
  RAIL_TOOL_CARDS,
  railChallenge,
  railPaywallGate,
  railProof,
  railServeTool,
  railStatus,
  railPriceUsd,
  type RailToolName,
} from '../x402-3009/rail.js'
import { supported, verify, settle } from '../x402-3009/facilitator.js'
import { provenDomainCached } from '../x402-3009/domain.js'
import { getChainById, evmWalletClientFromKey, type ChainDescriptor } from '../chains/index.js'
import type { TxContext } from '../asp/tools.js'
import { readBody, sendJson, type RouteCtx } from './shared.js'

/**
 * Is there a usable key to broadcast settlements with, and if not, which variable is at
 * fault? Reports the public address only; a key that fails the shape check never reaches
 * this output, and neither does any key material.
 */
async function settlementSigner(chain: ChainDescriptor): Promise<Record<string, unknown>> {
  const dedicated = process.env.X402_3009_SIGNER_KEY
  const chainVar = chain.signerEnvVar
  const usingVar = dedicated ? 'X402_3009_SIGNER_KEY' : (chainVar ?? '(none)')
  const wallet = await evmWalletClientFromKey(chain, dedicated || (chainVar ? process.env[chainVar] : undefined)).catch(() => null)
  if (wallet) return { configured: true, address: wallet.account.address, from: usingVar }
  const present = Boolean((dedicated ?? (chainVar ? process.env[chainVar] : undefined))?.trim())
  return {
    configured: false,
    from: usingVar,
    reason: present
      ? `${usingVar} is set but is not a 32-byte hex private key, so it was treated as unset. Settlement is refused until it is a real key.`
      : `Neither X402_3009_SIGNER_KEY nor ${chainVar ?? 'a chain signer variable'} is set, so there is nothing to broadcast with.`,
    effect: 'Everything except POST /api/facilitator/settle and the paid tools works; those refuse with no_signer rather than pretending.',
  }
}

export async function handleX402ThreeKRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx
  const isFacilitator = url.pathname.startsWith('/api/facilitator')
  const isTool = url.pathname.startsWith('/api/x402/tools/')
  if (!isFacilitator && !isTool) return false

  const status = railStatus()

  // ── GET /api/facilitator/status - configuration, honestly ──
  if (req.method === 'GET' && url.pathname === '/api/facilitator/status') {
    const chain = status.chain ? getChainById(status.chain) : undefined
    const domain = chain && status.token ? await provenDomainCached(chain, status.token) : null
    // Whether a USABLE settlement signer exists, and which variable to fix if not. This
    // exists because a deployment once had a signer variable set to a placeholder, and
    // the only symptom was every settlement failing with "no signer" while /status
    // cheerfully reported configured: true. The address is public; no key material is
    // exposed, and the check is the same one the settlement path runs.
    const signer = chain ? await settlementSigner(chain) : null
    sendJson(res, 200, {
      rail: 'x402-3009',
      configured: status.configured,
      ...(status.reason ? { reason: status.reason } : {}),
      network: status.network,
      chain: status.chain,
      asset: status.token?.address ?? null,
      assetSymbol: status.token?.symbol ?? null,
      payTo: status.payTo,
      price: {
        settlementFeeUsd: status.settlementFeeUsd,
        minValueUsd: status.minValueUsd,
        maxValueUsd: status.maxValueUsd,
        note: status.token?.feeBasis
          ? `The buyer pays no gas: we broadcast the signed authorization, and the settlement fee covers that broadcast on this chain. ${status.token.feeBasis}`
          : 'The buyer pays no gas: we broadcast the signed authorization, and the settlement fee covers that broadcast.',
      },
      domain: domain?.ok
        ? {
            ...domain.proven.domain,
            domainSeparator: domain.proven.domainSeparator,
            versionSource: domain.proven.versionSource,
            provenAt: domain.proven.provenAt,
            method:
              'The signing domain is PROVEN, not pasted: we rebuild EIP712Domain(name, version, chainId, verifyingContract) from the token\'s own name() plus each candidate version, and accept only the one that reproduces the live DOMAIN_SEPARATOR. No match means no challenge is served at all.',
          }
        : { proven: false, ...(domain ? { reason: domain.reason } : {}) },
      settlementSigner: signer,
      // What this deployment actually READ, per chain, and whether each can settle. The
      // single-chain fields above describe the default only, which is misleading the
      // moment a rail sells on more than one: an operator who set a variable needs to see
      // that it took effect, not infer it from a challenge.
      networks: await Promise.all(
        railNetworks().map(async (n) => {
          const s = railStatus(process.env, n)
          const c = s.chain ? getChainById(s.chain) : undefined
          return {
            network: s.network,
            chain: s.chain,
            configured: s.configured,
            ...(s.reason ? { reason: s.reason } : {}),
            assetSymbol: s.token?.symbol ?? null,
            settlementFeeUsd: s.settlementFeeUsd,
            signer: c ? await settlementSigner(c) : null,
          }
        }),
      ),
      configuredNetworksNote:
        'Set X402_3009_NETWORKS to a comma-separated list of CAIP-2 ids to sell on several chains. X402_3009_NETWORK still works for one.',
      registries: chain ? chain.contracts : null,
    })
    return true
  }

  // ── GET /api/facilitator/supported - x402 discovery ──
  if (req.method === 'GET' && url.pathname === '/api/facilitator/supported') {
    const out = await supported(status)
    sendJson(res, out.httpStatus, out.body)
    return true
  }

  // ── GET /api/facilitator/proof - the durable settlement log ──
  if (req.method === 'GET' && url.pathname === '/api/facilitator/proof') {
    sendJson(res, 200, await railProof(status))
    return true
  }

  // ── POST /api/facilitator/verify - open, read-only ──
  if (req.method === 'POST' && url.pathname === '/api/facilitator/verify') {
    const out = await verify(await readBody(req))
    sendJson(res, out.httpStatus, out.body)
    return true
  }

  // ── POST /api/facilitator/settle - allowlisted, we pay the gas ──
  if (req.method === 'POST' && url.pathname === '/api/facilitator/settle') {
    const out = await settle(await readBody(req))
    sendJson(res, out.httpStatus, out.body)
    return true
  }

  if (isFacilitator) {
    sendJson(res, 404, {
      error: 'unknown facilitator endpoint',
      endpoints: ['GET /api/facilitator/status', 'GET /api/facilitator/supported', 'GET /api/facilitator/proof', 'POST /api/facilitator/verify', 'POST /api/facilitator/settle'],
    })
    return true
  }

  // ── GET+POST /api/x402/tools/:name - the four paid trust tools ──
  const match = url.pathname.match(/^\/api\/x402\/tools\/([a-z_]+)$/)
  if (!match) return false
  const tool = match[1] as RailToolName
  if (!RAIL_TOOLS.includes(tool)) {
    sendJson(res, 404, { error: `unknown tool '${tool}'`, tools: [...RAIL_TOOLS] })
    return true
  }

  const gate = railPaywallGate(status)
  if (!gate.ok) {
    sendJson(res, gate.httpStatus, gate.body)
    return true
  }

  // A probing GET shows the price, the calling contract and the proven domain, so a
  // buyer agent can decide and sign without a round trip through a human.
  if (req.method === 'GET') {
    const challenge = await railChallenge(tool, status)
    sendJson(res, challenge.httpStatus, challenge.body)
    return true
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'use GET for the price and POST to call', price: railPriceUsd(tool, status) })
    return true
  }

  const header = String(req.headers['x-payment'] ?? '')
  if (!header) {
    const challenge = await railChallenge(tool, status)
    sendJson(res, challenge.httpStatus, challenge.body)
    return true
  }

  const body = (await readBody(req)) as { agentId?: unknown; txContext?: unknown } | null
  const agentId = typeof body?.agentId === 'string' ? body.agentId : ''
  if (!agentId) {
    sendJson(res, 400, { error: 'agentId is required', input: RAIL_TOOL_CARDS[tool].input, example: RAIL_TOOL_CARDS[tool].example })
    return true
  }
  const out = await railServeTool(tool, { agentId, txContext: (body?.txContext ?? null) as TxContext | null }, header, status)
  sendJson(res, out.httpStatus, out.body)
  return true
}
