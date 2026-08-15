/**
 * The Stellar side of the chain layer: an RPC handle and a signer, resolved from the
 * descriptor exactly the way the EVM side resolves its own.
 *
 * This is the only file besides the adapter that imports `@stellar/stellar-sdk`, mirroring
 * the rule the chains README already sets for viem. Everything above the adapter talks in
 * plain strings and descriptors.
 *
 * The discipline copied deliberately from evm/client.ts:
 *
 * - A malformed key is treated as ABSENT, loudly, rather than throwing. A crash on
 *   startup because someone pasted a key with a trailing newline is worse than a chain
 *   that cleanly reports it cannot sign, and this repo already learned that once on
 *   Robinhood Chain (commit 3e9644d, "a signer key with a stray newline is a key, not a
 *   502").
 * - The RPC comes from the descriptor with an env override, never from a constant here.
 */
import { Keypair, Networks, rpc } from '@stellar/stellar-sdk'

import type { ChainDescriptor } from '../types.js'
import { resolveRpcUrls } from '../evm/client.js'
import { isSecretSeed } from './strkey.js'

/**
 * Reused rather than duplicated. `resolveRpcUrls` is VM-agnostic in everything but its
 * current address: it reads `chain.rpcEnvVar` and falls back to `chain.rpcUrls`. If a
 * third ecosystem lands it should move to a shared module; copying four lines here would
 * just create two things that must agree.
 */
export function stellarRpcUrl(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): string {
  const [first] = resolveRpcUrls(chain, env)
  if (!first) throw new Error(`${chain.id} declares no RPC url`)
  return first
}

/**
 * The network passphrase, which on Stellar is what a signature is actually bound to.
 *
 * It lives here rather than in the adapter because the signing paths need it too, and two
 * copies of this mapping is how a testnet signature ends up presented to pubnet. Throwing
 * on an unknown caip2 is deliberate: there is no safe default, and guessing here would mean
 * signing for a network nobody chose.
 */
export function networkPassphrase(chain: ChainDescriptor): string {
  if (chain.caip2 === 'stellar:pubnet') return Networks.PUBLIC
  if (chain.caip2 === 'stellar:testnet') return Networks.TESTNET
  throw new Error(`${chain.id}: no known network passphrase for ${chain.caip2}`)
}

/** A Soroban RPC handle for this chain. */
export function sorobanServer(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): rpc.Server {
  if (chain.ecosystem !== 'stellar') {
    throw new Error(`sorobanServer: ${chain.id} is not a Stellar chain (${chain.ecosystem})`)
  }
  return new rpc.Server(stellarRpcUrl(chain, env))
}

/**
 * The signer for this chain, or null when there is none to be had.
 *
 * Null is the normal, supported state: without a key every write returns a labeled
 * prepared no-op instead of broadcasting, which is the rule for every chain here.
 *
 * A Stellar secret is an ed25519 StrKey, `S` followed by 55 base32 characters. It is NOT
 * a 0x hex private key, and the two are not interchangeable in either direction, so a
 * value that fails the shape check is far more likely to be an EVM key in the wrong
 * variable than a typo.
 */
export function stellarKeypair(
  chain: ChainDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): Keypair | null {
  const name = chain.signerEnvVar
  if (!name) return null
  const raw = env[name]?.trim()
  if (!raw) return null
  if (!isSecretSeed(raw)) {
    // Loud, and then absent. Never throw: this runs at request time on a shared server.
    console.error(
      `[chains/stellar] ${name} is set but is not a Stellar secret seed (expected S + 55 ` +
        `base32 chars). Treating ${chain.id} as unsigned, so its writes will return prepared ` +
        `rather than broadcasting. If that value is a 0x hex key, it belongs to an EVM chain.`,
    )
    return null
  }
  try {
    return Keypair.fromSecret(raw)
  } catch (e) {
    console.error(
      `[chains/stellar] ${name} has the right shape but did not decode as a keypair ` +
        `(${e instanceof Error ? e.message : String(e)}). Treating ${chain.id} as unsigned.`,
    )
    return null
  }
}

/**
 * Which variable holds the rail's dedicated fee payer for this network.
 *
 * Network-scoped for the same reason the signers and the OZ keys are: one variable plus a
 * network flag is the shape that signs a pubnet transaction with a testnet key.
 *
 * This replaces X402_STELLAR_SIGNER_SECRET, which was worse than useless. It was read by
 * the rail's readiness check and by NOTHING that signs, so setting it made the rail report
 * itself configured and ready while the signing path, which only ever read the chain's own
 * signerEnvVar, still had no key. An adversarial review found it; the variable never worked
 * and is retired rather than fixed in place, since a name that once meant "ready" and now
 * means something else is its own hazard.
 */
export function feePayerEnvVar(chain: ChainDescriptor): string {
  return chain.caip2 === 'stellar:pubnet'
    ? 'X402_STELLAR_PUBNET_FEE_PAYER'
    : 'X402_STELLAR_TESTNET_FEE_PAYER'
}

/**
 * The account that pays network fees when we broadcast for a buyer.
 *
 * Tries the rail's dedicated fee payer first so it can be a thin wallet holding only XLM,
 * separate from the chain's general signer, then falls back to that signer. Validation is
 * the same in both cases, which is the point: readiness and signing must never be able to
 * disagree about whether a key exists.
 */
export function stellarFeePayer(
  chain: ChainDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): Keypair | null {
  const dedicated = env[feePayerEnvVar(chain)]?.trim()
  if (dedicated) {
    if (isSecretSeed(dedicated)) return Keypair.fromSecret(dedicated)
    console.error(
      `[chains/stellar] ${feePayerEnvVar(chain)} is set but is not a Stellar secret seed. ` +
        `Falling back to ${chain.signerEnvVar ?? 'the chain signer'}.`,
    )
  }
  return stellarKeypair(chain, env)
}

/** The public account the signer would act as, without exposing the key. */
export function stellarSignerAddress(
  chain: ChainDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return stellarKeypair(chain, env)?.publicKey() ?? null
}
