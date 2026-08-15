/**
 * The Soroban x402 rail and the facilitator built on it.
 *
 * The sibling of `x402-3009-routes.ts`, same two audiences under one prefix:
 * `/api/x402/stellar/tools/*` is our own paywall, and `/api/x402/stellar/facilitator/*` is
 * the service any Stellar seller can call.
 *
 * Thin adapters only. Every decision (the fail-closed gate, the local signature check,
 * verify, settle, the allowlist, the proof aggregation) lives in ../x402-stellar/ where it
 * is unit-tested without a network.
 *
 * The tool endpoints are PAYMENT-gated, not session-gated, matching the EVM rails: the
 * buyer's authorization IS the payment. http.ts exempts them from the verified-session
 * mutation gate, and the rail answers 501 when unconfigured, so the exemption can never
 * free-serve anything.
 *
 * One prefix note that is easy to get wrong. `/api/x402/stellar/...` sits UNDER the EVM
 * rail's `/api/x402/tools/` sibling, so this group must be consulted first, or a request
 * for a Stellar tool would be matched by a regex meant for the other rail.
 */
import { getChainById } from '../chains/index.js'
import { feePayerEnvVar, stellarSignerAddress } from '../chains/stellar/client.js'
import { stellarFeePayer } from '../chains/stellar/client.js'
import { stellarSettle, stellarSupported, stellarVerify } from '../x402-stellar/facilitator.js'
import {
  RAIL_TOOLS,
  RAIL_TOOL_CARDS,
  ozKeyVar,
  stellarRailChallenge,
  stellarRailNetworks,
  stellarRailPaywallGate,
  stellarRailPriceUsd,
  stellarRailProof,
  stellarRailServeTool,
  stellarRailStatus,
  type RailToolName,
} from '../x402-stellar/rail.js'
import type { TxContext } from '../asp/tools.js'
import { readBody, sendJson, type RouteCtx } from './shared.js'

/**
 * Can this network actually broadcast, and if not, which variable is at fault?
 *
 * Reports the public account only. A key that fails the StrKey checksum never reaches this
 * output and no key material does either. The check is the SAME one the settlement path
 * runs, which is the point: this repo already shipped a deployment whose status said
 * configured while every settlement failed for want of a signer, because readiness and
 * signing were reading different variables.
 */
function broadcastReadiness(networkId: string): Record<string, unknown> {
  const chain = getChainById(networkId)
  if (!chain) return { configured: false, reason: `${networkId} is not a chain in the registry` }
  const kp = stellarFeePayer(chain)
  const feeVar = feePayerEnvVar(chain)
  const chainVar = chain.signerEnvVar ?? '(none)'
  if (kp) {
    const dedicated = Boolean(process.env[feeVar]?.trim())
    return { configured: true, account: kp.publicKey(), from: dedicated ? feeVar : chainVar }
  }
  const present = Boolean((process.env[feeVar] ?? (chain.signerEnvVar ? process.env[chain.signerEnvVar] : '') ?? '').trim())
  return {
    configured: false,
    from: `${feeVar} or ${chainVar}`,
    reason: present
      ? `A value is set but is not a Stellar secret seed (S followed by 55 base32 characters, checksum included), so it was treated as unset. A 0x hex key belongs to an EVM chain.`
      : `Neither ${feeVar} nor ${chainVar} is set, so there is nothing to broadcast with.`,
    fallback: `${ozKeyVar(chain)} would let OpenZeppelin Channels broadcast instead.`,
    effect: 'Everything except settlement works; settlement refuses with no_broadcaster rather than pretending.',
    signerAccount: stellarSignerAddress(chain),
  }
}

export async function handleX402StellarRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx
  if (!url.pathname.startsWith('/api/x402/stellar')) return false

  const status = stellarRailStatus()

  // ── GET /api/x402/stellar/status - configuration, honestly ──
  if (req.method === 'GET' && url.pathname === '/api/x402/stellar/status') {
    sendJson(res, 200, {
      rail: 'x402-stellar',
      vm: 'soroban',
      configured: status.configured,
      ...(status.reason ? { reason: status.reason } : {}),
      network: status.network,
      chain: status.chain,
      asset: status.token?.address ?? null,
      assetSymbol: status.token?.symbol ?? null,
      assetDecimals: status.token?.decimals ?? null,
      payTo: status.payTo,
      broadcaster: status.broadcaster,
      broadcasterReady: status.broadcasterReady,
      price: {
        note:
          'The buyer pays no network fee: they sign a Soroban authorization entry and we ' +
          'assemble, pay the fee and submit. Unlike our EVM rails there is no settlement fee ' +
          'added on top of the base price, which is us absorbing a real cost rather than ' +
          'there being none.',
      },
      authorization: {
        scheme: 'soroban-auth',
        domainProving:
          'Not applicable. Soroban fixes the authorization preimage in the protocol, so unlike ' +
          'EIP-3009 there is no per-token signing domain to prove. What we DO check locally is ' +
          'the ed25519 signature over that preimage, before any RPC call.',
      },
      networks: stellarRailNetworks().map((n) => {
        const s = stellarRailStatus(process.env, n)
        return {
          network: s.network,
          chain: s.chain,
          configured: s.configured,
          ...(s.reason ? { reason: s.reason } : {}),
          assetSymbol: s.token?.symbol ?? null,
          broadcaster: s.broadcaster,
          broadcast: s.chain ? broadcastReadiness(s.chain) : null,
        }
      }),
      configuredNetworksNote:
        'Set X402_STELLAR_NETWORKS to a comma-separated list of CAIP-2 ids (stellar:testnet, stellar:pubnet) to sell on several networks.',
    })
    return true
  }

  // ── GET /api/x402/stellar/proof - the durable settlement log ──
  if (req.method === 'GET' && url.pathname === '/api/x402/stellar/proof') {
    sendJson(res, 200, await stellarRailProof(status))
    return true
  }

  // ── the facilitator ──
  if (url.pathname.startsWith('/api/x402/stellar/facilitator')) {
    if (req.method === 'GET' && url.pathname === '/api/x402/stellar/facilitator/supported') {
      const out = stellarSupported()
      sendJson(res, out.httpStatus, out.body)
      return true
    }
    if (req.method === 'POST' && url.pathname === '/api/x402/stellar/facilitator/verify') {
      const out = await stellarVerify(await readBody(req))
      sendJson(res, out.httpStatus, out.body)
      return true
    }
    if (req.method === 'POST' && url.pathname === '/api/x402/stellar/facilitator/settle') {
      const out = await stellarSettle(await readBody(req))
      sendJson(res, out.httpStatus, out.body)
      return true
    }
    sendJson(res, 404, {
      error: 'unknown Stellar facilitator endpoint',
      endpoints: [
        'GET /api/x402/stellar/facilitator/supported',
        'POST /api/x402/stellar/facilitator/verify',
        'POST /api/x402/stellar/facilitator/settle',
      ],
    })
    return true
  }

  // ── GET+POST /api/x402/stellar/tools/:name - the four paid trust tools ──
  const match = url.pathname.match(/^\/api\/x402\/stellar\/tools\/([a-z_]+)$/)
  if (!match) {
    sendJson(res, 404, {
      error: 'unknown Stellar x402 endpoint',
      endpoints: [
        'GET /api/x402/stellar/status',
        'GET /api/x402/stellar/proof',
        'GET /api/x402/stellar/facilitator/supported',
        'POST /api/x402/stellar/facilitator/verify',
        'POST /api/x402/stellar/facilitator/settle',
        ...RAIL_TOOLS.map((t) => `GET+POST /api/x402/stellar/tools/${t}`),
      ],
    })
    return true
  }

  const tool = match[1] as RailToolName
  if (!RAIL_TOOLS.includes(tool)) {
    sendJson(res, 404, { error: `unknown tool '${tool}'`, tools: [...RAIL_TOOLS] })
    return true
  }

  const gate = stellarRailPaywallGate(status)
  if (!gate.ok) {
    sendJson(res, gate.httpStatus, gate.body)
    return true
  }

  // A probing GET shows the price and exactly what to sign, so a buyer agent can decide
  // without a round trip through a human.
  if (req.method === 'GET') {
    const challenge = stellarRailChallenge(tool, status)
    sendJson(res, challenge.httpStatus, challenge.body)
    return true
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'use GET for the price and POST to call', price: stellarRailPriceUsd(tool) })
    return true
  }

  const header = String(req.headers['x-payment'] ?? '')
  if (!header) {
    const challenge = stellarRailChallenge(tool, status)
    sendJson(res, challenge.httpStatus, challenge.body)
    return true
  }

  const body = (await readBody(req)) as { agentId?: unknown; txContext?: unknown } | null
  const agentId = typeof body?.agentId === 'string' ? body.agentId : ''
  if (!agentId) {
    sendJson(res, 400, { error: 'agentId is required', input: RAIL_TOOL_CARDS[tool].input, example: RAIL_TOOL_CARDS[tool].example })
    return true
  }
  const out = await stellarRailServeTool(
    tool,
    { agentId, txContext: (body?.txContext ?? null) as TxContext | null },
    header,
    status,
  )
  sendJson(res, out.httpStatus, out.body)
  return true
}
