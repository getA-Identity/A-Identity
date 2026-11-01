/**
 * The rules the Arc vault page applies before anything reaches a wallet, as pure functions.
 *
 * Type-only imports, on purpose: mcp/src/frontend-arc-vault.test.ts loads this file straight
 * from src/ through Node's type stripping and tests what each rule RETURNS, which a source
 * search cannot pin. Every rule here stands between a person and real USDC on Arc Mainnet:
 *
 *   - AgentSpendPolicy reads a dailyCap or an autoApproveMax of 0 as NO LIMIT, so a 0 is
 *     refused, never deployed and never set.
 *   - A sessionKeyExpiry of 0 means NO TIME BOUND, so 0 is never written. A revoke writes 1,
 *     a second already past on every chain; an extension is chain time plus a bounded
 *     duration, never the browser clock.
 *   - The operator is the agent's own key, which can only call pay(), so it is never the
 *     owner, the zero address, the vault or the token.
 *   - Arc drops a transaction whose maxFeePerGas is under 20 gwei without an error or a
 *     receipt, so no fee below that floor is ever proposed.
 *   - A vault is this page's build only when its code IS this build with the owner() and
 *     usdc() it reports written into every one of their immutable slots. Zeroing the slots
 *     and comparing the rest is not enough: a crafted copy can show one owner and obey another.
 *
 * Amounts are BigInt base units throughout. A float never touches money here.
 */
import type { VaultSnapshot } from './vault-read'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Arc's hard floor for maxFeePerGas: 20 gwei, in wei. */
export const FEE_FLOOR_WEI = 20_000_000_000n

/**
 * The largest tip ever proposed: 1 gwei, the value Arc's docs give for busy periods. A 0 tip is
 * accepted there, and an RPC suggesting more than this is not believed with someone's money.
 */
export const TIP_CAP_WEI = 1_000_000_000n

/** What a revoke writes: 1 is in the past on every chain, and 0 would mean no bound at all. */
export const REVOKED_SESSION_EXPIRY = 1n

/** The session key's lifetime, bounded: at least an hour, at most 30 days (the backend's bound). */
export const MIN_SESSION_SECONDS = 3600
export const MAX_SESSION_SECONDS = 30 * 86400
export const DEFAULT_SESSION_SECONDS = 7 * 86400

/** The lifetimes offered, shortest first. */
export const SESSION_CHOICES: readonly { seconds: number; label: string }[] = [
  { seconds: 3600, label: '1 hour' },
  { seconds: 86400, label: '1 day' },
  { seconds: 7 * 86400, label: '7 days' },
  { seconds: 30 * 86400, label: '30 days' },
]

/** Dust defaults, the values mcp/scripts/evm-mainnet-vault.mjs uses: the caps are the product. */
export const DEFAULT_DAILY_CAP = '1'
export const DEFAULT_AUTO_APPROVE = '0.25'
export const DEFAULT_FUNDING = '0.5'

/** Above this many USDC in one transfer, the review says so before anything is signed. */
export const SOFT_WARN_USDC = '10'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** 0x followed by 40 hex characters. Checksums are checked where viem is at hand. */
export function isHexAddress(a: string | null | undefined): boolean {
  return typeof a === 'string' && ADDRESS.test(a.trim())
}

/** The same address, whatever the case. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && (a as string).trim().toLowerCase() === (b as string).trim().toLowerCase()
}

/**
 * A decimal a person typed, in base units, or null when it is not a plain decimal with at
 * most `decimals` places. Exact: "0.1" at 6 decimals is 100000, never 99999.
 */
export function parseUnitsExact(text: string, decimals: number): bigint | null {
  const t = text.trim()
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  if (frac.length > decimals) return null
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}

/** Base units as a plain decimal with trailing zeros trimmed: 1500000 at 6 decimals is "1.5". */
export function formatUnitsExact(raw: bigint, decimals: number): string {
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${abs / base}${frac ? `.${frac}` : ''}`
}

/** Native wei (18 decimals on Arc) in the token's ERC-20 units, rounded UP so a reserve is never understated. */
export function weiToUnitsCeil(wei: bigint, nativeDecimals: number, tokenDecimals: number): bigint {
  if (nativeDecimals <= tokenDecimals) return wei * 10n ** BigInt(tokenDecimals - nativeDecimals)
  const scale = 10n ** BigInt(nativeDecimals - tokenDecimals)
  return (wei + scale - 1n) / scale
}

/** Native wei in the token's ERC-20 units, rounded DOWN so a balance is never overstated. */
export function weiToUnitsFloor(wei: bigint, nativeDecimals: number, tokenDecimals: number): bigint {
  if (nativeDecimals <= tokenDecimals) return wei * 10n ** BigInt(tokenDecimals - nativeDecimals)
  return wei / 10n ** BigInt(nativeDecimals - tokenDecimals)
}

/**
 * Why a daily cap and per-payment ceiling are refused, or null when both are usable. Both must
 * be above 0, because the contract reads 0 as no limit on that axis.
 */
export function capsRefusal(dailyCap: bigint | null, autoApproveMax: bigint | null, decimals: number): string | null {
  if (dailyCap === null || autoApproveMax === null)
    return `Enter both limits as plain amounts with at most ${decimals} decimal places, for example 1 or 0.25.`
  const zero: string[] = []
  if (dailyCap <= 0n) zero.push('daily cap')
  if (autoApproveMax <= 0n) zero.push('per-payment ceiling')
  if (zero.length)
    return `A ${zero.join(' and a ')} of 0 means NO LIMIT in AgentSpendPolicy, so this page refuses it. Set both above 0.`
  return null
}

/** Not a refusal: a ceiling above the cap is allowed, but the cap is then what binds a payment. */
export function capsWarning(dailyCap: bigint, autoApproveMax: bigint): string | null {
  return autoApproveMax > dailyCap
    ? 'The per-payment ceiling is above the daily cap, so the daily cap is what actually limits a single payment.'
    : null
}

/** Why a session key lifetime is refused, or null. */
export function sessionSecondsRefusal(seconds: number): string | null {
  if (!Number.isInteger(seconds) || seconds < MIN_SESSION_SECONDS) return 'A session key lasts at least one hour.'
  if (seconds > MAX_SESSION_SECONDS) return 'A session key lasts at most 30 days. Extend it again before then.'
  return null
}

/**
 * The expiry to write for a key that should last `seconds` from now, where now is the chain's
 * latest block time. Null when the lifetime is out of bounds or the chain time is unusable,
 * so neither 0 nor a time in the past can come out of here.
 */
export function sessionExpiryFor(chainNow: bigint, seconds: number): bigint | null {
  if (sessionSecondsRefusal(seconds) !== null) return null
  if (chainNow <= 0n) return null
  return chainNow + BigInt(seconds)
}

/** Why an expiry value must not be written, or null. The single choke point for 0. */
export function expiryRefusal(expiry: bigint): string | null {
  if (expiry === 0n)
    return 'An expiry of 0 means the operator key never expires, so this page never writes it. Revoking writes 1, a time already past.'
  if (expiry < 0n) return 'An expiry cannot be negative.'
  return null
}

/**
 * EIP-1559 fee fields at or above Arc's floor: twice the base fee plus the tip, never under
 * 20 gwei, the tip capped at 1 gwei and never above the maximum.
 */
export function feeFields(baseFeePerGas: bigint | null, tip: bigint | null): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const t = tip !== null && tip > 0n ? (tip < TIP_CAP_WEI ? tip : TIP_CAP_WEI) : 0n
  const base = baseFeePerGas !== null && baseFeePerGas > 0n ? baseFeePerGas : 0n
  const wanted = 2n * base + t
  const maxFeePerGas = wanted > FEE_FLOOR_WEI ? wanted : FEE_FLOOR_WEI
  return { maxFeePerGas, maxPriorityFeePerGas: t < maxFeePerGas ? t : maxFeePerGas }
}

/** A gas limit with a 20% margin over the estimate, rounded up. */
export function gasWithMargin(estimate: bigint): bigint {
  return (estimate * 120n + 99n) / 100n
}

/**
 * Why an operator address is refused, or null. The operator is a separate key that can only
 * call pay(); the owner key keeps every other power, so the two are never the same.
 */
export function operatorRefusal(operator: string, ctx: { owner: string | null; usdc: string; vault?: string | null }): string | null {
  const o = operator.trim()
  if (!o) return "Paste the agent's operator address: the separate key that will be allowed to call pay() and nothing else."
  if (!isHexAddress(o)) return 'The operator must be an EVM address: 0x followed by 40 hexadecimal characters.'
  if (sameAddress(o, ZERO_ADDRESS)) return 'The operator cannot be the zero address. To stop the agent, freeze the vault or revoke its key.'
  if (ctx.owner && sameAddress(o, ctx.owner))
    return 'The operator must be a different key from the owner: the agent gets a key that can only call pay(), and your owner key keeps every other power.'
  if (sameAddress(o, ctx.usdc)) return 'That is the USDC contract, not a key an agent can sign with.'
  if (ctx.vault && sameAddress(o, ctx.vault)) return 'That is the vault itself, not a key an agent can sign with.'
  return null
}

/** Why a withdrawal is refused, or null. Mirrors the contract's own gates, plus the balance. */
export function withdrawRefusal(input: {
  to: string
  amount: bigint | null
  balance: bigint
  vault: string
  usdc: string
  decimals: number
}): string | null {
  const to = input.to.trim()
  if (!isHexAddress(to)) return 'The destination must be an EVM address: 0x followed by 40 hexadecimal characters.'
  if (sameAddress(to, ZERO_ADDRESS)) return 'The destination cannot be the zero address: the contract refuses it.'
  if (sameAddress(to, input.vault)) return 'The destination cannot be the vault itself: the contract refuses it.'
  if (sameAddress(to, input.usdc)) return 'The destination cannot be the USDC contract: tokens sent there are lost, and the contract refuses it.'
  if (input.amount === null || input.amount <= 0n)
    return `Enter an amount above 0, with at most ${input.decimals} decimal places.`
  if (input.amount > input.balance)
    return `The vault holds ${formatUnitsExact(input.balance, input.decimals)} USDC. Enter that much or less.`
  return null
}

/** Gas an owner action takes, generously: a later freeze or withdraw needs this much left over. */
export const OWNER_ACTION_GAS = 80_000n

/** How many later owner actions a funding keeps the gas for: a freeze and a withdrawal. */
export const OWNER_ACTIONS_KEPT = 2n

/**
 * What a funding must leave behind for fees, in native wei: this transfer's own fee and the
 * owner actions after it. Funding everything would leave the owner unable to pay the gas to
 * stop the agent.
 */
export function fundingReserveWei(gas: bigint, maxFeePerGas: bigint): bigint {
  return (gas + OWNER_ACTIONS_KEPT * OWNER_ACTION_GAS) * maxFeePerGas
}

/**
 * Why a funding transfer is refused, or null: the rule prepareFund applies, from the chain's own
 * numbers. On Arc USDC is also the gas token, one balance at 18 decimals natively and 6 as an
 * ERC-20, so the sender must keep fundingReserveWei after the transfer. The balance is rounded
 * down and the reserve up, so neither is ever in the sender's favour.
 */
export function fundRefusal(input: {
  amount: bigint | null
  /** The sender's native balance, in wei. */
  senderWei: bigint
  /** This transfer's gas limit and fee cap, as prepared. */
  gas: bigint
  maxFeePerGas: bigint
  nativeDecimals: number
  decimals: number
}): string | null {
  if (input.amount === null || input.amount <= 0n) return `Enter an amount above 0, with at most ${input.decimals} decimal places.`
  const balance = weiToUnitsFloor(input.senderWei, input.nativeDecimals, input.decimals)
  const reserve = weiToUnitsCeil(fundingReserveWei(input.gas, input.maxFeePerGas), input.nativeDecimals, input.decimals)
  if (input.amount + reserve > balance)
    return (
      `Your wallet holds ${formatUnitsExact(balance, input.decimals)} USDC, and on Arc USDC also pays the network fee. ` +
      `Keep at least ${formatUnitsExact(reserve, input.decimals)} USDC for this fee and two later owner actions (a freeze, a withdrawal): send ${formatUnitsExact(
        balance > reserve ? balance - reserve : 0n,
        input.decimals,
      )} or less.`
    )
  return null
}

/** True when an amount is above the soft warning line. */
export function aboveSoftWarn(amount: bigint, decimals: number): boolean {
  const line = parseUnitsExact(SOFT_WARN_USDC, decimals)
  return line !== null && amount > line
}

/** Where the constructor writes each immutable into the runtime, by the immutable's name. */
export type ImmutableRanges = Readonly<Record<string, readonly { start: number; length: number }[]>>

/** An address as the 32-byte word solc stores an immutable address in: 12 zero bytes, then the 20. */
export function addressWord(address: string): string | null {
  return isHexAddress(address) ? `${'0'.repeat(24)}${address.trim().slice(2).toLowerCase()}` : null
}

/**
 * The runtime this build installs for the given immutable values: `runtime` with every range of
 * each named immutable holding that immutable's address as a 32-byte word (both of this vault's
 * immutables, owner and usdc, are addresses). Null, failing closed, when an immutable has no
 * usable value, a value names no immutable, or a range is not one word, overlaps another, or
 * falls outside the code.
 */
export function runtimeWith(runtime: string, ranges: ImmutableRanges, values: Readonly<Record<string, string>>): string | null {
  const hex = bareHex(runtime)
  if (hex === null) return null
  const names = Object.keys(ranges)
  const given = (n: string) => Object.prototype.hasOwnProperty.call(values, n)
  if (names.length === 0 || names.length !== Object.keys(values).length || !names.every(given)) return null
  const slots: { start: number; length: number; word: string }[] = []
  for (const name of names) {
    const word = addressWord(values[name])
    if (word === null) return null
    for (const r of ranges[name]) slots.push({ start: r.start, length: r.length, word })
  }
  slots.sort((a, b) => a.start - b.start)
  let out = ''
  let pos = 0
  for (const r of slots) {
    if (r.length !== 32 || r.start < pos || (r.start + r.length) * 2 > hex.length) return null
    out += hex.slice(pos * 2, r.start * 2) + r.word
    pos = r.start + r.length
  }
  return `0x${out}${hex.slice(pos * 2)}`
}

/**
 * True when `code` is exactly this build with these immutable values: `runtime` with each value
 * written into its own ranges, compared byte for byte. Pass the owner() and usdc() the vault
 * itself reports, so the owner the page shows is the only key its owner checks obey.
 */
export function isKnownBuild(code: string, runtime: string, ranges: ImmutableRanges, values: Readonly<Record<string, string>>): boolean {
  const expected = runtimeWith(runtime, ranges, values)
  const actual = typeof code === 'string' ? bareHex(code) : null
  return expected !== null && actual !== null && `0x${actual}` === expected
}

/** Hex without its 0x, lower case, or null when it is not whole bytes of hex. */
function bareHex(x: string): string | null {
  const h = (/^0x/i.test(x) ? x.slice(2) : x).toLowerCase()
  return h.length % 2 === 0 && /^[0-9a-f]*$/.test(h) ? h : null
}

/** "in 6d 23h" or "4h 5m ago", for UNIX seconds against a chain time in seconds. */
export function relativeSeconds(target: bigint, now: bigint): string {
  const diff = Number(target - now)
  const abs = Math.abs(diff)
  const d = Math.floor(abs / 86400)
  const h = Math.floor((abs % 86400) / 3600)
  const m = Math.floor((abs % 3600) / 60)
  const span = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${Math.max(m, abs > 0 ? 1 : 0)}m`
  return diff >= 0 ? `in ${span}` : `${span} ago`
}

/**
 * The owner's question, answered in one sentence from one snapshot: can the agent pay, and
 * how much more today. A key with no time bound is the loudest thing on the page, because it
 * breaks the promise the vault exists to keep.
 */
export function vaultHeadline(v: VaultSnapshot): { text: string; tone: 'ok' | 'warn' | 'danger' } {
  const usd = (x: bigint) => `${formatUnitsExact(x, v.decimals)} USDC`
  if (v.frozen) return { text: 'Frozen: the agent cannot pay anything until the owner unfreezes the vault.', tone: 'danger' }
  if (sameAddress(v.operator, ZERO_ADDRESS)) return { text: 'No operator: no key can pay from this vault until the owner sets one.', tone: 'warn' }
  if (v.sessionKeyExpiry === 0n)
    return {
      text: "The operator's key has NO time bound: it can pay until the owner acts. Set an expiry before funding this vault.",
      tone: 'danger',
    }
  if (v.expired)
    return { text: 'The session key has expired: the agent cannot pay until the owner extends it.', tone: 'danger' }
  if (v.balance === 0n) return { text: 'Active, but the vault holds no USDC: the agent cannot pay anything until it is funded.', tone: 'warn' }
  if (v.remainingToday === null)
    return { text: `Active: no daily cap is set, so the agent can spend up to the whole balance, ${usd(v.balance)}, today.`, tone: 'warn' }
  if (v.remainingToday === 0n)
    return { text: "Active, but today's cap is used up: the agent cannot pay more until the reset at 00:00 UTC.", tone: 'warn' }
  if (v.balance < v.remainingToday)
    return {
      text: `Active: the agent can spend up to ${usd(v.balance)} more today, everything the vault holds (the daily cap alone would allow ${usd(v.remainingToday)}).`,
      tone: 'ok',
    }
  return { text: `Active: the agent can spend up to ${usd(v.remainingToday)} more today.`, tone: 'ok' }
}
