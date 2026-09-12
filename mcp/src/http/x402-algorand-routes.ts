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
  ALGORAND_BATCH_TOOL,
  ALGORAND_LISTINGS,
  ALGORAND_TOOLS,
  algorandChallengeReadiness,
  algorandRailChallenge,
  algorandRailPaywallGate,
  algorandRailPriceUsd,
  algorandRailProof,
  algorandRailServeTool,
  algorandRailStatus,
  algorandRailNetworks,
  isAlgorandTool,
  payToOptInCheck,
  RAIL_TOOL_CARDS,
  type RailToolName,
} from '../x402-algorand/rail.js'
import { normalizeAgentIds } from '../x402-algorand/batch.js'
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

type ToolBody = { agentId?: unknown; agentIds?: unknown; txContext?: unknown } | null

async function readToolBody(req: RouteCtx['req']): Promise<ToolBody> {
  try {
    return (await readBody(req)) as ToolBody
  } catch {
    return null
  }
}

/** A GET carries the deal size as ?amountUsd=; a POST carries a txContext object. */
function txContextFromQuery(url: URL): TxContext | null {
  if (!url.searchParams.has('amountUsd')) return null
  const amount = Number(url.searchParams.get('amountUsd'))
  return Number.isFinite(amount) && amount >= 0 ? ({ amountUsd: amount } as TxContext) : null
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
      challenge: algorandChallengeReadiness(status),
      price: {
        note:
          'The buyer pays no network fee: they sign an ASA transfer with fee zero and the ' +
          "facilitator's fee-payer transaction covers the atomic group's pooled fee. No " +
          'settlement fee is added on top of the price, and the answer is produced before the ' +
          'payment is submitted, so a tool that cannot answer costs nothing.',
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

  // ── GET+POST /api/x402/algorand/tools/:name - the paid trust tools ──
  const match = url.pathname.match(/^\/api\/x402\/algorand\/tools\/([a-z_]+)$/)
  if (!match) {
    sendJson(res, 404, {
      error: 'unknown Algorand x402 endpoint',
      endpoints: [
        'GET /api/x402/algorand/status',
        'GET /api/x402/algorand/proof',
        ...ALGORAND_TOOLS.map((t) => `GET+POST /api/x402/algorand/tools/${t}`),
      ],
    })
    return true
  }

  const name = match[1]
  if (!isAlgorandTool(name)) {
    sendJson(res, 404, { error: `unknown tool '${name}'`, tools: [...ALGORAND_TOOLS] })
    return true
  }
  const tool = name
  const isBatch = tool === ALGORAND_BATCH_TOOL

  const gate = algorandRailPaywallGate(status)
  if (!gate.ok) {
    sendJson(res, gate.httpStatus, gate.body)
    return true
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'use GET for the price and POST to call', price: algorandRailPriceUsd(tool) })
    return true
  }

  // v2 header first, the v1 alias second; both carry base64 JSON.
  const header = String(req.headers['payment-signature'] ?? req.headers['x-payment'] ?? '')
  const body: ToolBody = req.method === 'POST' ? await readToolBody(req) : null

  if (!header) {
    // A batch is quoted for the size the caller names: ?count=N, the agentIds it lists, or
    // the default quote when it names nothing.
    let count: number | undefined
    if (isBatch) {
      const countParam = url.searchParams.get('count')
      const listed = normalizeAgentIds(body?.agentIds ?? url.searchParams.get('agentIds') ?? undefined)
      count = countParam ? Number(countParam) : listed.ok ? listed.ids.length : undefined
    }
    const challenge = algorandRailChallenge(tool, status, process.env, { count })
    sendWithPaymentRequired(res, challenge.httpStatus, challenge.body)
    return true
  }

  // The declared call is a POST with a JSON body. A paid GET is accepted as well, input in
  // query params, because generic x402 clients replay whichever method they probed with.
  const txContext: TxContext | null = req.method === 'POST' ? ((body?.txContext ?? null) as TxContext | null) : txContextFromQuery(url)
  let out: { httpStatus: number; body: unknown }
  if (isBatch) {
    const ids = normalizeAgentIds(req.method === 'POST' ? body?.agentIds : url.searchParams.get('agentIds') ?? undefined)
    if (!ids.ok) {
      // Refused before any settlement, so a malformed list never costs the buyer a payment.
      sendJson(res, 400, {
        error: ids.reason,
        input: { agentIds: 'array of 1 to 50 agent ids (JSON body on POST, comma-separated query param on GET)' },
        example: ALGORAND_LISTINGS[tool].body,
      })
      return true
    }
    out = await algorandRailServeTool(tool, { agentId: '', agentIds: ids.ids, txContext }, header, status)
  } else {
    const agentId = req.method === 'POST'
      ? (typeof body?.agentId === 'string' ? body.agentId.trim() : '')
      : (url.searchParams.get('agentId')?.trim() ?? '')
    if (!agentId) {
      // Refused before any settlement, so a missing input never costs the buyer a payment.
      const card = RAIL_TOOL_CARDS[tool as RailToolName]
      sendJson(res, 400, {
        error: 'agentId is required: a JSON body on POST, or a query param on GET',
        input: card.input,
        example: card.example,
      })
      return true
    }
    out = await algorandRailServeTool(tool, { agentId, txContext }, header, status)
  }

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
