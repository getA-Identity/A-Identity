/**
 * The Circle Gateway batched rail: paid trust tools for Circle Agent Marketplace buyers.
 *
 * Thin adapters only. Every decision - the fail-closed gate, the proven kind, the local
 * checks before settling, the read-back, the proof - lives in ../x402-gateway/ where it is
 * unit-tested without a network.
 *
 * PAYMENT-gated, not session-gated, like the other rails: the buyer's authorization IS
 * the settled payment. http.ts exempts /api/x402/gateway/* from the verified-session
 * mutation gate, and the rail answers 501 when unconfigured, so the exemption never
 * free-serves anything. Paid tools answer GET (query parameters) as well as POST (JSON
 * body), because Circle CLI's `services inspect` probes with GET and a POST-only route
 * would turn that probe into a 404 instead of the 402 it is looking for.
 */
import {
  GATEWAY_TOOLS,
  GATEWAY_FREE_TOOL,
  GATEWAY_TOOL_CARDS,
  railNetworks,
  railStatus,
  railPaywallGate,
  railChallenge,
  railServeTool,
  railFreeTool,
  railPaymentHeader,
  railProof,
  refreshCreditedRows,
  openApiDocument,
  toolPriceUsd,
  provenKind,
  type GatewayToolName,
  type GatewayToolInput,
} from '../x402-gateway/index.js'
import { getChainById } from '../chains/index.js'
import type { TxContext } from '../asp/tools.js'
import { readBody, sendJson, sendChallenge, type RouteCtx } from './shared.js'

/** Scheme + host this request arrived on, as Render and local both present it. */
function requestOrigin(ctx: RouteCtx): string {
  const proto = (ctx.req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'http'
  const host = (ctx.req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() || ctx.req.headers.host || 'localhost'
  return `${proto}://${host}`
}

async function toolInput(ctx: RouteCtx): Promise<GatewayToolInput> {
  const { req, url } = ctx
  if (req.method === 'POST') {
    const body = (await readBody(req)) as Record<string, unknown> | null
    return {
      agentId: typeof body?.agentId === 'string' ? body.agentId : undefined,
      from: typeof body?.from === 'string' ? body.from : undefined,
      to: typeof body?.to === 'string' ? body.to : undefined,
      txContext: (body?.txContext ?? null) as TxContext | null,
    }
  }
  const q = url.searchParams
  let txContext: TxContext | null = null
  const rawCtx = q.get('txContext')
  if (rawCtx) {
    try {
      txContext = JSON.parse(rawCtx) as TxContext
    } catch {
      txContext = null
    }
  }
  const amount = q.get('amountUsd')
  if (!txContext && amount && Number.isFinite(Number(amount))) txContext = { amountUsd: Number(amount) } as TxContext
  return { agentId: q.get('agentId') ?? undefined, from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, txContext }
}

export async function handleX402GatewayRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx
  if (!url.pathname.startsWith('/api/x402/gateway/')) return false
  const origin = requestOrigin(ctx)
  const wantedNetwork = url.searchParams.get('network')?.trim() || undefined
  const status = railStatus(process.env, wantedNetwork)

  // ── GET /api/x402/gateway/status - configuration, honestly ──
  if (req.method === 'GET' && url.pathname === '/api/x402/gateway/status') {
    const networks = await Promise.all(
      railNetworks().map(async (n) => {
        const s = railStatus(process.env, n)
        const c = s.chain ? getChainById(s.chain) : undefined
        const proof = c ? await provenKind(c) : null
        return {
          network: s.network,
          chain: s.chain,
          configured: s.configured,
          ...(s.reason ? { reason: s.reason } : {}),
          facilitator: s.facilitator,
          registryWallet: s.wallet,
          kind: proof?.ok
            ? { proven: true, verifyingContract: proof.proven.kind.extra.verifyingContract, asset: proof.proven.asset, provenAt: proof.proven.provenAt }
            : { proven: false, ...(proof ? { reason: proof.reason } : {}) },
        }
      }),
    )
    sendJson(res, 200, {
      rail: 'x402-gateway',
      configured: status.configured,
      ...(status.reason ? { reason: status.reason } : {}),
      network: status.network,
      chain: status.chain,
      payTo: status.payTo,
      facilitator: status.facilitator,
      prices: Object.fromEntries(GATEWAY_TOOLS.map((t) => [t, toolPriceUsd(t)])),
      settlementFeeUsd: 0,
      method:
        'The buyer signs an EIP-3009 authorization against Circle Gateway\'s GatewayWalletBatched domain and pays no gas; Gateway credits us and batches the on-chain settlement. Before any challenge is served the live /v1/x402/supported is read and its verifyingContract and USDC must match the registry. Nothing is recorded or served until the transfer is read back from Gateway\'s transfers API.',
      networks,
      configuredNetworksNote: 'Set X402_GATEWAY_NETWORKS to a comma-separated list of CAIP-2 ids of chains that declare a Circle Gateway in the registry, and X402_GATEWAY_PAYTO to the receiving address.',
      tools: [...GATEWAY_TOOLS],
      freeTool: GATEWAY_FREE_TOOL,
      openapi: `${origin}/api/x402/gateway/openapi.json`,
    })
    return true
  }

  // ── GET /api/x402/gateway/openapi.json - the listing prerequisite ──
  if (req.method === 'GET' && url.pathname === '/api/x402/gateway/openapi.json') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'public, max-age=300')
    sendJson(res, 200, openApiDocument(status, origin))
    return true
  }

  // ── GET /api/x402/gateway/proof - the durable settlement log, refreshed ──
  if (req.method === 'GET' && url.pathname === '/api/x402/gateway/proof') {
    const refreshed = await refreshCreditedRows()
    sendJson(res, 200, { ...(await railProof(status)), refreshed })
    return true
  }

  // ── GET+POST /api/x402/gateway/tools/:name ──
  const match = url.pathname.match(/^\/api\/x402\/gateway\/tools\/([a-z_]+)$/)
  if (!match) return false
  const name = match[1]

  if (name === GATEWAY_FREE_TOOL) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { error: 'use GET or POST' })
      return true
    }
    const input = await toolInput(ctx)
    if (!input.agentId) {
      sendJson(res, 400, { error: 'agentId is required', input: GATEWAY_TOOL_CARDS[GATEWAY_FREE_TOOL].input, example: GATEWAY_TOOL_CARDS[GATEWAY_FREE_TOOL].example })
      return true
    }
    sendJson(res, 200, await railFreeTool(input))
    return true
  }

  const tool = name as GatewayToolName
  if (!GATEWAY_TOOLS.includes(tool)) {
    sendJson(res, 404, { error: `unknown tool '${tool}'`, tools: [...GATEWAY_TOOLS, GATEWAY_FREE_TOOL] })
    return true
  }
  const gate = railPaywallGate(status)
  if (!gate.ok) {
    sendJson(res, gate.httpStatus, gate.body)
    return true
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'use GET or POST; both answer 402 until paid', price: toolPriceUsd(tool) })
    return true
  }

  const header = railPaymentHeader(req.headers)
  if (!header) {
    const challenge = await railChallenge(tool, status, { origin })
    sendChallenge(res, challenge.httpStatus, challenge.body)
    return true
  }
  const input = await toolInput(ctx)
  const out = await railServeTool(tool, input, header, status, { origin })
  for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v)
  sendChallenge(res, out.httpStatus, out.body)
  return true
}
