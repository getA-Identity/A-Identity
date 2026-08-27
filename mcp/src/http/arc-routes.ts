/**
 * Arc route group (split from http.ts): the /api/arc/* on-chain demos and reads
 * (ERC-8004 register, ERC-8183 jobs, Gateway, nanopay, AppKit, CCTP, agent-run,
 * batching, session keys, trust oracle). Handlers return true when the request was
 * handled; order within this file mirrors the original http.ts order.
 */
import { readArcContracts, registerAgentOnchain, createJobOnchain, runEscrowJobDemo, readMemosOnchain, rejectJobOnchain, claimJobRefundOnchain, readJobOnchain, payUsdcBatchOnchain } from '../arc-contracts.js'
import { runGatewayDemo, gatewayBalance } from '../gateway.js'
import { runNanopayDemo } from '../nanopay.js'
import { runCctpDemo } from '../cctp.js'
import { appKitCapabilities, quoteArcSwap, runArcSwapDemo } from '../appkit.js'
import { paymasterStatus } from '../paymaster.js'
import { runAgentRun } from '../autopilot.js'
import { runTrustOracleDogfood } from '../trust-oracle.js'
import { runSessionKeyDemo } from '../aa-wallet.js'
import { MAX_DEMO_USD, cappedDemoUsd, readBody, sendJson, type RouteCtx } from './shared.js'

/** Parse a caller-supplied ERC-8183 jobId (string or number) into a non-negative bigint,
 *  or null if it isn't a valid non-negative integer. Bounds the value so a malformed id
 *  can't reach the chain layer. */
function jobIdFromInput(v: unknown): bigint | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? BigInt(v) : null
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim())
  return null
}

export async function handleArcRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx

  // ── REST /api/arc/contracts (LIVE reads of real ERC-8004 + ERC-8183) ─────────
  if (req.method === 'GET' && url.pathname === '/api/arc/contracts') {
    const data = await readArcContracts()
    sendJson(res, data.reachable ? 200 : 503, data)
    return true
  }

  // ── REST /api/arc/memos: the on-chain "why" audit trail (Arc Memo precompile) ──
  // Public read of the Memo event log, filtered by the indexed memoId and/or sender,
  // block-bounded (DoS guard: maxBlocks is clamped in the adapter). Proves that an
  // agent settlement's reason is provably on-chain and indexable, not a server log.
  if (req.method === 'GET' && url.pathname === '/api/arc/memos') {
    const memoId = url.searchParams.get('memoId') ?? undefined
    const sender = url.searchParams.get('sender') ?? undefined
    if (memoId && !/^0x[0-9a-fA-F]{64}$/.test(memoId)) { sendJson(res, 400, { error: 'memoId must be a 32-byte 0x hash' }); return true }
    if (sender && !/^0x[0-9a-fA-F]{40}$/.test(sender)) { sendJson(res, 400, { error: 'sender must be a 0x address' }); return true }
    const maxParam = Number(url.searchParams.get('maxBlocks'))
    const maxBlocks = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : undefined
    try {
      const data = await readMemosOnchain({ memoId, sender, maxBlocks })
      sendJson(res, 200, data)
    } catch (err) {
      sendJson(res, 502, { supported: true, memos: [], error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // ── Real on-chain agent registration (ERC-8004). Env-gated; prepared w/o key ──
  if (req.method === 'POST' && url.pathname === '/api/arc/register-onchain') {
    const body = (await readBody(req).catch(() => null)) as { metadataUri?: string } | null
    const uri = body?.metadataUri ?? 'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei'
    sendJson(res, 200, await registerAgentOnchain(uri))
    return true
  }

  // ── Real ERC-8183 job (escrow). Env-gated; prepared w/o key ──────────────────
  if (req.method === 'POST' && url.pathname === '/api/arc/create-job') {
    const body = (await readBody(req).catch(() => null)) as
      | { provider?: string; evaluator?: string; description?: string }
      | null
    if (!body?.provider || !body?.evaluator) { sendJson(res, 400, { error: 'provider and evaluator required' }); return true }
    sendJson(res, 200, await createJobOnchain({
      provider: body.provider,
      evaluator: body.evaluator,
      description: body.description ?? 'A-Identity agentic-commerce job',
    }))
    return true
  }

  // ── One-click ERC-8183 lifecycle demo: complete (release) OR refund (dispute) ──
  if (req.method === 'POST' && url.pathname === '/api/arc/job-demo') {
    const body = (await readBody(req).catch(() => null)) as { budgetUsd?: number; description?: string; outcome?: string } | null
    const outcome = body?.outcome === 'refund' ? 'refund' : 'complete'
    sendJson(res, 200, await runEscrowJobDemo({ budgetUsd: body?.budgetUsd, description: body?.description, outcome }))
    return true
  }

  // ── Dispute a job: the evaluator rejects the deliverable -> client refunded on-chain ─
  if (req.method === 'POST' && url.pathname === '/api/arc/job/dispute') {
    const body = (await readBody(req).catch(() => null)) as { jobId?: string | number; reason?: string } | null
    const jobId = jobIdFromInput(body?.jobId)
    if (jobId === null) { sendJson(res, 400, { error: 'jobId (non-negative integer) required' }); return true }
    sendJson(res, 200, await rejectJobOnchain(jobId, typeof body?.reason === 'string' ? body.reason.slice(0, 200) : 'disputed'))
    return true
  }

  // ── Reclaim escrow for the client after a job's deadline (expiry refund) ──────
  if (req.method === 'POST' && url.pathname === '/api/arc/job/claim-refund') {
    const body = (await readBody(req).catch(() => null)) as { jobId?: string | number } | null
    const jobId = jobIdFromInput(body?.jobId)
    if (jobId === null) { sendJson(res, 400, { error: 'jobId (non-negative integer) required' }); return true }
    sendJson(res, 200, await claimJobRefundOnchain(jobId))
    return true
  }

  // ── Live on-chain job state (status, parties, budget) - public read ──────────
  if (req.method === 'GET' && url.pathname === '/api/arc/job') {
    const jobId = jobIdFromInput(url.searchParams.get('jobId'))
    if (jobId === null) { sendJson(res, 400, { error: 'jobId (non-negative integer) required' }); return true }
    sendJson(res, 200, await readJobOnchain(jobId))
    return true
  }

  // ── Circle Gateway: live unified USDC balance (public read) ───────────────────
  if (req.method === 'GET' && url.pathname === '/api/arc/gateway-balance') {
    const address = url.searchParams.get('address') ?? ''
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { sendJson(res, 400, { error: 'valid ?address= required' }); return true }
    sendJson(res, 200, await gatewayBalance(address))
    return true
  }

  // ── Circle Gateway: one-click deposit + gasless cross-chain transfer (Arc->Base) ──
  if (req.method === 'POST' && url.pathname === '/api/arc/gateway-demo') {
    const body = (await readBody(req).catch(() => null)) as { amountUsd?: number } | null
    sendJson(res, 200, await runGatewayDemo({ amountUsd: cappedDemoUsd(body?.amountUsd) }))
    return true
  }

  // ── Circle Nanopayments: one-click gasless, Gateway-batched USDC nanopayment ──
  if (req.method === 'POST' && url.pathname === '/api/arc/nanopay-demo') {
    const body = (await readBody(req).catch(() => null)) as { amountUsd?: number } | null
    sendJson(res, 200, await runNanopayDemo({ amountUsd: cappedDemoUsd(body?.amountUsd) }))
    return true
  }

  // ── Who pays the agent's gas: probed per chain, not asserted from a doc ──────────
  if (req.method === 'GET' && url.pathname === '/api/arc/gas') {
    const q = Number(url.searchParams.get('chainId'))
    sendJson(res, 200, await paymasterStatus(Number.isFinite(q) && q > 0 ? q : undefined))
    return true
  }

  // ── Circle App Kit on Arc ──────────────────────────────────────────────────────
  //    Read-only: what App Kit can do on Arc, answered from the SDK's own chain table.
  if (req.method === 'GET' && url.pathname === '/api/arc/appkit') {
    sendJson(res, 200, await appKitCapabilities())
    return true
  }
  //    A real USDC->EURC rate from Circle's service. No key, no write.
  if (req.method === 'POST' && url.pathname === '/api/arc/appkit-quote') {
    const body = (await readBody(req).catch(() => null)) as { amountUsd?: number } | null
    sendJson(res, 200, await quoteArcSwap({ amountUsd: cappedDemoUsd(body?.amountUsd) }))
    return true
  }
  //    The write: swap USDC for EURC on Arc, the only testnet App Kit can swap on.
  if (req.method === 'POST' && url.pathname === '/api/arc/appkit-swap-demo') {
    const body = (await readBody(req).catch(() => null)) as { amountUsd?: number } | null
    sendJson(res, 200, await runArcSwapDemo({ amountUsd: cappedDemoUsd(body?.amountUsd) }))
    return true
  }

  // ── Circle CCTP: one-click native USDC bridge (burn-and-mint) Arc -> Base Sepolia ──
  if (req.method === 'POST' && url.pathname === '/api/arc/cctp-demo') {
    const body = (await readBody(req).catch(() => null)) as { amountUsd?: number } | null
    sendJson(res, 200, await runCctpDemo({ amountUsd: cappedDemoUsd(body?.amountUsd) }))
    return true
  }

  // ── Autonomous agent run: the agent pays a service on its own until it hits the
  //    human-set budget, then stops itself; a protocol fee is routed to the treasury.
  if (req.method === 'POST' && url.pathname === '/api/arc/agent-run') {
    const body = (await readBody(req).catch(() => null)) as { maxCalls?: number; amountUsd?: number; budgetUsd?: number } | null
    // Cap the client-chosen amounts: this run deposits/spends the shared server signer.
    sendJson(res, 200, await runAgentRun({
      maxCalls: body?.maxCalls,
      amountUsd: cappedDemoUsd(body?.amountUsd, 0.05),
      budgetUsd: cappedDemoUsd(body?.budgetUsd, MAX_DEMO_USD),
    }))
    return true
  }

  // ── Batched settlement (bonus E): settle N USDC transfers ATOMICALLY in one Arc tx via
  //    Multicall3From (EOA preserved). Demonstrates Arc-native batching / high-frequency
  //    agent payments. Env-gated; prepared without a key; demo amounts/count are capped.
  if (req.method === 'POST' && url.pathname === '/api/arc/batch-demo') {
    const body = (await readBody(req).catch(() => null)) as { count?: number; amountUsd?: number } | null
    const count = Number.isFinite(body?.count) ? Math.min(Math.max(Math.floor(body!.count!), 1), 5) : 3
    const amountUsd = cappedDemoUsd(body?.amountUsd, 0.05) ?? 0.01
    // Distinct demo payees, so the batch shows "one Arc tx, many recipients".
    const demoPayees = [
      '0x000000000000000000000000000000000000dEaD',
      '0x000000000000000000000000000000000000bEEF',
      '0x0000000000000000000000000000000000000A11',
      '0x0000000000000000000000000000000000000B22',
      '0x0000000000000000000000000000000000000C33',
    ]
    const payments = Array.from({ length: count }, (_, i) => ({ to: demoPayees[i % demoPayees.length], amountUsd }))
    sendJson(res, 200, await payUsdcBatchOnchain(payments))
    return true
  }

  // ── ERC-4337 session-key smart account (idea C2): deploy a Kernel SCA, grant a session
  //    key scoped to cap/allowlist/expiry, and settle a REAL UserOp within bounds while an
  //    out-of-bounds payment is rejected on-chain by the policy validator. Credential-gated
  //    on PIMLICO_API_KEY (prepared without it).
  if (req.method === 'POST' && url.pathname === '/api/arc/session-key-demo') {
    const body = (await readBody(req).catch(() => null)) as { capUsd?: number; expirySeconds?: number; sponsorGas?: boolean } | null
    const expirySeconds = typeof body?.expirySeconds === 'number' && Number.isFinite(body.expirySeconds)
      ? Math.min(Math.max(body.expirySeconds, 60), 86400) : undefined
    sendJson(res, 200, await runSessionKeyDemo({ capUsd: cappedDemoUsd(body?.capUsd, 1), expirySeconds, sponsorGas: body?.sponsorGas === true }))
    return true
  }

  // ── Trust Oracle dogfood: a buyer agent pays risk_check over x402 (Arc nanopayment)
  //    then acts on the ALLOW/WARN/DENY verdict. The consumer side of the same Trust
  //    Oracle we list on Circle's Agent Marketplace. Env-gated; prepared without a key.
  if (req.method === 'POST' && url.pathname === '/api/arc/trust-oracle-demo') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; txContext?: { amountUsd?: number; kind?: string } } | null
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required (platform id, ERC-8004 token id, or 0x owner address)' }); return true }
    if (agentId.length > 128) { sendJson(res, 400, { error: 'agentId too long (max 128 chars)' }); return true }
    const txContext = body?.txContext && typeof body.txContext === 'object'
      ? { amountUsd: cappedDemoUsd(body.txContext.amountUsd), kind: typeof body.txContext.kind === 'string' ? body.txContext.kind.slice(0, 40) : undefined }
      : null
    sendJson(res, 200, await runTrustOracleDogfood({ agentId, txContext }))
    return true
  }

  return false
}
