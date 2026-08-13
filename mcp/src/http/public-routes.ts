/**
 * Public route group (split from http.ts): well-known OAuth metadata, /health, agent
 * resolve, reputation, chains, Arc/Circle status, x402 paid-data rails. Handlers
 * return true when the request was handled; order within this file mirrors the
 * original http.ts order.
 */
import { CHAIN_CONFIG } from '../data.js'
import { SURFACES } from '../policy/index.js'
import { publicCallers } from '../callers/registry.js'
import { buildStamp } from '../build-stamp.js'
import { createIdentityProvider } from '../erc8004.js'
import { getArcStatus } from '../arc.js'
import { getCircleStatus } from '../circle.js'
import { oauthEnabled, protectedResourceMetadata } from '../oauth.js'
import { agentReputation, listPlatformAgents } from '../platform.js'
import { merchantCheck } from '../commerce.js'
import {
  x402PayTo, paymentRequirements, verifyPayment, premiumResource,
  issueX402Nonce, x402NonceValid, consumeX402Nonce, verifyPayerBinding,
} from '../x402.js'
import { nanoPaymentRequirements, settleNano, nanoResource } from '../nanopay.js'
import { sendJson, type RouteCtx } from './shared.js'

export async function handlePublicRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx

  // ── OAuth Protected Resource Metadata (RFC 9728) ──────────────────────────────
  // The first document an MCP client reads when adding this server: it names the
  // resource and the authorization server that can mint tokens for it. Served from
  // both paths because clients differ on whether the resource path is appended.
  if (
    req.method === 'GET' &&
    (url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp')
  ) {
    if (!oauthEnabled()) {
      // Better a plain 404 than an empty metadata document: a client can act on
      // "this resource does not do OAuth", but not on a document with no issuer.
      sendJson(res, 404, { error: 'OAuth is not configured on this deployment' })
      return true
    }
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    sendJson(res, 200, protectedResourceMetadata())
    return true
  }

  // ── /health ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      server: 'a-identity-mcp',
      version: '0.2.0',
      transport: 'streamable-http',
      // Which build is actually answering. `version` comes from package.json and almost
      // never moves, so it cannot tell a fresh deploy from a stale one. This can: after a
      // push, poll /health until `commit` matches the SHA you pushed and you have proof
      // the new code is serving, rather than assuming the host redeployed.
      ...buildStamp(),
      chains: CHAIN_CONFIG.map((c) => ({ id: c.id, status: c.status })),
    })
    return true
  }

  // ── REST /api/agent — LIVE on-chain ERC-8004 resolve (Arc), no mocks ──────────
  if (req.method === 'GET' && url.pathname === '/api/agent') {
    const q = url.searchParams.get('q') ?? ''
    if (!q) { sendJson(res, 400, { error: 'Missing ?q= parameter' }); return true }
    const provider = createIdentityProvider()
    const agent = await provider.resolve(q)
    if (!agent) { sendJson(res, 404, { found: false, query: q, reason: 'No matching ERC-8004 registration on-chain' }); return true }
    sendJson(res, 200, { found: true, source: provider.kind, agent })
    return true
  }

  // ── REST /api/reputation — real, from platform settlements + on-chain identity ──
  if (req.method === 'GET' && url.pathname === '/api/reputation') {
    const id = url.searchParams.get('id') ?? ''
    if (!id) { sendJson(res, 400, { error: 'Missing ?id= parameter' }); return true }
    let rep = agentReputation(id)
    // Accept an on-chain id too (e.g. "eip155:5042002:8004/849980" or a bare token id):
    // map it to the platform agent anchored at that ERC-8004 token, then score it for real.
    if ('error' in rep) {
      const tokenId = id.match(/(\d+)\s*$/)?.[1]
      const anchored = tokenId ? listPlatformAgents().find((a) => a.onchainAgentId === tokenId) : undefined
      if (anchored) rep = agentReputation(anchored.id)
    }
    if ('error' in rep) { sendJson(res, 404, { found: false, agentId: id, reason: 'Unknown agent or no activity yet' }); return true }
    sendJson(res, 200, { found: true, reputation: rep })
    return true
  }

  // ── REST /api/commerce/merchant-check — verify a merchant agent pre-checkout ──
  // The trust step ACP/UCP checkout flows skip: agent-card discovery + live ERC-8004
  // resolve + the platform's KYA/reputation/Sybil view, composed into ALLOW/WARN/DENY
  // with every reason. Free, read-only, no state; invalid input is a clean 400.
  if (req.method === 'GET' && url.pathname === '/api/commerce/merchant-check') {
    const merchantUrl = url.searchParams.get('url') ?? undefined
    const merchantAgentId = url.searchParams.get('agentId') ?? undefined
    const result = await merchantCheck({ url: merchantUrl, agentId: merchantAgentId })
    if ('error' in result) { sendJson(res, 400, result); return true }
    sendJson(res, 200, result)
    return true
  }

  // ── REST /api/chains ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/chains') {
    sendJson(res, 200, { chains: CHAIN_CONFIG })
    return true
  }

  // ── REST /api/surfaces + /api/callers ─────────────────────────────────────────
  //
  // Static registry data, so they are plain GETs and sit outside the mutation gate. They
  // live here rather than behind the owner gate because neither says anything about an
  // agent: one is the list of action surfaces and their honest lifecycle status, the other
  // is which callers we can translate and how strong each one's enforcement actually is.
  //
  // The console derives its tabs from /api/surfaces so a `planned` surface renders as
  // deliberately-not-live instead of quietly disappearing, which is the drift that made
  // `bet` invisible even though its schema shipped.
  if (req.method === 'GET' && url.pathname === '/api/surfaces') {
    res.setHeader('Cache-Control', 'public, max-age=300')
    sendJson(res, 200, {
      surfaces: SURFACES.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        policyBlock: s.policyBlock,
        kinds: s.kinds,
        note: s.note,
      })),
    })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/callers') {
    res.setHeader('Cache-Control', 'public, max-age=300')
    sendJson(res, 200, {
      callers: publicCallers(),
      // Stated rather than implied: the original call shape still works and carries no
      // venue, so a reader does not conclude a callerId is now mandatory.
      direct:
        'A pre-normalized { intent, snapshot } is still accepted and needs no callerId. Its audit row records enforcement "none", because nothing we can name stood between the agent and the venue.',
      enforcement: {
        process: 'The caller starts the venue process and gates its writes, so a DENY is a real veto.',
        wrapper: 'The caller can only decline to make the call it was asked to make. An agent with another route to the same account is not contained.',
        none: 'Nothing we know of stands between the agent and the venue: the verdict is advice plus a record.',
      },
    })
    return true
  }

  // ── REST /api/arc (live Circle Arc testnet status) ────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/arc') {
    const status = await getArcStatus()
    sendJson(res, status.online ? 200 : 503, status)
    return true
  }

  // ── REST /api/circle (Circle developer platform link state) ──────────────────
  if (req.method === 'GET' && url.pathname === '/api/circle') {
    sendJson(res, 200, await getCircleStatus())
    return true
  }

  // ── x402: pay-per-request paid resource (real on-chain USDC settlement) ───────
  if (req.method === 'GET' && url.pathname === '/api/x402/data') {
    const payTo = await x402PayTo()
    if (!payTo) { sendJson(res, 501, { error: 'x402 not configured (no payTo / signer key)' }); return true }
    const proof = req.headers['x-payment']
    if (typeof proof !== 'string' || !proof) {
      // No payment yet -> 402 with machine-readable requirements + a fresh single-use
      // nonce. The client echoes this nonce in X-Payment-Nonce when it redeems.
      sendJson(res, 402, paymentRequirements(payTo, issueX402Nonce()))
      return true
    }
    // Redeem: the payment must answer THIS challenge — a live nonce we issued, bound to
    // this resource. Without it, an unrelated USDC transfer can't blind-unlock the data.
    const nonce = typeof req.headers['x-payment-nonce'] === 'string' ? req.headers['x-payment-nonce'] : undefined
    if (!x402NonceValid(nonce)) {
      sendJson(res, 402, { ...paymentRequirements(payTo, issueX402Nonce()), verifyError: 'missing or stale payment nonce; re-quote to get a fresh one' })
      return true
    }
    // Bind the redemption to the actual PAYER. The client proves control of the paying
    // wallet by signing the (nonce, payer) challenge; we then require the on-chain payment
    // to originate from that same wallet. This is what stops a front-runner who scraped the
    // tx hash off the public chain (or any unrelated transfer to payTo) from redeeming a
    // payment they did not make.
    const payer = typeof req.headers['x-payment-payer'] === 'string' ? req.headers['x-payment-payer'] : undefined
    const paySig = typeof req.headers['x-payment-sig'] === 'string' ? req.headers['x-payment-sig'] : undefined
    if (!payer || !/^0x[0-9a-fA-F]{40}$/.test(payer) || !paySig) {
      // Keep the same nonce live so the client can sign and retry without re-quoting.
      sendJson(res, 402, { ...paymentRequirements(payTo, nonce), verifyError: 'payer proof required: sign the x402 authorization with the paying wallet (X-Payment-Payer + X-Payment-Sig)' })
      return true
    }
    if (!(await verifyPayerBinding(nonce!, payer, paySig))) {
      sendJson(res, 402, { ...paymentRequirements(payTo, nonce), verifyError: 'payer signature does not match the paying wallet' })
      return true
    }
    const verified = await verifyPayment(proof, payTo, payer)
    if (!verified.ok) {
      // Keep the same nonce live (echo it back) so the client can retry while the
      // payment is still confirming; only a real failure/expiry forces a re-quote.
      sendJson(res, 402, { ...paymentRequirements(payTo, nonce), verifyError: verified.reason })
      return true
    }
    consumeX402Nonce(nonce!) // one challenge unlocks the resource exactly once
    sendJson(res, 200, await premiumResource(proof))
    return true
  }

  // ── x402 Nanopayments seller: gasless, Gateway-batched USDC (x402 v2) ─────────
  // Second x402 rail. No PAYMENT-SIGNATURE → 402 v2 with the GatewayWalletBatched
  // requirements; with one → settle through Circle Gateway and serve immediately.
  if (req.method === 'GET' && url.pathname === '/api/x402/nano/data') {
    const requirements = await nanoPaymentRequirements()
    if (!requirements) { sendJson(res, 501, { error: 'nanopayments not configured (no payTo / Gateway rail)' }); return true }
    const proof = req.headers['payment-signature']
    if (typeof proof !== 'string' || !proof) {
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(requirements)).toString('base64'))
      sendJson(res, 402, requirements)
      return true
    }
    const settled = await settleNano(proof)
    if (!settled.ok) { sendJson(res, 402, { ...requirements, settleError: settled.reason }); return true }
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(settled.settle)).toString('base64'))
    sendJson(res, 200, nanoResource(settled.settle))
    return true
  }

  return false
}
