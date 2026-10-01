/**
 * The passkey vault demo: a smart-account owner, a fee-sponsoring relay, and the agent side.
 *
 * Thin adapters only. Every decision (which network, which host functions may be relayed,
 * which authorization entries may ride along, which vaults the operator key may act on,
 * which smart account a vault may be deployed for, how a KYA decision maps onto the
 * allowlist, the caps) lives in ../stellar-passkey.ts, pure and unit-tested. Everything that
 * touches XDR lives in ../chains/stellar/relay.ts, ../chains/stellar/smart-account.ts and
 * the Stellar adapter. This file reads a body, reads the ledger, calls those, forwards to
 * the relayer, and picks a status code.
 *
 * Both Stellar networks are served. A request names its network in the body or, for the
 * relay, in the query string (the smart-account kit posts only `{ func, auth }`, so the
 * page puts the network in the relayer URL it configures). Naming none gets testnet.
 *
 * NOT behind the verified-session gate, and http.ts says why at the exemption: the public
 * /stellar page has no A-Identity login, the owner is a passkey the browser holds. What stands
 * in for the gate is that everything here is rate-budgeted and fail-closed, that the two
 * endpoints which spend the operator key do so under per-network caps a test pins (pubnet's
 * are dust), and that the operator key only ever acts on a vault whose live owner is a smart
 * account running the registry's account wasm, never on a recorded flagship vault.
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
import { CHAINS, addressUrl, createStellarAdapter, isContractId, txUrl, type ChainDescriptor, type StellarAdapter } from '../chains/index.js'
// Direct, like stellar-vault-routes.ts: the frozen error table is not part of the barrel.
import { errorName } from '../chains/stellar/adapter.js'
import { stellarSignerAddress } from '../chains/stellar/client.js'
import { inspectRelayPayload } from '../chains/stellar/relay.js'
import { createSmartAccountReader, type ContractCode, type FeePayerRead, type SmartAccountReader, type SmartAccountRules } from '../chains/stellar/smart-account.js'
import { riskCheck as liveRiskCheck } from '../asp/tools.js'
import { listPlatformAgents, subjectsLinkedToWallet } from '../platform.js'
import { ozApiKey, ozKeyVar, ozRelayerUrl } from '../x402-stellar/rail.js'
import {
  passkeyCaps,
  PASSKEY_RELEASE,
  UNBOUND_PAYEE_REASONS,
  allowlistPlan,
  allowlistRequest,
  bindPayeeToAgent,
  flagshipVaults,
  operatorGate,
  ownerAccountCheck,
  ozRelayOutcome,
  ozRelayRequest,
  passkeyAgentPayPlan,
  passkeyChain,
  passkeyDeployPlan,
  passkeyStatusView,
  relayBudget as sharedRelayBudget,
  seedBudget as sharedSeedBudget,
  relayDecision,
  relayFeeSettlement,
  relayParams,
  relayPreflight,
  requestedNetwork,
  servedNetworks,
  smartAccountCodeVerdict,
  type RelayBudget,
  type RiskDecisionName,
  type SeedBudget,
} from '../stellar-passkey.js'
import { readBody, sendJson, type RouteCtx } from './shared.js'

/** The adapter surface this group uses, so a test can stand in for it without a ledger. */
export type PasskeyAdapter = Pick<StellarAdapter, 'readVault' | 'deployVault' | 'readTokenBalance' | 'sacTransferFromSigner' | 'policyPay'>

/** Seams for the offline tests. Production passes nothing and every default is the live thing. */
export type PasskeyRouteDeps = {
  env?: NodeJS.ProcessEnv
  adapter?: (chain: ChainDescriptor) => PasskeyAdapter
  /** The live reads of a smart account (its code and its rules) and of a relayed transaction's fee payer. */
  accounts?: (chain: ChainDescriptor) => SmartAccountReader
  signerAddress?: (chain: ChainDescriptor, env: NodeJS.ProcessEnv) => string | null
  fetch?: typeof fetch
  riskCheck?: (agentId: string, tx: { payee?: string; amountUsd?: number } | null) => Promise<{ decision: RiskDecisionName; risk: string; reasons: string[]; signals: unknown }>
  agents?: () => { id: string; name: string; owner?: string }[]
  linkedSubjects?: (address: string) => string[]
  /** The global rate limit and the 24 hour fee reserve. A test hands in its own so no two
   *  tests share a window; production always uses the one process-wide ledger. */
  relayBudget?: RelayBudget
  /** The shared per-network ceiling on seed USDC. A test hands in its own so no two tests
   *  share a day, and so a pubnet assertion never depends on what a testnet one spent. */
  seedBudget?: SeedBudget
  /** How long to wait before each attempt to read a relayed transaction's fee payer. Tests pass []. */
  feePayerWaitsMs?: number[]
}

/** How long we wait for the relayer. Testnet retries inside Channels can take minutes. */
const RELAYER_TIMEOUT_MS = 150_000

/**
 * Two short looks for the transaction a relayer just accepted, so the answer can name who
 * paid its fee. A Stellar ledger closes in about five seconds; past that the page asks
 * GET /api/stellar/passkey/fee-payer itself rather than this request holding the kit open.
 */
const FEE_PAYER_WAITS_MS = [2_000, 3_000]

/** The settlement token's decimals, which on Stellar is 7 and is never assumed to be. */
function tokenDecimals(chain: ChainDescriptor): number {
  return chain.settlementTokens?.[0]?.decimals ?? chain.usdcDecimals ?? 7
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Who paid, in words a page can print beside the account. */
function feePayerWho(account: string, operator: string | null): 'operator' | 'relayer' {
  return operator && account === operator ? 'operator' : 'relayer'
}

export async function handleStellarPasskeyRoutes(ctx: RouteCtx, deps: PasskeyRouteDeps = {}): Promise<boolean> {
  const { req, res, url } = ctx
  if (!url.pathname.startsWith('/api/stellar/passkey/')) return false

  const env = deps.env ?? process.env
  const adapterFor = deps.adapter ?? ((chain: ChainDescriptor) => createStellarAdapter(chain))
  const accountsFor = deps.accounts ?? ((chain: ChainDescriptor) => createSmartAccountReader(chain))
  const signerOf = deps.signerAddress ?? ((chain: ChainDescriptor, e: NodeJS.ProcessEnv) => stellarSignerAddress(chain, e))
  const doFetch = deps.fetch ?? fetch
  const risk = deps.riskCheck ?? ((agentId: string, tx: { payee?: string; amountUsd?: number } | null) => liveRiskCheck(agentId, tx))
  const agents = deps.agents ?? (() => listPlatformAgents().map((a) => ({ id: a.id, name: a.name, owner: a.owner })))
  const linkedSubjects = deps.linkedSubjects ?? subjectsLinkedToWallet
  const budget = deps.relayBudget ?? sharedRelayBudget
  const seeds = deps.seedBudget ?? sharedSeedBudget

  const refuseChain = (gate: { status: number; code: string; reason: string }, keyed: 'ok' | 'success') => {
    sendJson(res, gate.status, {
      [keyed]: false,
      code: gate.code,
      reason: gate.reason,
      ...(keyed === 'success' ? { error: gate.reason } : {}),
      release: PASSKEY_RELEASE.name,
      servedNetworks: servedNetworks(CHAINS),
    })
    return true
  }

  /** Which chain a request is for: the body's network or the query string's, never both disagreeing. */
  const chainOf = (bodyNetwork: unknown) => {
    const named = requestedNetwork(bodyNetwork, url.searchParams.get('network'), CHAINS)
    if (!named.ok) return named
    return passkeyChain(named.network, CHAINS)
  }

  /** A contract's code, or null when the read failed. Null is read as "stop" by every verdict. */
  const codeOf = async (chain: ChainDescriptor, address: string): Promise<ContractCode | null> => {
    try {
      return await accountsFor(chain).readCode(address, env)
    } catch {
      return null
    }
  }

  // ── GET /api/stellar/passkey/status - what is configured, never a secret ───────
  if (req.method === 'GET' && url.pathname === '/api/stellar/passkey/status') {
    const gate = chainOf(undefined)
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
        seedLimits: seeds.snapshot(chain.caip2, passkeyCaps(chain)),
        servedNetworks: servedNetworks(CHAINS),
      }),
    )
    return true
  }

  // ── GET /api/stellar/passkey/vault - one vault, read live, for the owner's page ─
  if (req.method === 'GET' && url.pathname === '/api/stellar/passkey/vault') {
    const gate = chainOf(undefined)
    if (!gate.ok) return refuseChain(gate, 'ok')
    const chain = gate.chain
    const contract = (url.searchParams.get('contract') ?? '').trim()
    if (!isContractId(contract)) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: 'contract must be the vault\'s Soroban contract id (C... StrKey)' })
      return true
    }
    let v: Awaited<ReturnType<PasskeyAdapter['readVault']>>
    try {
      v = await adapterFor(chain).readVault(contract, env)
    } catch (e) {
      sendJson(res, 502, { ok: false, code: 'rpc_error', reason: `vault ${contract} could not be read on ${chain.caip2}: ${e instanceof Error ? e.message : String(e)}` })
      return true
    }
    const owner = v.owner.trim()
    const ownerCode = isContractId(owner) ? await codeOf(chain, owner) : null
    const verdict = isContractId(owner) ? smartAccountCodeVerdict(owner, ownerCode, chain.contracts.smartAccount?.wasmHash) : null
    sendJson(res, 200, {
      ok: true,
      read: 'live',
      network: chain.caip2,
      contract,
      explorerUrl: addressUrl(chain, contract),
      ...v,
      ownerKind: isContractId(owner) ? 'smart-account' : 'account',
      ownerIsDemoSmartAccount: verdict?.ok ?? false,
      ...(verdict && !verdict.ok ? { ownerNote: verdict.reason } : {}),
      operatorIsThisServer: v.operator.trim() === signerOf(chain, env),
      checkedAt: new Date().toISOString(),
    })
    return true
  }

  // ── GET /api/stellar/passkey/fee-payer - who paid for a transaction, from the ledger ─
  if (req.method === 'GET' && url.pathname === '/api/stellar/passkey/fee-payer') {
    const gate = chainOf(undefined)
    if (!gate.ok) return refuseChain(gate, 'ok')
    const chain = gate.chain
    const hash = (url.searchParams.get('hash') ?? '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: 'hash must be a transaction hash, 64 hex characters' })
      return true
    }
    let read: FeePayerRead
    try {
      read = await accountsFor(chain).readFeePayer(hash, env)
    } catch (e) {
      sendJson(res, 502, { ok: false, code: 'rpc_error', reason: `transaction ${hash} could not be read on ${chain.caip2}: ${e instanceof Error ? e.message : String(e)}` })
      return true
    }
    if (!read.found) {
      sendJson(res, 404, { ok: false, code: 'not_found', hash, network: chain.caip2, reason: `${chain.caip2} RPC does not know transaction ${hash} (not yet in a ledger, or past the RPC's retention window).` })
      return true
    }
    const operator = signerOf(chain, env)
    sendJson(res, 200, {
      ok: true,
      read: 'live',
      network: chain.caip2,
      hash,
      status: read.status,
      ledger: read.ledger,
      feeAccount: read.feeAccount,
      sourceAccount: read.sourceAccount,
      feeBump: read.feeBump,
      feeChargedStroops: read.feeChargedStroops,
      who: feePayerWho(read.feeAccount, operator),
      explorerUrl: txUrl(chain, hash),
      note: read.feeBump
        ? 'The fee was charged to the fee-bump outer source; the inner source is the account the transaction ran under. Neither is the smart account that authorized it.'
        : 'Not a fee-bump: the fee was charged to the transaction source.',
    })
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
    // The kit's RelayerClient posts only { func, auth }, so the network usually arrives in
    // the query string of the relayer URL the page configured; a body may name it too.
    const gate = chainOf(parsed.network)
    if (!gate.ok) return refuseChain(gate, 'success')
    const chain = gate.chain

    // Decode first, decide second, and only then look at whether a key exists. The order is
    // the property: a request this relay would never forward must never cost a key lookup,
    // let alone a ledger read.
    const seen = inspectRelayPayload(chain, parsed.params)
    const sa = chain.contracts.smartAccount
    const pre = relayPreflight(seen, { smartAccountWasmHash: sa?.wasmHash, webauthnVerifier: sa?.webauthnVerifier })
    if (!pre.ok) {
      const status = !seen.ok && seen.code === 'wrong_network' ? 409 : pre.status
      sendJson(res, status, { success: false, code: !seen.ok ? seen.code : pre.code, error: pre.reason, reason: pre.reason })
      return true
    }

    // The live reads, each only when the decision could still pass: a flagship vault or a
    // missing signer is refused before anything is read.
    const flagship = flagshipVaults(chain)
    const signer = signerOf(chain, env)
    let vaultLive: { owner: string; operator: string } | null = null
    let accountCode: ContractCode | null = null
    if (pre.rule === 'smart-account-admin' && pre.smartAccount) {
      accountCode = await codeOf(chain, pre.smartAccount)
    } else if (pre.vault && !flagship.includes(pre.vault) && signer) {
      try {
        const v = await adapterFor(chain).readVault(pre.vault, env)
        vaultLive = { owner: v.owner, operator: v.operator }
      } catch {
        vaultLive = null
      }
      if (vaultLive && vaultLive.operator.trim() === signer && isContractId(vaultLive.owner.trim())) {
        accountCode = await codeOf(chain, vaultLive.owner.trim())
      }
    }
    const decision = relayDecision(pre, { vault: vaultLive, signer, accountCode, expectedWasmHash: sa?.wasmHash, flagship })
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
        network: chain.caip2,
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
      // Who paid, read off the ledger rather than assumed: the relayer fee-bumps from an
      // account of its own, and a page that says "you paid nothing" should be able to name
      // the account that did. Two short looks; past them the page asks fee-payer itself.
      let feePayer: Record<string, unknown> = {
        account: null,
        who: 'relayer',
        read: 'not-yet',
        lookup: outcome.hash ? `/api/stellar/passkey/fee-payer?hash=${outcome.hash}&network=${encodeURIComponent(chain.caip2)}` : null,
      }
      if (outcome.hash) {
        for (const wait of deps.feePayerWaitsMs ?? FEE_PAYER_WAITS_MS) {
          if (wait > 0) await sleep(wait)
          try {
            const read = await accountsFor(chain).readFeePayer(outcome.hash, env)
            if (read.found) {
              feePayer = {
                account: read.feeAccount,
                sourceAccount: read.sourceAccount,
                feeBump: read.feeBump,
                feeChargedStroops: read.feeChargedStroops,
                status: read.status,
                who: feePayerWho(read.feeAccount, signer),
                read: 'live',
              }
              break
            }
          } catch {
            // A read that fails is the same as one that has not landed yet: the page asks again.
          }
        }
      }
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
        feePayer,
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
    const gate = chainOf(body?.network)
    if (!gate.ok) return refuseChain(gate, 'ok')
    const chain = gate.chain
    const token = chain.settlementTokens?.[0]
    if (!token) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: `${chain.caip2} declares no settlement token, so there is nothing a vault could hold` })
      return true
    }
    const caps = passkeyCaps(chain)
    const plan = passkeyDeployPlan(body, token.decimals, caps, chain.caip2)
    if (!plan.ok) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: plan.reason, network: chain.caip2, caps: { ...caps } })
      return true
    }

    // The owner, read live before anything is spent: the registry's account code, and one
    // rule holding exactly the passkey this browser named. A browser can claim any C...
    // address; the account itself is what is believed.
    const sa = chain.contracts.smartAccount
    const reader = accountsFor(chain)
    const [ownerCode, ownerRules] = await Promise.all([
      reader.readCode(plan.owner, env).catch(() => null),
      reader.readRules(plan.owner, env).catch((): SmartAccountRules | null => null),
    ])
    const ownerOk = ownerAccountCheck({
      owner: plan.owner,
      publicKeyHex: plan.ownerPublicKeyHex,
      code: ownerCode,
      rules: ownerRules,
      expected: { wasmHash: sa?.wasmHash, webauthnVerifier: sa?.webauthnVerifier },
    })
    if (!ownerOk.ok) {
      sendJson(res, ownerOk.status, { ok: false, code: ownerOk.code, reason: `${ownerOk.reason}. Nothing was deployed and nothing was spent.`, network: chain.caip2, owner: plan.owner })
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
      ownerCheck: {
        read: 'live',
        wasmHash: sa?.wasmHash,
        ruleId: ownerOk.ruleId,
        signer: { kind: 'webauthn', verifier: ownerOk.verifier, publicKeyHex: plan.ownerPublicKeyHex },
        note: 'The smart account runs the registry\'s account wasm and its only signer is this passkey, read off the ledger before the deploy.',
      },
      operator,
      // The deploy and the seed are sourced and paid by the operator account, not by the relayer.
      feePayer: operator ? { account: operator, who: 'operator' } : null,
      token: token.address,
      tokenSymbol: token.symbol,
      vaultWasmHash: chain.contracts.spendVaultWasmHash ?? null,
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

    // Charged here and not earlier: a prepared answer spends nothing, so it must not spend
    // the day's budget either. Refunded below on every path where the seed does not land.
    const charged = seeds.charge(chain.caip2, plan.seedUsd, caps)
    if (!charged.ok) {
      res.setHeader('Retry-After', String(charged.retryAfterSeconds))
      sendJson(res, charged.status, { ok: false, code: charged.code, reason: charged.reason, network: chain.caip2, seedBudget: seeds.snapshot(chain.caip2, caps) })
      return true
    }
    const refundSeed = () => seeds.refund(chain.caip2, plan.seedUsd)

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
      refundSeed()
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
          refundSeed()
        } else {
          const moved = await adapter.sacTransferFromSigner(token.address, deployed.vault, plan.seedRaw, env)
          // Only a settled transfer keeps the charge. Anything else means the USDC is still
          // ours, and a budget that counted it would shrink for money that never moved.
          if (moved.outcome !== 'settled') refundSeed()
          seed = {
            amountUsd: plan.seedUsd,
            outcome: moved.outcome,
            ...('txHash' in moved ? { txHash: moved.txHash, explorerUrl: moved.explorerUrl } : {}),
            ...('ledger' in moved ? { ledger: moved.ledger } : {}),
            ...('reason' in moved ? { reason: moved.reason } : {}),
          }
        }
      } catch (e) {
        refundSeed()
        seed = { amountUsd: plan.seedUsd, outcome: 'error', reason: `the seed transfer was not attempted: ${e instanceof Error ? e.message : String(e)}` }
      }
    }

    // owner() read back from the new vault, so the page shows the chain's answer rather than
    // the argument we passed. A read that fails says so; it does not undo a settled deploy.
    let ownerReadBack: Record<string, unknown>
    try {
      const v = await adapter.readVault(deployed.vault, env)
      ownerReadBack = { read: 'live', owner: v.owner, matches: v.owner.trim() === plan.owner, operator: v.operator }
    } catch (e) {
      ownerReadBack = { read: 'failed', owner: null, matches: null, reason: e instanceof Error ? e.message : String(e) }
    }

    sendJson(res, 200, {
      ok: true,
      outcome: 'settled',
      ...base,
      vault: deployed.vault,
      explorerUrl: addressUrl(chain, deployed.vault),
      deploy: { txHash: deployed.txHash, explorerUrl: deployed.explorerUrl, ledger: deployed.ledger },
      ownerReadBack,
      seed,
      note:
        `Vault ${deployed.vault} is owned by the smart account ${plan.owner} and operated by ${operator}. The owner's ` +
        'passkey signs set_policy, set_allowed, set_frozen and withdraw through the smart account (relayed via POST /api/stellar/passkey/relay); ' +
        `the operator signs pay() (POST /api/stellar/passkey/agent-pay), only to payees the owner allowlisted and only inside the owner's policy.` +
        (chain.testnet ? ' Testnet: a reset takes all of this with it.' : ''),
    })
    return true
  }

  // ── POST /api/stellar/passkey/allowlist/plan - KYA decision onto the allowlist ──
  if (req.method === 'POST' && url.pathname === '/api/stellar/passkey/allowlist/plan') {
    const body = (await readBody(req).catch(() => null)) as { network?: unknown } | null
    const gate = chainOf(body?.network)
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
    const gate = chainOf(body?.network)
    if (!gate.ok) return refuseChain(gate, 'ok')
    const chain = gate.chain
    const payCaps = passkeyCaps(chain)
    const plan = passkeyAgentPayPlan(body, tokenDecimals(chain), payCaps, chain.caip2)
    if (!plan.ok) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: plan.reason, network: chain.caip2, maxUsd: payCaps.agentPayMaxUsd })
      return true
    }
    const adapter = adapterFor(chain)
    const base = { network: chain.id, caip2: chain.caip2, contract: plan.contract, to: plan.to, amountUsd: plan.amountUsd, amountRaw: plan.amountRaw }
    const flagship = flagshipVaults(chain)
    const expectedWasmHash = chain.contracts.smartAccount?.wasmHash

    // A flagship vault is refused before anything else, prepared answer included: the
    // exact pay() call on it is not something this public endpoint should hand out either.
    if (flagship.includes(plan.contract)) {
      const g = operatorGate(plan.contract, { flagship, signer: null, live: null, ownerCode: null, expectedWasmHash })
      if (!g.ok) {
        sendJson(res, g.status, { ok: false, ...base, code: g.code, reason: g.reason })
        return true
      }
    }

    const signer = signerOf(chain, env)
    if (!signer) {
      const prepared = await adapter.policyPay(plan.contract, plan.to, plan.amountRaw, env)
      sendJson(res, 200, { ok: false, ...base, outcome: prepared.outcome, ...('reason' in prepared ? { reason: prepared.reason } : {}), note: 'No operator key is configured, so this is the exact pay() call and nothing was submitted.' })
      return true
    }
    let live: { owner: string; operator: string } | null = null
    let readError: string | null = null
    try {
      const v = await adapter.readVault(plan.contract, env)
      live = { owner: v.owner, operator: v.operator }
    } catch (e) {
      readError = e instanceof Error ? e.message : String(e)
    }
    const owner = live?.owner.trim() ?? ''
    const ownerCode = live && live.operator.trim() === signer && isContractId(owner) ? await codeOf(chain, owner) : null
    const g = operatorGate(plan.contract, { flagship, signer, live, ownerCode, expectedWasmHash })
    if (!g.ok) {
      sendJson(res, g.status, { ok: false, ...base, code: g.code, reason: readError && g.code === 'rpc_error' ? `${g.reason} (${readError})` : g.reason })
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
      owner: g.owner,
      // pay() is sourced and paid by the operator account, never by the relayer.
      feePayer: { account: signer, who: 'operator' },
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
