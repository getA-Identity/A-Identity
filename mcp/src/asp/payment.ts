/**
 * Optional OKX x402 payment layer for the ASP gateway.
 *
 * When the OKX Secured-Aggregator credentials + a recipient address are present, this
 * wraps the four paid tool routes with OKX's x402 middleware: an unpaid request is cut
 * with HTTP 402 + a payment challenge before it reaches business logic; after the buyer's
 * Agentic Wallet pays on X Layer (eip155:196), the request is replayed and served.
 *
 * Credential-gated, exactly like the rest of this backend (ARC_SIGNER_KEY, Circle keys):
 * with no creds the gateway runs in FREE mode (tools still work, nothing is charged), so
 * it is always deployable and testable. The SDK is imported DYNAMICALLY with loose typing
 * so `tsc` never hard-depends on it and a missing optional dep can't break the build or the
 * boot - it just falls back to free mode.
 *
 * NOTE: the OKX *seller* side requires OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE
 * (from web3.okx.com/onchainos/dev-portal). A recipient address alone is NOT enough -
 * settlement is brokered through OKX's facilitator via an HMAC-signed client.
 */
import type { Express } from 'express'

/** X Layer mainnet. Testnet is eip155:1952; 195 is deprecated - never use it. */
const NETWORK = process.env.OKX_X402_NETWORK ?? 'eip155:196'

/** Per-call USD prices; OKX auto-converts to the X Layer settlement token (USD₮0, 6 dp).
 *  Routes NOT listed here (e.g. the free-tier trust_preview) are never charged. */
export const PRICES: Record<string, string> = {
  'POST /tools/verify_agent': '$0.001',
  'POST /tools/reputation_score': '$0.002',
  'POST /tools/risk_check': '$0.005',
  'POST /tools/agent_passport': '$0.01',
  'POST /tools/counterparty_check': '$0.008',
  'POST /tools/guardrail_check': '$0.005',
}

/**
 * Copy the spec challenge out of the `PAYMENT-REQUIRED` header and into the 402 body.
 *
 * Why this is a decode rather than a second hand-written challenge: the OKX SDK builds
 * the real requirements (it resolves the settlement asset from the facilitator, which we
 * never see), and its `unpaidResponseBody` hook is handed only the request context, not
 * those requirements. Anything we typed out by hand here would be a duplicate free to
 * drift from the header on price, payTo or asset. Decoding the header cannot drift: the
 * body IS the header.
 *
 * The reason to do it at all: OKX puts the whole challenge in that header ("v1 puts in
 * body, v2 puts in header", per the SDK), so a generic x402 client that reads the body,
 * the way the Celo rail serves it, finds no challenge and cannot pay. This opens the ASP
 * rail to those clients without touching the header, the prices or the tool schemas.
 *
 * `amount` is the field name this rail's SDK uses; `maxAmountRequired` is the older
 * Coinbase name that other clients look for. Both are emitted with the same value rather
 * than picking a side. Returns the body unchanged on anything unexpected: a malformed
 * header must not turn a 402 into a 500.
 */
export function withSpecChallenge(body: string, header: unknown): string {
  if (typeof header !== 'string' || !header) return body
  let challenge: Record<string, unknown>
  let parsed: Record<string, unknown>
  try {
    challenge = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)) return body
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body

  const accepts = Array.isArray(challenge.accepts)
    ? challenge.accepts.map((a) => {
        if (!a || typeof a !== 'object' || Array.isArray(a)) return a
        const entry = a as Record<string, unknown>
        return 'amount' in entry && !('maxAmountRequired' in entry)
          ? { ...entry, maxAmountRequired: entry.amount }
          : entry
      })
    : challenge.accepts

  // Our own keys win: the calling contract below is richer than the header's copy.
  return JSON.stringify({
    x402Version: challenge.x402Version,
    accepts,
    resource: challenge.resource,
    ...(challenge.extensions === undefined ? {} : { extensions: challenge.extensions }),
    ...parsed,
  })
}

const AGENT_ID_DOC = 'ERC-8004 token id ("#849980"), CAIP id ("eip155:196:8004/6271"), or 0x owner address'
const TX_CONTEXT_DOC = 'optional object: { "amountUsd": number, "payee": "0x… address" }'

/**
 * The machine-readable calling contract for each paid tool, served INSIDE the 402
 * response body (via the SDK's unpaidResponseBody hook) so a buyer agent knows the
 * exact method, JSON fields, and an example BEFORE paying - no guessing from prose.
 */
const CONTRACTS: Record<string, { description: string; input: Record<string, string>; example: Record<string, unknown> }> = {
  'POST /tools/verify_agent': {
    description: 'Verify an AI agent: ERC-8004 identity + KYA status + endpoint liveness.',
    input: { agentId: AGENT_ID_DOC },
    example: { agentId: '#849980' },
  },
  'POST /tools/reputation_score': {
    description: 'Deterministic 0-1000 reputation with a full breakdown and its on-chain attestation.',
    input: { agentId: AGENT_ID_DOC },
    example: { agentId: '#849980' },
  },
  'POST /tools/risk_check': {
    description: 'Pre-transaction ALLOW / WARN / DENY verdict on a counterparty, with reasons.',
    input: { agentId: AGENT_ID_DOC, txContext: TX_CONTEXT_DOC },
    example: { agentId: '#849980', txContext: { amountUsd: 25 } },
  },
  'POST /tools/counterparty_check': {
    description: 'Deal-specific verdict between two agents: counterparty risk + same-operator self-deal detection.',
    input: { from: `the paying agent: ${AGENT_ID_DOC}`, to: `the counterparty: ${AGENT_ID_DOC}`, txContext: TX_CONTEXT_DOC },
    example: { from: '#6271', to: '#849980', txContext: { amountUsd: 25 } },
  },
  'POST /tools/agent_passport': {
    description: 'The full trust passport: identity + KYA + reputation + risk in one call.',
    input: { agentId: AGENT_ID_DOC },
    example: { agentId: '#849980' },
  },
  'POST /tools/guardrail_check': {
    description:
      'Does this agent operate under an enforced spend/trade policy, and does it respect the verdicts? Returns bands only: no caps, allowlists, symbols, amounts or holdings are ever disclosed.',
    input: { agentId: AGENT_ID_DOC },
    example: { agentId: '#849980' },
  },
}

export type PaymentStatus = {
  enabled: boolean
  mode: 'paid' | 'free'
  network: string
  payTo: string | null
  prices: Record<string, string>
  reason: string
}

/**
 * Register the OKX x402 middleware on `app` (must be called BEFORE the /tools routes so
 * unpaid calls are stopped first). Returns the resulting mode; never throws.
 */
export async function applyOkxX402(app: Express): Promise<PaymentStatus> {
  const payTo = process.env.PAY_TO_ADDRESS ?? null
  const apiKey = process.env.OKX_API_KEY
  const secretKey = process.env.OKX_SECRET_KEY
  const passphrase = process.env.OKX_PASSPHRASE

  const base = { network: NETWORK, payTo, prices: PRICES }

  if (!payTo || !apiKey || !secretKey || !passphrase) {
    return {
      ...base,
      enabled: false,
      mode: 'free',
      reason: 'Free mode: set PAY_TO_ADDRESS + OKX_API_KEY + OKX_SECRET_KEY + OKX_PASSPHRASE to charge per call.',
    }
  }

  try {
    // Un-typed dynamic imports: keep the SDK out of the tsc type graph and make it a truly
    // optional runtime dependency. Specifiers are cast to string to defeat static resolution.
    const core: any = await import('@okxweb3/x402-core' as string)
    const coreServer: any = await import('@okxweb3/x402-core/server' as string)
    const evmServer: any = await import('@okxweb3/x402-evm/exact/server' as string)
    const expressX402: any = await import('@okxweb3/x402-express' as string)

    const facilitatorClient = new core.OKXFacilitatorClient({ apiKey, secretKey, passphrase, syncSettle: true })
    const resourceServer = new coreServer.x402ResourceServer(facilitatorClient).register(NETWORK, new evmServer.ExactEvmScheme())

    const routes: Record<string, unknown> = {}
    for (const [route, price] of Object.entries(PRICES)) {
      const contract = CONTRACTS[route]
      const path = route.replace('POST ', '')
      const tool = path.replace('/tools/', '')
      const required = contract ? Object.keys(contract.input).filter((k) => !contract.input[k].startsWith('optional')) : []
      // Key WITHOUT the verb so the SDK compiles it as any-method ("*"): the OKX buyer
      // CLI probes with GET by default, and a POST-only key would let that probe fall
      // through to a 404 ("endpoint_unreachable") instead of the 402 challenge. The
      // gateway serves both GET (query params) and POST (JSON body) for every paid tool.
      routes[path] = {
        accepts: { scheme: 'exact', network: NETWORK, payTo, price },
        // Fills the 402 challenge's resource.description (was empty before).
        description: contract?.description,
        // Best-effort Bazaar-style schema for buyers that read extensions.
        extensions: contract
          ? {
              outputSchema: {
                input: {
                  type: 'http',
                  method: 'POST',
                  bodyType: 'json',
                  body: {
                    type: 'object',
                    properties: Object.fromEntries(Object.entries(contract.input).map(([k, v]) => [k, { description: v }])),
                    required,
                  },
                },
              },
            }
          : undefined,
        // The 402 body carries the exact calling contract in the fields buyer agents
        // actually scan for (required / inputSchema), so a correct paid replay can be
        // assembled without guessing from the listing prose.
        unpaidResponseBody: contract
          ? () => ({
              contentType: 'application/json',
              body: {
                error: 'Payment required',
                message: `Payment required. ${contract.description} Call with POST (JSON body) or GET (query params).`,
                tool,
                method: 'POST',
                contentTypeExpected: 'application/json',
                required,
                inputSchema: {
                  type: 'object',
                  properties: Object.fromEntries(Object.entries(contract.input).map(([k, v]) => [k, { description: v }])),
                  required,
                },
                example: contract.example,
                freeTier: 'POST /tools/trust_preview (no payment, rate-limited): coarse band + flags',
                methodology: 'https://a-identity-asp.onrender.com/methodology',
                proof: 'https://a-identity-asp.onrender.com/proof',
              },
            })
          : undefined,
      }
    }
    const httpServer = new coreServer.x402HTTPResourceServer(resourceServer, routes)

    // Wraps res.send BEFORE the payment middleware installs, so that when the SDK sends a
    // 402 our wrapper is already in the chain and can fold the header's challenge into the
    // body. Only 402s are touched; every other response passes through untouched.
    app.use((_req, res, next) => {
      const send = res.send.bind(res)
      res.send = (payload: unknown) => {
        if (res.statusCode === 402 && typeof payload === 'string') {
          try {
            const merged = withSpecChallenge(payload, res.getHeader('PAYMENT-REQUIRED'))
            if (merged !== payload) {
              // The body grew, so the length header the SDK may have set is now wrong.
              res.removeHeader('Content-Length')
              return send(merged)
            }
          } catch {
            // Never let challenge decoration break a payment challenge.
          }
        }
        return send(payload)
      }
      next()
    })

    app.use(expressX402.paymentMiddlewareFromHTTPServer(httpServer))
    await resourceServer.initialize()

    return { ...base, enabled: true, mode: 'paid', reason: 'OKX x402 active on X Layer.' }
  } catch (e) {
    // Log the detail server-side; keep the public reason (shown in /health) generic so a
    // startup error string can never leak internals/creds through the service card.
    console.error('[asp] OKX x402 init failed:', e)
    return {
      ...base,
      enabled: false,
      mode: 'free',
      reason: 'Free mode: OKX x402 layer unavailable.',
    }
  }
}
