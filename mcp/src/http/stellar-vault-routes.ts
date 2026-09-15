/**
 * The Stellar spend vaults: a public read, and the two halves of an owner-signed write.
 *
 * Thin adapters only. Every decision (which entrypoints exist, what their arguments mean,
 * whose wallet may be a source, which contracts may be addressed, how a ledger TTL becomes
 * a date) lives in ../stellar-vault.ts, where it is unit-tested with no network. Everything
 * that touches XDR lives in the Stellar adapter. This file reads a body, calls those two,
 * and picks a status code.
 *
 * Why there are two write endpoints rather than one. On Soroban the vault's owner is the
 * human's own account by construction: `__constructor` refuses `owner == operator`, we hold
 * only the operator key, and every owner entrypoint calls `owner.require_auth()`. There is
 * no configuration in which this server could sign `set_policy`. So `prepare` builds the
 * exact transaction and proves by simulation that the contract would accept it, the owner's
 * wallet signs it, and `submit` broadcasts what comes back. We never hold the key, and the
 * fee is charged to the owner's own account because the owner's account is the source.
 *
 * Both writes sit behind the verified-session gate in http.ts, like every other POST under
 * /api/ that is not payment-gated. The public read is open on purpose: a deployed vault's
 * limits are on a public ledger already, and the point of publishing them is that a claim
 * about a budget an agent cannot exceed should be checkable by someone who does not trust us.
 */
import { CHAINS, addressUrl, createStellarAdapter, isAccountId, isContractId } from '../chains/index.js'
// Direct, like x402-stellar-routes.ts reaches for the Stellar client: `errorName` is the
// contract's frozen error table and is not part of the chains barrel.
import { errorName } from '../chains/stellar/adapter.js'
import type { ChainDescriptor } from '../chains/types.js'
import { getUserWallets, listPlatformAgents } from '../platform.js'
import {
  authorizeCallerAndVault,
  authorizeOwnerCall,
  isOwnerAction,
  ownerCallPlan,
  vaultReport,
  type OwnerCallArgs,
  type StellarVaultReport,
  type VaultObservation,
} from '../stellar-vault.js'
import { readBody, sendJson, type RouteCtx } from './shared.js'

/** Every Stellar chain in the registry that declares a flagship vault. */
function vaultChains(): ChainDescriptor[] {
  return CHAINS.filter((c) => c.ecosystem === 'stellar' && Boolean(c.contracts.spendVault))
}

/** A Stellar chain by registry id or CAIP-2, or null. Never guessed: the two networks
 *  differ by a passphrase, and guessing is how a testnet signature meets pubnet. */
function stellarChain(want: unknown): ChainDescriptor | null {
  if (typeof want !== 'string' || !want.trim()) return null
  const key = want.trim()
  return CHAINS.find((c) => c.ecosystem === 'stellar' && (c.id === key || c.caip2 === key)) ?? null
}

/** The settlement token's decimals, which on Stellar is 7 and is never assumed to be. */
function tokenDecimals(chain: ChainDescriptor): number {
  return chain.settlementTokens?.[0]?.decimals ?? chain.usdcDecimals ?? 7
}

/** Vaults recorded on agents this caller owns, on this network. Both the flat field and
 *  the additive `vaults[]` array, so a multi-chain agent is not half-seen. */
function ownedVaultsOn(chain: ChainDescriptor, caller?: string): string[] {
  if (!caller) return []
  const out = new Set<string>()
  for (const agent of listPlatformAgents()) {
    if (!agent.owner || agent.owner !== caller) continue
    if (agent.vaultAddress && agent.vaultChainCaip2 === chain.caip2) out.add(agent.vaultAddress)
    for (const v of agent.vaults ?? []) if (v.chainCaip2 === chain.caip2) out.add(v.address)
  }
  return [...out]
}

/** Stellar wallets this account has proven control of, beyond the session's own. */
function linkedStellarWallets(caller?: string): string[] {
  return getUserWallets(caller)
    .filter((w) => w.ecosystem === 'stellar' && isAccountId(w.address))
    .map((w) => w.address)
}

/**
 * Read one vault live: its state, the ledger it was read at, and how long its instance
 * entry has left. Never throws; an unreachable network is an observation.
 */
async function observe(chain: ChainDescriptor, contract: string): Promise<VaultObservation> {
  const checkedAt = new Date().toISOString()
  try {
    const a = createStellarAdapter(chain)
    const [state, ttl] = await Promise.all([a.readVault(contract), a.readInstanceTtl(contract)])
    const decimals = state.decimals
    const usd = (raw: string) => Number(BigInt(raw)) / 10 ** decimals
    const expiry = Number(state.sessionKeyExpiry)
    return {
      reachable: true,
      ledger: ttl.ledger,
      checkedAt,
      liveUntilLedger: ttl.liveUntilLedger,
      archived: ttl.archived,
      state: {
        owner: state.owner,
        operator: state.operator,
        token: state.token,
        decimals,
        dailyCapUsd: usd(state.dailyCapRaw),
        autoApproveUsd: usd(state.autoApproveMaxRaw),
        spentTodayUsd: usd(state.spentTodayRaw),
        balanceUsd: usd(state.balanceRaw),
        frozen: state.frozen,
        allowlistEnabled: state.allowlistEnabled,
        sessionKeyExpiry: Number.isFinite(expiry) ? expiry : 0,
      },
    }
  } catch (e) {
    return { reachable: false, checkedAt, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * The public read, cached for 30 seconds.
 *
 * Twelve simulations plus a ledger-entry read per vault is not a page-load cost, and this
 * endpoint is open. The cache is per process and deliberately short: the numbers it serves
 * are a live read with a `checkedAt` beside them, so a stale answer is only honest while
 * the stamp says how stale.
 */
const CACHE_MS = 30_000
let cache: { at: number; body: { vaults: StellarVaultReport[]; checkedAt: string } } | null = null

async function vaultsView(): Promise<{ vaults: StellarVaultReport[]; checkedAt: string }> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.body
  const chains = vaultChains()
  const reports = await Promise.all(
    chains.map(async (chain) => {
      const contract = chain.contracts.spendVault as string
      const obs = await observe(chain, contract)
      return vaultReport(chain, contract, addressUrl(chain, contract), obs, now)
    }),
  )
  const body = { vaults: reports, checkedAt: new Date(now).toISOString() }
  cache = { at: now, body }
  return body
}

/** TEST ONLY: drop the memo cache so a test never reads another test's answer. */
export function __clearStellarVaultCacheForTests(): void {
  cache = null
}

export async function handleStellarVaultRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url, caller, callerId } = ctx

  // ── GET /api/stellar/vaults - the flagship vaults, live, public ────────────────
  if (req.method === 'GET' && url.pathname === '/api/stellar/vaults') {
    sendJson(res, 200, {
      ...(await vaultsView()),
      note:
        'Live reads of the AgentSpendPolicy instances the registry declares, cached for 30 s. ' +
        'TTL days are an estimate from the ledger close time stated beside them, not a promise.',
    })
    return true
  }

  // ── POST /api/stellar/vault/prepare - build the owner call, unsigned ───────────
  if (req.method === 'POST' && url.pathname === '/api/stellar/vault/prepare') {
    const body = (await readBody(req).catch(() => null)) as
      | { network?: unknown; contract?: unknown; source?: unknown; action?: unknown; args?: OwnerCallArgs }
      | null
    const chain = stellarChain(body?.network)
    if (!chain) {
      sendJson(res, 400, {
        ok: false,
        code: 'bad_request',
        reason: `network must name a Stellar chain: ${vaultChains().map((c) => c.id).join(' or ')}`,
      })
      return true
    }
    if (!isOwnerAction(body?.action)) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: 'action must be one of set_policy, set_frozen, set_allowed, set_session_key_expiry, withdraw, owner_pay' })
      return true
    }
    const contract = typeof body?.contract === 'string' ? body.contract.trim() : ''
    const source = typeof body?.source === 'string' ? body.source.trim() : ''
    if (!isContractId(contract) || !isAccountId(source)) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: 'contract must be a Soroban contract id (C...) and source a Stellar account (G...)' })
      return true
    }

    const plan = ownerCallPlan(body.action, body?.args ?? {}, tokenDecimals(chain))
    if (!plan.ok) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: plan.reason })
      return true
    }

    // Everything answerable without the network, first. Reading the vault before asking
    // whether the caller owns the wallet would let anyone spend an RPC round trip per
    // request just by naming a contract.
    const who = {
      source,
      contract,
      caller: callerId,
      callerIsWallet: caller?.method === 'wallet',
      linkedWallets: linkedStellarWallets(callerId),
      registryVaults: [chain.contracts.spendVault as string],
      ownedVaults: ownedVaultsOn(chain, callerId),
    }
    const cheap = authorizeCallerAndVault(who)
    if (!cheap.ok) {
      sendJson(res, cheap.status, { ok: false, code: cheap.code, reason: cheap.reason })
      return true
    }

    // Then the owner, read live. Our stored copy is a copy; the ledger is the fact, and a
    // read that will not answer stops the request rather than waving it on.
    const adapter = createStellarAdapter(chain)
    let liveOwner: string | null = null
    try {
      liveOwner = (await adapter.readVault(contract)).owner
    } catch {
      liveOwner = null
    }
    const gate = authorizeOwnerCall({ ...who, liveOwner })
    if (!gate.ok) {
      sendJson(res, gate.status, { ok: false, code: gate.code, reason: gate.reason })
      return true
    }

    const built = await adapter.prepareOwnerCall(contract, plan.method, plan.args, source)
    if (!built.ok) {
      const status = built.code === 'refused' ? 409 : built.code === 'restore_needed' ? 409 : built.code === 'rpc_error' ? 502 : 400
      sendJson(res, status, {
        ok: false,
        code: built.code,
        reason: built.reason,
        ...(built.contractErrorCode !== undefined ? { contractErrorCode: built.contractErrorCode } : {}),
        ...(built.contractErrorName ? { contractErrorName: built.contractErrorName } : {}),
      })
      return true
    }

    sendJson(res, 200, {
      ok: true,
      xdr: built.xdr,
      networkPassphrase: built.networkPassphrase,
      network: chain.id,
      caip2: chain.caip2,
      contract,
      action: plan.method,
      summary: `${plan.summary}. ${built.summary}`,
      expiresAtLedger: built.expiresAtLedger,
      validUntil: built.validUntil,
      feeStroops: built.feeStroops,
      archivedEntries: built.archivedEntries,
      note:
        `This transaction is NOT signed. Its source account ${source} pays the ` +
        `${built.feeStroops} stroop fee, not this server, and this server never holds your key. ` +
        'If that account is multisig, every required signature has to be added before it is ' +
        'submitted. Send the signed envelope to POST /api/stellar/vault/submit.',
    })
    return true
  }

  // ── POST /api/stellar/vault/submit - broadcast what the owner signed ───────────
  if (req.method === 'POST' && url.pathname === '/api/stellar/vault/submit') {
    const body = (await readBody(req).catch(() => null)) as { network?: unknown; xdr?: unknown } | null
    const chain = stellarChain(body?.network)
    if (!chain) {
      sendJson(res, 400, {
        ok: false,
        code: 'bad_request',
        reason: `network must name a Stellar chain: ${vaultChains().map((c) => c.id).join(' or ')}`,
      })
      return true
    }
    if (typeof body?.xdr !== 'string' || !body.xdr.trim()) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: 'xdr must be the signed transaction envelope, base64' })
      return true
    }

    const adapter = createStellarAdapter(chain)
    // Read the envelope BEFORE submitting: the allowlist and the ownership check are the
    // only things between this endpoint and an open relay, and both need what is inside.
    const seen = adapter.inspectOwnerEnvelope(body.xdr.trim())
    if (!seen.ok) {
      sendJson(res, seen.code === 'wrong_network' ? 409 : 400, { ok: false, code: seen.code, reason: seen.reason })
      return true
    }

    const who = {
      source: seen.source,
      contract: seen.contract,
      caller: callerId,
      callerIsWallet: caller?.method === 'wallet',
      linkedWallets: linkedStellarWallets(callerId),
      registryVaults: [chain.contracts.spendVault as string],
      ownedVaults: ownedVaultsOn(chain, callerId),
    }
    const cheap = authorizeCallerAndVault(who)
    if (!cheap.ok) {
      sendJson(res, cheap.status, { ok: false, code: cheap.code, reason: cheap.reason })
      return true
    }
    let liveOwner: string | null = null
    try {
      liveOwner = (await adapter.readVault(seen.contract)).owner
    } catch {
      liveOwner = null
    }
    const gate = authorizeOwnerCall({ ...who, liveOwner })
    if (!gate.ok) {
      sendJson(res, gate.status, { ok: false, code: gate.code, reason: gate.reason })
      return true
    }

    const sent = await adapter.submitSignedEnvelope(body.xdr.trim())
    const outcome = sent.outcome
    if (!outcome) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: 'the envelope could not be read after it was accepted, so nothing was submitted' })
      return true
    }
    // Named only when OUR contract raised it. A code that propagated out of the token
    // carries a number our table does not define, and naming it would tell the caller a
    // trustline failure was a policy refusal.
    const named =
      outcome.outcome === 'refused' && outcome.contractErrorIsOurs
        ? errorName(outcome.contractErrorCode)
        : undefined
    const status =
      outcome.outcome === 'settled' ? 200 : outcome.outcome === 'pending' ? 202 : outcome.outcome === 'prepared' ? 502 : 409
    sendJson(res, status, {
      ok: outcome.outcome === 'settled',
      outcome: outcome.outcome,
      network: chain.id,
      caip2: chain.caip2,
      contract: seen.contract,
      action: seen.method,
      ...('txHash' in outcome ? { txHash: outcome.txHash, explorerUrl: outcome.explorerUrl } : {}),
      ...('ledger' in outcome ? { ledger: outcome.ledger } : {}),
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...('contractErrorCode' in outcome && outcome.contractErrorCode !== undefined
        ? { contractErrorCode: outcome.contractErrorCode }
        : {}),
      ...(named ? { contractErrorName: named } : {}),
      // Stated on every arm, because the one thing a relay must never be vague about is
      // whether the money moved.
      note:
        outcome.outcome === 'settled'
          ? 'In the ledger and successful. This server signed nothing and paid nothing.'
          : outcome.outcome === 'pending'
            ? 'Submitted and not in a ledger yet. It stays valid for its full timeout, so it may still land: do not re-sign it and do not record it as failed.'
            : 'Nothing settled.',
    })
    return true
  }

  return false
}
