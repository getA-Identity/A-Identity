/**
 * Every decision the Stellar vault endpoints make, with no network and no Stellar SDK.
 *
 * The shape of the feature is unusual enough to be worth stating before the code. On Arc a
 * vault's owner can be the server, so the server signs owner calls. On Soroban it cannot:
 * `AgentSpendPolicy.__constructor` refuses `owner == operator`, we hold the operator key,
 * and every owner entrypoint calls `owner.require_auth()`. So the product cannot be "the
 * server changes your limits". It is "the server builds the exact transaction, proves by
 * simulation that the contract would accept it, and hands it to the wallet that may sign
 * it" - and then broadcasts what comes back.
 *
 * That makes the two write endpoints a RELAY, and a relay is only as safe as what it
 * refuses. The rules live here, as pure functions, because a rule that can only be tested
 * by standing up a server and a ledger is a rule nobody re-tests after they change it:
 *
 *  - which entrypoints may be built at all (six, named, never a pattern),
 *  - which arguments each one takes and how a USD number becomes base units,
 *  - whose wallet may be a transaction source (the caller's own, proven, never a stranger's),
 *  - which contracts may be addressed (a registry vault, a vault on an agent you own, or a
 *    vault running a build we published whose live owner is your own wallet),
 *  - how a ledger TTL turns into a date a human can act on,
 *  - and how one vault's live state becomes the public read the console panel shows.
 *
 * `mcp/src/http/stellar-vault-routes.ts` is the thin half: it reads the body, calls these,
 * calls the adapter, and maps the answer onto a status code.
 */
import { isAccountId, isContractId } from './chains/stellar/strkey.js'
import type { ChainDescriptor } from './chains/types.js'

/**
 * One argument in the form the Stellar adapter converts to XDR.
 *
 * Restated here rather than imported so this module stays free of anything that reaches
 * the SDK, even as a type. `adapter.ts` owns the conversion and a test pins the two lists
 * against each other, so they cannot drift without going red.
 */
export type ScArgPlan =
  | { kind: 'i128'; value: string }
  | { kind: 'u64'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'address'; value: string }

/** The six owner entrypoints, in the contract's own spelling. Frozen: this is a boundary. */
export const OWNER_ACTIONS = [
  'set_policy',
  'set_frozen',
  'set_allowed',
  'set_session_key_expiry',
  'withdraw',
  'owner_pay',
] as const
export type OwnerAction = (typeof OWNER_ACTIONS)[number]

export function isOwnerAction(v: unknown): v is OwnerAction {
  return typeof v === 'string' && (OWNER_ACTIONS as readonly string[]).includes(v)
}

/** What a caller may send for each action. Every field is checked before it is used. */
export type OwnerCallArgs = {
  dailyCapUsd?: unknown
  autoApproveUsd?: unknown
  allowlistEnabled?: unknown
  frozen?: unknown
  payee?: unknown
  allowed?: unknown
  expiryUnix?: unknown
  to?: unknown
  amountUsd?: unknown
}

export type OwnerCallPlan =
  | { ok: true; method: OwnerAction; args: ScArgPlan[]; summary: string }
  | { ok: false; reason: string }

/**
 * A USD amount in the token's own base units, as a decimal string.
 *
 * Stellar settles at 7 decimals and every EVM stablecoin this product settles in has 6, so
 * the decimals come from the token descriptor rather than a constant. `Math.round` on the
 * scaled value rather than string surgery, because the amounts here are console-sized and
 * the alternative is a parser nobody will read; the rounding is at the token's own
 * precision, so it can only ever move the value by less than one base unit.
 */
export function toRawUnits(usd: number, decimals: number): string {
  return String(BigInt(Math.round(usd * 10 ** decimals)))
}

/** A finite, non-negative number no larger than the ceiling a console ever sends. */
function positiveUsd(v: unknown, opts: { allowZero: boolean }): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  if (v < 0) return null
  if (!opts.allowZero && v === 0) return null
  if (v > 1_000_000) return null
  return v
}

/** An address the contract will accept: a classic account or another contract. */
function anyStellarAddress(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return isAccountId(s) || isContractId(s) ? s : null
}

/**
 * Turn a request into the exact contract call, or say why it is not one.
 *
 * Pure, and deliberately strict: a missing boolean is refused rather than defaulted,
 * because every default here is a silent policy change on somebody's money. `set_policy`
 * with an omitted `allowlistEnabled` would turn an allowlist off; that is a decision, not
 * an omission, so it has to be sent.
 */
export function ownerCallPlan(action: OwnerAction, args: OwnerCallArgs, decimals: number): OwnerCallPlan {
  const money = (usd: number) => ({ kind: 'i128' as const, value: toRawUnits(usd, decimals) })
  switch (action) {
    case 'set_policy': {
      const cap = positiveUsd(args.dailyCapUsd, { allowZero: true })
      const ceiling = positiveUsd(args.autoApproveUsd, { allowZero: true })
      if (cap === null) return { ok: false, reason: 'dailyCapUsd must be a number from 0 upward (0 means no cap)' }
      if (ceiling === null) return { ok: false, reason: 'autoApproveUsd must be a number from 0 upward (0 means no ceiling)' }
      if (typeof args.allowlistEnabled !== 'boolean') {
        return { ok: false, reason: 'allowlistEnabled must be true or false; leaving it out would silently change the allowlist' }
      }
      return {
        ok: true,
        method: action,
        args: [money(cap), money(ceiling), { kind: 'bool', value: args.allowlistEnabled }],
        summary: `daily cap ${cap} USD, auto-approve ceiling ${ceiling} USD, allowlist ${args.allowlistEnabled ? 'on' : 'off'}`,
      }
    }
    case 'set_frozen': {
      if (typeof args.frozen !== 'boolean') return { ok: false, reason: 'frozen must be true or false' }
      return {
        ok: true,
        method: action,
        args: [{ kind: 'bool', value: args.frozen }],
        summary: args.frozen
          ? 'freeze the vault: the agent cannot spend at all, and owner_pay still works'
          : 'unfreeze the vault',
      }
    }
    case 'set_allowed': {
      const payee = anyStellarAddress(args.payee)
      if (!payee) return { ok: false, reason: 'payee must be a Stellar account (G...) or a contract (C...)' }
      if (typeof args.allowed !== 'boolean') return { ok: false, reason: 'allowed must be true or false' }
      return {
        ok: true,
        method: action,
        args: [{ kind: 'address', value: payee }, { kind: 'bool', value: args.allowed }],
        summary: `${args.allowed ? 'allow' : 'revoke'} payee ${payee}`,
      }
    }
    case 'set_session_key_expiry': {
      const expiry = args.expiryUnix
      if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry < 0 || !Number.isInteger(expiry)) {
        return { ok: false, reason: 'expiryUnix must be a whole number of UNIX seconds, 0 or more' }
      }
      // The contract's rule, restated because it is the one people get backwards: 0 is NO
      // time bound at all, which is an operator whose authority never lapses.
      return {
        ok: true,
        method: action,
        args: [{ kind: 'u64', value: String(expiry) }],
        summary:
          expiry === 0
            ? 'remove the session-key time bound entirely (0 means the operator never lapses)'
            : `session key expires ${new Date(expiry * 1000).toISOString()}; pay() reverts SessionKeyExpired after it`,
      }
    }
    case 'withdraw':
    case 'owner_pay': {
      const to = anyStellarAddress(args.to)
      if (!to) return { ok: false, reason: 'to must be a Stellar account (G...) or a contract (C...)' }
      const amount = positiveUsd(args.amountUsd, { allowZero: false })
      if (amount === null) return { ok: false, reason: 'amountUsd must be a number above 0 (the contract refuses 0 with InvalidAmount)' }
      return {
        ok: true,
        method: action,
        args: [{ kind: 'address', value: to }, money(amount)],
        summary:
          action === 'withdraw'
            ? `withdraw ${amount} USD from the vault to ${to}`
            : `owner override: pay ${amount} USD to ${to}, past the auto-approve ceiling and the freeze, still counted by the daily cap`,
      }
    }
  }
}

// ── who may ask, and about which vault ───────────────────────────────────────────

export type AuthorizeInput = {
  /** The wallet or contract named as the transaction source. */
  source: string
  /** The vault the call addresses. */
  contract: string
  /** The session subject, which IS a wallet address on a wallet sign-in. */
  caller?: string
  /** True when that subject is a wallet rather than an email. */
  callerIsWallet: boolean
  /** Stellar wallets this account has proven control of, beyond the session's own. */
  linkedWallets: string[]
  /** Vaults the registry declares on this network. Public, and anyone's to read. */
  registryVaults: string[]
  /** Vaults recorded on agents this caller owns, on this network. */
  ownedVaults: string[]
  /**
   * Whether the vault's live executable is an AgentSpendPolicy build we published. Undefined
   * when it was not read, which happens whenever the vault is already listed: the read is
   * only spent on a vault that has no other way in.
   */
  knownBuild?: boolean
  /** The vault's live `owner`, or null when the read did not answer. */
  liveOwner: string | null
}

export type AuthorizeResult =
  | { ok: true }
  | { ok: false; status: number; code: 'bad_request' | 'not_your_wallet' | 'not_owner' | 'unknown_vault' | 'rpc_error'; reason: string }

/**
 * The second way a vault becomes addressable: the code it runs, rather than where we wrote
 * its address down.
 *
 * A person who deploys their own vault from a build we published, with their own wallet as
 * the owner, should be able to drive it from the console without us adding its address to
 * the registry or to an agent first. What makes that safe is the pair of facts the gate
 * then demands: the instance's live executable is one of `knownVaultWasmHashes` (so the
 * entrypoints mean what our source says they mean), AND its live owner is the caller's own
 * session or linked wallet (checked in authorizeOwnerCall, as for every vault). Neither alone
 * is enough: a known build owned by a stranger is a stranger's vault, and an owner match on
 * unknown code is a contract whose `set_frozen` could do anything.
 */
export function knownBuildOf(chain: ChainDescriptor, wasmHash: string | null | undefined): { known: boolean; version: string | null } {
  const h = (wasmHash ?? '').toLowerCase()
  const hit = (chain.contracts.knownVaultWasmHashes ?? []).find((k) => k.hash.toLowerCase() === h)
  return hit ? { known: true, version: hit.version } : { known: false, version: null }
}

/**
 * Three separate questions, asked in order, because they fail for different people.
 *
 *  1. Is this source a wallet the CALLER has proven? We never relay for a stranger, even a
 *     correctly signed transaction: an endpoint that broadcasts anything anyone hands it is
 *     an open relay wearing our IP address, and being the sender of someone else's
 *     transaction is not a neutral act.
 *  2. Is this contract one we know? Either a registry slot declares it, or it is recorded on
 *     an agent the caller owns, or its live executable is an AgentSpendPolicy build we
 *     published (see knownBuildOf). Anything else and this endpoint would be a
 *     general-purpose proxy into Soroban.
 *  3. Is that source actually the vault's owner ON CHAIN? Checked against a live read, not
 *     against what we stored, because our record is a copy and the ledger is the fact. A
 *     read that did not answer is 502, never a pass: failing open here would let anyone
 *     spend our simulation budget building calls for vaults they do not own.
 */
export function authorizeOwnerCall(input: AuthorizeInput): AuthorizeResult {
  const cheap = authorizeCallerAndVault(input)
  if (!cheap.ok) return cheap

  const source = input.source.trim()
  if (input.liveOwner === null) {
    return {
      ok: false,
      status: 502,
      code: 'rpc_error',
      reason:
        `the vault's owner could not be read on chain, so this call was not built. The check is ` +
        'never skipped: an unreadable owner is a reason to stop, not a reason to continue.',
    }
  }
  if (input.liveOwner.trim() !== source) {
    return {
      ok: false,
      status: 403,
      code: 'not_owner',
      reason:
        `${source} is not the owner of ${input.contract}. The vault reports its owner as ` +
        `${input.liveOwner}, read live, and only that account can sign an owner call.`,
    }
  }
  return { ok: true }
}

/**
 * The half of the gate that needs no network, split out so it can run FIRST.
 *
 * Ordering is the point rather than tidiness. The owner check needs a live read, and doing
 * that read before asking whether the caller owns the wallet at all would let anyone spend
 * an RPC round trip per request simply by naming a vault. Shape, wallet and vault are all
 * answerable from what we already hold, so they are answered first and the read is only
 * ever made for a caller who could have been allowed.
 */
export function authorizeCallerAndVault(input: Omit<AuthorizeInput, 'liveOwner'>): AuthorizeResult {
  const wallet = authorizeCaller(input)
  if (!wallet.ok) return wallet
  if (vaultListed(input) || input.knownBuild === true) return { ok: true }
  return {
    ok: false,
    status: 404,
    code: 'unknown_vault',
    reason:
      input.knownBuild === false
        ? `${input.contract} is not a vault this server will build calls for: it is not in the chain registry, ` +
          'not recorded on an agent you own, and the code it runs is not an AgentSpendPolicy build we ' +
          'published (contracts.knownVaultWasmHashes). This endpoint is not a general Soroban relay.'
        : `${input.contract} is not a vault this server knows: it is neither in the chain registry ` +
          'nor recorded on an agent you own. This endpoint is not a general Soroban relay.',
  }
}

/** True when the vault is named by a registry slot or recorded on an agent the caller owns. */
export function vaultListed(input: Pick<AuthorizeInput, 'contract' | 'registryVaults' | 'ownedVaults'>): boolean {
  const known = new Set([...input.registryVaults, ...input.ownedVaults].map((v) => v.trim()))
  return known.has(input.contract.trim())
}

/**
 * Shape and wallet only: the half of the gate that needs neither the network nor the vault.
 * Runs first, so a stranger's request never costs even the wasm-hash read the known-build
 * path needs.
 */
export function authorizeCaller(input: Omit<AuthorizeInput, 'liveOwner' | 'knownBuild'>): AuthorizeResult {
  const source = input.source.trim()
  if (!isAccountId(source)) {
    return { ok: false, status: 400, code: 'bad_request', reason: `${input.source} is not a Stellar account id (G... StrKey)` }
  }
  if (!isContractId(input.contract.trim())) {
    return { ok: false, status: 400, code: 'bad_request', reason: `${input.contract} is not a Soroban contract id (C... StrKey)` }
  }

  const mine = new Set<string>()
  if (input.caller && input.callerIsWallet && isAccountId(input.caller.trim())) mine.add(input.caller.trim())
  for (const w of input.linkedWallets) if (isAccountId(w.trim())) mine.add(w.trim())
  if (!mine.has(source)) {
    return {
      ok: false,
      status: 403,
      code: 'not_your_wallet',
      reason:
        `${source} is not a wallet this account has proven control of, so this server will not ` +
        'build or relay a transaction from it. Sign in with that wallet, or link it from your ' +
        'account first.',
    }
  }
  return { ok: true }
}

// ── who owns a new vault ─────────────────────────────────────────────────────────

export type VaultOwnerChoice = { ok: true; owner: string } | { ok: false; reason: string; linkedWallets?: string[] }

/**
 * Which Stellar account becomes a new vault's OWNER, or why none may be picked.
 *
 * The choice is permanent: AgentSpendPolicy has no set_owner and no upgrade, so a wrong owner
 * is a vault the caller cannot withdraw from, ever. That is why nothing here is guessed.
 *
 *  1. An explicit `ownerAddress` wins, and a malformed one is refused rather than replaced.
 *     Falling through to another account because of a typo would hand the vault to an
 *     account the caller did not name.
 *  2. A wallet session's own G... account, which the caller has just proven.
 *  3. The caller's ONE linked Stellar wallet. With several, the caller has to say which: this
 *     used to take the first in the list, the OLDEST link, silently and for good.
 */
export function chooseStellarVaultOwner(input: { ownerAddress?: string; caller?: string; linkedWallets: string[] }): VaultOwnerChoice {
  const explicit = (input.ownerAddress ?? '').trim()
  if (explicit) {
    return isAccountId(explicit)
      ? { ok: true, owner: explicit }
      : {
          ok: false,
          reason:
            `ownerAddress ${explicit} is not a Stellar account id (G... StrKey). A vault owner is ` +
            'permanent, so no other account is picked in its place. Nothing was deployed.',
        }
  }
  const session = (input.caller ?? '').trim()
  if (isAccountId(session)) return { ok: true, owner: session }
  const linked = [...new Set(input.linkedWallets.map((w) => w.trim()).filter((w) => isAccountId(w)))]
  if (linked.length === 1) return { ok: true, owner: linked[0] }
  if (linked.length > 1) {
    return {
      ok: false,
      linkedWallets: linked,
      reason:
        `This account has ${linked.length} linked Stellar wallets, and a vault owner is permanent ` +
        '(the contract has no set_owner), so one is not picked for you. Send ownerAddress naming ' +
        'the wallet that should own this vault. Nothing was deployed.',
    }
  }
  return {
    ok: false,
    reason:
      'This vault needs a Stellar account (G...) as its human owner: it is the account ' +
      'that freezes, withdraws and overrides, and it must not be the server. Sign in with a ' +
      'Stellar wallet, link one to your account, or pass ownerAddress. Nothing was deployed.',
  }
}

// ── the public view ──────────────────────────────────────────────────────────────

/**
 * Seconds per ledger close, measured rather than assumed.
 *
 * Pubnet ran 5.625 s on 2026-08-24 and testnet 5.010 s the same day. The larger number is
 * used for both, so a TTL estimate errs toward reporting MORE time than there is... which
 * is the wrong direction for a warning, and is why every answer carries the assumption
 * beside the number instead of presenting a date as a fact.
 */
export const LEDGER_CLOSE_SECONDS = 5.625

export type LedgerTtl = {
  liveUntilLedger: number
  remainingLedgers: number
  approxDays: number
  archivesAround: string
  assumption: string
}

/** Ledgers left, turned into days and a date, with the conversion stated. */
export function ledgerTtl(liveUntilLedger: number, currentLedger: number, nowMs: number): LedgerTtl {
  const remainingLedgers = liveUntilLedger - currentLedger
  const seconds = remainingLedgers * LEDGER_CLOSE_SECONDS
  return {
    liveUntilLedger,
    remainingLedgers,
    approxDays: Math.round((seconds / 86400) * 10) / 10,
    archivesAround: new Date(nowMs + seconds * 1000).toISOString().slice(0, 10),
    assumption: `${LEDGER_CLOSE_SECONDS} s per ledger close, measured on pubnet 2026-08-24`,
  }
}

/** The vault's own numbers, in the units a human reads. */
export type VaultStateView = {
  owner: string
  operator: string
  token: string
  decimals: number
  dailyCapUsd: number
  autoApproveUsd: number
  spentTodayUsd: number
  balanceUsd: number
  frozen: boolean
  allowlistEnabled: boolean
  /** UNIX seconds. 0 means NO time bound at all, not an expiry in 1970. */
  sessionKeyExpiry: number
}

/** What a live read of one vault found, or why it found nothing. */
export type VaultObservation =
  | { reachable: false; reason: string; checkedAt: string }
  | {
      reachable: true
      ledger: number
      checkedAt: string
      state: VaultStateView
      /** Null when the instance entry is not live for the next ledger. */
      liveUntilLedger: number | null
      /** True when the entry came back but its TTL had lapsed, as opposed to no entry at all. */
      archived?: boolean
    }

/**
 * What kind of thing owns a vault, read off the owner's StrKey prefix.
 *
 * A G... owner is a classic account: a wallet, a multisig, a person. A C... owner is a
 * contract, which on this surface means a passkey smart account: the owner entrypoints are
 * then signed by a WebAuthn credential through the account's `execute`. Null when there is
 * no owner to read, because a kind guessed from a label would be a claim about a ledger
 * nobody looked at.
 */
export function ownerKindOf(owner: string | null | undefined): 'smart-account' | 'account' | null {
  if (typeof owner !== 'string') return null
  const o = owner.trim()
  if (isContractId(o)) return 'smart-account'
  if (isAccountId(o)) return 'account'
  return null
}

export type StellarVaultReport = {
  chain: string
  caip2: string
  network: 'pubnet' | 'testnet'
  status: string
  contract: string
  explorerUrl: string
  /** What this row is, for a reader: the flagship vault, or the passkey-owned one. */
  label: string
  /** Which registry slot this row comes from; null for a vault that is in no slot. */
  role: VaultRole | null
  /** One honest sentence about that slot, the same one GET /api/stellar/vault/read serves. */
  roleLabel: string | null
  /** Read off the live owner's StrKey prefix; null when the owner could not be read. */
  ownerKind: 'smart-account' | 'account' | null
  live: { reachable: boolean; ledger?: number; checkedAt: string; reason?: string }
  state?: VaultStateView
  ttl?: LedgerTtl
  /** Present when the instance entry is gone: an archived vault needs a restore, not a fix. */
  archived?: string
}

/**
 * One vault, as a row anyone may read. Pure: the caller does the I/O and hands in what it saw.
 *
 * An unreachable chain is REPORTED rather than thrown, because this endpoint's job is to
 * say what is true right now and "we could not reach it" is true right now. A page that
 * fails outright when one of two networks is slow tells a reader nothing about the other.
 */
export function vaultReport(
  chain: ChainDescriptor,
  contract: string,
  explorerUrl: string,
  obs: VaultObservation,
  nowMs: number = Date.now(),
  label = 'flagship vault',
  role: VaultRole | null = roleOfVault(chain, contract),
): StellarVaultReport {
  const base = {
    chain: chain.id,
    caip2: chain.caip2,
    network: (chain.testnet ? 'testnet' : 'pubnet') as 'pubnet' | 'testnet',
    status: chain.status,
    contract,
    explorerUrl,
    label,
    role,
    roleLabel: role ? VAULT_ROLE_LABELS[role] : null,
    ownerKind: ownerKindOf(obs.reachable ? obs.state.owner : null),
  }
  if (!obs.reachable) {
    return { ...base, live: { reachable: false, checkedAt: obs.checkedAt, reason: obs.reason } }
  }
  // Live means live for the next ledger. A liveUntilLedger at or behind the ledger it was read
  // at is a lapsed entry, and handing it to ledgerTtl would print a countdown that ended long
  // ago as if it were still running: the RPC reports an archived entry's TTL as ledger 0.
  const live = obs.liveUntilLedger !== null && obs.liveUntilLedger > obs.ledger
  return {
    ...base,
    live: { reachable: true, ledger: obs.ledger, checkedAt: obs.checkedAt },
    state: obs.state,
    ...(live
      ? { ttl: ledgerTtl(obs.liveUntilLedger as number, obs.ledger, nowMs) }
      : {
          archived:
            obs.archived || obs.liveUntilLedger !== null
              ? 'the instance entry is ARCHIVED: its TTL lapsed, so the next call to this vault has to ' +
                'restore it, and since protocol 23 that restore happens inside the call with the rent ' +
                'folded into its fee. Nothing the vault holds is lost.'
              : 'no live instance entry: either this vault has already archived and needs a restoring ' +
                'footprint on its next call, or this address is not deployed on this network.',
        }),
  }
}

// ── roles: which registry slot a vault comes from ────────────────────────────────

/**
 * The four registry slots a Stellar vault can come from, and what each one is evidence of.
 *
 * The label is the honest sentence, not decoration. The 2026-09-19 passkey-owned vault was a
 * rehearsal whose owner calls were signed by a software P-256 key in our own script, and a
 * reader who saw it listed beside the SOW 2 vaults with no label would reasonably count it
 * as the device-passkey deliverable. It is not, and the label says so wherever it is shown.
 */
export type VaultRole = 'flagship' | 'wallet-owned' | 'device-passkey' | 'rehearsal'

export const VAULT_ROLE_LABELS: Readonly<Record<VaultRole, string>> = {
  flagship: 'Flagship vault: the AgentSpendPolicy instance the registry names for this network.',
  'wallet-owned':
    'SOW 2 D2: owned by a browser-wallet key. Every owner call is signed in that wallet, with the owner as the transaction source paying the fee.',
  'device-passkey': 'SOW 2 D3: owned by a smart account whose only signer is a passkey held by a device.',
  rehearsal:
    'Rehearsal: owner calls were signed by a software P-256 key in our own script, not a device passkey. Not SOW 2 D3 evidence.',
}

/** Every vault a registry slot names on this chain, in display order, with its role. */
export function registryVaultSlots(chain: ChainDescriptor): { contract: string; role: VaultRole }[] {
  const c = chain.contracts
  const out: { contract: string; role: VaultRole }[] = []
  if (c.spendVault) out.push({ contract: c.spendVault, role: 'flagship' })
  if (c.walletOwnedVault) out.push({ contract: c.walletOwnedVault, role: 'wallet-owned' })
  if (c.devicePasskeyVault) out.push({ contract: c.devicePasskeyVault, role: 'device-passkey' })
  if (c.passkeyVault) out.push({ contract: c.passkeyVault, role: 'rehearsal' })
  return out
}

/** The role a registry slot gives this contract on this chain, or null for a vault in no slot. */
export function roleOfVault(chain: ChainDescriptor, contract: string): VaultRole | null {
  return registryVaultSlots(chain).find((s) => s.contract === contract.trim())?.role ?? null
}

// ── amounts ──────────────────────────────────────────────────────────────────────

/** A token amount as both the integer the contract holds and the decimal a person reads. */
export type Amount = { raw: string; display: string }

/**
 * Base units to an Amount, by string arithmetic so a 7-decimal balance never passes through
 * a float. Trailing zeros are trimmed: 10 USDC is '10', half a USDC is '0.5'.
 */
export function amountOf(raw: string | bigint, decimals: number): Amount {
  const v = BigInt(raw)
  const neg = v < 0n
  const abs = neg ? -v : v
  const scale = 10n ** BigInt(Math.max(0, decimals))
  const whole = abs / scale
  const frac = decimals > 0 ? (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '') : ''
  return { raw: v.toString(), display: `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}` }
}

// ── the public read of ONE vault ─────────────────────────────────────────────────

/** What GET /api/stellar/vault/read answers on success. Field names are the shared contract. */
export type VaultReadBody = {
  network: string
  chainId: string
  contract: string
  realMoney: boolean
  wasmHash: string
  knownBuild: boolean
  build: string | null
  role: VaultRole | null
  roleLabel: string | null
  owner: string
  ownerKind: 'account' | 'smart-account'
  operator: string
  token: string
  tokenSymbol: string
  decimals: number
  frozen: boolean
  dailyCap: Amount
  spentToday: Amount
  remainingToday: Amount | null
  autoApproveMax: Amount
  allowlistEnabled: boolean
  sessionKeyExpiry: number
  sessionKeyExpired: boolean
  balance: Amount
  day: number
  resetsAt: string
  ledger: number
  readAt: string
  ttl: { liveUntilLedger: number | null; archived: boolean }
  explorer: { contract: string }
  note?: string
}

/** The vault's raw state as the adapter reads it. Restated so this module stays SDK-free. */
export type RawVaultState = {
  owner: string
  operator: string
  token: string
  decimals: number
  dailyCapRaw: string
  autoApproveMaxRaw: string
  frozen: boolean
  allowlistEnabled: boolean
  sessionKeyExpiry: string
  day: string
  spentTodayRaw: string
  balanceRaw: string
  ledger?: number
}

/**
 * One vault's live state in the shape the console panel reads. Pure: the route does the I/O.
 *
 * The derived numbers are where a panel goes wrong, so they are derived here once:
 *  - `remainingToday` is null when the cap is 0, because 0 means NO cap, not "nothing left".
 *    Otherwise it is cap minus spent, floored at 0 (the owner's override counts toward the day
 *    without being refused by the cap, so spent can exceed it).
 *  - `resetsAt` is the next 00:00 UTC after the contract's own day index, which is the
 *    instant `spent_today` starts reading a fresh bucket. The panel converts it to the
 *    reader's timezone; the instant itself is UTC because the contract's day is.
 *  - `sessionKeyExpired` is false when the expiry is 0, which means no time bound at all.
 */
export function vaultReadBody(input: {
  chain: ChainDescriptor
  contract: string
  state: RawVaultState
  wasmHash: string
  ttl: { liveUntilLedger: number | null; archived: boolean }
  explorerUrl: string
  tokenSymbol: string
  ledger: number
  readAt: string
  nowMs: number
}): VaultReadBody {
  const { chain, contract, state } = input
  const decimals = Number(state.decimals)
  const build = knownBuildOf(chain, input.wasmHash)
  const role = roleOfVault(chain, contract)
  const cap = BigInt(state.dailyCapRaw)
  const spent = BigInt(state.spentTodayRaw)
  const left = cap === 0n ? null : cap > spent ? cap - spent : 0n
  const expiry = Number(state.sessionKeyExpiry)
  const day = Number(state.day)
  const notes: string[] = []
  if (!build.known) {
    // The "no owner actions" clause only where the gate agrees: a registry slot is let
    // through on its slot, whatever it runs, so saying it there would be untrue.
    notes.push(
      'This contract runs code that is not an AgentSpendPolicy build we published. Its views answered ' +
        'like one, so these are the numbers it reports, not numbers our source can vouch for' +
        (role === null ? ', and the console offers no owner actions on it.' : '.'),
    )
  }
  if (input.ttl.archived) {
    notes.push(
      'The instance entry is archived: the next call to this vault restores it inside that call, with ' +
        'the rent in its fee. Nothing the vault holds is lost.',
    )
  }
  return {
    network: chain.caip2,
    chainId: chain.id,
    contract,
    realMoney: !chain.testnet,
    wasmHash: input.wasmHash,
    knownBuild: build.known,
    build: build.version,
    role,
    roleLabel: role ? VAULT_ROLE_LABELS[role] : null,
    owner: state.owner,
    ownerKind: ownerKindOf(state.owner) ?? 'account',
    operator: state.operator,
    token: state.token,
    tokenSymbol: input.tokenSymbol,
    decimals,
    frozen: state.frozen,
    dailyCap: amountOf(cap, decimals),
    spentToday: amountOf(spent, decimals),
    remainingToday: left === null ? null : amountOf(left, decimals),
    autoApproveMax: amountOf(state.autoApproveMaxRaw, decimals),
    allowlistEnabled: state.allowlistEnabled,
    sessionKeyExpiry: Number.isFinite(expiry) ? expiry : 0,
    sessionKeyExpired: Number.isFinite(expiry) && expiry !== 0 && Math.floor(input.nowMs / 1000) > expiry,
    balance: amountOf(state.balanceRaw, decimals),
    day,
    resetsAt: new Date((day + 1) * 86_400_000).toISOString(),
    ledger: input.ledger,
    readAt: input.readAt,
    ttl: input.ttl,
    explorer: { contract: input.explorerUrl },
    ...(notes.length ? { note: notes.join(' ') } : {}),
  }
}

/** What GET /api/stellar/vault/is-allowed answers. */
export type IsAllowedBody = {
  network: string
  contract: string
  address: string
  allowed: boolean
  allowlistEnabled: boolean
  effective: 'allowed' | 'blocked' | 'not-enforced'
  ledger: number
  readAt: string
}

/**
 * The checker's answer, with the one distinction a yes or no hides: an allowlist that is
 * not enforced lets every payee through whatever the per-address flag says, so that case is
 * its own state rather than a "yes" that would also be true of an address nobody ever added.
 */
export function isAllowedBody(input: {
  chain: ChainDescriptor
  contract: string
  address: string
  allowed: boolean
  allowlistEnabled: boolean
  ledger: number
  readAt: string
}): IsAllowedBody {
  return {
    network: input.chain.caip2,
    contract: input.contract,
    address: input.address,
    allowed: input.allowed,
    allowlistEnabled: input.allowlistEnabled,
    effective: !input.allowlistEnabled ? 'not-enforced' : input.allowed ? 'allowed' : 'blocked',
    ledger: input.ledger,
    readAt: input.readAt,
  }
}

/**
 * A small time-boxed memo, keyed by string, with explicit eviction.
 *
 * Its own class rather than a bare Map so the one rule that matters is in one place: an
 * entry older than the TTL is never served. The clock is injected so a test can move it.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>()
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (this.now() - hit.at >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: string, value: T): void {
    this.entries.set(key, { at: this.now(), value })
    // Bounded: the read endpoint is public and accepts any contract id, so the memo must
    // not grow with the number of distinct ids anyone cares to ask about.
    if (this.entries.size > 500) {
      for (const [k, v] of this.entries) if (this.now() - v.at >= this.ttlMs) this.entries.delete(k)
      while (this.entries.size > 500) this.entries.delete(this.entries.keys().next().value as string)
    }
  }

  /** Drop every entry whose key satisfies `match`, for a bust after a settled write. */
  deleteWhere(match: (key: string) => boolean): void {
    for (const k of [...this.entries.keys()]) if (match(k)) this.entries.delete(k)
  }

  clear(): void {
    this.entries.clear()
  }
}
