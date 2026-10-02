/**
 * The Stellar spend vaults: three public reads, and the two halves of an owner-signed write.
 *
 * Thin adapters only. Every decision (which entrypoints exist, what their arguments mean,
 * whose wallet may be a source, which contracts may be addressed, how a ledger TTL becomes
 * a date, how raw state becomes the panel's numbers) lives in ../stellar-vault.ts, where it
 * is unit-tested with no network. Everything that touches XDR lives in the Stellar adapter.
 * This file reads a request, calls those two, and picks a status code.
 *
 * Why there are two write endpoints rather than one. On Soroban the vault's owner is the
 * human's own account by construction: `__constructor` refuses `owner == operator`, we hold
 * only the operator key, and every owner entrypoint calls `owner.require_auth()`. There is
 * no configuration in which this server could sign `set_policy`. So `prepare` builds the
 * exact transaction and proves by simulation that the contract would accept it, the owner's
 * wallet signs it, and `submit` broadcasts what comes back. We never hold the key, and the
 * fee is charged to the owner's own account because the owner's account is the source.
 * Nothing in this file can produce an owner authorization: the only signature on what
 * `submit` relays is the one the owner's wallet put there.
 *
 * Both writes sit behind the verified-session gate in http.ts, like every other POST under
 * /api/ that is not payment-gated. The reads are open on purpose: a deployed vault's limits
 * are on a public ledger already, and the point of publishing them is that a claim about a
 * budget an agent cannot exceed should be checkable by someone who does not trust us.
 *
 * Every non-2xx body carries a `code` from one closed list (bad_request, unknown_vault,
 * not_owner, wrong_network, insufficient_xlm, no_trustline, refused, restore_needed,
 * pending, not_accepted, failed on the writes; bad_request, not_found, not_a_spend_vault,
 * read_failed on the reads), so a client can branch on it and never has to parse a reason.
 */
import { CHAINS, addressUrl, createStellarAdapter, isAccountId, isContractId, type StellarAdapter } from '../chains/index.js'
// Direct, like x402-stellar-routes.ts reaches for the Stellar client: the frozen error table
// and the simulation-error class are not part of the chains barrel.
import { SimulationError, errorNameFor } from '../chains/stellar/adapter.js'
import type { ChainDescriptor } from '../chains/types.js'
import { getUserWallets, listPlatformAgents } from '../platform.js'
import {
  TtlCache,
  authorizeCaller,
  authorizeCallerAndVault,
  authorizeOwnerCall,
  isAllowedBody,
  isOwnerAction,
  knownBuildOf,
  ownerCallPlan,
  registryVaultSlots,
  vaultListed,
  vaultReadBody,
  vaultReport,
  type AuthorizeResult,
  type OwnerCallArgs,
  type StellarVaultReport,
  type VaultObservation,
  type VaultReadBody,
  type VaultRole,
} from '../stellar-vault.js'
import { readBody, sendJson, type RouteCtx } from './shared.js'

/** The adapter surface this group uses, so a test can stand in for it without a ledger. */
export type VaultRouteAdapter = Pick<
  StellarAdapter,
  | 'readVault'
  | 'readInstanceTtl'
  | 'readExecutableWasmHash'
  | 'readTokenSymbol'
  | 'isAllowed'
  | 'prepareOwnerCall'
  | 'inspectOwnerEnvelope'
  | 'submitSignedEnvelope'
>

/** Seams for the offline tests. Production passes nothing and every default is the live thing. */
export type StellarVaultRouteDeps = {
  adapter?: (chain: ChainDescriptor) => VaultRouteAdapter
  /** The clock the read cache and the expiry check use. */
  now?: () => number
  agents?: () => { owner?: string; vaultAddress?: string; vaultChainCaip2?: string; vaults?: { chainCaip2: string; address: string }[] }[]
  linkedWallets?: (caller?: string) => { ecosystem: string; address: string }[]
}

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

/** The sentence every "which network?" refusal uses, naming both spellings it accepts. */
function networkHint(): string {
  return CHAINS.filter((c) => c.ecosystem === 'stellar')
    .map((c) => `${c.id} (${c.caip2})`)
    .join(' or ')
}

/**
 * The settlement token's decimals, used ONLY to check an owner call's shape before the gate.
 * The call that is built is scaled by the vault's own decimals, read live: a known build may
 * hold any SEP-41 token, and scaling a 6-decimal vault's withdrawal at 7 would sign ten times
 * the amount the review screen showed.
 */
function tokenDecimals(chain: ChainDescriptor): number {
  return chain.settlementTokens?.[0]?.decimals ?? chain.usdcDecimals ?? 7
}

/** Decimals a vault can report and still be scaled to: a whole number an i128 can carry. */
function usableDecimals(d: unknown): d is number {
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 30
}

/** Every contract a registry slot names on this chain: flagship, D2, D3 and the rehearsal. */
function registryVaultsOn(chain: ChainDescriptor): string[] {
  return registryVaultSlots(chain).map((s) => s.contract)
}

// ── caches ─────────────────────────────────────────────────────────────────────────

/** The clock the caches read, set from the deps at the top of every request. */
let clock: () => number = Date.now

/**
 * The single-vault read, cached for at most 5 seconds per (network, contract).
 *
 * Five seconds is one ledger close. Twelve simulations and a ledger-entry read per request
 * is real work on an open endpoint, and a panel that refreshes or two readers looking at the
 * same vault should not each cost that; but the answer carries its own ledger and readAt, and
 * a number older than one ledger stops being "live" in any sense a person would accept. A
 * settled owner call busts the entry for its vault, so the panel never shows the state from
 * before a change the same person just made.
 */
const READ_CACHE_MS = 5_000
const readCache = new TtlCache<VaultReadBody>(READ_CACHE_MS, () => clock())
const readKey = (chain: ChainDescriptor, contract: string) => `${chain.caip2}|${contract}`

/**
 * The vault list, cached for 30 seconds. Its stamps say how stale it is; the single-vault
 * read above is the one a panel polls.
 */
const LIST_CACHE_MS = 30_000
let listCache: { at: number; body: { vaults: StellarVaultReport[]; checkedAt: string } } | null = null

/** Drop what we hold about one vault after a write to it settled. */
function bustVault(chain: ChainDescriptor, contract: string): void {
  readCache.deleteWhere((k) => k === readKey(chain, contract))
  listCache = null
}

/** TEST ONLY: drop every memo so a test never reads another test's answer. */
export function __clearStellarVaultCacheForTests(): void {
  listCache = null
  readCache.clear()
}

// ── the vault list ─────────────────────────────────────────────────────────────────

/** The `label` each slot has always carried, kept so a reader of the old list sees nothing move. */
const ROW_LABELS: Record<VaultRole, string> = {
  flagship: 'flagship vault',
  'wallet-owned': 'wallet-owned vault (browser wallet owner)',
  'device-passkey': 'device-passkey vault (smart account owner)',
  rehearsal: 'passkey-owned vault (smart account owner)',
}

/**
 * Every vault row this endpoint publishes: the flagship vault per network first, then the
 * other slots each network fills. The flagship rows keep their old position and shape; the
 * rest are extra rows, each with a role and its honest label.
 */
function vaultRows(): { chain: ChainDescriptor; contract: string; role: VaultRole }[] {
  const stellar = CHAINS.filter((c) => c.ecosystem === 'stellar')
  const slots = stellar.flatMap((chain) => registryVaultSlots(chain).map((s) => ({ chain, ...s })))
  return [...slots.filter((s) => s.role === 'flagship'), ...slots.filter((s) => s.role !== 'flagship')]
}

/**
 * Read one vault live: its state, the ledger it was read at, and how long its instance
 * entry has left. Never throws; an unreachable network is an observation.
 */
async function observe(a: VaultRouteAdapter, contract: string): Promise<VaultObservation> {
  const checkedAt = new Date(clock()).toISOString()
  try {
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

async function vaultsView(adapterFor: (c: ChainDescriptor) => VaultRouteAdapter): Promise<{ vaults: StellarVaultReport[]; checkedAt: string }> {
  const now = clock()
  if (listCache && now - listCache.at < LIST_CACHE_MS) return listCache.body
  const reports = await Promise.all(
    vaultRows().map(async ({ chain, contract, role }) => {
      const obs = await observe(adapterFor(chain), contract)
      return vaultReport(chain, contract, addressUrl(chain, contract), obs, now, ROW_LABELS[role], role)
    }),
  )
  const body = { vaults: reports, checkedAt: new Date(now).toISOString() }
  listCache = { at: now, body }
  return body
}

// ── the single-vault reads ─────────────────────────────────────────────────────────

/** A read refusal, in the one shape every read error has. */
function readError(
  res: RouteCtx['res'],
  status: number,
  error: 'bad_request' | 'not_found' | 'not_a_spend_vault' | 'read_failed',
  reason: string,
  extra: Record<string, unknown> = {},
): true {
  sendJson(res, status, { error, code: error, reason, ...extra })
  return true
}

/**
 * The network and contract a read names, or the 400 that says which one is wrong. Shared by
 * both single-vault reads so they cannot disagree about what a valid request is.
 */
function readTarget(ctx: RouteCtx): { chain: ChainDescriptor; contract: string } | null {
  const chain = stellarChain(ctx.url.searchParams.get('network'))
  if (!chain) {
    readError(ctx.res, 400, 'bad_request', `network must name a Stellar chain: ${networkHint()}. It is never guessed.`)
    return null
  }
  const contract = (ctx.url.searchParams.get('contract') ?? '').trim()
  if (!isContractId(contract)) {
    readError(ctx.res, 400, 'bad_request', 'contract must be a Soroban contract id (C... StrKey).')
    return null
  }
  return { chain, contract }
}

type Executable = Awaited<ReturnType<VaultRouteAdapter['readExecutableWasmHash']>>

/**
 * Is there a contract here, and is it worth asking the vault views at all? Answers the 404,
 * the 422 for a contract that runs no wasm (a token, say), and the 502 for a ledger read that
 * did not come back. Returns the executable on success.
 */
async function executableOr(ctx: RouteCtx, a: VaultRouteAdapter, chain: ChainDescriptor, contract: string): Promise<Executable | null> {
  let exe: Executable
  try {
    exe = await a.readExecutableWasmHash(contract)
  } catch (e) {
    readError(ctx.res, 502, 'read_failed', `the instance entry of ${contract} could not be read on ${chain.name}: ${e instanceof Error ? e.message : String(e)}`, {
      at: new Date(clock()).toISOString(),
    })
    return null
  }
  if (!exe.found) {
    readError(ctx.res, 404, 'not_found', `no contract instance exists at ${contract} on ${chain.name} (read at ledger ${exe.ledger}).`, {
      ledger: exe.ledger,
    })
    return null
  }
  if (exe.executable !== 'wasm' || !exe.wasmHash) {
    readError(
      ctx.res,
      422,
      'not_a_spend_vault',
      `${contract} on ${chain.name} runs ${exe.executable === 'stellar-asset' ? 'the built-in Stellar Asset Contract' : 'no wasm this server can read'}, not an AgentSpendPolicy.`,
      { wasmHash: exe.wasmHash ?? null },
    )
    return null
  }
  return exe
}

/**
 * A view call that failed, turned into the right refusal. A contract that ANSWERED with an
 * error and runs code we did not publish is not a vault we can read (422). A known build that
 * failed, or a host that did not answer, is a read that failed (502), stamped with when.
 */
function viewFailure(res: RouteCtx['res'], e: unknown, known: boolean, wasmHash: string, chain: ChainDescriptor, contract: string): true {
  const reason = e instanceof Error ? e.message : String(e)
  if (e instanceof SimulationError && !known) {
    return readError(
      res,
      422,
      'not_a_spend_vault',
      `${contract} on ${chain.name} does not answer the AgentSpendPolicy views (${reason}), and wasm ${wasmHash} is not a build we published.`,
      { wasmHash },
    )
  }
  return readError(res, 502, 'read_failed', `the vault's views could not be read on ${chain.name}: ${reason}. Nothing is shown rather than a stale number.`, {
    at: new Date(clock()).toISOString(),
    wasmHash,
  })
}

// ── the owner-call gate, shared by prepare and submit ──────────────────────────────

/**
 * Which public `code` an internal gate refusal carries. The gate's own codes are finer than
 * the shared list; the finer one rides along as `reasonCode` so nothing is lost.
 */
function gateBody(r: Extract<AuthorizeResult, { ok: false }>): { status: number; body: Record<string, unknown> } {
  if (r.code === 'not_your_wallet') {
    return { status: 403, body: { ok: false, code: 'not_owner', reasonCode: 'not_your_wallet', reason: r.reason } }
  }
  if (r.code === 'rpc_error') {
    return { status: 502, body: { ok: false, code: 'failed', resultCode: 'rpc_error', reason: r.reason } }
  }
  return { status: r.status, body: { ok: false, code: r.code, reason: r.reason } }
}

/**
 * Run the whole gate for an owner call: wallet first (no network), then the vault (a
 * registry slot, an agent the caller owns, or, only if neither, one ledger read to see
 * whether it runs a build we published), then the live owner. Returns the live vault's token
 * and decimals on success: prepare needs the token for the trustline preflight and the
 * decimals to scale every amount in the call.
 */
async function gate(
  ctx: RouteCtx,
  deps: StellarVaultRouteDeps,
  a: VaultRouteAdapter,
  chain: ChainDescriptor,
  contract: string,
  source: string,
): Promise<{ ok: true; token: string; decimals: number | null } | { ok: false; status: number; body: Record<string, unknown> }> {
  const who = {
    source,
    contract,
    caller: ctx.callerId,
    callerIsWallet: ctx.caller?.method === 'wallet',
    linkedWallets: linkedStellarWallets(deps, ctx.callerId),
    registryVaults: registryVaultsOn(chain),
    ownedVaults: ownedVaultsOn(deps, chain, ctx.callerId),
  }
  const wallet = authorizeCaller(who)
  if (!wallet.ok) return { ok: false, ...gateBody(wallet) }

  // Only a vault with no other way in costs the wasm read. A read that does not come back
  // leaves knownBuild false, which refuses: an unknown build is never let through by default.
  let knownBuild: boolean | undefined
  if (!vaultListed(who)) {
    try {
      const exe = await a.readExecutableWasmHash(contract)
      knownBuild = exe.found && exe.executable === 'wasm' && knownBuildOf(chain, exe.wasmHash).known
    } catch {
      knownBuild = false
    }
  }
  const vault = authorizeCallerAndVault({ ...who, knownBuild })
  if (!vault.ok) return { ok: false, ...gateBody(vault) }

  // Then the owner, read live. Our stored copy is a copy; the ledger is the fact, and a
  // read that will not answer stops the request rather than waving it on.
  let liveOwner: string | null = null
  let token = ''
  let decimals: number | null = null
  try {
    const state = await a.readVault(contract)
    liveOwner = state.owner
    token = state.token
    decimals = state.decimals
  } catch {
    liveOwner = null
  }
  const owner = authorizeOwnerCall({ ...who, knownBuild, liveOwner })
  if (!owner.ok) return { ok: false, ...gateBody(owner) }
  return { ok: true, token, decimals }
}

/** Vaults recorded on agents this caller owns, on this network. Both the flat field and
 *  the additive `vaults[]` array, so a multi-chain agent is not half-seen. */
function ownedVaultsOn(deps: StellarVaultRouteDeps, chain: ChainDescriptor, caller?: string): string[] {
  if (!caller) return []
  const out = new Set<string>()
  for (const agent of (deps.agents ?? listPlatformAgents)()) {
    if (!agent.owner || agent.owner !== caller) continue
    if (agent.vaultAddress && agent.vaultChainCaip2 === chain.caip2) out.add(agent.vaultAddress)
    for (const v of agent.vaults ?? []) if (v.chainCaip2 === chain.caip2) out.add(v.address)
  }
  return [...out]
}

/** Stellar wallets this account has proven control of, beyond the session's own. */
function linkedStellarWallets(deps: StellarVaultRouteDeps, caller?: string): string[] {
  return (deps.linkedWallets ?? getUserWallets)(caller)
    .filter((w) => w.ecosystem === 'stellar' && isAccountId(w.address))
    .map((w) => w.address)
}

// ── the handler ────────────────────────────────────────────────────────────────────

export async function handleStellarVaultRoutes(ctx: RouteCtx, deps: StellarVaultRouteDeps = {}): Promise<boolean> {
  const { req, res, url } = ctx
  if (!url.pathname.startsWith('/api/stellar/vault')) return false
  clock = deps.now ?? Date.now
  const adapterFor = deps.adapter ?? ((chain: ChainDescriptor) => createStellarAdapter(chain))

  // ── GET /api/stellar/vaults - every registry vault, live, public ───────────────
  if (req.method === 'GET' && url.pathname === '/api/stellar/vaults') {
    sendJson(res, 200, {
      ...(await vaultsView(adapterFor)),
      note:
        'Live reads of the AgentSpendPolicy instances the registry declares, cached for 30 s. ' +
        'TTL days are an estimate from the ledger close time stated beside them, not a promise. ' +
        'ownerKind is read off each vault\'s live owner: account for a G... wallet, smart-account ' +
        'for a C... account whose owner calls are signed through its own signer. role and roleLabel ' +
        'say which registry slot a row comes from and what it is evidence of.',
    })
    return true
  }

  // ── GET /api/stellar/vault/read - one vault, any contract, live, public ────────
  if (req.method === 'GET' && url.pathname === '/api/stellar/vault/read') {
    const target = readTarget(ctx)
    if (!target) return true
    const { chain, contract } = target
    const cached = readCache.get(readKey(chain, contract))
    if (cached) {
      sendJson(res, 200, cached)
      return true
    }

    const a = adapterFor(chain)
    const exe = await executableOr(ctx, a, chain, contract)
    if (!exe) return true
    const wasmHash = exe.wasmHash as string
    const known = knownBuildOf(chain, wasmHash).known

    let state: Awaited<ReturnType<VaultRouteAdapter['readVault']>>
    try {
      state = await a.readVault(contract)
    } catch (e) {
      return viewFailure(res, e, known, wasmHash, chain, contract)
    }
    // The registry's symbol when the token is one it vouches for; otherwise the token's own
    // answer, read live, and said to be unreadable rather than guessed when it is not.
    const listed = (chain.settlementTokens ?? []).find((t) => t.address === state.token)?.symbol
    const tokenSymbol = listed ?? (await a.readTokenSymbol(state.token).catch(() => 'unreadable'))

    const body = vaultReadBody({
      chain,
      contract,
      state,
      wasmHash,
      ttl: { liveUntilLedger: exe.liveUntilLedger, archived: exe.archived },
      explorerUrl: addressUrl(chain, contract),
      tokenSymbol,
      ledger: Math.max(state.ledger ?? 0, exe.ledger),
      readAt: new Date(clock()).toISOString(),
      nowMs: clock(),
    })
    readCache.set(readKey(chain, contract), body)
    sendJson(res, 200, body)
    return true
  }

  // ── GET /api/stellar/vault/is-allowed - one payee, live, public ────────────────
  if (req.method === 'GET' && url.pathname === '/api/stellar/vault/is-allowed') {
    const target = readTarget(ctx)
    if (!target) return true
    const { chain, contract } = target
    const address = (url.searchParams.get('address') ?? '').trim()
    if (!isAccountId(address) && !isContractId(address)) {
      return readError(res, 400, 'bad_request', 'address must be a Stellar account (G...) or a contract (C...).')
    }
    const a = adapterFor(chain)
    const exe = await executableOr(ctx, a, chain, contract)
    if (!exe) return true
    const wasmHash = exe.wasmHash as string
    try {
      const r = await a.isAllowed(contract, address)
      sendJson(res, 200, isAllowedBody({ chain, contract, address, ...r, readAt: new Date(clock()).toISOString() }))
    } catch (e) {
      viewFailure(res, e, knownBuildOf(chain, wasmHash).known, wasmHash, chain, contract)
    }
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

    // The shape is checked first, at the registry token's precision, so a malformed body is
    // refused before the gate spends a read. The plan that is BUILT comes after the gate.
    const shape = ownerCallPlan(body.action, body?.args ?? {}, tokenDecimals(chain))
    if (!shape.ok) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: shape.reason })
      return true
    }

    const adapter = adapterFor(chain)
    const g = await gate(ctx, deps, adapter, chain, contract, source)
    if (!g.ok) {
      sendJson(res, g.status, g.body)
      return true
    }

    // Every amount is scaled by the decimals THIS vault stored from its own token at
    // construction, which the console also checks its input against. A vault whose decimals
    // cannot be used is refused rather than scaled by a guess.
    if (!usableDecimals(g.decimals)) {
      sendJson(res, 502, {
        ok: false,
        code: 'failed',
        resultCode: 'vault_decimals_unreadable',
        reason: `the vault reported decimals ${String(g.decimals)}, which no amount can be scaled by, so nothing was built`,
      })
      return true
    }
    const plan = ownerCallPlan(body.action, body?.args ?? {}, g.decimals)
    if (!plan.ok) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: plan.reason })
      return true
    }

    const built = await adapter.prepareOwnerCall(contract, plan.method, plan.args, source, undefined, { vaultToken: g.token || undefined })
    if (!built.ok) {
      const common = { ok: false, reason: built.reason }
      if (built.code === 'refused') {
        // Named only when OUR contract raised it and the entrypoint can raise that code.
        sendJson(res, 409, {
          ...common,
          code: 'refused',
          errorName: built.contractErrorName ?? null,
          errorCode: built.contractErrorCode ?? null,
          ...(built.contractErrorFrom ? { errorFrom: built.contractErrorFrom } : {}),
          ...(built.contractErrorCode !== undefined ? { contractErrorCode: built.contractErrorCode } : {}),
          ...(built.contractErrorName ? { contractErrorName: built.contractErrorName } : {}),
        })
      } else if (built.code === 'insufficient_xlm') {
        sendJson(res, 409, { ...common, code: 'insufficient_xlm', availableXlm: built.availableXlm, neededXlm: built.neededXlm })
      } else if (built.code === 'no_trustline') {
        sendJson(res, 409, { ...common, code: 'no_trustline', destination: built.destination, asset: built.asset })
      } else if (built.code === 'restore_needed') {
        sendJson(res, 409, { ...common, code: 'restore_needed' })
      } else if (built.code === 'rpc_error') {
        sendJson(res, 502, { ...common, code: 'failed', resultCode: 'rpc_error' })
      } else {
        sendJson(res, 400, { ...common, code: 'bad_request' })
      }
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
      source,
      summary: `${plan.summary}. ${built.summary}`,
      expiresAtLedger: built.expiresAtLedger,
      validUntil: built.validUntil,
      feeStroops: built.feeStroops,
      feeXlm: built.feeXlm,
      archivedEntries: built.archivedEntries,
      ...(built.restoreNeeded ? { restoreNeeded: true } : {}),
      preflight: built.preflight,
      note:
        `This transaction is NOT signed. Its source account ${source} pays the ` +
        `${built.feeXlm} XLM fee, not this server, and this server never holds your key. ` +
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

    const adapter = adapterFor(chain)
    // Read the envelope BEFORE submitting: the allowlist and the ownership check are the
    // only things between this endpoint and an open relay, and both need what is inside.
    const seen = adapter.inspectOwnerEnvelope(body.xdr.trim())
    if (!seen.ok) {
      sendJson(res, seen.code === 'wrong_network' ? 409 : 400, { ok: false, code: seen.code, reason: seen.reason })
      return true
    }

    const g = await gate(ctx, deps, adapter, chain, seen.contract, seen.source)
    if (!g.ok) {
      sendJson(res, g.status, g.body)
      return true
    }

    const sent = await adapter.submitSignedEnvelope(body.xdr.trim())
    const outcome = sent.outcome
    if (!outcome) {
      sendJson(res, 400, { ok: false, code: 'bad_request', reason: 'the envelope could not be read after it was accepted, so nothing was submitted' })
      return true
    }

    const base = {
      ok: outcome.outcome === 'settled',
      outcome: outcome.outcome,
      network: chain.id,
      caip2: chain.caip2,
      contract: seen.contract,
      action: seen.method,
      ...('txHash' in outcome ? { txHash: outcome.txHash, hash: outcome.txHash, explorerUrl: outcome.explorerUrl } : {}),
      ...('ledger' in outcome ? { ledger: outcome.ledger } : {}),
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...('contractErrorCode' in outcome && outcome.contractErrorCode !== undefined ? { contractErrorCode: outcome.contractErrorCode } : {}),
    }

    if (outcome.outcome === 'settled') {
      // The vault changed, so neither cache may serve its old state for another second.
      bustVault(chain, seen.contract)
      sendJson(res, 200, {
        ...base,
        status: 'settled',
        ...(outcome.feeChargedStroops ? { feeChargedStroops: outcome.feeChargedStroops } : {}),
        note: 'In the ledger and successful. This server signed nothing and paid nothing.',
      })
      return true
    }

    if (outcome.outcome === 'pending') {
      sendJson(res, 202, {
        ...base,
        status: 'pending',
        code: 'pending',
        note: 'Submitted and not in a ledger yet. It stays valid for its full timeout, so it may still land: do not re-sign it and do not record it as failed.',
      })
      return true
    }

    if (outcome.outcome === 'failed') {
      // In a ledger, and failed: the fee is spent and nothing moved. When OUR contract
      // refused it with a code that entrypoint can raise, that is a typed refusal and says so.
      const e =
        outcome.contractErrorCode !== undefined ? { code: outcome.contractErrorCode, ours: outcome.contractErrorIsOurs !== false } : undefined
      const name = errorNameFor(seen.method, e)
      sendJson(res, 409, {
        ...base,
        code: name ? 'refused' : 'failed',
        landed: true,
        resultCode: outcome.resultCode ?? 'txFailed',
        ...(outcome.opResultCode ? { opResultCode: outcome.opResultCode } : {}),
        ...(name ? { errorName: name, errorCode: outcome.contractErrorCode, contractErrorName: name } : {}),
        ...(outcome.contractErrorFrom ? { errorFrom: outcome.contractErrorFrom } : {}),
        note: 'In a ledger and failed. It consumed the fee from your account and moved nothing.',
      })
      return true
    }

    if (outcome.outcome === 'refused' && outcome.rejection) {
      const r = outcome.rejection
      const hash = outcome.rejectedHash
      if (r.code === 'insufficient_balance') {
        sendJson(res, 409, {
          ...base,
          code: 'insufficient_xlm',
          resultCode: r.resultCode,
          availableXlm: outcome.xlm?.availableXlm ?? 'unknown',
          neededXlm: outcome.xlm?.neededXlm ?? 'unknown',
          note: 'Nothing landed and no fee was charged. Add XLM to the owner account, then prepare the call again.',
        })
      } else if (r.code === 'error') {
        sendJson(res, 409, { ...base, code: 'failed', resultCode: r.resultCode, ...(hash ? { hash } : {}), note: 'Nothing landed and no fee was charged.' })
      } else {
        // TRY_AGAIN_LATER, a stale sequence, or a fee bid below the market: nothing landed,
        // and a fresh prepare and signature is the whole fix.
        sendJson(res, 409, {
          ...base,
          code: 'not_accepted',
          resultCode: r.resultCode,
          ...(hash ? { hash } : {}),
          note:
            r.code === 'not_accepted'
              ? 'The network did not take it into its queue. Nothing landed; it is safe to submit again in a few seconds.'
              : 'Nothing landed and no fee was charged. Prepare the call again and sign the new envelope.',
        })
      }
      return true
    }

    // A refusal with no rejection, or `prepared`, which this path should never produce.
    sendJson(res, 502, { ...base, code: 'failed', resultCode: outcome.outcome === 'prepared' ? 'not_submitted' : 'rpc_error', note: 'Nothing settled.' })
    return true
  }

  return false
}
