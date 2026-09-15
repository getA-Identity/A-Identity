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
 *  - which contracts may be addressed (a registry vault or a vault on an agent you own),
 *  - and how a ledger TTL turns into a date a human can act on.
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
  /** The vault's live `owner`, or null when the read did not answer. */
  liveOwner: string | null
}

export type AuthorizeResult =
  | { ok: true }
  | { ok: false; status: number; code: 'bad_request' | 'not_your_wallet' | 'not_owner' | 'unknown_vault' | 'rpc_error'; reason: string }

/**
 * Three separate questions, asked in order, because they fail for different people.
 *
 *  1. Is this source a wallet the CALLER has proven? We never relay for a stranger, even a
 *     correctly signed transaction: an endpoint that broadcasts anything anyone hands it is
 *     an open relay wearing our IP address, and being the sender of someone else's
 *     transaction is not a neutral act.
 *  2. Is this contract one we know? Either the registry declares it, or it is recorded on
 *     an agent the caller owns. Anything else and this endpoint would be a general-purpose
 *     proxy into Soroban.
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

  const known = new Set([...input.registryVaults, ...input.ownedVaults].map((v) => v.trim()))
  if (!known.has(input.contract.trim())) {
    return {
      ok: false,
      status: 404,
      code: 'unknown_vault',
      reason:
        `${input.contract} is not a vault this server knows: it is neither in the chain registry ` +
        'nor recorded on an agent you own. This endpoint is not a general Soroban relay.',
    }
  }
  return { ok: true }
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
  | { reachable: true; ledger: number; checkedAt: string; state: VaultStateView; liveUntilLedger: number | null }

export type StellarVaultReport = {
  chain: string
  caip2: string
  network: 'pubnet' | 'testnet'
  status: string
  contract: string
  explorerUrl: string
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
): StellarVaultReport {
  const base = {
    chain: chain.id,
    caip2: chain.caip2,
    network: (chain.testnet ? 'testnet' : 'pubnet') as 'pubnet' | 'testnet',
    status: chain.status,
    contract,
    explorerUrl,
  }
  if (!obs.reachable) {
    return { ...base, live: { reachable: false, checkedAt: obs.checkedAt, reason: obs.reason } }
  }
  return {
    ...base,
    live: { reachable: true, ledger: obs.ledger, checkedAt: obs.checkedAt },
    state: obs.state,
    ...(obs.liveUntilLedger !== null
      ? { ttl: ledgerTtl(obs.liveUntilLedger, obs.ledger, nowMs) }
      : {
          archived:
            'no live instance entry: either this vault has already archived and needs a restoring ' +
            'footprint on its next call, or this address is not deployed on this network.',
        }),
  }
}
