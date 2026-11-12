/**
 * NEAR identifier shapes for the browser: account ids and transaction hashes.
 *
 * The same rules as mcp/src/chains/near/ids.ts, which src/ cannot import (separate package,
 * separate deploy). An ACCOUNT ID is 2 to 64 characters of a-z, 0-9 and the separators `.`,
 * `-` and `_`, never a separator at either end or two in a row (the near-account-id crate's
 * rule). A TRANSACTION HASH is 32 bytes in base58, so 32 to 44 characters, and the check
 * decodes it because a 44-character string can encode more than 32 bytes.
 *
 * Shape only: whether the account exists is a question for the chain (rpc.ts).
 * Pure and import-free, so near.test.ts can load it through Node's type stripping.
 */

export const NEAR_ACCOUNT_ID_RE = /^(?=.{2,64}$)(?:(?:[a-z\d]+[-_])*[a-z\d]+\.)*(?:[a-z\d]+[-_])*[a-z\d]+$/

const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** True for any well-formed NEAR account id: named (alice.testnet) or implicit (64 hex). */
export const isNearAccountId = (s: string): boolean => NEAR_ACCOUNT_ID_RE.test(s)

/** Byte length of a base58 string, or null when it has a character outside the alphabet. */
function base58Length(s: string): number | null {
  let n = 0n
  for (const ch of s) {
    const v = B58.indexOf(ch)
    if (v < 0) return null
    n = n * 58n + BigInt(v)
  }
  let bytes = 0
  while (n > 0n) {
    n >>= 8n
    bytes += 1
  }
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros += 1
  return bytes + zeros
}

/** True only for base58 text that decodes to exactly 32 bytes, which is what a NEAR tx hash is. */
export function isNearTxHash(s: string): boolean {
  return TX_HASH_RE.test(s) && base58Length(s) === 32
}

/** A long id shortened for a narrow column: the start and the end, never a guess at the middle. */
export function shortId(id: string, keep = 10): string {
  if (id.length <= keep * 2 + 3) return id
  return `${id.slice(0, keep)}...${id.slice(-keep)}`
}

/** A public key ("ed25519:...") shortened the same way, keeping its curve prefix readable. */
export function shortKey(pk: string): string {
  const i = pk.indexOf(':')
  const curve = i > 0 ? pk.slice(0, i + 1) : ''
  const body = i > 0 ? pk.slice(i + 1) : pk
  return body.length <= 14 ? pk : `${curve}${body.slice(0, 6)}...${body.slice(-6)}`
}
