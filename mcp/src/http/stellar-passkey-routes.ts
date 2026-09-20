/**
 * The passkey vault demo: a smart-account owner, a fee-sponsoring relay, and the agent side.
 *
 * Thin adapters only. Every decision (which network, which host functions may be relayed,
 * which authorization entries may ride along, how a KYA decision maps onto the allowlist,
 * the caps) lives in ../stellar-passkey.ts, pure and unit-tested. Everything that touches XDR
 * lives in ../chains/stellar/relay.ts and the Stellar adapter. This file reads a body, calls
 * those, forwards to the relayer, and picks a status code.
 *
 * NOT behind the verified-session gate, and http.ts says why at the exemption: the public
 * /stellar page has no A-Identity login, the owner is a passkey the browser holds. What stands
 * in for the gate is that everything here is testnet only, rate-budgeted and fail-closed, and
 * that the two endpoints which spend the operator key do so under caps a test pins.
 *
 * The relay has two more bounds that http.ts cannot give it, because http.ts budgets per IP
 * and the thing at risk here is one credential of ours shared by everyone: a GLOBAL rate
 * limit charged at the door, and a 24 hour reserve against the relayer fee charged in the
 * last step before the key is used. Both live in ../stellar-passkey.ts with the argument for
 * why the fee can only be reserved and not pre-checked, and both are published by
 * GET /api/stellar/passkey/status rather than kept private.
 *
 * Nothing here logs a request body. An authorization entry carries the passkey's signature and
 * its clientDataJSON, which are the person's credential material as far as a log is concerned.
 */
import { CHAINS, addressUrl, createStellarAdapter, txUrl, type ChainDescriptor, type StellarAdapter } from '../chains/index.js'
// Direct, like stellar-vault-routes.ts: the frozen error table is not part of the barrel.
import { errorName } from '../chains/stellar/adapter.js'
import { stellarSignerAddress } from '../chains/stellar/client.js'
import { inspectRelayPayload } from '../chains/stellar/relay.js'
import { riskCheck as liveRiskCheck } from '../asp/tools.js'
import { listPlatformAgents, subjectsLinkedToWallet } from '../platform.js'
import { ozApiKey, ozKeyVar, ozRelayerUrl } from '../x402-stellar/rail.js'
import {
  PASSKEY_CAPS,
  PASSKEY_RELEASE,
  UNBOUND_PAYEE_REASONS,
  allowlistPlan,
  allowlistRequest,
  bindPayeeToAgent,
  ozRelayOutcome,
  ozRelayRequest,
  passkeyAgentPayPlan,
  passkeyChain,
  passkeyDeployPlan,
  passkeyStatusView,
  relayBudget as sharedRelayBudget,
  relayDecision,
  relayFeeSettlement,
  relayParams,
  relayPreflight,
  type RelayBudget,
  type RiskDecisionName,
} from '../stellar-passkey.js'
import { readBody, sendJson, type RouteCtx } from './shared.js'

/** The adapter surface this group uses, so a test can stand in for it without a ledger. */
export type PasskeyAdapter = Pick<StellarAdapter, 'readVault' | 'deployVault' | 'readTokenBalance' | 'sacTransferFromSigner' | 'policyPay'>

/** Seams for the offline tests. Production passes nothing and every default is the live thing. */
export type PasskeyRouteDeps = {
  env?: NodeJS.ProcessEnv
  adapter?: (chain: ChainDescriptor) => PasskeyAdapter
  signerAddress?: (chain: ChainDescriptor, env: NodeJS.ProcessEnv) => string | null
  fetch?: typeof fetch
  riskCheck?: (agentId: string, tx: { payee?: string; amountUsd?: number } | null) => Promise<{ decision: RiskDecisionName; risk: string; reasons: string[]; signals: unknown }>
  agents?: () => { id: string; name: string; owner?: string }[]
  linkedSubjects?: (address: string) => string[]
  /** The global rate limit and the 24 hour fee reserve. A test hands in its own so no two
   *  tests share a window; production always uses the one process-wide ledger. */
  relayBudget?: RelayBudget
}

/** How long we wait for the relayer. Testnet retries inside Channels can take minutes. */
const RELAYER_TIMEOUT_MS = 150_000

/** The settlement token's decimals, which on Stellar is 7 and is never assumed to be. */
function tokenDecimals(chain: ChainDescriptor): number {
  return chain.settlementTokens?.[0]?.decimals ?? chain.usdcDecimals ?? 7
}

export async function handleStellarPasskeyRoutes(ctx: RouteCtx, deps: PasskeyRouteDeps = {}): Promise<boolean> {
  const { req, res, url } = ctx
  if (!url.pathname.startsWith('/api/stellar/passkey/')) return false

  const env = deps.env ?? process.env
  const adapterFor = deps.adapter ?? ((chain: ChainDescriptor) => createStellarAdapter(chain))
  const signerOf = deps.signerAddress ?? ((chain: ChainDescriptor, e: NodeJS.ProcessEnv) => stellarSignerAddress(chain, e))
  const doFetch = deps.fetch ?? fetch
  const risk = deps.riskCheck ?? ((agentId: string, tx: { payee?: string; amountUsd?: number } | null) => liveRiskCheck(agentId, tx))
  const agents = deps.agents ?? (() => listPlatformAgents().map((a) => ({ id: a.id, name: a.name, owner: a.owner })))
  const linkedSubjects = deps.linkedSubjects ?? subjectsLinkedToWallet
  const budget = deps.relayBudget ?? sharedRelayBudget

  const refuseChain = (gate: Extract<ReturnType<typeof passkeyChain>, { ok: false }>, keyed: 'ok' | 'success') => {
    sendJson(res, gate.status, {
      [keyed]: false,
      code: gate.code,
      reason: gate.reason,
      ...(keyed === 'success' ? { error: gate.reason } : {}),
      release: PASSKEY_RELEASE.name,
      testnetOnly: true,
    })
    return true
  }

  // ── GET /api/stellar/passkey/status - what is configured, never a secret ───────
  if (req.method === 'GET' && url.pathname === '/api/stellar/passkey/status') {
    const gate = passkeyChain(url.searchParams.get('network') ?? undefined, CHAINS)
    if (!gate.ok) return refuseChain(gate, 'ok')
    const chain = gate.chain
    sendJson(
      res,
      200,
      passkeyStatusView(chain, {
        keyVar: ozKeyVar(chain),
        keyConfigured: Boolean(ozApiKey(chain, env)),
        relayerUrl: ozRelayerUrl(chain, env),
        operator: signerOf(chain, env),
        explorerFor: (a) => addressUrl(chain, a),
        relayLimits: budget.snapshot(),
      }),
    )
    return true
  }

  // ── POST /api/stellar/passkey/relay - fee-sponsor an allowlisted request ───────
  if (req.method === 'POST' && url.pathname === '/api/stellar/passkey/relay') {
    // The global rate limit, charged at the door and before the body is even read.
    // http.ts already bounds this path per IP, which bounds one address; this bounds
    // everyone together, which is the unit that matters when the thing being spent is a
    // credential of ours rather than a caller's own gas. SDF's reference proxy for this
    // same kit sets both numbers and we had only the first.
    const admitted = budget.admit()
    if (!admitted.ok) {
      res.setHeader('Retry-After', String(admitted.retryAfterSeconds))
      sendJson(res, admitted.status, { success: false, code: admitted.code, error: admitted.reason, reason: admitted.reason, retryAfterSeconds: admitted.retryAfterSeconds })
      return true
    }
    const body = await readBody(req).catch(() => null)
    const parsed = relayParams(body)
    if (!parsed.ok) {
      sendJson(res, 400, { success: false, code: 'bad_request', error: parsed.reason, reason: parsed.reason })
      return true
    }
    const gate = passkeyChain(parsed.network, CHAINS)
    if (!gate.ok) return refuseChain(gate, 'success')
    const chain = gate.chain

    // Decode first, decide second, and only then look at whether a key exists. The order is
    // the property: a request this relay would never forward must never cost a key lookup,
    // let alone a ledger read.
    const seen = inspectRelayPayload(chain, parsed.params)
    const pre = relayPreflight(seen, { smartAccountWasmHash: chain.contracts.smartAccount?.wasmHash })
    if (!pre.ok) {
      const status = !seen.ok && seen.code === 'wrong_network' ? 409 : pre.status
      sendJson(res, status, { success: false, code: !seen.ok ? seen.code : pre.code, error: pre.reason, reason: pre.reason })
      return true
    }

    let live: { owner: string; operator: string } | null = null
    if (pre.vault) {
      try {
        const v = await adapterFor(chain).readVault(pre.vault, env)
        live = { owner: v.owner, operator: v.operator }
      } catch {
        live = null
      }
    }
    const decision = relayDecision(pre, live, signerOf(chain, env))
    if (!decision.ok) {
      sendJson(res, decision.status, { success: false, code: decision.code, error: decision.reason, reason: decision.reason, rule: pre.rule, vault: pre.vault })
      return true
    }

    const keyVar = ozKeyVar(chain)
    const request = ozRelayRequest(ozRelayerUrl(chain, env), keyVar, parsed.params)
    const key = ozApiKey(chain, env)
    if (!key) {
      const reason = `${keyVar} is unset; this is exactly what would be posted to ${PASSKEY_RELEASE.relayerProduct}, and nothing was.`
      sendJson(res, 501, {
        success: false,
        outcome: 'prepared',
        relayer: PASSKEY_RELEASE.relayerName,
        reason,
        error: reason,
        rule: pre.rule,
        vault: pre.vault,
        summary: pre.summary,
        payload: request,
      })
      return true
    }

    // The fee reserve, charged in the last step before our key is used and never before it,
    // so a request that was going to be answered `prepared` never costs the day anything.
    // It is a RESERVE: we do not build the envelope on the { func, auth } carrier, so
    // Channels prices the transaction after we hand it over and there is no fee to check
    // beforehand. See PASSKEY_RELAY_LIMITS for the whole argument.
    const reserved = budget.reserve()
    if (!reserved.ok) {
      res.setHeader('Retry-After', String(reserved.retryAfterSeconds))
      sendJson(res, reserved.status, {
        success: false,
        code: reserved.code,
        error: reserved.reason,
        reason: reserved.reason,
        retryAfterSeconds: reserved.retryAfterSeconds,
        rule: pre.rule,
        vault: pre.vault,
        limits: budget.snapshot().fee,
      })
      return true
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RELAYER_TIMEOUT_MS)
    let httpStatus: number
    let json: unknown = null
    try {
      const r = await doFetch(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      })
      httpStatus = r.status
      try {
        json = await r.json()
      } catch {
        json = null
      }
    } catch (e) {
      clearTimeout(timer)
      const why = e instanceof Error && e.name === 'AbortError' ? `no answer within ${RELAYER_TIMEOUT_MS / 1000} s` : e instanceof Error ? e.message : String(e)
      // The reserve is deliberately NOT handed back here. A request that timed out may
      // have been simulated, priced and broadcast; we simply do not know, and the safe
      // reading of "we do not know what we spent" is that we spent it.
      sendJson(res, 502, {
        success: false,
        code: 'relayer_unreachable',
        error: `the relayer could not be reached: ${why}`,
        reason: `the relayer could not be reached: ${why}`,
        relayer: PASSKEY_RELEASE.relayerName,
        rule: pre.rule,
        vault: pre.vault,
        fee: {
          reservedStroops: reserved.reservedStroops.toString(),
          basis: 'reserved',
          note: 'the relayer never answered, so whether this cost anything is unknown and the reserve stands against the 24 hour budget rather than being handed back on a guess',
        },
      })
      return true
    }
    clearTimeout(timer)

    const outcome = ozRelayOutcome(httpStatus, json)
    // What the day owes back, decided over the relayer's answer and applied once.
    const settled = relayFeeSettlement(outcome, reserved.reservedStroops)
    budget.settle({ windowResetAt: reserved.windowResetAt, refundStroops: settled.refundStroops, measured: settled.basis === 'measured' })
    const feeBlock = {
      reservedStroops: reserved.reservedStroops.toString(),
      chargedStroops: settled.feeStroops === null ? null : settled.feeStroops.toString(),
      basis: settled.basis,
      note: settled.note,
    }
    if (outcome.success) {
      sendJson(res, 200, {
        success: true,
        // The kit reads `data` when it is nested and the root otherwise; both are given.
        data: { transactionId: outcome.transactionId, status: outcome.status, hash: outcome.hash },
        transactionId: outcome.transactionId,
        hash: outcome.hash,
        status: outcome.status,
        ...(outcome.hash ? { explorerUrl: txUrl(chain, outcome.hash) } : {}),
        relayer: PASSKEY_RELEASE.relayerName,
        network: chain.caip2,
        rule: pre.rule,
        vault: pre.vault,
        summary: pre.summary,
        fee: feeBlock,
        note: 'Accepted by the relayer, which pays the fee and broadcasts from its own channel account. A hash is a submission, not a receipt: read the transaction before recording anything as settled.',
      })
      return true
    }
    sendJson(res, httpStatus >= 400 ? httpStatus : 409, {
      success: false,
      error: outcome.error,
      ...(outcome.code ? { code: outcome.code, errorCode: outcome.code } : {}),
      data: outcome.data,
      relayer: PASSKEY_RELEASE.relayerName,
      network: chain.caip2,
      rule: pre.rule,
      vault: pre.vault,
      fee: feeBlock,
    })
    return true
  }

  // ── POST /api/stellar/passkey/vault/deploy - a vault owned by the smart account ─
  if (req.method === 'POST' && url.pathname === '/api/stellar/passkey/vault/deploy') {
    const body = (await readBody(req).catch(() => null)) as { network?: unknown } | null
    const gate = passkeyChain(body?.network, CHAINS)
    if (!gate.ok) return refuseChain(gate, 'ok')
    const chain = gate.chain
    const token = chain.settlementTokens?.[0]
    if (!token) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: `${chain.caip2} declares no settlement token, so there is nothing a vault could hold` })
      return true
    }
    const plan = passkeyDeployPlan(body, token.decimals)
    if (!plan.ok) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: plan.reason, caps: { ...PASSKEY_CAPS } })
      return true
    }

    const operator = signerOf(chain, env)
    const constructorArgs = {
      owner: plan.owner,
      operator,
      token: token.address,
      dailyCapRaw: plan.dailyCapRaw,
      autoApproveMaxRaw: plan.autoApproveMaxRaw,
      dailyCapUsd: plan.dailyCapUsd,
      autoApproveUsd: plan.autoApproveUsd,
    }
    const base = {
      network: chain.id,
      caip2: chain.caip2,
      owner: plan.owner,
      ownerKind: 'smart-account' as const,
      operator,
      token: token.address,
      tokenSymbol: token.symbol,
      constructorArgs,
    }
    if (!operator) {
      sendJson(res, 200, {
        ok: false,
        outcome: 'prepared',
        ...base,
        seed: { amountUsd: plan.seedUsd, outcome: 'prepared' },
        reason:
          `${chain.signerEnvVar ?? 'the chain signer'} is not set, so this server has no operator account and nothing was ` +
          'submitted. This is the exact __constructor call it would make, with the operator being whatever account that key decodes to.',
      })
      return true
    }

    const adapter = adapterFor(chain)
    const deployed = await adapter.deployVault(
      { owner: plan.owner, operator, token: token.address, dailyCapRaw: plan.dailyCapRaw, autoApproveMaxRaw: plan.autoApproveMaxRaw },
      env,
    )
    if (deployed.outcome !== 'settled') {
      const named = deployed.outcome === 'refused' && deployed.contractErrorIsOurs ? errorName(deployed.contractErrorCode) : undefined
      const status = deployed.outcome === 'pending' ? 202 : deployed.outcome === 'prepared' ? 200 : 409
      sendJson(res, status, {
        ok: false,
        outcome: deployed.outcome,
        ...base,
        ...('txHash' in deployed ? { txHash: deployed.txHash, explorerUrl: deployed.explorerUrl } : {}),
        ...('reason' in deployed ? { reason: deployed.reason } : {}),
        ...('contractErrorCode' in deployed && deployed.contractErrorCode !== undefined ? { contractErrorCode: deployed.contractErrorCode } : {}),
        ...(named ? { contractErrorName: named } : {}),
        seed: { amountUsd: plan.seedUsd, outcome: 'none', reason: 'no vault was created, so nothing was seeded' },
      })
      return true
    }

    // The seed: USDC out of the operator's own account into the new vault, so the demo's
    // pay() has something to move. Only when the account can actually cover it, checked by
    // reading the balance rather than by letting the SAC refuse and paying a fee for it.
    let seed: Record<string, unknown> = { amountUsd: plan.seedUsd, outcome: 'none', reason: 'seedUsd was 0' }
    if (plan.seedUsd > 0) {
      try {
        const balance = await adapter.readTokenBalance(token.address, operator, env)
        if (balance < BigInt(plan.seedRaw)) {
          seed = {
            amountUsd: plan.seedUsd,
            outcome: 'skipped',
            reason: `the operator ${operator} holds ${Number(balance) / 10 ** token.decimals} ${token.symbol}, less than the ${plan.seedUsd} requested, so the vault starts empty. Fund it by any SEP-41 transfer to ${deployed.vault}.`,
          }
        } else {
          const moved = await adapter.sacTransferFromSigner(token.address, deployed.vault, plan.seedRaw, env)
          seed = {
            amountUsd: plan.seedUsd,
            outcome: moved.outcome,
            ...('txHash' in moved ? { txHash: moved.txHash, explorerUrl: moved.explorerUrl } : {}),
            ...('ledger' in moved ? { ledger: moved.ledger } : {}),
            ...('reason' in moved ? { reason: moved.reason } : {}),
          }
        }
      } catch (e) {
        seed = { amountUsd: plan.seedUsd, outcome: 'error', reason: `the seed transfer was not attempted: ${e instanceof Error ? e.message : String(e)}` }
      }
    }

    sendJson(res, 200, {
      ok: true,
      outcome: 'settled',
      ...base,
      vault: deployed.vault,
      explorerUrl: addressUrl(chain, deployed.vault),
      deploy: { txHash: deployed.txHash, explorerUrl: deployed.explorerUrl, ledger: deployed.ledger },
      seed,
      note:
        `Vault ${deployed.vault} is owned by the smart account ${plan.owner} and operated by ${operator}. The owner's ` +
        'passkey signs set_policy / set_allowed through the smart account (relay them via POST /api/stellar/passkey/relay); ' +
        'the operator signs pay() (POST /api/stellar/passkey/agent-pay). Testnet: a reset takes all of this with it.',
    })
    return true
  }

  // ── POST /api/stellar/passkey/allowlist/plan - KYA decision onto the allowlist ──
  if (req.method === 'POST' && url.pathname === '/api/stellar/passkey/allowlist/plan') {
    const body = (await readBody(req).catch(() => null)) as { network?: unknown } | null
    const gate = passkeyChain(body?.network, CHAINS)
    if (!gate.ok) return refuseChain(gate, 'ok')
    const chain = gate.chain
    const want = allowlistRequest(body)
    if (!want.ok) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: want.reason })
      return true
    }

    const bound = bindPayeeToAgent({ agentId: want.agentId, payee: want.payee, agents: agents(), linkedSubjects: linkedSubjects(want.payee) })
    let decision: RiskDecisionName | null = null
    let riskLevel: string | null = null
    let reasons: string[] = UNBOUND_PAYEE_REASONS
    let signals: unknown = null
    let agent: { id: string; name: string } | null = null
    if (bound.agentId) {
      try {
        const r = await risk(bound.agentId, { payee: want.payee })
        decision = r.decision
        riskLevel = r.risk
        reasons = r.reasons
        signals = r.signals
      } catch (e) {
        sendJson(res, 502, { ok: false, code: 'risk_unavailable', reason: `risk_check for ${bound.agentId} did not answer: ${e instanceof Error ? e.message : String(e)}. Nothing was planned.` })
        return true
      }
      const row = agents().find((a) => a.id === bound.agentId)
      agent = row ? { id: row.id, name: row.name } : { id: bound.agentId, name: bound.agentId }
    }
    const plan = allowlistPlan(decision, want.payee, reasons)
    sendJson(res, 200, {
      ok: true,
      network: chain.id,
      caip2: chain.caip2,
      contract: want.contract,
      payee: want.payee,
      agent,
      binding: bound.binding,
      bindingNote: bound.note,
      decision: plan.decision,
      risk: riskLevel ?? (plan.decision === 'DENY' ? 'high' : null),
      reasons,
      signals,
      chainAction: plan.chainAction,
      serverWarning: plan.serverWarning,
      enforcement: plan.enforcement,
      source: bound.agentId ? 'risk_check (mcp/src/asp/tools.ts), the same scorer the paid tool serves' : 'no agent, so no scorer ran',
      note: 'This endpoint writes nothing on chain. The chainAction, when there is one, is signed by the vault owner (the passkey) client-side and relayed through POST /api/stellar/passkey/relay.',
      checkedAt: new Date().toISOString(),
    })
    return true
  }

  // ── POST /api/stellar/passkey/agent-pay - the agent side, through pay() ────────
  if (req.method === 'POST' && url.pathname === '/api/stellar/passkey/agent-pay') {
    const body = (await readBody(req).catch(() => null)) as { network?: unknown } | null
    const gate = passkeyChain(body?.network, CHAINS)
    if (!gate.ok) return refuseChain(gate, 'ok')
    const chain = gate.chain
    const plan = passkeyAgentPayPlan(body, tokenDecimals(chain))
    if (!plan.ok) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: plan.reason, maxUsd: PASSKEY_CAPS.agentPayMaxUsd })
      return true
    }
    const adapter = adapterFor(chain)
    const base = { network: chain.id, caip2: chain.caip2, contract: plan.contract, to: plan.to, amountUsd: plan.amountUsd, amountRaw: plan.amountRaw }

    const signer = signerOf(chain, env)
    if (!signer) {
      const prepared = await adapter.policyPay(plan.contract, plan.to, plan.amountRaw, env)
      sendJson(res, 200, { ok: false, ...base, outcome: prepared.outcome, ...('reason' in prepared ? { reason: prepared.reason } : {}), note: 'No operator key is configured, so this is the exact pay() call and nothing was submitted.' })
      return true
    }
    let operator: string
    try {
      operator = (await adapter.readVault(plan.contract, env)).operator
    } catch (e) {
      sendJson(res, 502, { ok: false, ...base, code: 'rpc_error', reason: `vault ${plan.contract} could not be read (${e instanceof Error ? e.message : String(e)}), so nothing was submitted. The operator check is never skipped.` })
      return true
    }
    if (operator.trim() !== signer) {
      sendJson(res, 403, { ok: false, ...base, code: 'not_operator', reason: `vault ${plan.contract} is operated by ${operator}, not by this server (${signer}), so this server cannot and will not call pay() on it.` })
      return true
    }

    const outcome = await adapter.policyPay(plan.contract, plan.to, plan.amountRaw, env)
    const named = outcome.outcome === 'refused' && outcome.contractErrorIsOurs ? errorName(outcome.contractErrorCode) : undefined
    const status = outcome.outcome === 'settled' ? 200 : outcome.outcome === 'pending' ? 202 : outcome.outcome === 'prepared' ? 200 : 409
    sendJson(res, status, {
      ok: outcome.outcome === 'settled',
      ...base,
      outcome: outcome.outcome,
      operator: signer,
      ...('txHash' in outcome ? { txHash: outcome.txHash, explorerUrl: outcome.explorerUrl } : {}),
      ...('ledger' in outcome ? { ledger: outcome.ledger } : {}),
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...('contractErrorCode' in outcome && outcome.contractErrorCode !== undefined ? { contractErrorCode: outcome.contractErrorCode } : {}),
      ...(outcome.outcome === 'refused' && outcome.contractErrorIsOurs !== undefined ? { contractErrorIsOurs: outcome.contractErrorIsOurs } : {}),
      ...(named ? { contractErrorName: named } : {}),
      note:
        outcome.outcome === 'settled'
          ? 'In the ledger and successful: the vault paid under the policy its owner set.'
          : outcome.outcome === 'refused'
            ? 'refused in simulation, so no transaction exists; that is Soroban, not evasion'
            : outcome.outcome === 'failed'
              ? 'The transaction landed and FAILED: it consumed a fee and moved nothing. This is the on-chain form of the same refusal.'
              : outcome.outcome === 'pending'
                ? 'Submitted and not in a ledger yet. It stays valid for its full timeout; do not retry it and do not record it as failed.'
                : 'Nothing was submitted.',
    })
    return true
  }

  return false
}
