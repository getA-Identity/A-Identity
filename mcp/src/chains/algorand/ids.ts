/**
 * Algorand identifier shapes and checksum validation.
 *
 * Mirrors chains/stellar/strkey.ts in spirit: the VM family defines what an
 * address and a transaction id look like, and the shared drift maps in
 * strkey.ts branch on ecosystem so provenance and registry tests validate the
 * right shape instead of loosening into one pattern that checks nothing.
 *
 * An Algorand ADDRESS is 58 characters of RFC 4648 base32 (A-Z, 2-7, no
 * padding): 32 bytes of ed25519 public key plus a 4-byte checksum, the last
 * four bytes of sha512/256 over the key. A TRANSACTION ID is 52 characters of
 * the same alphabet: the base32 of a 32-byte hash, unpadded, so its final
 * character can only be one of the 16 symbols whose trailing bits are zero.
 * The checksum is verified here with node's own sha512-256 rather than pulled
 * from algosdk, so shape validation stays dependency-free and synchronous.
 */
import { createHash } from 'node:crypto'

export const ALGORAND_ADDRESS_RE = /^[A-Z2-7]{58}$/
export const ALGORAND_TX_ID_RE = /^[A-Z2-7]{52}$/

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode unpadded RFC 4648 base32. Returns null on any invalid character. */
function b32decode(s: string): Uint8Array | null {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx < 0) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/**
 * True only for a well-formed Algorand address whose 4-byte checksum matches
 * sha512/256 of the public key. A regex-only check would accept 1 in 4
 * billion random strings; the checksum is what actually catches typos.
 */
export function isAlgorandAddress(s: string): boolean {
  if (!ALGORAND_ADDRESS_RE.test(s)) return false
  const decoded = b32decode(s)
  if (!decoded || decoded.length !== 36) return false
  const pubkey = decoded.subarray(0, 32)
  const checksum = decoded.subarray(32, 36)
  const digest = createHash('sha512-256').update(pubkey).digest()
  const expected = digest.subarray(28, 32)
  return checksum.every((b, i) => b === expected[i])
}

/** Transaction ids carry no checksum; the 52-char base32 shape is the check. */
export const isAlgorandTxId = (s: string): boolean => ALGORAND_TX_ID_RE.test(s)
