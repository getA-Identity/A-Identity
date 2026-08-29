/**
 * Route group for the Algorand x402 rail: /api/x402/algorand/*.
 *
 * Same posture as the Stellar group it mirrors: status tells the truth about
 * configuration, proof serves the durable settlement log, a GET on a tool is
 * the free price quote (the 402 challenge), and a POST with a payment header
 * is the paid call. One difference worth naming: this rail exposes NO
 * /facilitator endpoints of its own, because settlement runs through the
 * external GoPlausible facilitator; pretending to offer verify/settle here
 * would advertise a service we do not perform.
 */
import {
  algorandRailChallenge,
  algorandRailPaywallGate,
  algorandRailPriceUsd,
  algorandRailProof,
  algorandRailServeTool,
  algorandRailStatus,
  algorandRailNetworks,
  payToOptInCheck,
  RAIL_TOOLS,
  RAIL_TOOL_CARDS,
  type RailToolName,
} from '../x402-algorand/rail.js'
import type { TxContext } from '../asp/tools.js'
import { readBody, sendJson, type RouteCtx, sendChallenge } from './shared.js'

/** Serve the 402 (or any rail response) with the v2 header alongside the body:
 *  v2 clients read PAYMENT-REQUIRED, v1-era ones read the JSON body. */
function sendWithPaymentRequired(res: RouteCtx['res'], httpStatus: number, body: unknown): void {
  if (httpStatus === 402) {
    try {
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(body)).toString('base64'))
    } catch {
      /* header is best-effort; the body carries the same object */
    }
  }
  sendChallenge(res, httpStatus, body)
}

export async function handleX402AlgorandRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx
  if (!url.pathname.startsWith('/api/x402/algorand')) return false

  const wantedNetwork = url.searchParams.get('network')?.trim() || undefined
  const status = algorandRailStatus(process.env, wantedNetwork)

  // ── GET /api/x402/algorand/status - configuration, honestly ──
  if (req.method === 'GET' && url.pathname === '/api/x402/algorand/status') {
    const optIn = await payToOptInCheck(status)
    sendJson(res, 200, {
      rail: 'x402-algorand',
      vm: 'avm',
      configured: status.configured,
      ...(status.reason ? { reason: status.reason } : {}),
      network: status.network,
      facilitatorNetwork: status.facilitatorNetwork,
      chain: status.chain,
      asset: status.token?.address ?? null,
      assetSymbol: status.token?.symbol ?? null,
      assetDecimals: status.token?.decimals ?? null,
      payTo: status.payTo,
      payToOptIn: optIn,
      facilitator: status.facilitator,
      ...(status.tag ? { tag: status.tag } : {}),
      price: {
        note:
          'The buyer pays no network fee: they sign an ASA transfer with fee zero and the ' +
          "facilitator's fee-payer transaction covers the atomic group's pooled fee. No " +
          'settlement fee is added on top of the base price.',
      },
      authorization: {
        scheme: 'exact (x402 v2, AVM)',
        note:
          'The signed fee-zero transfer IS the authorization; replay protection is the ' +
          "protocol's own transaction-id dedup plus firstValid/lastValid rounds, and our " +
          'durable settlement log refuses a transaction id that already paid for a serving.',
      },
      networks: algorandRailNetworks().map((n) => {
        const s = algorandRailStatus(process.env, n)
        return {
          network: s.network,
          facilitatorNetwork: s.facilitatorNetwork,
          chain: s.chain,
          configured: s.configured,
          ...(s.reason ? { reason: s.reason } : {}),
          assetSymbol: s.token?.symbol ?? null,
        }
      }),
      configuredNetworksNote:
        'Set X402_ALGORAND_NETWORKS to a comma-separated list of registry CAIP-2 ids to sell on several networks.',
    })
    return true
  }

  // ── GET /api/x402/algorand/proof - the durable settlement log ──
  if (req.method === 'GET' && url.pathname === '/api/x402/algorand/proof') {
    sendJson(res, 200, await algorandRailProof(status))
    return true
  }

  // ── GET+POST /api/x402/algorand/tools/:name - the four paid trust tools ──
  const match = url.pathname.match(/^\/api\/x402\/algorand\/tools\/([a-z_]+)$/)
  if (!match) {
    sendJson(res, 404, {
      error: 'unknown Algorand x402 endpoint',
      endpoints: [
        'GET /api/x402/algorand/status',
        'GET /api/x402/algorand/proof',
        ...RAIL_TOOLS.map((t) => `GET+POST /api/x402/algorand/tools/${t}`),
      ],
    })
    return true
  }

  const tool = match[1] as RailToolName
  if (!RAIL_TOOLS.includes(tool)) {
    sendJson(res, 404, { error: `unknown tool '${tool}'`, tools: [...RAIL_TOOLS] })
    return true
  }

  const gate = algorandRailPaywallGate(status)
  if (!gate.ok) {
    sendJson(res, gate.httpStatus, gate.body)
    return true
  }

  if (req.method === 'GET') {
    const challenge = algorandRailChallenge(tool, status)
    sendWithPaymentRequired(res, challenge.httpStatus, challenge.body)
    return true
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'use GET for the price and POST to call', price: algorandRailPriceUsd(tool) })
    return true
  }

  // v2 header first, the v1 alias second; both carry base64 JSON.
  const header = String(req.headers['payment-signature'] ?? req.headers['x-payment'] ?? '')
  if (!header) {
    const challenge = algorandRailChallenge(tool, status)
    sendWithPaymentRequired(res, challenge.httpStatus, challenge.body)
    return true
  }

  const body = (await readBody(req)) as { agentId?: unknown; txContext?: unknown } | null
  const agentId = typeof body?.agentId === 'string' ? body.agentId : ''
  if (!agentId) {
    sendJson(res, 400, { error: 'agentId is required', input: RAIL_TOOL_CARDS[tool].input, example: RAIL_TOOL_CARDS[tool].example })
    return true
  }
  const out = await algorandRailServeTool(
    tool,
    { agentId, txContext: (body?.txContext ?? null) as TxContext | null },
    header,
    status,
  )
  if (out.httpStatus === 200) {
    // The x402 v2 receipt header, mirroring what the facilitator settled.
    const settlement = (out.body as { settlement?: unknown })?.settlement
    if (settlement) {
      try {
        res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(settlement)).toString('base64'))
      } catch {
        /* best-effort */
      }
    }
  }
  sendWithPaymentRequired(res, out.httpStatus, out.body)
  return true
}
