/**
 * Amounts on NEAR, as exact integers.
 *
 * Every number the vault speaks in is an integer in the smallest unit: USDC amounts are 6
 * decimal places of a token (1250000 is 1.25 USDC), NEAR is 24 (yoctoNEAR), and gas is counted
 * in units of which 10^12 make one Tgas. They cross JSON as decimal strings because a JSON
 * number loses precision above 2^53, so this file never routes one through a float: parsing
 * and formatting are string and bigint work only.
 *
 * A typed amount with more decimals than the token has is REFUSED, not truncated. Truncating
 * "0.0000005" to 0 at 6 decimals would quietly turn a payment into nothing; a refusal says so.
 *
 * Pure and import-free on purpose: src/lib/near/near.test.ts loads it through Node's type
 * stripping, which cannot resolve the bundler's paths.
 */

/** yoctoNEAR in one NEAR. */
export const YOCTO_PER_NEAR = 10n ** 24n

/** Gas units in one Tgas. */
export const GAS_PER_TGAS = 10n ** 12n

/** The deposit an owner method needs: exactly one yoctoNEAR, which only a full-access key can attach. */
export const ONE_YOCTO = '1'

/** The largest value a NEAR U128 can hold. */
export const U128_MAX = (1n << 128n) - 1n

/** Gas for `tgas` Tgas, as the decimal string a function call carries. */
export function tgas(n: number): string {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`gas must be a positive whole number of Tgas, got ${n}`)
  return (BigInt(n) * GAS_PER_TGAS).toString()
}

/** True for a decimal string a NEAR U128 can hold: digits only, no sign, no leading zeros. */
export function isU128(s: unknown): s is string {
  return typeof s === 'string' && /^(0|[1-9][0-9]*)$/.test(s) && BigInt(s) <= U128_MAX
}

export type Parsed = { ok: true; units: bigint } | { ok: false; reason: string }

/**
 * Decimal text to integer units: "1.25" at 6 decimals is 1250000n.
 *
 * Accepts digits with at most one point and nothing else (no sign, no exponent, no grouping
 * commas). A comma used as the decimal mark is refused rather than read either way.
 */
export function parseUnits(text: string, decimals: number): Parsed {
  const s = text.trim()
  if (s === '') return { ok: false, reason: 'Enter an amount.' }
  if (s.includes(',')) return { ok: false, reason: 'Use a point for decimals, with no commas: 1.25, not 1,25.' }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s)
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return { ok: false, reason: 'Use digits and at most one point, such as 1.25.' }
  const whole = m[1] || '0'
  const frac = m[2] ?? ''
  if (frac.length > decimals) {
    return { ok: false, reason: `This token has ${decimals} decimal places, so ${s} cannot be sent exactly. Use at most ${decimals} digits after the point.` }
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
  if (units > U128_MAX) return { ok: false, reason: 'That amount is larger than the chain can hold.' }
  return { ok: true, units }
}

/** Integer units to exact decimal text, trailing zeros trimmed: 1250000n at 6 decimals is "1.25". */
export function formatUnits(units: bigint | string, decimals: number): string {
  const n = typeof units === 'string' ? BigInt(units) : units
  const neg = n < 0n
  const abs = neg ? -n : n
  if (decimals === 0) return `${neg ? '-' : ''}${abs.toString()}`
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`
}

/** The same exact value with the whole part grouped for reading: 1234567.5 reads "1,234,567.5". */
export function formatGrouped(units: bigint | string, decimals: number): string {
  const exact = formatUnits(units, decimals)
  const [whole, frac] = exact.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac ? `${grouped}.${frac}` : grouped
}

/**
 * yoctoNEAR as NEAR for display, rounded DOWN to `digits` places so it never shows more than
 * the account holds. A non-zero amount too small to show reads "less than 0.0001", never "0".
 */
export function formatNear(yocto: bigint | string, digits = 4): string {
  const n = typeof yocto === 'string' ? BigInt(yocto) : yocto
  if (n === 0n) return '0'
  const step = YOCTO_PER_NEAR / 10n ** BigInt(digits)
  const floored = (n / step) * step
  if (floored === 0n) return `less than 0.${'0'.repeat(digits - 1)}1`
  return formatGrouped(floored, 24)
}

/** A NEAR U128 decimal string to bigint, or null when it is not one. */
export function u128(s: unknown): bigint | null {
  return isU128(s) ? BigInt(s) : null
}
