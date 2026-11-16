/**
 * Generic viem client factory for any EVM chain descriptor. This is the extracted,
 * parameterized version of the Arc client wiring: a fallback transport over every RPC
 * (an endpoint that fails rolls to the next), a keyless public client for reads, and a
 * wallet client present only when the chain's signer env var is set.
 *
 * What the fallback does not do: it rolls over only when a request fails. A host that does
 * not have a receipt answers null, which is a successful answer, so a receipt wait through
 * this client keeps polling the first host that answers. To find a receipt, use
 * ./receipts.ts, which asks every host; the settlement engine and the EVM adapter do.
 *
 * Behavior is identical to the original Arc wiring when handed the Arc descriptor.
 */
import { privateKeyToAccount } from 'viem/accounts'
import { retiredEntry, type RetiredAddress } from '../retired.js'
import type { ChainDescriptor } from '../types.js'

/**
 * Resolve a chain's RPC url list: the primary may be overridden by the chain's
 * `rpcEnvVar`, then the remaining fallbacks follow, de-duplicated and non-empty.
 * (Mirrors the original `ARC_RPCS` computation.)
 */
export function resolveRpcUrls(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): string[] {
  const override = chain.rpcEnvVar ? env[chain.rpcEnvVar] : undefined
  const primary = override || chain.rpcUrls[0]
  return [primary, ...chain.rpcUrls.slice(1)].filter((v, i, a) => v && a.indexOf(v) === i)
}

/** A fallback transport over every RPC, so an endpoint that fails rolls to the next
 *  instead of failing the call. Each endpoint retries a couple of times on its own. A null
 *  answer is not a failure and rolls nowhere; see the note at the top of this file. */
export async function evmTransport(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env) {
  const { http, fallback } = await import('viem')
  return fallback(
    resolveRpcUrls(chain, env).map((url) => http(url, { timeout: 8000, retryCount: 2, retryDelay: 400 })),
    { rank: false },
  )
}

/** Keyless public client for reads. */
export async function evmPublicClient(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env) {
  const { createPublicClient } = await import('viem')
  return createPublicClient({ transport: await evmTransport(chain, env) })
}

/**
 * Why a key must not sign, or null when it may: it derives an address A-Identity retired as
 * compromised (chains/retired.ts), whose key someone else holds. `name` is the env var that
 * holds it, for the message; the key itself is never named, returned or kept. A value that is not
 * a key is not this function's to judge, and answers null. `lookup` is the retired list; a test
 * passes its own, because no test holds a retired key.
 */
export function retiredSignerRefusal(
  key: string | undefined,
  name = 'the signer key',
  lookup: (address: string) => RetiredAddress | null = retiredEntry,
): string | null {
  const raw = key?.trim()
  if (!raw) return null
  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`).toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(hex)) return null
  let address: string
  try {
    address = privateKeyToAccount(hex as `0x${string}`).address
  } catch {
    return null
  }
  const r = lookup(address)
  return r ? `${name} holds the key of ${r.label}, which A-Identity retired on ${r.retiredOn} because someone else holds that key, so this server never signs with it.` : null
}

/**
 * The opening sentence of a no-op's reason when a path has no signer: the retired-key refusal when
 * `name` holds a key whose address is retired (retiredSignerRefusal), so a key that is set and refused
 * is never reported as not set, and `No ${name} set.` otherwise.
 */
export function noSignerReason(
  env: NodeJS.ProcessEnv,
  name: string,
  lookup: (address: string) => RetiredAddress | null = retiredEntry,
): string {
  return retiredSignerRefusal(env[name], name, lookup) ?? `No ${name} set.`
}

/**
 * The key a server signer may use, or undefined: a key whose address is retired is refused here
 * (retiredSignerRefusal), logged by name, and every caller answers as it does with no key at all,
 * a no-op that broadcasts nothing. For the paths that build their own account from an env key
 * rather than through evmWalletClientFromKey.
 */
export function usableSignerKey(key: string | undefined, name: string, lookup: (address: string) => RetiredAddress | null = retiredEntry): string | undefined {
  const refused = retiredSignerRefusal(key, name, lookup)
  if (!refused) return key
  console.error(`[chains] ${refused} Treating it as unset.`)
  return undefined
}

/**
 * Build a wallet client from an EXPLICIT private key (used when the signer is not the
 * chain's default signer, e.g. a distinct reputation-validator wallet that, per ERC-8004,
 * must differ from the agent owner). Returns null when there is no usable key, and a key
 * whose address is retired (retiredSignerRefusal) is no usable key: every caller then answers
 * as it does with no key, a labeled no-op, and the reason is logged by name.
 *
 * A malformed key is treated as no key rather than as an exception, because that is what
 * the honesty rule requires of a missing credential: a clean, labeled no-op. It matters in
 * practice - a key pasted into a hosting dashboard arrives with a trailing newline often
 * enough that the trim below is the difference between a working rail and a 502 quoting
 * viem at a user who cannot act on it. Anything still unusable after trimming is logged
 * loudly, because a silently absent signer is a configuration error nobody would find.
 */
export async function evmWalletClientFromKey(
  chain: ChainDescriptor,
  key: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  lookup: (address: string) => RetiredAddress | null = retiredEntry,
) {
  const raw = key?.trim()
  if (!raw) return null
  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`).toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(hex)) {
    console.error(
      `[chains] the signer key for ${chain.id} is not a 32-byte hex private key (got ${hex.length - 2} hex chars). Treating it as unset; writes on this chain will report no signer.`,
    )
    return null
  }
  const refused = retiredSignerRefusal(hex, `the signer key for ${chain.id}`, lookup)
  if (refused) {
    console.error(`[chains] ${refused} Treating it as unset; writes on this chain will report no signer.`)
    return null
  }
  if (chain.evmChainId == null) throw new Error(`Chain ${chain.id} has no EVM chain id`)
  const { createWalletClient, defineChain } = await import('viem')
  const viemChain = defineChain({
    id: chain.evmChainId,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: { default: { http: resolveRpcUrls(chain, env) } },
  })
  const account = privateKeyToAccount(hex as `0x${string}`)
  return { client: createWalletClient({ account, chain: viemChain, transport: await evmTransport(chain, env) }), account }
}

/** Present only when the chain's signer env var is set. Human-on-the-loop lives one
 *  level up: nothing here broadcasts unless a caller explicitly asks to execute. */
export async function evmWalletClient(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env) {
  return evmWalletClientFromKey(chain, chain.signerEnvVar ? env[chain.signerEnvVar] : undefined, env)
}

/** Decode a viem contract revert into the Solidity error name (e.g. "AboveAutoApprove"). */
export async function revertReason(err: unknown): Promise<string> {
  const { BaseError, ContractFunctionRevertedError } = await import('viem')
  if (err instanceof BaseError) {
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (rev instanceof ContractFunctionRevertedError) {
      return rev.data?.errorName ?? rev.reason ?? rev.shortMessage
    }
    return err.shortMessage
  }
  return err instanceof Error ? err.message : String(err)
}

/** Convert a USD amount to the chain's USDC base units (Arc/EVM = 6 decimals). */
export function usdcUnits(chain: ChainDescriptor, amountUsd: number): bigint {
  return BigInt(Math.round(amountUsd * 10 ** chain.usdcDecimals))
}

/** Convert USDC base units back to a USD number. */
export function fromUsdcUnits(chain: ChainDescriptor, v: bigint): number {
  return Number(v) / 10 ** chain.usdcDecimals
}

/** Base units for a token whose decimals come from the token itself rather than from the
 *  chain's USDC convention. A settlement token is not always USDC, so its decimals are
 *  read from the contract and cross-checked before any price is quoted. */
export function tokenUnits(decimals: number, amountUsd: number): bigint {
  return BigInt(Math.round(amountUsd * 10 ** decimals))
}

/** Inverse of tokenUnits. */
export function fromTokenUnits(decimals: number, v: bigint): number {
  return Number(v) / 10 ** decimals
}

/** Explorer link for a tx hash. */
export function txUrl(chain: ChainDescriptor, hash: string): string {
  return `${chain.explorer}/tx/${hash}`
}

/** Explorer link for an address. */
export function addressUrl(chain: ChainDescriptor, address: string): string {
  return `${chain.explorer}/address/${address}`
}
