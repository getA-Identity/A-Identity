/**
 * Every decision the passkey endpoints make, with no network and no Stellar SDK.
 *
 * The feature in one paragraph. A person on the public /stellar page creates a passkey; the
 * smart-account kit deploys an OpenZeppelin smart account (a C... contract) whose only signer
 * is that WebAuthn credential; this server deploys an AgentSpendPolicy vault whose OWNER is
 * that contract and whose OPERATOR is our own testnet key; the person's passkey then signs the
 * owner calls (set_policy, set_allowed) through the smart account's `execute`, the vault's
 * `owner.require_auth()` is satisfied because the smart account is the direct invoker, and the
 * agent side pays through `pay()` under the policy the passkey set. Proven live on testnet on
 * 2026-09-19; the registry's `passkeyVault` is that vault.
 *
 * Fees: the kit posts `{ func, auth }` to a relayer, and our endpoint forwards it to
 * OpenZeppelin Channels with a key we hold. Whatever we forward is paid for and broadcast
 * under our account, which makes that endpoint an open relay unless something refuses all it
 * does not positively recognise. That something is here, as pure functions over the plain
 * shape `chains/stellar/relay.ts` decodes, because a rule that can only be tested against a
 * ledger is a rule nobody re-tests after they change it:
 *
 *  - which network may be served at all (testnet, by name; pubnet refused, by name),
 *  - which host functions may be relayed (exactly three shapes, listed, never a pattern),
 *  - which authorization entries may ride along (the ones FOR that function, by byte equality),
 *  - how a KYA decision maps onto a binary on-chain allowlist,
 *  - the caps on what the operator key may be made to spend,
 *  - and what the relay may spend across everyone: a global rate limit and a 24 hour
 *    reserve against the relayer fee, both published by the status endpoint.
 *
 * `mcp/src/http/stellar-passkey-routes.ts` is the thin half: it reads the body, calls these,
 * calls the adapter, forwards to the relayer, and picks a status code.
 */
import type { RelayInspection } from './chains/stellar/relay-shape.js'
import { isAccountId, isContractId } from './chains/stellar/strkey.js'
import type { ChainDescriptor } from './chains/types.js'
import { OWNER_ACTIONS, isOwnerAction, ownerKindOf, toRawUnits, type OwnerAction } from './stellar-vault.js'

export { ownerKindOf }

/** What this release is, stated once so every endpoint says the same thing. */
export const PASSKEY_RELEASE = {
  name: 'stellar-passkey-vault',
  network: 'stellar:testnet',
  testnetOnly: true,
  relayerProduct: 'OpenZeppelin Relayer (Channels)',
  relayerName: 'openzeppelin-channels',
} as const

/**
 * What the operator key may be made to spend, in USD, by anyone on the internet.
 *
 * These endpoints have no session in front of them, so the caps ARE the authorization. A
 * vault's daily cap bounds what the agent can move per day and its ceiling what one payment
 * may be; the seed is USDC that leaves our own account for good; agent-pay is one payment.
 */
export const PASSKEY_CAPS = {
  dailyCapUsd: 10,
  autoApproveUsd: 2,
  seedUsdDefault: 0.2,
  seedUsdMax: 0.5,
  agentPayMaxUsd: 1,
} as const

// ── which network ────────────────────────────────────────────────────────────────

export type PasskeyChainGate =
  | { ok: true; chain: ChainDescriptor }
  | { ok: false; status: 400; code: 'bad_request' | 'testnet_only'; reason: string }

/**
 * The one network this release serves, resolved by registry id or CAIP-2, defaulting to
 * testnet when nothing is named. Pubnet is refused BY NAME rather than falling through: the
 * pubnet smart-account constants exist in the same OpenZeppelin release document and were
 * deliberately not recorded, and no pubnet vault has a smart-account owner.
 */
export function passkeyChain(want: unknown, chains: ChainDescriptor[]): PasskeyChainGate {
  const key = typeof want === 'string' && want.trim() ? want.trim() : PASSKEY_RELEASE.network
  const chain = chains.find((c) => c.ecosystem === 'stellar' && (c.id === key || c.caip2 === key)) ?? null
  if (!chain) {
    return { ok: false, status: 400, code: 'bad_request', reason: `network must be ${PASSKEY_RELEASE.network} (or its registry id); ${key} is not a Stellar chain in the registry` }
  }
  if (!chain.testnet || chain.caip2 !== PASSKEY_RELEASE.network) {
    return {
      ok: false,
      status: 400,
      code: 'testnet_only',
      reason:
        `${chain.caip2} is not served: the passkey vault release is TESTNET ONLY. The pubnet smart-account ` +
        'constants are deliberately not in the registry and no pubnet vault has a smart-account owner, so ' +
        'nothing here can reach real money. Nothing was submitted.',
    }
  }
  if (!chain.contracts.smartAccount) {
    return { ok: false, status: 400, code: 'testnet_only', reason: `${chain.caip2} declares no contracts.smartAccount, so no passkey account can be deployed or relayed on it` }
  }
  return { ok: true, chain }
}

// ── the relay: what may be forwarded ─────────────────────────────────────────────

/** The two bodies the smart-account kit's RelayerClient sends, verbatim. */
export type RelayParams = { func: string; auth: string[] } | { xdr: string }

/**
 * Read the kit's body. It posts `{ func, auth }` or `{ xdr }` at the top level; the OZ
 * Channels API wants the same object under `params`, and a caller who already wrapped it is
 * accepted too, so the same request can be replayed against either.
 */
export function relayParams(body: unknown): { ok: true; params: RelayParams; network: unknown } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'a JSON body is required: { func, auth } or { xdr }, optionally with network' }
  const b = body as Record<string, unknown>
  const inner = b.params && typeof b.params === 'object' ? (b.params as Record<string, unknown>) : b
  const hasFunc = inner.func !== undefined || inner.auth !== undefined
  const hasXdr = inner.xdr !== undefined
  if (hasFunc && hasXdr) return { ok: false, reason: 'send either { func, auth } or { xdr }, not both' }
  if (hasXdr) {
    if (typeof inner.xdr !== 'string' || !inner.xdr.trim()) return { ok: false, reason: 'xdr must be the signed transaction envelope, base64' }
    return { ok: true, params: { xdr: inner.xdr.trim() }, network: b.network }
  }
  if (typeof inner.func !== 'string' || !inner.func.trim()) return { ok: false, reason: 'func must be the base64 HostFunction XDR (or send xdr, a signed envelope)' }
  if (!Array.isArray(inner.auth) || inner.auth.some((a) => typeof a !== 'string' || !a.trim())) {
    return { ok: false, reason: 'auth must be an array of base64 SorobanAuthorizationEntry XDR strings' }
  }
  return { ok: true, params: { func: inner.func.trim(), auth: (inner.auth as string[]).map((a) => a.trim()) }, network: b.network }
}

export type RelayRule = 'smart-account-deploy' | 'owner-call' | 'smart-account-execute'

export type RelayPreflightOk = {
  ok: true
  rule: RelayRule
  /** The vault the request reaches, or null for a deploy, which reaches no vault. */
  vault: string | null
  /** The smart account doing the calling, on the execute rule. */
  smartAccount: string | null
  method: OwnerAction | null
  /** Every address that authorizes something in this request. */
  authAddresses: string[]
  summary: string
}
export type RelayPreflight = RelayPreflightOk | { ok: false; status: 400; code: 'bad_request'; reason: string }

const ACCEPTED =
  'this relay forwards exactly three shapes: a createContractV2 of the OpenZeppelin smart account wasm the ' +
  'registry names, an owner entrypoint on a vault this server operates, or a smart account\'s ' +
  `execute() whose target is such a vault and whose target_fn is an owner entrypoint (${OWNER_ACTIONS.join(', ')})`

/**
 * The half of the relay gate that needs no network, run FIRST and over the whole request.
 *
 * Every authorization entry has to be FOR the host function it rides with, compared by the
 * bytes of the invocation rather than by our reading of it: an entry whose root is some other
 * call would be signed authority for that other call, and the relayer would pay to land it.
 * Sub-invocations are refused except the one shape a vault owner call can produce through a
 * smart account. Source-account credentials are refused on the kit's `{ func, auth }` carrier
 * because the envelope's source there is the RELAYER's channel account, not anyone we know.
 */
export function relayPreflight(inspection: RelayInspection, ctx: { smartAccountWasmHash: string | undefined }): RelayPreflight {
  const bad = (reason: string): RelayPreflight => ({ ok: false, status: 400, code: 'bad_request', reason })
  if (!inspection.ok) return bad(inspection.reason)
  const { func, auth, carrier } = inspection
  if (auth.length === 0) return bad('no authorization entry was given, so nothing here is signed by anyone; the relayer would pay to fail')
  if (auth.some((a) => a.credentials === 'other')) return bad('an authorization entry uses a credential kind this relay does not read (delegated or V2 credentials); refused rather than guessed at')
  if (carrier === 'func-auth' && auth.some((a) => a.credentials === 'source-account')) {
    return bad('a source-account authorization on the { func, auth } carrier would be authorized by the relayer\'s own channel account; sign an address credential instead, or send a signed envelope as xdr')
  }

  if (func.kind === 'other') return bad(`${func.what} is not relayed; ${ACCEPTED}`)

  if (func.kind === 'create-contract-v2') {
    const want = ctx.smartAccountWasmHash?.toLowerCase()
    if (!want) return bad('this chain declares no contracts.smartAccount, so there is no wasm hash a deploy could be checked against')
    if ((func.wasmHash ?? '').toLowerCase() !== want) {
      return bad(`the deploy would instantiate wasm ${func.wasmHash ?? '(not wasm)'}, and the only executable this relay pays to create is the OpenZeppelin smart account ${want}`)
    }
    for (const [i, a] of auth.entries()) {
      if (a.root.kind !== 'create-contract-v2' || a.root.createXdr !== func.createXdr) {
        return bad(`auth[${i}] authorizes something other than this exact deploy; every entry must be for the host function it rides with`)
      }
      if (a.sub.length > 0) return bad(`auth[${i}] authorizes ${a.sub.length} sub-invocation(s) under the deploy; a smart-account deploy needs none`)
    }
    return {
      ok: true,
      rule: 'smart-account-deploy',
      vault: null,
      smartAccount: null,
      method: null,
      authAddresses: auth.map((a) => a.address).filter((x): x is string => Boolean(x)),
      summary: `deploy an OpenZeppelin smart account (wasm ${want.slice(0, 8)}...) from ${func.deployer ?? 'an unknown deployer'}, ${func.constructorArgs} constructor argument(s)`,
    }
  }

  // An invocation. Two shapes: the smart account's execute() wrapping an owner call, or the
  // owner call itself, authorized directly by the (contract) owner.
  if (func.execute) {
    const smartAccount = func.contract
    const { target, targetFn } = func.execute
    if (!isContractId(smartAccount)) return bad(`${smartAccount} is not a contract id, so it cannot be a smart account`)
    if (!isContractId(target)) return bad(`execute() targets ${target}, which is not a Soroban contract id`)
    if (!isOwnerAction(targetFn)) return bad(`execute() would call ${targetFn} on ${target}; only a vault owner entrypoint is relayed (${OWNER_ACTIONS.join(', ')}). pay is the operator's call and this server signs it itself.`)
    for (const [i, a] of auth.entries()) {
      if (a.root.kind !== 'contract-fn' || a.root.contract !== smartAccount || a.root.method !== 'execute' || a.root.argsXdr !== func.argsXdr) {
        return bad(`auth[${i}] authorizes something other than this exact execute(); every entry must be for the host function it rides with`)
      }
      for (const sub of a.sub) {
        if (sub.kind !== 'contract-fn' || sub.contract !== target || !isOwnerAction(sub.method)) {
          return bad(`auth[${i}] authorizes a sub-invocation outside the target vault's owner entrypoints; refused`)
        }
      }
      if (a.credentials !== 'address' || a.address !== smartAccount) {
        return bad(`auth[${i}] is not the smart account ${smartAccount} authorizing its own execute(); nothing else may authorize it`)
      }
    }
    return {
      ok: true,
      rule: 'smart-account-execute',
      vault: target,
      smartAccount,
      method: targetFn,
      authAddresses: [smartAccount],
      summary: `${smartAccount} executes ${targetFn} on vault ${target}`,
    }
  }

  if (!isOwnerAction(func.method)) return bad(`${func.method} on ${func.contract} is not relayed; ${ACCEPTED}`)
  const vault = func.contract
  if (!isContractId(vault)) return bad(`${vault} is not a Soroban contract id`)
  const addresses: string[] = []
  for (const [i, a] of auth.entries()) {
    if (a.root.kind !== 'contract-fn' || a.root.contract !== vault || a.root.method !== func.method || a.root.argsXdr !== func.argsXdr) {
      return bad(`auth[${i}] authorizes something other than this exact ${func.method}; every entry must be for the host function it rides with`)
    }
    if (a.sub.length > 0) return bad(`auth[${i}] authorizes ${a.sub.length} sub-invocation(s) under ${func.method}; an owner call needs none`)
    if (a.credentials !== 'address' || !a.address || !isContractId(a.address)) {
      return bad(`auth[${i}] is not a contract (smart account) authorizing ${func.method}; a G... owner signs through POST /api/stellar/vault/prepare and submit, not through this relay`)
    }
    addresses.push(a.address)
  }
  return {
    ok: true,
    rule: 'owner-call',
    vault,
    smartAccount: null,
    method: func.method,
    authAddresses: addresses,
    summary: `${func.method} on vault ${vault}, authorized by ${[...new Set(addresses)].join(', ')}`,
  }
}

export type RelayDecision =
  | { ok: true; vault: string | null; owner: string | null; operator: string | null }
  | {
      ok: false
      status: 403 | 502 | 503
      code: 'no_operator' | 'rpc_error' | 'not_our_vault' | 'owner_not_contract' | 'not_owner'
      reason: string
    }

/**
 * The half that needs the ledger, and why it is never skipped.
 *
 * "A vault we operate" is a live fact, not a registry entry: the vault's `operator()` has to
 * read back as this server's own signer. An unreadable vault is 502, never a pass, because
 * failing open here would let anyone have us pay for calls on vaults we know nothing about;
 * and no signer at all is 503, because without one there is no vault we operate. The owner
 * bound to the authorization is checked against the vault's live `owner()`, not against the
 * request's own claim about itself.
 */
export function relayDecision(pre: RelayPreflightOk, live: { owner: string; operator: string } | null, signer: string | null): RelayDecision {
  if (pre.rule === 'smart-account-deploy') return { ok: true, vault: null, owner: null, operator: null }
  if (!signer) {
    return {
      ok: false,
      status: 503,
      code: 'no_operator',
      reason: 'this server has no Stellar testnet signer configured, so it operates no vault and relays no owner call. Nothing was forwarded.',
    }
  }
  if (!live) {
    return { ok: false, status: 502, code: 'rpc_error', reason: `vault ${pre.vault} could not be read on chain, so the call was not forwarded. The check is never skipped: an unreadable vault is a reason to stop.` }
  }
  if (live.operator.trim() !== signer) {
    return { ok: false, status: 403, code: 'not_our_vault', reason: `vault ${pre.vault} is operated by ${live.operator}, not by this server, so this relay will not pay for calls on it. Nothing was forwarded.` }
  }
  const owner = live.owner.trim()
  if (pre.rule === 'owner-call') {
    if (!isContractId(owner)) {
      return { ok: false, status: 403, code: 'owner_not_contract', reason: `vault ${pre.vault} is owned by the account ${owner}, not by a smart account; its owner signs through the vault console, not this relay.` }
    }
    const stranger = pre.authAddresses.find((a) => a !== owner)
    if (stranger) return { ok: false, status: 403, code: 'not_owner', reason: `${stranger} authorized this call, and vault ${pre.vault} reports its owner as ${owner}, read live. Nothing was forwarded.` }
  }
  if (pre.rule === 'smart-account-execute' && owner !== pre.smartAccount) {
    return { ok: false, status: 403, code: 'not_owner', reason: `${pre.smartAccount} is not the owner of vault ${pre.vault}; it reports ${owner}, read live. Nothing was forwarded.` }
  }
  return { ok: true, vault: pre.vault, owner, operator: live.operator.trim() }
}

// ── the relayer's wire shape ─────────────────────────────────────────────────────

export type OzRelayRequest = {
  url: string
  method: 'POST'
  headers: { 'Content-Type': 'application/json'; Authorization: string }
  body: { params: RelayParams }
}

/**
 * Exactly what is posted to OZ Channels, with the key named and never present: the returned
 * shape is what a prepared answer publishes, and what the executing path sends after
 * substituting the real bearer for the placeholder.
 */
export function ozRelayRequest(url: string, keyVar: string, params: RelayParams): OzRelayRequest {
  return { url, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer <${keyVar}>` }, body: { params } }
}

export type OzRelayOutcome =
  | { success: true; transactionId: string | null; hash: string | null; status: string | null; data: unknown }
  | { success: false; error: string; code: string | null; data: unknown }

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null)
const looksLikeCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Z][A-Z0-9_:-]*$/.test(v.trim())
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * The relayer's answer, read the way the smart-account kit's RelayerClient reads it, so what
 * we hand back is what the kit would have understood from Channels directly: success only on
 * a 2xx with `success: true`, the payload from `data` when nested, and the error message and
 * code from the same places the kit looks in the same order.
 */
export function ozRelayOutcome(httpStatus: number, json: unknown): OzRelayOutcome {
  const root = asObject(json)
  const nested = asObject(root?.data)
  const data = nested ?? root ?? {}
  if (httpStatus >= 200 && httpStatus < 300 && root?.success === true) {
    return { success: true, transactionId: str(data.transactionId), hash: str(data.hash), status: str(data.status), data }
  }
  const message =
    str(root?.message) ??
    (typeof root?.error === 'string' && !looksLikeCode(root.error) ? str(root.error) : null) ??
    str(nested?.message) ??
    str(root?.error) ??
    `the relayer answered HTTP ${httpStatus} with no message`
  const code =
    str(root?.code) ??
    str(root?.errorCode) ??
    str(nested?.code) ??
    str(nested?.errorCode) ??
    (looksLikeCode(nested?.error) ? nested!.error.trim() : null) ??
    (looksLikeCode(root?.error) ? root!.error.trim() : null)
  return { success: false, error: message, code, data }
}

// ── what the relay may spend, across everyone ────────────────────────────────────

/**
 * The ceilings the relay endpoint enforces on ALL callers at once, and the honest account
 * of where each one can be enforced.
 *
 * Measured against SDF's own reference relayer proxy for this same smart-account kit
 * (relayer-proxy/wrangler.toml in the smart-account-kit repo, deployed at
 * smart-account-relayer-proxy.sdf-ecosystem.workers.dev), which sets four numbers: 10
 * requests per IP per minute, 100 requests per minute across everyone, a maximum resource
 * fee of 1,000,000 stroops and a maximum total fee of 1,100,000. The first we already had
 * as the `passkey-relay` bucket in rate-budget.ts, and a test pins the two together so the
 * number published here cannot drift from the number http.ts applies. Of the other three,
 * the global rate limit is enforced here as SDF enforces it, the max total fee becomes the
 * amount we RESERVE per forwarded request, and the max RESOURCE fee is not enforced at all,
 * because it is a component of a fee we never compute. Saying that is the point of the next
 * three paragraphs.
 *
 * The fee ceiling is the one that needs a plain word, because SDF can enforce it in a way
 * we cannot. SDF's proxy BUILDS the envelope, so it reads the fee its own simulation
 * produced and refuses before sending. On the kit's `{ func, auth }` carrier we build
 * nothing: we hand two base64 strings to Channels, and Channels simulates, prices, signs
 * and broadcasts under its own channel account. The fee does not exist at the moment we
 * decide, and the answer Channels sends back is a submission acknowledgement
 * (`transactionId`, `status`, `hash`) with no fee anywhere in it. There is no pre-check to
 * make here, so this module does not pretend to one.
 *
 * What it does instead is RESERVE. Every forwarded request charges the ceiling against a
 * rolling 24 hour budget BEFORE it goes out, and the reserve is settled afterwards against
 * whatever turns out to be knowable:
 *
 *   relayer reported a fee    the reserve is replaced by that number (basis: measured)
 *   it reported none          the full reserve stands (basis: reserved)
 *   it refused, named no tx   nothing was broadcast, so the reserve is handed back
 *   it never answered         we cannot know, so the reserve stands
 *
 * Reserving the ceiling rather than the charge stops us slightly early, which is the same
 * direction x402-stellar/settle.ts argues for when it budgets the BID and not the charge: a
 * guard that spends money should err toward stopping. So the quantity actually bounded is
 * the COUNT of fee-sponsored broadcasts per day, and the status endpoint publishes it as
 * exactly that rather than as a measurement of XLM we spent.
 */
export type PasskeyRelayLimits = {
  /** Enforced in rate-budget.ts and applied per client IP by http.ts. Published here, not applied here. */
  perIp: { bucket: string; max: number; windowMs: number }
  /** Enforced here, across every caller at once: a per-IP budget times N addresses is not a budget. */
  global: { max: number; windowMs: number }
  /** ceilingStroops is reserved per forwarded request; dailyStroops is the rolling window it comes out of. */
  fee: { ceilingStroops: bigint; dailyStroops: bigint; windowMs: number }
}

export const PASSKEY_RELAY_LIMITS: PasskeyRelayLimits = {
  perIp: { bucket: 'passkey-relay', max: 10, windowMs: 60_000 },
  global: { max: 100, windowMs: 60_000 },
  // 1,100,000 is SDF's max TOTAL fee for the same relayer, to the stroop. 110,000,000 is
  // exactly 100 of those, so the budget reads as "100 fee-sponsored broadcasts a day" and
  // the status endpoint can say that number rather than leaving a reader to divide.
  fee: { ceilingStroops: 1_100_000n, dailyStroops: 110_000_000n, windowMs: 86_400_000 },
}

export type RelayBudgetRefusal = {
  ok: false
  status: 429
  code: 'relay_global_rate_limit' | 'relay_fee_budget_exhausted'
  reason: string
  retryAfterSeconds: number
}
export type RelayAdmission = { ok: true; used: number; max: number; resetAt: number } | RelayBudgetRefusal
export type RelayReservation = { ok: true; reservedStroops: bigint; windowResetAt: number } | RelayBudgetRefusal

/** What a settled reserve did to the day, handed back to the ledger by the route. */
export type RelaySettlement = {
  refundStroops: bigint
  /** The fee the relayer named, 0 when it refused before broadcasting, null when unknown. */
  feeStroops: bigint | null
  basis: 'measured' | 'reserved' | 'not-broadcast'
  note: string
}

export type RelayBudgetSnapshot = {
  perIp: { bucket: string; max: number; windowMs: number; enforcedIn: string }
  global: { max: number; windowMs: number; used: number; resetAt: string | null; enforcedIn: string }
  fee: {
    ceilingStroops: string
    dailyStroops: string
    reservedStroops: string
    remainingStroops: string
    relaysLeft: number
    relaysForwarded: number
    feesReported: number
    windowMs: number
    resetAt: string | null
    basis: 'measured' | 'mixed' | 'reserved' | 'nothing-forwarded'
    enforcedIn: string
    note: string
  }
}

export type RelayBudget = {
  /** The global rate limit, charged at the door, before anything is decoded. */
  admit(now?: number): RelayAdmission
  /** The day's fee reserve, charged in the last step before our key is used. */
  reserve(now?: number): RelayReservation
  /** Give back what was not spent, once the relayer has said what it did. */
  settle(input: { windowResetAt: number; refundStroops: bigint; measured: boolean }, now?: number): void
  /** What the status endpoint publishes. Reads; never opens a window. */
  snapshot(now?: number): RelayBudgetSnapshot
}

const PER_IP_WHERE = 'mcp/src/rate-budget.ts (bucket passkey-relay), applied per client IP by mcp/src/http.ts'
const GLOBAL_WHERE = 'mcp/src/http/stellar-passkey-routes.ts, charged before the body is read'
const FEE_WHERE = 'mcp/src/http/stellar-passkey-routes.ts, charged in the step before the relayer key is used'

/**
 * A relay budget with its own counters, so a test can hold one and the server can hold one.
 *
 * Process local, like every other limiter here and for the same reason: a horizontally
 * scaled deploy moves all of them to a shared store together. Stated rather than implied,
 * because on two Render instances this bounds 100 a minute each and not 100 between them.
 */
export function createRelayBudget(limits: PasskeyRelayLimits = PASSKEY_RELAY_LIMITS): RelayBudget {
  let win = { used: 0, resetAt: 0 }
  let day = { reserved: 0n, forwarded: 0, reported: 0, resetAt: 0 }
  const rollWindow = (now: number) => {
    if (win.resetAt <= now) win = { used: 0, resetAt: now + limits.global.windowMs }
  }
  const rollDay = (now: number) => {
    if (day.resetAt <= now) day = { reserved: 0n, forwarded: 0, reported: 0, resetAt: now + limits.fee.windowMs }
  }
  const secondsTo = (at: number, now: number) => Math.max(1, Math.ceil((at - now) / 1000))

  return {
    admit(now = Date.now()) {
      rollWindow(now)
      if (win.used >= limits.global.max) {
        const retryAfterSeconds = secondsTo(win.resetAt, now)
        return {
          ok: false,
          status: 429,
          code: 'relay_global_rate_limit',
          retryAfterSeconds,
          reason:
            `this relay forwards at most ${limits.global.max} requests per ${limits.global.windowMs / 1000} s across ALL callers, ` +
            `and that window is used up. The per-IP budget bounds one address; this one bounds everyone together, because a ` +
            `credential we hold pays for whatever goes through. Nothing was decoded and nothing was forwarded. Retry in ${retryAfterSeconds} s.`,
        }
      }
      win.used += 1
      return { ok: true, used: win.used, max: limits.global.max, resetAt: win.resetAt }
    },

    reserve(now = Date.now()) {
      rollDay(now)
      const reservedStroops = limits.fee.ceilingStroops
      if (day.reserved + reservedStroops > limits.fee.dailyStroops) {
        const retryAfterSeconds = secondsTo(day.resetAt, now)
        return {
          ok: false,
          status: 429,
          code: 'relay_fee_budget_exhausted',
          retryAfterSeconds,
          reason:
            `this relay reserves ${reservedStroops} stroops of relayer fee for every request it forwards, and the 24 hour budget of ` +
            `${limits.fee.dailyStroops} stroops is committed (${day.reserved} reserved across ${day.forwarded} forwarded requests). ` +
            'Nothing was forwarded and the relayer key was not used. The reserve is a ceiling and not a measurement: Channels prices ' +
            'the transaction after we hand it over, so the number bounded here is how many broadcasts we will pay for, not how much XLM they cost.',
        }
      }
      day.reserved += reservedStroops
      day.forwarded += 1
      return { ok: true, reservedStroops, windowResetAt: day.resetAt }
    },

    settle(input, now = Date.now()) {
      rollDay(now)
      // The window rolled out from under this request, so its reserve went with it and
      // refunding now would credit a day that never paid.
      if (day.resetAt !== input.windowResetAt) return
      if (input.measured) day.reported += 1
      if (input.refundStroops > 0n) day.reserved = day.reserved > input.refundStroops ? day.reserved - input.refundStroops : 0n
    },

    snapshot(now = Date.now()) {
      const g = win.resetAt > now ? win : { used: 0, resetAt: 0 }
      const d = day.resetAt > now ? day : { reserved: 0n, forwarded: 0, reported: 0, resetAt: 0 }
      const remaining = limits.fee.dailyStroops > d.reserved ? limits.fee.dailyStroops - d.reserved : 0n
      const basis: RelayBudgetSnapshot['fee']['basis'] =
        d.forwarded === 0 ? 'nothing-forwarded' : d.reported === 0 ? 'reserved' : d.reported === d.forwarded ? 'measured' : 'mixed'
      return {
        perIp: { ...limits.perIp, enforcedIn: PER_IP_WHERE },
        global: { max: limits.global.max, windowMs: limits.global.windowMs, used: g.used, resetAt: g.resetAt ? new Date(g.resetAt).toISOString() : null, enforcedIn: GLOBAL_WHERE },
        fee: {
          ceilingStroops: limits.fee.ceilingStroops.toString(),
          dailyStroops: limits.fee.dailyStroops.toString(),
          reservedStroops: d.reserved.toString(),
          remainingStroops: remaining.toString(),
          relaysLeft: Number(remaining / limits.fee.ceilingStroops),
          relaysForwarded: d.forwarded,
          feesReported: d.reported,
          windowMs: limits.fee.windowMs,
          resetAt: d.resetAt ? new Date(d.resetAt).toISOString() : null,
          basis,
          enforcedIn: FEE_WHERE,
          note:
            'Reserved, not measured. We do not build the envelope on the { func, auth } carrier, so Channels prices the ' +
            'transaction after we hand it over and its answer names no fee; each forwarded request therefore commits the ' +
            'ceiling and the reserve is only replaced by a real number if the relayer ever reports one. What this bounds is how ' +
            'many broadcasts our relayer key will pay for in 24 hours.',
        },
      }
    },
  }
}

/** The one the server uses. A test makes its own so no two tests share a window. */
export const relayBudget = createRelayBudget()

/**
 * A fee in the relayer's answer, if there is one.
 *
 * Channels has not been observed to report a fee on any answer we have seen; these are the
 * names its payload would have to use for a reserve to settle against a real number, so the
 * day stays on basis `reserved` until one appears rather than on a guess dressed as a
 * measurement. A bid field (maxFee) is deliberately not read: it would be a ceiling
 * reported as a charge, and we already have a ceiling.
 */
const FEE_FIELDS = ['feeCharged', 'fee_charged', 'feeStroops', 'fee_stroops', 'fee']

export function relayFeeReported(data: unknown): bigint | null {
  const d = asObject(data)
  if (!d) return null
  for (const k of FEE_FIELDS) {
    const v = d[k]
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v)
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim())
  }
  return null
}

/**
 * What the day owes back once the relayer has answered, and on what basis.
 *
 * The refusal case is the one worth reading twice. A refusal that names a transaction may
 * still have reached the network, so the reserve stands; a refusal that names none did not,
 * so the reserve is handed back in full. Erring the other way would let a caller sending
 * shape-valid payloads that Channels rejects burn the day's budget for free.
 */
export function relayFeeSettlement(outcome: OzRelayOutcome, reservedStroops: bigint): RelaySettlement {
  if (outcome.success) {
    const fee = relayFeeReported(outcome.data)
    if (fee === null) {
      return {
        refundStroops: 0n,
        feeStroops: null,
        basis: 'reserved',
        note: `the relayer acknowledged the submission without naming a fee, so the full reserve of ${reservedStroops} stroops stands; this is a reserve, not a measurement`,
      }
    }
    return {
      refundStroops: fee >= reservedStroops ? 0n : reservedStroops - fee,
      feeStroops: fee,
      basis: 'measured',
      note: `the relayer reported ${fee} stroops, so the reserve of ${reservedStroops} was settled against it`,
    }
  }
  const hash = str(asObject(outcome.data)?.hash)
  if (hash) {
    return {
      refundStroops: 0n,
      feeStroops: null,
      basis: 'reserved',
      note: `the relayer refused but named transaction ${hash}, which may have reached the network, so the reserve stands rather than being handed back on a guess`,
    }
  }
  return {
    refundStroops: reservedStroops,
    feeStroops: 0n,
    basis: 'not-broadcast',
    note: 'the relayer refused without naming a transaction, so nothing was broadcast and nothing was paid; the reserve was handed back',
  }
}

// ── the deploy and the agent payment: bodies and caps ────────────────────────────

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export type PasskeyDeployPlan =
  | { ok: true; owner: string; dailyCapUsd: number; autoApproveUsd: number; seedUsd: number; dailyCapRaw: string; autoApproveMaxRaw: string; seedRaw: string }
  | { ok: false; reason: string }

/**
 * A vault owned by a passkey smart account, under the demo caps.
 *
 * The owner has to be a CONTRACT: a G... owner already has the vault console, and this path
 * exists for the account a browser passkey controls. Zero caps are refused although the
 * contract accepts them, because in this contract 0 means NO cap, and a vault anyone on the
 * internet can have us deploy and seed must have one.
 */
export function passkeyDeployPlan(body: unknown, decimals: number): PasskeyDeployPlan {
  const b = asObject(body) ?? {}
  const owner = typeof b.owner === 'string' ? b.owner.trim() : ''
  if (!isContractId(owner)) {
    return { ok: false, reason: 'owner must be the passkey smart account\'s contract id (C... StrKey). A G... owner uses POST /api/agents/vault through the console instead.' }
  }
  if (!finite(b.dailyCapUsd) || b.dailyCapUsd <= 0 || b.dailyCapUsd > PASSKEY_CAPS.dailyCapUsd) {
    return { ok: false, reason: `dailyCapUsd must be a number above 0 and at most ${PASSKEY_CAPS.dailyCapUsd} on testnet (0 would mean no cap)` }
  }
  if (!finite(b.autoApproveUsd) || b.autoApproveUsd <= 0 || b.autoApproveUsd > PASSKEY_CAPS.autoApproveUsd) {
    return { ok: false, reason: `autoApproveUsd must be a number above 0 and at most ${PASSKEY_CAPS.autoApproveUsd} on testnet (0 would mean no ceiling)` }
  }
  let seedUsd: number = PASSKEY_CAPS.seedUsdDefault
  if (b.seedUsd !== undefined) {
    if (!finite(b.seedUsd) || b.seedUsd < 0 || b.seedUsd > PASSKEY_CAPS.seedUsdMax) {
      return { ok: false, reason: `seedUsd must be a number from 0 to ${PASSKEY_CAPS.seedUsdMax}; it is USDC that leaves this server's own account for good` }
    }
    seedUsd = b.seedUsd
  }
  return {
    ok: true,
    owner,
    dailyCapUsd: b.dailyCapUsd,
    autoApproveUsd: b.autoApproveUsd,
    seedUsd,
    dailyCapRaw: toRawUnits(b.dailyCapUsd, decimals),
    autoApproveMaxRaw: toRawUnits(b.autoApproveUsd, decimals),
    seedRaw: toRawUnits(seedUsd, decimals),
  }
}

export type PasskeyAgentPayPlan = { ok: true; contract: string; to: string; amountUsd: number; amountRaw: string } | { ok: false; reason: string }

/** The agent's payment: one call to `pay()`, at most one dollar, on a vault this server operates. */
export function passkeyAgentPayPlan(body: unknown, decimals: number): PasskeyAgentPayPlan {
  const b = asObject(body) ?? {}
  const contract = typeof b.contract === 'string' ? b.contract.trim() : ''
  const to = typeof b.to === 'string' ? b.to.trim() : ''
  if (!isContractId(contract)) return { ok: false, reason: 'contract must be the vault\'s Soroban contract id (C... StrKey)' }
  if (!isAccountId(to) && !isContractId(to)) return { ok: false, reason: 'to must be a Stellar account (G...) or a contract (C...)' }
  if (!finite(b.amountUsd) || b.amountUsd <= 0 || b.amountUsd > PASSKEY_CAPS.agentPayMaxUsd) {
    return { ok: false, reason: `amountUsd must be a number above 0 and at most ${PASSKEY_CAPS.agentPayMaxUsd} on this demo endpoint` }
  }
  return { ok: true, contract, to, amountUsd: b.amountUsd, amountRaw: toRawUnits(b.amountUsd, decimals) }
}

// ── the allowlist plan: a KYA decision onto a binary on-chain switch ─────────────

export type AllowlistRequest = { ok: true; contract: string; payee: string; agentId: string | null } | { ok: false; reason: string }

export function allowlistRequest(body: unknown): AllowlistRequest {
  const b = asObject(body) ?? {}
  const contract = typeof b.contract === 'string' ? b.contract.trim() : ''
  const payee = typeof b.payee === 'string' ? b.payee.trim() : ''
  if (!isContractId(contract)) return { ok: false, reason: 'contract must be the vault\'s Soroban contract id (C... StrKey)' }
  if (!isAccountId(payee) && !isContractId(payee)) return { ok: false, reason: 'payee must be a Stellar account (G...) or a contract (C...)' }
  const agentId = typeof b.agentId === 'string' && b.agentId.trim() ? b.agentId.trim().slice(0, 200) : null
  return { ok: true, contract, payee, agentId }
}

export type AgentBinding = 'linked-wallet' | 'declared' | 'none'

/**
 * Which A-Identity agent a payee stands for, and how firmly.
 *
 *  declared      the caller named an agentId; the payee address itself vouches for nothing.
 *  linked-wallet an account that owns a platform agent proved control of this very address
 *                by signature (a wallet sign-in, or a wallet linked to the account).
 *  none          nobody we know is bound to this address.
 *
 * Reported rather than collapsed, because the risk decision that follows is only as good as
 * the binding it was made about.
 */
export function bindPayeeToAgent(input: {
  agentId: string | null
  payee: string
  agents: { id: string; owner?: string }[]
  linkedSubjects: string[]
}): { agentId: string | null; binding: AgentBinding; note: string } {
  const norm = (s: string) => s.trim().toLowerCase()
  if (input.agentId) {
    return { agentId: input.agentId, binding: 'declared', note: 'agentId was named by the caller; the payee address itself was not checked against that agent' }
  }
  const linked = new Set(input.linkedSubjects.map(norm).filter(Boolean))
  const hit = input.agents.find((a) => typeof a.owner === 'string' && linked.has(norm(a.owner)))
  if (hit) {
    return { agentId: hit.id, binding: 'linked-wallet', note: `the account that owns agent ${hit.id} proved control of ${input.payee} by signature` }
  }
  return { agentId: null, binding: 'none', note: `no A-Identity agent is bound to ${input.payee}: no account linked it and no agentId was named` }
}

export type RiskDecisionName = 'ALLOW' | 'WARN' | 'DENY'
export type AllowlistChainAction = { method: 'set_allowed'; payee: string; ok: boolean } | null

/**
 * The allowlist is binary and the risk decision has three values, so the mapping is stated
 * once, here, and published beside every plan as `enforcement`.
 */
export const ALLOWLIST_ENFORCEMENT = {
  allowlist: 'binary: a payee is either allowed on chain or it is not; the vault has no WARN state',
  ALLOW: 'on-chain entry: set_allowed(payee, true), signed by the owner passkey through the smart account; pay() to this payee then passes the allowlist and is still bounded by the ceiling and the daily cap',
  WARN: 'server-side only: nothing is written; the vault keeps whatever it already holds for this payee, and the reasons are returned for the person to decide',
  DENY: 'on-chain revoke: set_allowed(payee, false), signed by the owner passkey; pay() to this payee then reverts with PayeeNotAllowed (contract error #3), in simulation or on chain',
  signer: 'the vault OWNER (the passkey smart account) signs any chain action client-side and this endpoint writes nothing on chain',
} as const

export function allowlistPlan(
  decision: RiskDecisionName | null,
  payee: string,
  reasons: string[],
): { decision: RiskDecisionName; chainAction: AllowlistChainAction; serverWarning: string | null; enforcement: typeof ALLOWLIST_ENFORCEMENT } {
  const effective: RiskDecisionName = decision ?? 'DENY'
  if (effective === 'ALLOW') {
    return { decision: effective, chainAction: { method: 'set_allowed', payee, ok: true }, serverWarning: null, enforcement: ALLOWLIST_ENFORCEMENT }
  }
  if (effective === 'WARN') {
    return {
      decision: effective,
      chainAction: null,
      serverWarning: `WARN is not written on chain: ${reasons.join('; ') || 'proceed with caution'}. The allowlist entry for ${payee} is left as it is.`,
      enforcement: ALLOWLIST_ENFORCEMENT,
    }
  }
  return { decision: effective, chainAction: { method: 'set_allowed', payee, ok: false }, serverWarning: null, enforcement: ALLOWLIST_ENFORCEMENT }
}

/** The reasons an unbound payee is denied, in the same voice risk_check uses. */
export const UNBOUND_PAYEE_REASONS = [
  'No A-Identity agent is bound to this payee: no account proved control of the address and no agentId was named, so there is no identity, KYA or reputation to assess',
  'An unbound payee is denied rather than warned about, because on a binary allowlist the only safe default is off',
]

// ── the status view ──────────────────────────────────────────────────────────────

export function passkeyStatusView(
  chain: ChainDescriptor,
  cfg: {
    keyVar: string
    keyConfigured: boolean
    relayerUrl: string
    operator: string | null
    explorerFor: (address: string) => string
    /** Live, from the budget the relay endpoint actually charges. Required, so the numbers
     *  cannot be published from a copy that has drifted from the one being enforced. */
    relayLimits: RelayBudgetSnapshot
  },
): Record<string, unknown> {
  const sa = chain.contracts.smartAccount
  return {
    release: PASSKEY_RELEASE.name,
    testnetOnly: PASSKEY_RELEASE.testnetOnly,
    network: chain.caip2,
    chain: chain.id,
    relayer: {
      product: PASSKEY_RELEASE.relayerProduct,
      name: PASSKEY_RELEASE.relayerName,
      url: cfg.relayerUrl,
      keyVar: cfg.keyVar,
      keyConfigured: cfg.keyConfigured,
      endpoint: '/api/stellar/passkey/relay',
      note: cfg.keyConfigured
        ? 'Allowlisted requests are forwarded and fee-sponsored by the relayer; the key never leaves this server.'
        : `${cfg.keyVar} is unset, so the relay answers prepared: it validates and returns exactly what it would post, and forwards nothing.`,
    },
    smartAccount: sa
      ? { wasmHash: sa.wasmHash, webauthnVerifier: sa.webauthnVerifier, ed25519Verifier: sa.ed25519Verifier, verified: sa.verified, thirdParty: true, publisher: 'OpenZeppelin' }
      : null,
    passkeyVault: chain.contracts.passkeyVault
      ? { contract: chain.contracts.passkeyVault, explorerUrl: cfg.explorerFor(chain.contracts.passkeyVault), ownerKind: 'smart-account' }
      : null,
    operator: {
      envVar: chain.signerEnvVar ?? null,
      configured: Boolean(cfg.operator),
      account: cfg.operator,
      role: 'the vault operator that signs pay(), and the source of every vault deployed here',
    },
    caps: { ...PASSKEY_CAPS },
    // Published for the same reason the caps are: nothing sits in front of this endpoint
    // except these numbers, so a reader who cannot see them cannot check them. The fee
    // block says reserved rather than spent on purpose; its own note explains why we
    // cannot say spent.
    limits: cfg.relayLimits,
    endpoints: {
      status: 'GET /api/stellar/passkey/status',
      relay: 'POST /api/stellar/passkey/relay  { func, auth[] } | { xdr }',
      deploy: 'POST /api/stellar/passkey/vault/deploy  { owner, dailyCapUsd, autoApproveUsd, seedUsd? }',
      allowlistPlan: 'POST /api/stellar/passkey/allowlist/plan  { contract, payee, agentId? }',
      agentPay: 'POST /api/stellar/passkey/agent-pay  { contract, to, amountUsd }',
    },
    pubnet: { served: false, reason: 'testnet only in this release: the pubnet smart-account constants are deliberately not recorded and no pubnet vault has a smart-account owner' },
    checkedAt: new Date().toISOString(),
  }
}
