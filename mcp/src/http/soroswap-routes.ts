/**
 * Soroswap: one public read, and nothing else.
 *
 * Thin adapter only. Every decision (which router, what a valid pair is, what a quote is
 * allowed to claim, which caveats ride along) lives in ../soroswap.ts, unit-tested with a
 * stubbed simulator. This file reads a query string, calls that, and picks a status code.
 *
 * Public and unauthenticated on purpose, and safe to be: the handler signs nothing, spends
 * nothing and holds no key. A quote is a Soroban SIMULATION against a third party's router,
 * which costs no fee and changes no state, so there is no credential here to protect and
 * no budget here to drain. It is also GET-only, which keeps it outside the verified-session
 * gate in http.ts without needing an exemption written there.
 *
 * What it is NOT is a swap. A-Identity does not swap. The vault has no swap entrypoint and
 * would need a new wasm to grow one, so the honest surface today is the price and the named
 * absence of the execution, which is what `kind: "quote"` in every answer says.
 */
import { CHAINS } from '../chains/index.js'
import type { ChainDescriptor } from '../chains/types.js'
import { soroswapQuote, soroswapRouter } from '../soroswap.js'
import { sendJson, type RouteCtx } from './shared.js'

/** Every chain the registry gives a Soroswap router. Today that is testnet, only. */
function soroswapChains(): ChainDescriptor[] {
  return CHAINS.filter((c) => c.ecosystem === 'stellar' && Boolean(soroswapRouter(c)))
}

/** The chain a request names, by registry id or CAIP-2, defaulting to the only one we serve. */
function pickChain(want: string | null): ChainDescriptor | null {
  const chains = soroswapChains()
  if (!want) return chains[0] ?? null
  return chains.find((c) => c.id === want || c.caip2 === want) ?? null
}

export async function handleSoroswapRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx

  // ── GET /api/stellar/soroswap/quote - what a swap WOULD return, right now ──────
  if (req.method === 'GET' && url.pathname === '/api/stellar/soroswap/quote') {
    const chain = pickChain(url.searchParams.get('chain'))
    if (!chain) {
      // 501 rather than 404: the route exists and the capability is simply not configured
      // on any chain here, which is the same fail-closed shape the other rails use.
      sendJson(res, 501, {
        available: false,
        reason: 'no chain in the registry records a Soroswap router',
        served: soroswapChains().map((c) => c.caip2),
      })
      return true
    }
    // Defaults make the bare URL answer the question the product actually has: an agent
    // holding XLM owes a USDC invoice, so what does the conversion cost? Both ends still
    // come out of the registry rather than being written here, because a token address in
    // this file is exactly what chains/no-hardcoded-chains.test.ts exists to refuse.
    const usdc = (chain.settlementTokens ?? [])[0]?.address ?? ''
    const xlm = chain.contracts?.nativeSac ?? ''
    const sellAsset = url.searchParams.get('sell') ?? xlm
    const buyAsset = url.searchParams.get('buy') ?? usdc
    // One XLM, in stroops. A default has to be some number and this is the one a reader can
    // check against any price screen.
    const sellAmount = url.searchParams.get('sellAmount') ?? '10000000'

    const quote = await soroswapQuote({ chain, sellAsset, buyAsset, sellAmount })
    // 200 either way. An unavailable quote is an answer about the pool, not an error of
    // ours, and a 4xx would make a caller retry something that is not going to change.
    sendJson(res, 200, {
      ...quote,
      integration: {
        partner: 'Soroswap',
        role: 'price discovery for an agent holding the wrong asset',
        howRead: 'router_get_amounts_out, simulated. No API key, no hosted endpoint, nothing signed.',
        executes: false,
        whyNot:
          'AgentSpendPolicy has no swap entrypoint and no upgrade path, so executing a swap under the policy would mean a new wasm and a new vault. Quoting is what exists today, and it is labeled as a quote rather than dressed as a route.',
      },
    })
    return true
  }

  return false
}
