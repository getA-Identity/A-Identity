/**
 * Stellar address and hash SHAPES, as pure predicates.
 *
 * Deliberately dependency-free: no `@stellar/stellar-sdk` import, so the drift tests that
 * consume these can stay offline and instant. This file answers "does this string look
 * like the right KIND of thing", never "does it exist on chain".
 *
 * StrKey is base32 (RFC 4648: A-Z and 2-7, so no 0, 1, 8 or 9) with a version byte and a
 * CRC16 checksum, rendered as 56 characters. The leading letter carries the type, and
 * that letter is load-bearing here rather than cosmetic: on Stellar a contract and an
 * account are different kinds of thing that live at different explorer routes and behave
 * differently, so a check that accepts either is not a check.
 *
 * We validate the alphabet, the length AND the CRC16 checksum that StrKey carries for
 * exactly this purpose. An earlier version skipped the checksum, reasoning that these
 * values come from a derivation or a live read rather than from a keyboard. An adversarial
 * review pointed out where that reasoning fails: X402_STELLAR_PAYTO is typed by a human,
 * and a single wrong character produces a string that passes an alphabet-and-length test,
 * makes the rail report itself configured, and sells to an account nobody can pay. The
 * checksum is fifteen lines and it catches that.
 *
 * Implemented here rather than imported so this file stays dependency-free and the drift
 * tests that use it stay offline and instant. strkey.test.ts checks our answer against the
 * SDK's on real and corrupted values, so the two cannot disagree.
 */
import type { Ecosystem } from '../types.js'

const STRKEY_BODY = '[A-Z2-7]{55}'

/** A Soroban contract id, e.g. the USDC Stellar Asset Contract. */
export const STELLAR_CONTRACT_RE = new RegExp(`^C${STRKEY_BODY}$`)
/** A classic account id, e.g. an asset issuer or a payee. */
export const STELLAR_ACCOUNT_RE = new RegExp(`^G${STRKEY_BODY}$`)
/** An ed25519 secret seed. Never logged, never stored here; the shape check only. */
export const STELLAR_SECRET_RE = new RegExp(`^S${STRKEY_BODY}$`)

/**
 * A Stellar transaction hash: the same 32 bytes an EVM hash carries, rendered WITHOUT the
 * `0x` prefix. That prefix is an EVM convention, and prepending one here would break
 * every explorer link derived from it.
 */
export const STELLAR_TX_HASH_RE = /^[0-9a-f]{64}$/

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 with no padding, which is what StrKey uses. Null on any bad character. */
function b32decode(input: string): Uint8Array | null {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of input) {
    const idx = B32.indexOf(ch)
    if (idx < 0) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

/** CRC16-XModem: polynomial 0x1021, initial value 0. Stellar stores it little-endian. */
function crc16(bytes: Uint8Array): number {
  let crc = 0x0000
  for (const b of bytes) {
    crc ^= b << 8
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc & 0xffff
}

/** StrKey version bytes, which are what make the leading letter what it is. */
const VERSION = { account: 6 << 3, seed: 18 << 3, contract: 2 << 3 } as const

/**
 * Shape, version byte and checksum. All three, because each catches something the others
 * do not: the regex catches a wrong alphabet, the version byte catches a C... where a G...
 * belongs, and the CRC catches a transcription error that looks perfect.
 */
function validStrKey(input: string, re: RegExp, version: number): boolean {
  if (!re.test(input)) return false
  const raw = b32decode(input)
  // 1 version byte + 32 payload + 2 checksum
  if (!raw || raw.length !== 35) return false
  if (raw[0] !== version) return false
  const expected = crc16(raw.subarray(0, 33))
  const actual = raw[33] | (raw[34] << 8)
  return expected === actual
}

export const isContractId = (s: string): boolean => validStrKey(s, STELLAR_CONTRACT_RE, VERSION.contract)
export const isAccountId = (s: string): boolean => validStrKey(s, STELLAR_ACCOUNT_RE, VERSION.account)
export const isSecretSeed = (s: string): boolean => validStrKey(s, STELLAR_SECRET_RE, VERSION.seed)
export const isStellarTxHash = (s: string): boolean => STELLAR_TX_HASH_RE.test(s)

// ── the shape maps the drift tests share ─────────────────────────────────────────────
//
// These live here, exported, so `registry.test.ts` and `provenance.test.ts` cannot drift
// apart on what a valid address looks like. Address shape is a property of the VM, so it
// branches on ecosystem rather than loosening into one pattern that accepts both and
// therefore checks neither. The EVM entries are byte-identical to what those tests
// asserted before Stellar existed.

/** A token or contract address, per ecosystem. */
export const SETTLEMENT_ADDRESS_RE: Record<Ecosystem, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  stellar: STELLAR_CONTRACT_RE,
}

/** An account that can own something, per ecosystem. */
export const OWNER_ADDRESS_RE: Record<Ecosystem, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  stellar: STELLAR_ACCOUNT_RE,
}

/** A transaction hash, per ecosystem. Neither branch accepts the other's rendering. */
export const TX_HASH_RE: Record<Ecosystem, RegExp> = {
  evm: /^0x[0-9a-f]{64}$/,
  stellar: STELLAR_TX_HASH_RE,
}

/** Human-readable names for the shapes above, for assertion messages. */
export const SHAPE_NAME: Record<Ecosystem, { address: string; tx: string }> = {
  evm: { address: '20-byte hex address (0x...)', tx: '32-byte hex hash (0x...)' },
  stellar: {
    address: 'Soroban contract id (C... StrKey, base32 without 0 1 8 9)',
    tx: '32-byte hex hash with NO 0x prefix',
  },
}
