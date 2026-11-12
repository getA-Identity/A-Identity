/**
 * NEAR identifier shapes: account ids and transaction hashes, as pure predicates.
 *
 * Mirrors chains/algorand/ids.ts: the VM family defines what an address and a transaction id
 * look like, and the shared drift maps in stellar/strkey.ts branch on ecosystem, so the
 * registry and provenance tests check the right shape instead of loosening into one pattern
 * that checks nothing. No SDK import and no I/O: this answers "is this the right KIND of
 * string", never "does it exist on chain" (chains/near/client.ts asks that).
 *
 * A NEAR ACCOUNT ID is 2 to 64 characters of a-z, 0-9 and the separators `.`, `-` and `_`,
 * with no separator at either end and never two in a row. The rule is the one the official
 * near/near-account-id crate enforces (src/validation.rs, MIN_LEN 2, MAX_LEN 64), and the
 * regex below is the one that file names as equivalent. Uppercase is not a NEAR account id at
 * all, which is what separates a NEAR eth-implicit account from a checksummed EVM address.
 *
 * The crate then sorts a valid id into five kinds (account_id_ref.rs, get_account_type), in
 * this order: eth-implicit (`0x` plus 40 lowercase hex), near-implicit (64 lowercase hex),
 * deterministic (`0s` plus 40 lowercase hex, NEP-616), universal (`0u` plus 52 lowercase
 * Crockford base32 whose last character is `0` or `g`, the only canonical endings), and
 * named, which is everything else. All five are mirrored here, because classifying a `0s...`
 * id as a named account would describe it as something a registrar could have issued.
 *
 * A TRANSACTION HASH is a 32-byte CryptoHash rendered in base58 (Bitcoin alphabet), so 32 to
 * 44 characters with no prefix; 32 zero bytes render as 32 `1`s. The shape check decodes the
 * string and requires exactly 32 bytes, because a regex alone accepts 44-character strings
 * that encode more than 256 bits.
 */

/** The account-id rule as one RegExp, length included, for the Record<Ecosystem, RegExp> maps. */
export const NEAR_ACCOUNT_ID_RE = /^(?=.{2,64}$)(?:(?:[a-z\d]+[-_])*[a-z\d]+\.)*(?:[a-z\d]+[-_])*[a-z\d]+$/

/** A base58 CryptoHash: 32 to 44 characters of the Bitcoin alphabet (no 0, O, I or l). */
export const NEAR_TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export type NearAccountKind = 'named' | 'near-implicit' | 'eth-implicit' | 'deterministic' | 'universal'

/** True for any well-formed NEAR account id, of any kind. */
export const isNearAccountId = (s: string): boolean => NEAR_ACCOUNT_ID_RE.test(s)

/** Which kind of account a valid id names, in the crate's own order; null when the id is invalid. */
export function nearAccountKind(s: string): NearAccountKind | null {
  if (!isNearAccountId(s)) return null
  if (/^0x[0-9a-f]{40}$/.test(s)) return 'eth-implicit'
  if (/^[0-9a-f]{64}$/.test(s)) return 'near-implicit'
  if (/^0s[0-9a-f]{40}$/.test(s)) return 'deterministic'
  if (/^0u[0-9a-hjkmnp-tv-z]{51}[0g]$/.test(s)) return 'universal'
  return 'named'
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Decode Bitcoin-alphabet base58. Null on any character outside the alphabet. */
function b58decode(s: string): Uint8Array | null {
  let n = 0n
  for (const ch of s) {
    const v = B58.indexOf(ch)
    if (v < 0) return null
    n = n * 58n + BigInt(v)
  }
  const body: number[] = []
  while (n > 0n) {
    body.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  // Each leading '1' is one leading zero byte, which the integer above cannot carry.
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros += 1
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body])
}

/** True only for a base58 string that decodes to exactly 32 bytes, which is what a NEAR tx hash is. */
export function isNearTxHash(s: string): boolean {
  if (!NEAR_TX_HASH_RE.test(s)) return false
  return b58decode(s)?.length === 32
}

/**
 * The one NEAR network the registry carries (registry.ts, descriptor `near-testnet`), by the
 * CAIP-2 id that descriptor declares. ids.test.ts fails if the two ever disagree.
 */
const ROUTED_NETWORK = 'near:testnet'

/** NEAR's registrar top-level account on testnet: a named account registered there ends in it. */
const TESTNET_TOP_LEVEL = '.testnet'

export type NearTarget = { network: typeof ROUTED_NETWORK; account: string; kind: NearAccountKind }

/**
 * Whether a free-form query names a NEAR account, and which one.
 *
 * Deliberately narrow, because most NEAR account ids are also something else this codebase
 * already parses, and those readings came first: bare digits are ERC-8004 token ids,
 * `agent_<id>` is a platform agent id, a lowercase `0x` plus 40 hex is an EVM address, a
 * 64-hex string is also a Stellar transaction hash and the shape of an unprefixed EVM key,
 * and a dotted name such as `alice.tg` is a web domain in a real country TLD. So only two
 * forms are claimed here, the ones nothing else claims:
 *
 *  - the CAIP-10 form `near:testnet:<account>`, any account kind, because the namespace says
 *    which reading is meant;
 *  - a bare named account ending in `.testnet`, NEAR's own testnet registrar suffix, which is
 *    not a top-level domain on the internet.
 *
 * A pure classifier. Nothing calls it on a request path yet: routing a trust check to NEAR is
 * a later change, and it must use this function rather than a looser test of its own.
 */
export function nearTargetOf(query: string): NearTarget | null {
  const s = query.trim()
  const prefix = `${ROUTED_NETWORK}:`
  if (s.startsWith(prefix)) {
    const account = s.slice(prefix.length)
    const kind = nearAccountKind(account)
    return kind ? { network: ROUTED_NETWORK, account, kind } : null
  }
  if (s.endsWith(TESTNET_TOP_LEVEL) && nearAccountKind(s) === 'named') {
    return { network: ROUTED_NETWORK, account: s, kind: 'named' }
  }
  return null
}
