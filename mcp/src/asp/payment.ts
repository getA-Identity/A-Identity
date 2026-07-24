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
 * boot — it just falls back to free mode.
 *
 * NOTE: the OKX *seller* side requires OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE
 * (from web3.okx.com/onchainos/dev-portal). A recipient address alone is NOT enough —
 * settlement is brokered through OKX's facilitator via an HMAC-signed client.
 */
import type { Express } from 'express'

/** X Layer mainnet. Testnet is eip155:1952; 195 is deprecated — never use it. */
const NETWORK = process.env.OKX_X402_NETWORK ?? 'eip155:196'

/** Per-call USD prices; OKX auto-converts to the X Layer settlement token (USD₮0, 6 dp).
 *  Routes NOT listed here (e.g. the free-tier trust_preview) are never charged. */
export const PRICES: Record<string, string> = {
  'POST /tools/verify_agent': '$0.001',
  'POST /tools/reputation_score': '$0.002',
  'POST /tools/risk_check': '$0.005',
  'POST /tools/agent_passport': '$0.01',
  'POST /tools/counterparty_check': '$0.008',
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
      routes[route] = { accepts: { scheme: 'exact', network: NETWORK, payTo, price } }
    }
    const httpServer = new coreServer.x402HTTPResourceServer(resourceServer, routes)
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
