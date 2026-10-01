/**
 * Every decision the passkey endpoints make, with no network and no Stellar SDK.
 *
 * The feature in one paragraph. A person on the public /stellar page creates a passkey; the
 * smart-account kit deploys an OpenZeppelin smart account (a C... contract) whose only signer
 * is that WebAuthn credential; this server deploys an AgentSpendPolicy vault whose OWNER is
 * that contract and whose OPERATOR is our own key for that network; the person's passkey then
 * signs the owner calls (set_policy, set_allowed, set_frozen, withdraw) through the smart
 * account's `execute`, the vault's `owner.require_auth()` is satisfied because the smart
 * account is the direct invoker, and the agent side pays through `pay()` under the policy the
 * passkey set. Both Stellar networks are served: pubnet with dust caps sized for real money,
 * testnet for rehearsal and for the evidence a device passkey produces. The registry's
 * `passkeyVault` (testnet, 2026-09-19) was signed by a SOFTWARE P-256 key in
 * mcp/scripts/stellar-passkey-proof.mjs: it is a rehearsal of this flow, never device evidence.
 *
 * Fees: the kit posts `{ func, auth }` to a relayer, and our endpoint forwards it to
 * OpenZeppelin Channels with a key we hold. Whatever we forward is paid for and broadcast
 * under our account, which makes that endpoint an open relay unless something refuses all it
 * does not positively recognise. That something is here, as pure functions over the plain
 * shape `chains/stellar/relay.ts` decodes, because a rule that can only be tested against a
 * ledger is a rule nobody re-tests after they change it:
 *
 *  - which network may be served at all (any Stellar network the registry records the
 *    OpenZeppelin constants for; an unnamed one is testnet, never pubnet),
 *  - which host functions may be relayed (exactly four shapes, listed, never a pattern),
 *  - which vaults the operator key may act on (demo vaults owned by a smart account running
 *    the registry's wasm, read live; never a flagship vault, refused by id),
 *  - which smart account a vault may be deployed for (one WebAuthn signer, the one the
 *    browser names, read live off the account before anything is spent),
 *  - which authorization entries may ride along (the ones FOR that function, by byte equality),
 *  - how a KYA decision maps onto a binary on-chain allowlist,
 *  - the caps on what the operator key may be made to spend,
 *  - and what the relay may spend across everyone: a global rate limit and a 24 hour
 *    reserve against the relayer fee, both published by the status endpoint.
 *
 * `mcp/src/http/stellar-passkey-routes.ts` is the thin half: it reads the body, calls these,
 * calls the adapter, forwards to the relayer, and picks a status code.
 */
import type { RelayInspection, RelaySigner } from './chains/stellar/relay-shape.js'
import { isAccountId, isContractId } from './chains/stellar/strkey.js'
import type { ChainDescriptor } from './chains/types.js'
import { OWNER_ACTIONS, isOwnerAction, ownerKindOf, toRawUnits, type OwnerAction } from './stellar-vault.js'

export { ownerKindOf }

/** What this release is, stated once so every endpoint says the same thing. */
export const PASSKEY_RELEASE = {
  name: 'stellar-passkey-vault',
  /** The network a request gets when it names none. Testnet, deliberately: an unqualified
   *  call must never be the one that spends real money. */
  defaultNetwork: 'stellar:testnet',
  relayerProduct: 'OpenZeppelin Relayer (Channels)',
  relayerName: 'openzeppelin-channels',
} as const

/**
 * What the operator key may be made to spend, in USD, by anyone on the internet.
 *
 * These endpoints have no session in front of them, so the caps ARE the authorization. A
 * vault's daily cap bounds what the agent can move per day and its ceiling what one payment
 * may be; the seed is USDC that leaves our own account for good; agent-pay is one payment.
 *
 * WHY THIS IS PER NETWORK, and why there is no flat export any more. The same numbers on
 * pubnet would be a public faucet on real USDC: 0.2 a visitor, unbounded visitors. The flat
 * `PASSKEY_CAPS` was removed rather than kept beside a pubnet copy, because a call site that
 * forgot to switch would have read the testnet numbers and spent mainnet money, and that is
 * the one mistake here that cannot be undone. Every call site takes a chain now, so the
 * compiler finds them all.
 *
 * On pubnet the seed is dust on purpose. Five of the six steps a visitor runs cost XLM fees
 * only, which the relayer sponsors; the seed is the single leg that moves our USDC, so it
 * is the single number that has to be small, and `seedDailyTotalUsd` bounds the sum of it
 * across everyone rather than per visitor.
 */
export type PasskeyCaps = {
  dailyCapUsd: number
  autoApproveUsd: number
  seedUsdDefault: number
  seedUsdMax: number
  agentPayMaxUsd: number
  /** The sum of every seed this network may pay out in a UTC day, across all callers. */
  seedDailyTotalUsd: number
}

const TESTNET_CAPS: PasskeyCaps = {
  dailyCapUsd: 10,
  autoApproveUsd: 2,
  seedUsdDefault: 0.2,
  seedUsdMax: 0.5,
  agentPayMaxUsd: 1,
  // Test money. The bound exists so the shape is identical on both networks and the pubnet
  // path is not the only one whose budget code ever runs.
  seedDailyTotalUsd: 20,
}

const PUBNET_CAPS: PasskeyCaps = {
  dailyCapUsd: 0.05,
  autoApproveUsd: 0.02,
  seedUsdDefault: 0.01,
  seedUsdMax: 0.02,
  agentPayMaxUsd: 0.01,
  // One dollar a day, so a hundred visitors can each see a real mainnet settlement and the
  // hundred and first is told plainly that the day's budget is spent rather than served a
  // failure that looks like a bug.
  seedDailyTotalUsd: 1,
}

/** The caps for one network. Pubnet is the tight set; everything else is testnet's. */
export function passkeyCaps(chain: ChainDescriptor): PasskeyCaps {
  return chain.caip2 === 'stellar:pubnet' ? PUBNET_CAPS : TESTNET_CAPS
}

/** Published so the status endpoint can show both without a caller having to ask twice. */
export const PASSKEY_CAPS_BY_NETWORK: Record<string, PasskeyCaps> = {
  'stellar:testnet': TESTNET_CAPS,
  'stellar:pubnet': PUBNET_CAPS,
}

// ── which network ────────────────────────────────────────────────────────────────

export type PasskeyChainGate =
  | { ok: true; chain: ChainDescriptor }
  | { ok: false; status: 400; code: 'bad_request' | 'network_not_served'; reason: string }

/**
 * Which Stellar network a request runs on, by registry id or CAIP-2.
 *
 * A network is served when the registry records OpenZeppelin's smart-account constants for
 * it, and not otherwise. That is the whole rule, and it is a fact about the registry rather
 * than a list kept here, so a network becomes servable the day its constants are read off
 * its own ledger and recorded, and never before.
 *
 * Naming nothing gets TESTNET, deliberately. Pubnet moves real USDC, so reaching it has to
 * be something a caller asked for in words rather than something a missing field did.
 */
export function passkeyChain(want: unknown, chains: ChainDescriptor[]): PasskeyChainGate {
  const key = typeof want === 'string' && want.trim() ? want.trim() : PASSKEY_RELEASE.defaultNetwork
  const chain = chains.find((c) => c.ecosystem === 'stellar' && (c.id === key || c.caip2 === key)) ?? null
  if (!chain) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      reason: `${key} is not a Stellar chain in the registry; name one of ${servedNetworks(chains).join(', ') || '(none)'} by CAIP-2 or registry id`,
    }
  }
  if (!chain.contracts.smartAccount) {
    return {
      ok: false,
      status: 400,
      code: 'network_not_served',
      reason:
        `${chain.caip2} declares no contracts.smartAccount, so no passkey account can be deployed or relayed on it. ` +
        'The constants are recorded per network only once they have been read off that network. Nothing was submitted.',
    }
  }
  return { ok: true, chain }
}

/** Every network this release can serve right now, for an error message and for status. */
export function servedNetworks(chains: ChainDescriptor[]): string[] {
  return chains.filter((c) => c.ecosystem === 'stellar' && c.contracts.smartAccount).map((c) => c.caip2)
}

/**
 * Which network a request NAMED, from its body or its query string.
 *
 * The query string exists for one caller: the smart-account kit's RelayerClient posts the
 * kit's own `{ func, auth }` and nothing else, so the only place a browser can say which
 * network a relayed request is for is the relayer URL it was configured with
 * (`/api/stellar/passkey/relay?network=stellar:testnet`). Both are read, and two that
 * disagree are refused rather than one being preferred: a request that names pubnet in one
 * place and testnet in the other was built by something confused, and the cost of guessing
 * wrong is a fee on the wrong ledger or a refusal the person cannot explain.
 *
 * Returns the raw name (or undefined for none); `passkeyChain` resolves it.
 */
export function requestedNetwork(
  fromBody: unknown,
  fromQuery: string | null | undefined,
  chains: ChainDescriptor[],
): { ok: true; network: string | undefined } | { ok: false; status: 400; code: 'network_conflict'; reason: string } {
  const b = typeof fromBody === 'string' && fromBody.trim() ? fromBody.trim() : undefined
  const q = typeof fromQuery === 'string' && fromQuery.trim() ? fromQuery.trim() : undefined
  if (b && q) {
    const resolve = (k: string) => chains.find((c) => c.ecosystem === 'stellar' && (c.id === k || c.caip2 === k))?.caip2 ?? k
    if (resolve(b) !== resolve(q)) {
      return {
        ok: false,
        status: 400,
        code: 'network_conflict',
        reason: `the body names ${b} and the query string names ${q}; name one network once. Nothing was decoded or forwarded.`,
      }
    }
  }
  return { ok: true, network: b ?? q }
}

/**
 * The vaults the operator key must never be made to act on from these public endpoints,
 * by id: the network's flagship vault and the 2026-09-19 passkey rehearsal vault.
 *
 * Belt and braces. The live checks below already refuse any vault whose owner is not a
 * smart account running the registry's account wasm, and the flagship vault's owner is a
 * G... account. Naming them as well means a future change to that owner, or a signer key
 * that happens to operate both, still cannot turn this demo into a way to spend from them.
 */
export function flagshipVaults(chain: ChainDescriptor): string[] {
  return [chain.contracts.spendVault, chain.contracts.passkeyVault].filter((v): v is string => typeof v === 'string' && isContractId(v))
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

export type RelayRule = 'smart-account-deploy' | 'owner-call' | 'smart-account-execute' | 'smart-account-admin'

export type RelayPreflightOk = {
  ok: true
  rule: RelayRule
  /** The vault the request reaches, or null for a deploy or an account admin call, which reach no vault. */
  vault: string | null
  /** The smart account doing the calling, on the execute and admin rules. */
  smartAccount: string | null
  /** The vault entrypoint on the vault rules, or the account method on the admin rule. */
  method: OwnerAction | AccountAdminMethod | null
  /** Every address that authorizes something in this request. */
  authAddresses: string[]
  summary: string
}
export type RelayPreflight = RelayPreflightOk | { ok: false; status: 400; code: 'bad_request'; reason: string }

/** The two account methods a smart account may call on ITSELF through this relay. */
export const ACCOUNT_ADMIN_METHODS = ['add_context_rule', 'add_signer'] as const
export type AccountAdminMethod = (typeof ACCOUNT_ADMIN_METHODS)[number]

const ACCEPTED =
  'this relay forwards exactly four shapes: a createContractV2 of the OpenZeppelin smart account wasm the ' +
  'registry names, an owner entrypoint on a vault this server operates, a smart account\'s ' +
  `execute() whose target is such a vault and whose target_fn is an owner entrypoint (${OWNER_ACTIONS.join(', ')}), ` +
  'or a smart account adding one WebAuthn signer to ITSELF (add_context_rule with a Default context, one signer and no policy; or add_signer on a rule other than 0)'

/** What a preflight needs from the registry. Both come from `chain.contracts.smartAccount`. */
export type RelayPreflightCtx = { smartAccountWasmHash: string | undefined; webauthnVerifier: string | undefined }

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
export function relayPreflight(inspection: RelayInspection, ctx: RelayPreflightCtx): RelayPreflight {
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

  // A smart account changing its own signer set: the shape adding a second device needs.
  // Read closely, because a signer the relay helped add is a signer that can move the vault.
  if ((ACCOUNT_ADMIN_METHODS as readonly string[]).includes(func.method)) {
    const account = func.contract
    const admin = func.admin
    if (!isContractId(account)) return bad(`${account} is not a contract id, so it cannot be a smart account`)
    if (!admin) return bad(`${func.method} on ${account} does not carry the OpenZeppelin account's own argument types, so it is not read and not relayed`)
    const verifier = ctx.webauthnVerifier
    if (!verifier) return bad('this chain declares no contracts.smartAccount.webauthnVerifier, so there is no verifier a new signer could be checked against')
    const isPasskey = (s: RelaySigner) => s.kind === 'external' && s.verifier === verifier
    if (admin.method === 'add_context_rule') {
      if (admin.contextType !== 'default') {
        return bad(`add_context_rule with a ${admin.contextType} context is not relayed; a second device gets its own Default rule, so it can authorize alone`)
      }
      if (admin.signers.length !== 1 || !isPasskey(admin.signers[0])) {
        return bad(`add_context_rule must carry exactly one WebAuthn signer under the registry's verifier ${verifier}; this one carries ${admin.signers.length} signer(s) of kind ${admin.signers.map((s) => s.kind).join(', ') || 'none'}`)
      }
      if (admin.policies > 0) {
        return bad('add_context_rule with a policy is not relayed; a policy can authorize on its own, and this relay only pays to add a device')
      }
    } else {
      if (admin.contextRuleId === null) return bad('add_signer names no context rule id')
      if (admin.contextRuleId === 0) {
        return bad('add_signer on rule 0 is not relayed: rule 0 has no policy, so a second signer there would make every action need BOTH devices (2-of-2). A second device gets its own rule through add_context_rule.')
      }
      if (!isPasskey(admin.signer)) return bad(`add_signer must add a WebAuthn signer under the registry's verifier ${verifier}; this one is ${admin.signer.kind}`)
    }
    for (const [i, a] of auth.entries()) {
      if (a.root.kind !== 'contract-fn' || a.root.contract !== account || a.root.method !== func.method || a.root.argsXdr !== func.argsXdr) {
        return bad(`auth[${i}] authorizes something other than this exact ${func.method}; every entry must be for the host function it rides with`)
      }
      if (a.sub.length > 0) return bad(`auth[${i}] authorizes ${a.sub.length} sub-invocation(s) under ${func.method}; an account adding its own signer needs none`)
      if (a.credentials !== 'address' || a.address !== account) {
        return bad(`auth[${i}] is not the smart account ${account} authorizing a change to itself; nothing else may authorize it`)
      }
    }
    return {
      ok: true,
      rule: 'smart-account-admin',
      vault: null,
      smartAccount: account,
      method: admin.method,
      authAddresses: [account],
      summary: `${account} adds one WebAuthn signer to itself (${admin.method}${admin.method === 'add_signer' ? ` on rule ${admin.contextRuleId}` : ', a new Default rule'})`,
    }
  }

  // An invocation on a vault. Two shapes: the smart account's execute() wrapping an owner
  // call, or the owner call itself, authorized directly by the (contract) owner.
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

/**
 * Whether a contract runs the smart-account code the registry names, from a live read.
 *
 * "Is a demo smart account" is decided by CODE, never by a claim: the instance entry's
 * executable has to be the registry's account wasm. A missing entry, a Stellar Asset
 * Contract, an undecodable entry or another wasm are all refusals, each with its own words.
 */
export function smartAccountCodeVerdict(
  address: string,
  code: { found: boolean; executable: string | null; wasmHash: string | null } | null,
  expectedWasmHash: string | undefined,
): { ok: true } | { ok: false; code: 'rpc_error' | 'not_smart_account' | 'smart_account_code_mismatch' | 'network_not_served'; reason: string } {
  const want = expectedWasmHash?.toLowerCase()
  if (!want) return { ok: false, code: 'network_not_served', reason: 'this chain declares no contracts.smartAccount, so there is no account code anything could be checked against' }
  if (!code) return { ok: false, code: 'rpc_error', reason: `the code of ${address} could not be read on chain; the check is never skipped, so nothing was done` }
  if (!code.found) return { ok: false, code: 'not_smart_account', reason: `nothing is deployed at ${address} on this network, so it is not a smart account` }
  if (code.executable !== 'wasm' || !code.wasmHash) {
    return { ok: false, code: 'not_smart_account', reason: `${address} runs ${code.executable ?? 'an executable this server cannot decode'}, not the OpenZeppelin smart-account wasm` }
  }
  if (code.wasmHash.toLowerCase() !== want) {
    return {
      ok: false,
      code: 'smart_account_code_mismatch',
      reason: `${address} runs wasm ${code.wasmHash}, and the only account code this demo serves on this network is ${want}, read from the registry`,
    }
  }
  return { ok: true }
}

export type RelayDecisionCode =
  | 'no_operator'
  | 'rpc_error'
  | 'not_our_vault'
  | 'owner_not_contract'
  | 'not_owner'
  | 'flagship_vault'
  | 'not_smart_account'
  | 'smart_account_code_mismatch'
  | 'network_not_served'

export type RelayDecision =
  | { ok: true; vault: string | null; owner: string | null; operator: string | null }
  | { ok: false; status: 403 | 502 | 503; code: RelayDecisionCode; reason: string }

/** The live facts a relay decision rests on, each read by the route and none taken from the request. */
export type RelayLive = {
  /** The vault's owner() and operator(), on the vault rules. Null when the read failed. */
  vault: { owner: string; operator: string } | null
  /** This server's operator account for the network, or null when no key is configured. */
  signer: string | null
  /** The code the smart account in question runs: the vault owner, or the admin caller. Null when unread or failed. */
  accountCode: { found: boolean; executable: string | null; wasmHash: string | null } | null
  /** The registry's account wasm for the network. */
  expectedWasmHash: string | undefined
  /** Vault ids refused outright (flagshipVaults). */
  flagship: string[]
}

/**
 * The half that needs the ledger, and why it is never skipped.
 *
 * "A vault we operate" is a live fact, not a registry entry: the vault's `operator()` has to
 * read back as this server's own signer. An unreadable vault is 502, never a pass, because
 * failing open here would let anyone have us pay for calls on vaults we know nothing about;
 * and no signer at all is 503, because without one there is no vault we operate. The owner
 * bound to the authorization is checked against the vault's live `owner()`, not against the
 * request's own claim about itself, and that owner has to be a smart account running the
 * registry's account code: a demo vault this flow deployed, and no other.
 */
export function relayDecision(pre: RelayPreflightOk, live: RelayLive): RelayDecision {
  if (pre.rule === 'smart-account-deploy') return { ok: true, vault: null, owner: null, operator: null }
  if (pre.rule === 'smart-account-admin') {
    const verdict = smartAccountCodeVerdict(pre.smartAccount ?? '', live.accountCode, live.expectedWasmHash)
    if (!verdict.ok) {
      return { ok: false, status: verdict.code === 'rpc_error' ? 502 : 403, code: verdict.code, reason: `${verdict.reason}. Nothing was forwarded.` }
    }
    return { ok: true, vault: null, owner: pre.smartAccount, operator: null }
  }
  if (pre.vault && live.flagship.includes(pre.vault)) {
    return {
      ok: false,
      status: 403,
      code: 'flagship_vault',
      reason: `vault ${pre.vault} is one of this network's recorded vaults, and the public passkey relay never pays for calls on those, whoever signs them. Nothing was forwarded.`,
    }
  }
  if (!live.signer) {
    return {
      ok: false,
      status: 503,
      code: 'no_operator',
      reason: 'this server has no Stellar signer configured for this network, so it operates no vault and relays no owner call. Nothing was forwarded.',
    }
  }
  if (!live.vault) {
    return { ok: false, status: 502, code: 'rpc_error', reason: `vault ${pre.vault} could not be read on chain, so the call was not forwarded. The check is never skipped: an unreadable vault is a reason to stop.` }
  }
  if (live.vault.operator.trim() !== live.signer) {
    return { ok: false, status: 403, code: 'not_our_vault', reason: `vault ${pre.vault} is operated by ${live.vault.operator}, not by this server, so this relay will not pay for calls on it. Nothing was forwarded.` }
  }
  const owner = live.vault.owner.trim()
  if (!isContractId(owner)) {
    return { ok: false, status: 403, code: 'owner_not_contract', reason: `vault ${pre.vault} is owned by the account ${owner}, not by a smart account; its owner signs through the vault console, not this relay.` }
  }
  if (pre.rule === 'owner-call') {
    const stranger = pre.authAddresses.find((a) => a !== owner)
    if (stranger) return { ok: false, status: 403, code: 'not_owner', reason: `${stranger} authorized this call, and vault ${pre.vault} reports its owner as ${owner}, read live. Nothing was forwarded.` }
  }
  if (pre.rule === 'smart-account-execute' && owner !== pre.smartAccount) {
    return { ok: false, status: 403, code: 'not_owner', reason: `${pre.smartAccount} is not the owner of vault ${pre.vault}; it reports ${owner}, read live. Nothing was forwarded.` }
  }
  const verdict = smartAccountCodeVerdict(owner, live.accountCode, live.expectedWasmHash)
  if (!verdict.ok) {
    return { ok: false, status: verdict.code === 'rpc_error' ? 502 : 403, code: verdict.code, reason: `vault ${pre.vault} is not a demo vault: ${verdict.reason}. Nothing was forwarded.` }
  }
  return { ok: true, vault: pre.vault, owner, operator: live.vault.operator.trim() }
}

// ── the operator key's own calls: which vaults it may act on ─────────────────────

export type OperatorGate =
  | { ok: true; owner: string; operator: string }
  | {
      ok: false
      status: 403 | 502 | 503
      code: 'flagship_vault' | 'no_operator' | 'rpc_error' | 'not_operator' | 'owner_not_contract' | 'not_smart_account' | 'smart_account_code_mismatch' | 'network_not_served'
      reason: string
    }

/**
 * Whether the OPERATOR key may call pay() on this vault for an anonymous caller (X.4).
 *
 * The risk this closes is specific. agent-pay has no session in front of it, and its first
 * version checked only that the vault's live operator was our signer. If the same key also
 * operates a vault that is not a demo (the flagship testnet vault is operated by exactly the
 * account STELLAR_TESTNET_SIGNER_SECRET decodes to), anyone could have us call pay() on it,
 * inside its policy but at a time and to a payee of their choosing. So a vault qualifies only
 * when all of these read true, live: it is not a recorded vault, our signer operates it, and
 * its owner is a smart account whose instance runs the registry's account wasm, which is to
 * say a vault this passkey flow deployed for a passkey.
 */
export function operatorGate(
  vault: string,
  input: {
    flagship: string[]
    signer: string | null
    live: { owner: string; operator: string } | null
    ownerCode: { found: boolean; executable: string | null; wasmHash: string | null } | null
    expectedWasmHash: string | undefined
  },
): OperatorGate {
  if (input.flagship.includes(vault)) {
    return {
      ok: false,
      status: 403,
      code: 'flagship_vault',
      reason: `vault ${vault} is one of this network's recorded vaults; the public passkey endpoints never have the operator key act on it. Nothing was submitted.`,
    }
  }
  if (!input.signer) return { ok: false, status: 503, code: 'no_operator', reason: 'no operator key is configured for this network, so this server operates no vault. Nothing was submitted.' }
  if (!input.live) return { ok: false, status: 502, code: 'rpc_error', reason: `vault ${vault} could not be read, so nothing was submitted. The operator check is never skipped.` }
  if (input.live.operator.trim() !== input.signer) {
    return { ok: false, status: 403, code: 'not_operator', reason: `vault ${vault} is operated by ${input.live.operator}, not by this server (${input.signer}), so this server cannot and will not call pay() on it.` }
  }
  const owner = input.live.owner.trim()
  if (!isContractId(owner)) {
    return { ok: false, status: 403, code: 'owner_not_contract', reason: `vault ${vault} is owned by the account ${owner}, so it is not a passkey demo vault and the public endpoint will not pay from it. Nothing was submitted.` }
  }
  const verdict = smartAccountCodeVerdict(owner, input.ownerCode, input.expectedWasmHash)
  if (!verdict.ok) {
    return { ok: false, status: verdict.code === 'rpc_error' ? 502 : 403, code: verdict.code, reason: `vault ${vault} is not a passkey demo vault: ${verdict.reason}. Nothing was submitted.` }
  }
  return { ok: true, owner, operator: input.live.operator.trim() }
}

// ── the deploy's owner: one passkey, read live ───────────────────────────────────

export type OwnerAccountCheck =
  | { ok: true; ruleId: number; verifier: string; keyHex: string }
  | {
      ok: false
      status: 400 | 403 | 502
      code:
        | 'rpc_error'
        | 'not_smart_account'
        | 'smart_account_code_mismatch'
        | 'network_not_served'
        | 'owner_rules_unexpected'
        | 'owner_signer_unexpected'
        | 'owner_key_mismatch'
      reason: string
    }

/**
 * Whether a vault may be deployed with this smart account as its owner.
 *
 * The deploy spends our key and, on pubnet, our USDC, for an owner nobody has vouched for,
 * so what the browser says about the owner is checked against the account itself before
 * anything is spent. It must run the registry's account wasm, and it must hold exactly one
 * active context rule (Default, no policy, no expiry) whose only signer is
 * External(registry WebAuthn verifier, the passkey key the browser sent). No Ed25519 key,
 * no delegated G... account and no policy may sit beside it: any of those could authorize
 * the vault's owner calls without the passkey, and then "the passkey owns this vault" would
 * be a sentence the chain does not back.
 *
 * The key comparison is on the first 65 bytes, the uncompressed P-256 point. The
 * OpenZeppelin WebAuthn signer stores the credential id after it (smart-account-kit's
 * buildKeyData), which the browser need not send and the check need not trust.
 */
export function ownerAccountCheck(input: {
  owner: string
  publicKeyHex: string
  code: { found: boolean; executable: string | null; wasmHash: string | null } | null
  rules: { count: number; rules: { id: number; contextType: string; signers: RelaySigner[]; policies: string[]; validUntil: number | null }[] } | null
  expected: { wasmHash: string | undefined; webauthnVerifier: string | undefined }
}): OwnerAccountCheck {
  const verdict = smartAccountCodeVerdict(input.owner, input.code, input.expected.wasmHash)
  if (!verdict.ok) {
    return { ok: false, status: verdict.code === 'rpc_error' ? 502 : verdict.code === 'network_not_served' ? 400 : 403, code: verdict.code, reason: verdict.reason }
  }
  if (!input.rules) return { ok: false, status: 502, code: 'rpc_error', reason: `the signers of ${input.owner} could not be read, so no vault was deployed for it` }
  const verifier = input.expected.webauthnVerifier
  if (!verifier) return { ok: false, status: 400, code: 'network_not_served', reason: 'this chain declares no WebAuthn verifier, so no passkey signer can be checked' }
  const { rules } = input.rules
  if (rules.length !== 1) {
    return {
      ok: false,
      status: 403,
      code: 'owner_rules_unexpected',
      reason: `${input.owner} has ${rules.length} active context rules; a vault is deployed only for an account whose single rule holds the one passkey, so that nothing but that passkey can authorize for it`,
    }
  }
  const rule = rules[0]
  if (rule.contextType !== 'default' || rule.policies.length > 0 || rule.validUntil !== null) {
    return {
      ok: false,
      status: 403,
      code: 'owner_rules_unexpected',
      reason: `${input.owner}'s rule ${rule.id} is ${rule.contextType} with ${rule.policies.length} polic(ies)${rule.validUntil !== null ? ` and expires at ledger ${rule.validUntil}` : ''}; it must be a Default rule with no policy and no expiry`,
    }
  }
  if (rule.signers.length !== 1) {
    return { ok: false, status: 403, code: 'owner_signer_unexpected', reason: `${input.owner}'s rule ${rule.id} holds ${rule.signers.length} signers; it must hold exactly one, the passkey` }
  }
  const signer = rule.signers[0]
  if (signer.kind !== 'external' || signer.verifier !== verifier) {
    const what = signer.kind === 'external' ? `an External signer under ${signer.verifier}` : signer.kind === 'delegated' ? `the delegated account ${signer.address}` : 'a signer of a kind this server does not read'
    return { ok: false, status: 403, code: 'owner_signer_unexpected', reason: `${input.owner}'s only signer is ${what}, not a WebAuthn passkey under the registry's verifier ${verifier}` }
  }
  const want = input.publicKeyHex.toLowerCase()
  if (signer.keyHex.length < 130 || signer.keyHex.slice(0, 130).toLowerCase() !== want) {
    return {
      ok: false,
      status: 403,
      code: 'owner_key_mismatch',
      reason: `${input.owner}'s passkey signer is not the public key this request sent, so the browser asking is not the passkey that controls it. No vault was deployed.`,
    }
  }
  return { ok: true, ruleId: rule.id, verifier, keyHex: signer.keyHex }
}

/**
 * The passkey's public key as the browser sends it: the 65-byte uncompressed P-256 point
 * (0x04 || x || y), in hex or base64 / base64url. Returned as lowercase hex, or null.
 */
export function parsePasskeyPublicKey(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  let bytes: Buffer | null = null
  if (/^(0x)?[0-9a-fA-F]{130}$/.test(t)) bytes = Buffer.from(t.replace(/^0x/, ''), 'hex')
  else if (/^[A-Za-z0-9+/_-]{86,88}={0,2}$/.test(t)) bytes = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (!bytes || bytes.length !== 65 || bytes[0] !== 0x04) return null
  return bytes.toString('hex')
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

// ── what the SEED may cost us, across everyone, per network ──────────────────────
//
// The relay budget above bounds XLM fees a third party charges us. This one bounds the
// only leg that moves our own USDC: the seed a freshly deployed demo vault is given. On
// testnet that is play money and the budget exists so the code path is exercised. On
// pubnet it is the difference between a demo and a faucet, because nothing sits in front
// of the deploy endpoint except these numbers.
//
// Counted in micro-USD integers rather than floats. Seeds are hundredths of a dollar and
// summing 0.01 a hundred times in binary floating point does not give 1.

export type SeedBudgetRefusal = {
  ok: false
  status: 429
  code: 'seed_budget_exhausted'
  reason: string
  retryAfterSeconds: number
}
export type SeedCharge =
  | { ok: true; chargedUsd: number; spentUsd: number; budgetUsd: number; resetAt: number }
  | SeedBudgetRefusal

export type SeedSnapshot = {
  network: string
  budgetUsd: number
  spentUsd: number
  remainingUsd: number
  seedsLeft: number
  seedsPaid: number
  windowMs: number
  resetAt: number | null
  enforcedIn: string
  note: string
}

export interface SeedBudget {
  charge(network: string, usd: number, caps: PasskeyCaps, now?: number): SeedCharge
  /** Hand the reserve back when the seed did not happen after all. */
  refund(network: string, usd: number, now?: number): void
  snapshot(network: string, caps: PasskeyCaps, now?: number): SeedSnapshot
}

const MICRO = 1_000_000
const micro = (usd: number) => Math.max(0, Math.round(usd * MICRO))

/** Factory rather than a singleton so a test never inherits another test's day. */
export function createSeedBudget(windowMs = 86_400_000): SeedBudget {
  const days = new Map<string, { spent: number; paid: number; resetAt: number }>()
  const roll = (network: string, now: number) => {
    const d = days.get(network)
    if (!d || d.resetAt <= now) {
      const fresh = { spent: 0, paid: 0, resetAt: now + windowMs }
      days.set(network, fresh)
      return fresh
    }
    return d
  }
  return {
    charge(network, usd, caps, now = Date.now()) {
      const d = roll(network, now)
      const budget = micro(caps.seedDailyTotalUsd)
      const want = micro(usd)
      // A zero seed is allowed and costs nothing: a caller may deploy an empty vault on
      // purpose, and refusing that would make the budget stop something it does not pay for.
      if (want === 0) {
        return { ok: true, chargedUsd: 0, spentUsd: d.spent / MICRO, budgetUsd: caps.seedDailyTotalUsd, resetAt: d.resetAt }
      }
      if (d.spent + want > budget) {
        const retryAfterSeconds = Math.max(1, Math.ceil((d.resetAt - now) / 1000))
        return {
          ok: false,
          status: 429,
          code: 'seed_budget_exhausted',
          retryAfterSeconds,
          reason:
            `the ${network} demo seeds at most ${caps.seedDailyTotalUsd} USDC per UTC day across ALL callers, and ` +
            `${d.spent / MICRO} of it is spent across ${d.paid} vaults. Nothing was deployed and no USDC left this server. ` +
            'The vault deploy and every passkey signature cost network fees only, which the relayer sponsors; the seed is the one ' +
            `leg that moves our own money, which is why it is the one leg with a shared ceiling. Retry in ${retryAfterSeconds} s, ` +
            'or fund a vault yourself and skip the seed entirely by sending seedUsd 0.',
        }
      }
      d.spent += want
      d.paid += 1
      return { ok: true, chargedUsd: usd, spentUsd: d.spent / MICRO, budgetUsd: caps.seedDailyTotalUsd, resetAt: d.resetAt }
    },

    refund(network, usd, now = Date.now()) {
      const d = days.get(network)
      // A refund into a window that already rolled is a refund of money the new window
      // never counted, so it is dropped rather than credited against someone else's day.
      if (!d || d.resetAt <= now) return
      const back = micro(usd)
      if (back === 0) return
      d.spent = Math.max(0, d.spent - back)
      d.paid = Math.max(0, d.paid - 1)
    },

    snapshot(network, caps, now = Date.now()) {
      const d = days.get(network)
      const live = d && d.resetAt > now ? d : { spent: 0, paid: 0, resetAt: 0 }
      const remaining = Math.max(0, micro(caps.seedDailyTotalUsd) - live.spent)
      return {
        network,
        budgetUsd: caps.seedDailyTotalUsd,
        spentUsd: live.spent / MICRO,
        remainingUsd: remaining / MICRO,
        seedsLeft: caps.seedUsdDefault > 0 ? Math.floor(remaining / micro(caps.seedUsdDefault)) : 0,
        seedsPaid: live.paid,
        windowMs,
        resetAt: live.resetAt || null,
        enforcedIn: 'mcp/src/http/stellar-passkey-routes.ts, charged before the vault deploy spends the operator key',
        note:
          'Measured, not reserved: unlike the relayer fee, we choose this amount and know it exactly. A deploy that fails after ' +
          'the charge hands it back, so a refused chain write does not cost the day a seed.',
      }
    },
  }
}

/** Process-local, like the relay budget, and bounded per instance for the same reason. */
export const seedBudget = createSeedBudget()

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
  | {
      ok: true
      owner: string
      /** The passkey's 65-byte P-256 point, lowercase hex, checked against the account's live signer. */
      ownerPublicKeyHex: string
      dailyCapUsd: number
      autoApproveUsd: number
      seedUsd: number
      dailyCapRaw: string
      autoApproveMaxRaw: string
      seedRaw: string
    }
  | { ok: false; reason: string }

/**
 * A vault owned by a passkey smart account, under the demo caps.
 *
 * The owner has to be a CONTRACT: a G... owner already has the vault console, and this path
 * exists for the account a browser passkey controls. The browser also sends the passkey's
 * public key, which the route compares with the account's live signer before anything is
 * spent (ownerAccountCheck). Zero caps are refused although the contract accepts them,
 * because in this contract 0 means NO cap, and a vault anyone on the internet can have us
 * deploy and seed must have one.
 */
export function passkeyDeployPlan(body: unknown, decimals: number, caps: PasskeyCaps, network: string): PasskeyDeployPlan {
  const b = asObject(body) ?? {}
  const owner = typeof b.owner === 'string' ? b.owner.trim() : ''
  if (!isContractId(owner)) {
    return { ok: false, reason: 'owner must be the passkey smart account\'s contract id (C... StrKey). A G... owner uses POST /api/agents/vault through the console instead.' }
  }
  const ownerPublicKeyHex = parsePasskeyPublicKey(b.ownerPublicKey)
  if (!ownerPublicKeyHex) {
    return {
      ok: false,
      reason: 'ownerPublicKey must be the passkey\'s 65-byte uncompressed P-256 public key (0x04 || x || y), hex or base64; it is compared with the smart account\'s live signer before a vault is deployed for it',
    }
  }
  if (!finite(b.dailyCapUsd) || b.dailyCapUsd <= 0 || b.dailyCapUsd > caps.dailyCapUsd) {
    return { ok: false, reason: `dailyCapUsd must be a number above 0 and at most ${caps.dailyCapUsd} on ${network} (0 would mean no cap)` }
  }
  if (!finite(b.autoApproveUsd) || b.autoApproveUsd <= 0 || b.autoApproveUsd > caps.autoApproveUsd) {
    return { ok: false, reason: `autoApproveUsd must be a number above 0 and at most ${caps.autoApproveUsd} on ${network} (0 would mean no ceiling)` }
  }
  let seedUsd: number = caps.seedUsdDefault
  if (b.seedUsd !== undefined) {
    if (!finite(b.seedUsd) || b.seedUsd < 0 || b.seedUsd > caps.seedUsdMax) {
      return { ok: false, reason: `seedUsd must be a number from 0 to ${caps.seedUsdMax} on ${network}; it is USDC that leaves this server's own account for good` }
    }
    seedUsd = b.seedUsd
  }
  return {
    ok: true,
    owner,
    ownerPublicKeyHex,
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
export function passkeyAgentPayPlan(body: unknown, decimals: number, caps: PasskeyCaps, network: string): PasskeyAgentPayPlan {
  const b = asObject(body) ?? {}
  const contract = typeof b.contract === 'string' ? b.contract.trim() : ''
  const to = typeof b.to === 'string' ? b.to.trim() : ''
  if (!isContractId(contract)) return { ok: false, reason: 'contract must be the vault\'s Soroban contract id (C... StrKey)' }
  if (!isAccountId(to) && !isContractId(to)) return { ok: false, reason: 'to must be a Stellar account (G...) or a contract (C...)' }
  if (!finite(b.amountUsd) || b.amountUsd <= 0 || b.amountUsd > caps.agentPayMaxUsd) {
    return { ok: false, reason: `amountUsd must be a number above 0 and at most ${caps.agentPayMaxUsd} on ${network}` }
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
    /** Live too, from the same ledger the deploy endpoint charges. */
    seedLimits: SeedSnapshot
    /** Every network this deployment serves, so a page can offer exactly those. */
    servedNetworks: string[]
  },
): Record<string, unknown> {
  const sa = chain.contracts.smartAccount
  const caps = passkeyCaps(chain)
  const realMoney = chain.caip2 === 'stellar:pubnet'
  const missing = [!cfg.keyConfigured ? cfg.keyVar : null, !cfg.operator ? (chain.signerEnvVar ?? 'the chain signer') : null].filter(Boolean)
  return {
    release: PASSKEY_RELEASE.name,
    network: chain.caip2,
    chain: chain.id,
    // Real money or not, said first rather than left to be inferred from a CAIP-2 string.
    realMoney,
    // Served means these endpoints answer for this network at all, which is a fact about the
    // registry (the OpenZeppelin constants are recorded for it). Whether each step can
    // actually EXECUTE rather than answer prepared is `readiness`, a fact about this
    // deployment's configuration, and the two are kept apart so neither is mistaken for
    // the other.
    served: Boolean(sa),
    servedNetworks: cfg.servedNetworks,
    readiness: {
      relay: cfg.keyConfigured,
      operator: Boolean(cfg.operator),
      allSteps: missing.length === 0,
      note:
        missing.length === 0
          ? 'Every step executes: the relay forwards to the relayer and the operator key deploys, seeds and pays.'
          : `Steps that need ${missing.join(' and ')} answer prepared: validated, and nothing submitted.`,
    },
    defaultNetwork: PASSKEY_RELEASE.defaultNetwork,
    relayer: {
      product: PASSKEY_RELEASE.relayerProduct,
      name: PASSKEY_RELEASE.relayerName,
      url: cfg.relayerUrl,
      keyVar: cfg.keyVar,
      keyConfigured: cfg.keyConfigured,
      configured: cfg.keyConfigured,
      // Not knowable from here, and said so rather than filled in. Channels pays from its
      // own fund account through a pool of channel accounts, and which one is a fact of
      // each transaction: the fee-bump's outer source, read off the ledger per hash.
      feePayerAccount: null,
      feePayerNote:
        'The relayer fee-bumps each transaction from its own account; the paying account is named per transaction by GET /api/stellar/passkey/fee-payer?hash=...&network=..., read from the ledger.',
      endpoint: '/api/stellar/passkey/relay',
      note: cfg.keyConfigured
        ? 'Allowlisted requests are forwarded and fee-sponsored by the relayer; the key never leaves this server.'
        : `${cfg.keyVar} is unset, so the relay answers prepared: it validates and returns exactly what it would post, and forwards nothing.`,
    },
    smartAccount: sa
      ? {
          wasmHash: sa.wasmHash,
          webauthnVerifier: sa.webauthnVerifier,
          ed25519Verifier: sa.ed25519Verifier,
          verified: sa.verified,
          thirdParty: true,
          publisher: 'OpenZeppelin',
        }
      : null,
    vault: {
      // The code a vault deployed here instantiates, from the registry. Ops move it when a
      // new build is uploaded; nothing in this file names a hash of its own.
      wasmHash: chain.contracts.spendVaultWasmHash ?? null,
      flagshipRefused: flagshipVaults(chain),
    },
    passkeyVault: chain.contracts.passkeyVault
      ? {
          contract: chain.contracts.passkeyVault,
          explorerUrl: cfg.explorerFor(chain.contracts.passkeyVault),
          ownerKind: 'smart-account',
          note: 'A rehearsal: its owner was signed by a software P-256 key in mcp/scripts/stellar-passkey-proof.mjs, not by a device passkey.',
        }
      : null,
    operator: {
      envVar: chain.signerEnvVar ?? null,
      configured: Boolean(cfg.operator),
      account: cfg.operator,
      address: cfg.operator,
      role: 'the vault operator that signs pay(), and the source and fee payer of every vault deployed here. It can pay() from a demo vault inside the policy its owner set, to payees the owner allowlisted, and nothing else.',
    },
    // The caps in force on THIS network, and every network's beside them, because a reader
    // comparing pubnet against testnet should not have to call the endpoint twice to learn
    // that the pubnet seed is a fiftieth of the testnet one. The named aliases are the ones
    // the page reads to size its defaults.
    caps: {
      ...caps,
      dailyCapMaxUsd: caps.dailyCapUsd,
      perPaymentMaxUsd: caps.autoApproveUsd,
      sharedDailyCeilingUsd: caps.seedDailyTotalUsd,
    },
    capsByNetwork: PASSKEY_CAPS_BY_NETWORK,
    // Published for the same reason the caps are: nothing sits in front of this endpoint
    // except these numbers, so a reader who cannot see them cannot check them. The fee
    // block says reserved rather than spent on purpose; its own note explains why we
    // cannot say spent.
    limits: cfg.relayLimits,
    // The other ceiling, and the one that bounds OUR money rather than a third party's fee.
    seedBudget: cfg.seedLimits,
    endpoints: {
      status: 'GET /api/stellar/passkey/status?network=',
      relay: 'POST /api/stellar/passkey/relay?network=  { func, auth[] } | { xdr }',
      deploy: 'POST /api/stellar/passkey/vault/deploy  { network, owner, ownerPublicKey, dailyCapUsd, autoApproveUsd, seedUsd? }',
      vault: 'GET /api/stellar/passkey/vault?contract=&network=',
      feePayer: 'GET /api/stellar/passkey/fee-payer?hash=&network=',
      allowlistPlan: 'POST /api/stellar/passkey/allowlist/plan  { network, contract, payee, agentId? }',
      agentPay: 'POST /api/stellar/passkey/agent-pay  { network, contract, to, amountUsd }',
    },
    checkedAt: new Date().toISOString(),
  }
}
