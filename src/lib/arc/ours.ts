/**
 * Is this vault, or this key, ours? Asked of the provenance ledger as it was generated into the
 * build (src/lib/arc-ledger.ts), so the answer does not depend on the backend being awake, and of
 * whatever the backend has listed since, when it has answered.
 *
 * Runtime imports only with their .ts extension, so mcp/src/frontend-arc-vault.test.ts can load
 * this straight from src/.
 */
import { ARC_LEDGER_KEYS, ARC_LEDGER_VAULTS } from '../arc-ledger.ts'
import { sameAddress } from './vault-rules.ts'

type Listed = { network: string; address: string; kind: string }

/** The ledger's vaults, and any the backend listed as ours, match this network and address. */
export function isOurVault(network: string, address: string, listed: readonly Listed[] = []): boolean {
  return (
    ARC_LEDGER_VAULTS.some((v) => v.network === network && sameAddress(v.address, address)) ||
    listed.some((v) => v.kind === 'ours' && v.network === network && sameAddress(v.address, address))
  )
}

/** The ledger's keys, and any the backend listed, on this network hold this address. */
export function isOurKey(network: string, address: string, listed: Readonly<Record<string, readonly string[]>> = {}): boolean {
  return [...(ARC_LEDGER_KEYS[network] ?? []), ...(listed[network] ?? [])].some((k) => sameAddress(k, address))
}
