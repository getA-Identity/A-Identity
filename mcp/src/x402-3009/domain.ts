/**
 * EIP-712 signing-domain discovery, by PROOF rather than by assertion.
 *
 * A buyer signing an EIP-3009 authorization has to sign against the token's exact
 * EIP-712 domain. Get one field wrong and the signature is worthless: the transfer
 * reverts and nobody can tell from the outside whether the buyer or the seller was at
 * fault. The usual practice is to paste the domain into the code, which is what the Celo
 * rail does (celo-x402.ts: a human read name() and version() once and wrote them down).
 *
 * That is not good enough here for a concrete reason: USDG exposes NEITHER `version()`
 * NOR `eip712Domain()` (both revert), so its version genuinely cannot be read from the
 * chain. What the token DOES expose is `DOMAIN_SEPARATOR()`, which is the keccak of the
 * whole domain struct. So instead of trusting a written-down version we rebuild each
 * candidate domain, hash it, and accept only the one that reproduces the live separator.
 * A token with no matching candidate is refused, and the rail serves no challenge at all
 * rather than inviting a buyer to sign something we cannot settle.
 *
 * Everything here is chain-generic: it works for any EIP-3009 token on any EVM chain in
 * the registry, which is why the module is named for the mechanism, not for a chain.
 */
import { keccak256, stringToHex, encodeAbiParameters } from 'viem'
import type { ChainDescriptor, SettlementToken } from '../chains/index.js'
import { EIP3009_ABI, evmPublicClient } from '../chains/index.js'

export type Eip712Domain = {
  name: string
  version: string
  chainId: number
  verifyingContract: `0x${string}`
}

export type ProvenDomain = {
  domain: Eip712Domain
  /** The LIVE separator read from the token, which `domain` reproduces exactly. */
  domainSeparator: `0x${string}`
  /** 'onchain' = version() answered. 'proven-candidate' = the token has no version() and
   *  this candidate is the one whose hash matched the live separator. */
  versionSource: 'onchain' | 'proven-candidate'
  symbol: string
  decimals: number
  provenAt: string
}

export type DomainFailCode =
  | 'no_domain_separator'
  | 'name_unreadable'
  | 'no_matching_candidate'
  | 'decimals_mismatch'
  | 'not_eip3009'
  | 'no_evm_chain_id'
  | 'rpc_error'

export type DomainResult =
  | { ok: true; proven: ProvenDomain }
  | { ok: false; reason: string; code: DomainFailCode }

/**
 * Reads one view function off the token. Injectable so the whole proof path unit-tests
 * with no RPC, which matters because these are the branches that decide whether real
 * money is allowed to move.
 */
export type TokenReader = (
  fn: 'name' | 'symbol' | 'decimals' | 'version' | 'DOMAIN_SEPARATOR' | 'authorizationState',
  args?: readonly unknown[],
) => Promise<unknown>

export type DomainDeps = {
  reader?: TokenReader
  now?: () => Date
  env?: NodeJS.ProcessEnv
}

const DOMAIN_TYPEHASH_SOURCE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'

/** keccak of the standard EIP-712 domain struct. Pure. */
export function eip712DomainSeparator(d: Eip712Domain): `0x${string}` {
  // Imported eagerly from viem's pure crypto surface: no client, no network, and keeping
  // it synchronous lets the tests assert the hash directly against a live value.
  return keccakDomain(d)
}

/** The first candidate whose separator equals `live`, or null. Pure. */
export function proveDomain(candidates: Eip712Domain[], live: string): Eip712Domain | null {
  const target = live.toLowerCase()
  for (const c of candidates) {
    if (eip712DomainSeparator(c).toLowerCase() === target) return c
  }
  return null
}

/**
 * Candidate domains to try, most authoritative first: the version the contract itself
 * reports, then the versions the registry declares for this token, then the two versions
 * essentially every EIP-712 token in the wild uses. De-duplicated, order preserved.
 */
export function domainCandidates(
  facts: { name: string; version: string | null; chainId: number; verifyingContract: `0x${string}` },
  declared?: string[],
): Eip712Domain[] {
  const versions: string[] = []
  const push = (v: string | null | undefined) => {
    if (v && !versions.includes(v)) versions.push(v)
  }
  push(facts.version)
  for (const v of declared ?? []) push(v)
  push('1')
  push('2')
  return versions.map((version) => ({
    name: facts.name,
    version,
    chainId: facts.chainId,
    verifyingContract: facts.verifyingContract,
  }))
}

/**
 * Read the token and prove its signing domain. Fails CLOSED: an unprovable domain, a
 * decimals disagreement with the descriptor, a missing DOMAIN_SEPARATOR or a token that
 * does not answer `authorizationState` all return ok:false, and the caller must then
 * serve no payment challenge.
 */
export async function discoverDomain(
  chain: ChainDescriptor,
  token: SettlementToken,
  deps: DomainDeps = {},
): Promise<DomainResult> {
  const now = deps.now ?? (() => new Date())
  if (chain.evmChainId == null) {
    return { ok: false, code: 'no_evm_chain_id', reason: `${chain.id} has no EVM chain id, so an EIP-712 domain cannot be built` }
  }
  const address = token.address as `0x${string}`
  const read = deps.reader ?? (await rpcReader(chain, address, deps.env))

  let separator: string
  try {
    separator = String(await read('DOMAIN_SEPARATOR'))
  } catch (e) {
    return {
      ok: false,
      code: 'no_domain_separator',
      reason: `${token.symbol} does not answer DOMAIN_SEPARATOR(), so its signing domain cannot be proven: ${msg(e)}`,
    }
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(separator)) {
    return { ok: false, code: 'no_domain_separator', reason: `${token.symbol} returned a malformed DOMAIN_SEPARATOR: ${separator}` }
  }

  let name: string
  try {
    name = String(await read('name'))
  } catch (e) {
    return { ok: false, code: 'name_unreadable', reason: `${token.symbol} does not answer name(): ${msg(e)}` }
  }

  // A revert here is expected and fine: USDG has no version(). That is the whole reason
  // the candidate proof exists, so it must not be treated as an error.
  let onchainVersion: string | null = null
  try {
    onchainVersion = String(await read('version'))
  } catch {
    onchainVersion = null
  }

  let symbol = token.symbol
  try {
    symbol = String(await read('symbol'))
  } catch {
    /* symbol is a label, not a safety property: keep the descriptor's */
  }

  let decimals: number
  try {
    decimals = Number(await read('decimals'))
  } catch (e) {
    return { ok: false, code: 'rpc_error', reason: `${token.symbol} does not answer decimals(): ${msg(e)}` }
  }
  if (decimals !== token.decimals) {
    // A descriptor typo here is a 1000x mispricing, so it fails closed rather than
    // quoting a price nobody meant.
    return {
      ok: false,
      code: 'decimals_mismatch',
      reason: `${token.symbol} reports ${decimals} decimals, the registry declares ${token.decimals}. Refusing to price against a disagreement.`,
    }
  }

  // Cheap read-only proof that the token really implements EIP-3009, with no write and
  // no signature involved.
  try {
    await read('authorizationState', [ZERO_ADDRESS, ZERO_BYTES32])
  } catch (e) {
    return {
      ok: false,
      code: 'not_eip3009',
      reason: `${token.symbol} does not implement authorizationState, so it is not an EIP-3009 token: ${msg(e)}`,
    }
  }

  const candidates = domainCandidates(
    { name, version: onchainVersion, chainId: chain.evmChainId, verifyingContract: address },
    token.domainVersionCandidates,
  )
  const domain = proveDomain(candidates, separator)
  if (!domain) {
    const tried = candidates.map((c) => `"${c.version}" -> ${eip712DomainSeparator(c)}`).join(', ')
    return {
      ok: false,
      code: 'no_matching_candidate',
      reason: `No candidate domain reproduces ${token.symbol}'s live DOMAIN_SEPARATOR ${separator}. Tried name "${name}" with versions: ${tried}.`,
    }
  }

  return {
    ok: true,
    proven: {
      domain,
      domainSeparator: separator as `0x${string}`,
      versionSource: onchainVersion && onchainVersion === domain.version ? 'onchain' : 'proven-candidate',
      symbol,
      decimals,
      provenAt: now().toISOString(),
    },
  }
}

// ── memoization ───────────────────────────────────────────────────────────────────
// A proven domain is stable for the life of a token, but re-reading it occasionally is
// cheap insurance against an upgradeable token changing under us. A FAILED discovery is
// deliberately never cached: a transient RPC error must not pin the rail closed.

const DOMAIN_TTL_MS = 10 * 60_000
const cache = new Map<string, { at: number; result: DomainResult }>()

export async function provenDomainCached(
  chain: ChainDescriptor,
  token: SettlementToken,
  deps: DomainDeps = {},
): Promise<DomainResult> {
  const key = `${chain.caip2}/${token.address.toLowerCase()}`
  const hit = cache.get(key)
  const nowMs = (deps.now ? deps.now() : new Date()).getTime()
  if (hit && nowMs - hit.at < DOMAIN_TTL_MS) return hit.result
  const result = await discoverDomain(chain, token, deps)
  if (result.ok) cache.set(key, { at: nowMs, result })
  return result
}

export function clearDomainCache(): void {
  cache.clear()
}

// ── internals ─────────────────────────────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The real reader: one viem public client per chain, used only for view calls. */
async function rpcReader(chain: ChainDescriptor, address: `0x${string}`, env?: NodeJS.ProcessEnv): Promise<TokenReader> {
  const client = await evmPublicClient(chain, env ?? process.env)
  return (fn, args) =>
    client.readContract({
      address,
      abi: EIP3009_ABI,
      functionName: fn as never,
      args: (args ?? []) as never,
    }) as Promise<unknown>
}

/** Synchronous keccak of the domain struct. Split out so the exported helper can stay
 *  pure and synchronous while viem's crypto helpers are imported at module scope. */
function keccakDomain(d: Eip712Domain): `0x${string}` {
  const typeHash = keccak256(stringToHex(DOMAIN_TYPEHASH_SOURCE))
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [typeHash, keccak256(stringToHex(d.name)), keccak256(stringToHex(d.version)), BigInt(d.chainId), d.verifyingContract],
    ),
  )
}
