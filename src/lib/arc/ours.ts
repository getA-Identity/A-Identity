/**
 * Is this vault, or this key, ours? Asked of the provenance ledger as it was generated into the
 * build (src/lib/arc-ledger.ts), so the answer does not depend on the backend being awake, and of
 * whatever the backend has listed since, when it has answered.
 *
 * Runtime imports only with their .ts extension, so mcp/src/frontend-arc-vault.test.ts can load
 * this straight from src/.
 */
import { getAddress, isAddress } from 'viem'
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

/**
 * Our own vaults and keys, as this build already knows them. In the bundle, so the page has them
 * on its first render: asking the backend first left a cold backend's minute with nothing listed.
 */
export function ledgerKnownVaults(): { vaults: { network: string; address: `0x${string}`; kind: 'ours' }[]; ourKeys: Record<string, string[]> } {
  return {
    vaults: ARC_LEDGER_VAULTS.flatMap((v) => (isAddress(v.address, { strict: false }) ? [{ network: v.network, address: getAddress(v.address), kind: 'ours' as const }] : [])),
    ourKeys: Object.fromEntries(Object.entries(ARC_LEDGER_KEYS).map(([net, keys]) => [net, [...keys]])),
  }
}

/**
 * Which listed vault a link with no vault opens. Ours, which is labelled as ours and offers no
 * fund form, or the connected account's own. Never someone else's owner-held vault: a first-time
 * visitor would land on a stranger's vault and a form to send it money.
 */
export function autoLandVault<T extends { network: string; kind: string; owner?: string }>(rows: readonly T[], network: string, account: string | null): T | null {
  const here = rows.filter((v) => v.network === network)
  const mine = account ? here.find((v) => v.kind === 'owner-held' && v.owner && sameAddress(v.owner, account)) : undefined
  return mine ?? here.find((v) => v.kind === 'ours') ?? null
}

/** What sending USDC to a vault means, said the same way wherever funding is offered. */
export const FUND_RISK = 'Once sent, the owner can withdraw it and the agent key can spend it within the caps until the key expires.'
/** What someone who does not own the vault ticks before the form is shown. */
export const NOT_MY_VAULT = 'This is not my vault, and I cannot get this back.'
/** For a contract that names one of our keys as its owner and is not on our list. Anyone can
 *  deploy that, so it says nothing about who deployed it. */
export const NAMES_OUR_KEY = 'This contract names one of our keys as its owner; it is not in our ledger and we did not list it.'
