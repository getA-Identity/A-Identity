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
 * We validate the alphabet and the length, not the checksum. A checksum test would need
 * base32 decoding and would be validating a value we already got from a derivation or a
 * live read; the failure this guards against is a `G...` issuer pasted where a `C...`
 * contract belongs, and the first letter catches that.
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

export const isContractId = (s: string): boolean => STELLAR_CONTRACT_RE.test(s)
export const isAccountId = (s: string): boolean => STELLAR_ACCOUNT_RE.test(s)
export const isSecretSeed = (s: string): boolean => STELLAR_SECRET_RE.test(s)
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
