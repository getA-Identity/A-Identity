/**
 * CAIP helpers — Chain Agnostic Improvement Proposals. One data model across EVM,
 * and Stellar so a new chain is a new row, not a new special case.
 *
 *   CAIP-2  chain:   namespace:reference          e.g. eip155:5042002, stellar:testnet
 *   CAIP-10 account: chain_id:address             e.g. eip155:5042002:0xabc...
 *   CAIP-19 asset:   chain_id/ns:reference        e.g. eip155:5042002/erc20:0x3600...
 *
 * References are NOT all numeric: EVM uses an integer, Stellar a network label,
 * Bitcoin a genesis-hash prefix. Store the raw reference; never assume it parses
 * as a number. See ./README.md.
 */

/** CAIP-2 namespace: 3-8 chars of [-a-z0-9]. */
const NAMESPACE_RE = /^[-a-z0-9]{3,8}$/
/** CAIP-2 reference: 1-32 chars of [-_a-zA-Z0-9]. */
const REFERENCE_RE = /^[-_a-zA-Z0-9]{1,32}$/

export type Caip2 = { namespace: string; reference: string }

/** Parse a CAIP-2 chain id, validating both halves. Returns null if malformed. */
export function parseCaip2(chainId: string): Caip2 | null {
  const i = chainId.indexOf(':')
  if (i <= 0) return null
  const namespace = chainId.slice(0, i)
  const reference = chainId.slice(i + 1)
  if (!NAMESPACE_RE.test(namespace) || !REFERENCE_RE.test(reference)) return null
  return { namespace, reference }
}

/** True if the given CAIP-2 id is a well-formed identifier. */
export function isValidCaip2(chainId: string): boolean {
  return parseCaip2(chainId) !== null
}

/** True if the chain is in the EVM (eip155) namespace. */
export function isEvmCaip2(chainId: string): boolean {
  return parseCaip2(chainId)?.namespace === 'eip155'
}

/** The EVM numeric chain id encoded in an eip155 CAIP-2, or null for non-EVM/malformed. */
export function evmChainIdFromCaip2(chainId: string): number | null {
  const parsed = parseCaip2(chainId)
  if (!parsed || parsed.namespace !== 'eip155') return null
  const n = Number(parsed.reference)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Build a CAIP-2 id for an EVM chain. */
export function evmCaip2(evmChainId: number): string {
  return `eip155:${evmChainId}`
}

/** Build a CAIP-10 account id: `<caip2>:<address>`. Address is left encoded as-is
 *  (hex for EVM, StrKey for Stellar). */
export function buildCaip10(chainId: string, address: string): string {
  return `${chainId}:${address}`
}

export type Caip10 = { chainId: string; address: string }

/** Parse a CAIP-10 account id back into its chain id and address. Returns null if the
 *  chain-id half is not a valid CAIP-2. */
export function parseCaip10(account: string): Caip10 | null {
  const lastColon = account.lastIndexOf(':')
  if (lastColon <= 0) return null
  const chainId = account.slice(0, lastColon)
  const address = account.slice(lastColon + 1)
  if (!address || !isValidCaip2(chainId)) return null
  return { chainId, address }
}

/** Build a CAIP-19 asset id: `<caip2>/<assetNamespace>:<assetReference>`. */
export function buildCaip19(chainId: string, assetNamespace: string, assetReference: string): string {
  return `${chainId}/${assetNamespace}:${assetReference}`
}
