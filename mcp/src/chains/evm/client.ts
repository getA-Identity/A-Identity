/**
 * Generic viem client factory for any EVM chain descriptor. This is the extracted,
 * parameterized version of the Arc client wiring: a fallback transport over every RPC
 * (one flaky endpoint rolls to the next), a keyless public client for reads, and a
 * wallet client present only when the chain's signer env var is set.
 *
 * Behavior is identical to the original Arc wiring when handed the Arc descriptor.
 */
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

/** A fallback transport over every RPC, so one flaky endpoint rolls to the next
 *  instead of failing the call. Each endpoint retries a couple of times on its own. */
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
 * Build a wallet client from an EXPLICIT private key (used when the signer is not the
 * chain's default signer, e.g. a distinct reputation-validator wallet that, per ERC-8004,
 * must differ from the agent owner). Returns null when there is no usable key.
 *
 * A malformed key is treated as no key rather than as an exception, because that is what
 * the honesty rule requires of a missing credential: a clean, labeled no-op. It matters in
 * practice - a key pasted into a hosting dashboard arrives with a trailing newline often
 * enough that the trim below is the difference between a working rail and a 502 quoting
 * viem at a user who cannot act on it. Anything still unusable after trimming is logged
 * loudly, because a silently absent signer is a configuration error nobody would find.
 */
export async function evmWalletClientFromKey(chain: ChainDescriptor, key: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  const raw = key?.trim()
  if (!raw) return null
  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`).toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(hex)) {
    console.error(
      `[chains] the signer key for ${chain.id} is not a 32-byte hex private key (got ${hex.length - 2} hex chars). Treating it as unset; writes on this chain will report no signer.`,
    )
    return null
  }
  if (chain.evmChainId == null) throw new Error(`Chain ${chain.id} has no EVM chain id`)
  const { createWalletClient, defineChain } = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
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
