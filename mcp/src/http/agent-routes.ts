/**
 * Agent route group (split from http.ts): agent listing/creation, wallets, anchor,
 * vault, session key, Circle wallet, treasury, KYA, reputation, payment policy.
 * Handlers return true when the request was handled; order within this file mirrors
 * the original http.ts order.
 */
import {
  recordWallet, assignWallet, getWalletBalance, createAgent, listPlatformAgents,
  anchorAgentOnchain, provisionAgentVault, grantAgentSessionKey, getAgentVault,
  provisionCircleWallet, getAgentCircleWallet, getAgentTreasury, startAgentAutoYield,
  stopAgentAutoYield, startKyaChallenge, verifyKya, revokeAgentKya, getAgentKya,
  agentReputation, agentPolicy,
} from '../platform.js'
import { cappedDemoUsd, denyRead, errStatus, publicAgents, readBody, sendJson, type RouteCtx } from './shared.js'

export async function handleAgentRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url, callerId } = ctx

  // ── REST /api/agents — real agents this platform knows (no mocks) ─────────────
  if (req.method === 'GET' && url.pathname === '/api/agents') {
    const agents = publicAgents()
    sendJson(res, 200, { total: agents.length, source: 'platform', agents })
    return true
  }

  // ── Platform: wallets ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/wallets') {
    const body = (await readBody(req).catch(() => null)) as { address?: string } | null
    // No-custody by construction: the client generates the keypair in the browser and only
    // ever sends the public address. The server never generates or returns a private key
    // (the old server-side fallback returned a raw key over HTTP — removed).
    if (!body?.address || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
      sendJson(res, 400, { error: 'a client-generated wallet address (0x…) is required; the server never creates or holds private keys' })
      return true
    }
    sendJson(res, 201, recordWallet(body.address))
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/wallets/assign') {
    const body = (await readBody(req).catch(() => null)) as { address?: string; agentId?: string } | null
    if (!body?.address || !body?.agentId) { sendJson(res, 400, { error: 'address and agentId required' }); return true }
    const w = assignWallet(body.address, body.agentId, callerId)
    if ('error' in w) { sendJson(res, errStatus(w.error), w); return true }
    sendJson(res, 200, w)
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/wallet-balance') {
    const address = url.searchParams.get('address') ?? ''
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { sendJson(res, 400, { error: 'valid ?address= required' }); return true }
    sendJson(res, 200, await getWalletBalance(address))
    return true
  }

  // ── Platform: agents ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/agents') {
    const body = (await readBody(req).catch(() => null)) as {
      name?: string; description?: string; category?: string
      capabilities?: string[]; permissions?: Record<string, unknown>; walletAddress?: string
      logoUrl?: string; cardStyle?: unknown
    } | null
    if (!body?.name) { sendJson(res, 400, { error: 'name required' }); return true }
    const agent = createAgent({
      name: body.name,
      description: body.description ?? '',
      category: body.category ?? 'Other',
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
      permissions: (body.permissions ?? {}) as never,
      walletAddress: body.walletAddress,
      logoUrl: body.logoUrl,
      // Sanitized in createAgent: a whole 1..6 sticks, anything else means unset.
      cardStyle: body.cardStyle,
      owner: callerId,
    })
    sendJson(res, 201, { agent })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/platform-agents') {
    // Scoped to the caller: the app lists/manages only the agents you own. No session,
    // or a guest with none, gets an empty list (public discovery is /api/marketplace).
    const owned = callerId ? listPlatformAgents().filter((a) => a.owner === callerId) : []
    sendJson(res, 200, { agents: owned })
    return true
  }
  // Anchor an existing platform agent on-chain (real ERC-8004 register, env-gated)
  if (req.method === 'POST' && url.pathname === '/api/agents/anchor') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    const r = await anchorAgentOnchain(body.agentId, callerId)
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return true }
    sendJson(res, 200, r)
    return true
  }
  // Provision an on-chain policy vault for an agent (deploy + optional funding, env-gated)
  if (req.method === 'POST' && url.pathname === '/api/agents/vault') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; fundUsd?: number; ownerAddress?: string } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    // fundUsd is deposited from the shared server signer — cap it like the other demo spends.
    const r = await provisionAgentVault(body.agentId, { fundUsd: cappedDemoUsd(body.fundUsd), caller: callerId, ownerAddress: body.ownerAddress })
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return true }
    sendJson(res, 200, r)
    return true
  }
  // Grant / extend / revoke the agent's on-chain SESSION KEY (a time-bounded spend
  // authority on the vault). Owner-only; env-gated. Body: { agentId, durationHours | revoke }.
  if (req.method === 'POST' && url.pathname === '/api/agents/session-key') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; durationHours?: number; expiryUnix?: number; revoke?: boolean } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    // Bound the duration so a caller can't set a nonsensical far-future expiry (max ~30 days).
    const durationHours = typeof body.durationHours === 'number' && Number.isFinite(body.durationHours)
      ? Math.min(Math.max(body.durationHours, 0), 24 * 30)
      : undefined
    const r = await grantAgentSessionKey(body.agentId, { durationHours, expiryUnix: body.expiryUnix, revoke: body.revoke === true }, callerId)
    if (r.reason && !r.granted && !r.ownerGated && (r.reason.startsWith('Forbidden') || r.reason.startsWith('Unknown'))) {
      sendJson(res, errStatus(r.reason), r); return true
    }
    sendJson(res, 200, r)
    return true
  }
  // Read an agent's live on-chain vault policy + balance
  if (req.method === 'GET' && url.pathname === '/api/agents/vault') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    if (denyRead(res, agentId, callerId)) return true
    const r = await getAgentVault(agentId)
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return true }
    sendJson(res, 200, r)
    return true
  }
  // Provision a Circle Agent Wallet for an agent (hosted policy layer, credential-gated)
  if (req.method === 'POST' && url.pathname === '/api/agents/circle-wallet') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; fund?: boolean } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    const r = await provisionCircleWallet(body.agentId, { fund: body.fund, caller: callerId })
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return true }
    sendJson(res, 200, r)
    return true
  }
  // Read an agent's live Circle Agent Wallet state + balances
  if (req.method === 'GET' && url.pathname === '/api/agents/circle-wallet') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    if (denyRead(res, agentId, callerId)) return true
    const r = await getAgentCircleWallet(agentId)
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return true }
    sendJson(res, 200, r)
    return true
  }
  // ── Treasury: idle-balance auto-yield into USYC (Circle's yield-bearing token) ──
  // Live multi-asset balances + deployable idle + projected USYC earnings (read-only)
  if (req.method === 'GET' && url.pathname === '/api/agents/treasury') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    if (denyRead(res, agentId, callerId)) return true
    const capParam = url.searchParams.get('cap')
    const cap = capParam !== null && Number.isFinite(Number(capParam)) ? Number(capParam) : undefined
    const r = await getAgentTreasury(agentId, cap)
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return true }
    sendJson(res, 200, r)
    return true
  }
  // Owner authorizes (or turns off) auto-yield at a working-capital cap
  if (req.method === 'POST' && url.pathname === '/api/agents/treasury') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; capUsd?: number; enabled?: boolean } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    const r =
      body.enabled === false
        ? stopAgentAutoYield(body.agentId, callerId)
        : await startAgentAutoYield(body.agentId, typeof body.capUsd === 'number' ? body.capUsd : 25, callerId)
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return true }
    sendJson(res, 200, r)
    return true
  }
  // ── KYA (Know Your Agent): prove the agent controls its wallet ─────────────────
  // Start a challenge for the agent to sign (owner-only)
  if (req.method === 'POST' && url.pathname === '/api/agents/kya/challenge') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    const r = startKyaChallenge(body.agentId, callerId)
    if ('error' in r) { sendJson(res, errStatus(r.error), r); return true }
    sendJson(res, 200, r)
    return true
  }
  // Finish KYA: verify the wallet signature, mark verified, attest on-chain (best-effort)
  if (req.method === 'POST' && url.pathname === '/api/agents/kya/verify') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; message?: string; signature?: string } | null
    if (!body?.agentId || !body?.message || !body?.signature) {
      sendJson(res, 400, { error: 'agentId, message, signature required' }); return true
    }
    const r = await verifyKya(body.agentId, body.message, body.signature, callerId)
    if ('error' in r) { sendJson(res, errStatus(r.error), r); return true }
    sendJson(res, 200, r)
    return true
  }
  // Revoke KYA: flag the agent as an incident (owner-only). risk_check then DENYs it; the
  // agent is no longer hireable. Best-effort negative on-chain attestation (tag "revoked").
  if (req.method === 'POST' && url.pathname === '/api/agents/kya/revoke') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; reason?: string } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    const r = await revokeAgentKya(body.agentId, body.reason ?? '', callerId)
    if ('error' in r) { sendJson(res, errStatus(r.error), r); return true }
    sendJson(res, 200, r)
    return true
  }
  // Read an agent's KYA status + live on-chain validation
  if (req.method === 'GET' && url.pathname === '/api/agents/kya') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    const r = await getAgentKya(agentId)
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return true }
    sendJson(res, 200, r)
    return true
  }
  // Reputation for one agent, computed from real activity
  if (req.method === 'GET' && url.pathname === '/api/agents/reputation') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    const r = agentReputation(agentId)
    sendJson(res, 'error' in r ? 404 : 200, r)
    return true
  }
  // Live policy for one agent (limits + today's spend + reset time)
  if (req.method === 'GET' && url.pathname === '/api/agents/policy') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return true }
    if (denyRead(res, agentId, callerId)) return true
    const p = agentPolicy(agentId)
    sendJson(res, 'error' in p ? 404 : 200, p)
    return true
  }

  return false
}
