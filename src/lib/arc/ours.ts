/**
 * Is this vault, or this key, ours? Asked of the provenance ledger as it was generated into the
 * build (src/lib/arc-ledger.ts), so the answer does not depend on the backend being awake, and of
 * whatever the backend has listed since, when it has answered. Is this key retired? Asked of the
 * same build: an address A-Identity retired as compromised is never ours, whatever any list says.
 *
 * Runtime imports only with their .ts extension, so mcp/src/frontend-arc-vault.test.ts can load
 * this straight from src/.
 */
import { getAddress, isAddress } from 'viem'
import { ARC_LEDGER_KEYS, ARC_LEDGER_RETIRED, ARC_LEDGER_VAULTS } from '../arc-ledger.ts'
import { sameAddress } from './vault-rules.ts'

type Listed = { network: string; address: string; kind: string }

/**
 * The entry for an address A-Identity retired as compromised (mcp/src/chains/retired.ts, generated into
 * the build as ARC_LEDGER_RETIRED), in any case, or null. Someone else holds the key of every such address.
 */
export function retiredKeyOf(address: string | null | undefined): { address: string; label: string; retiredOn: string } | null {
  return ARC_LEDGER_RETIRED.find((r) => sameAddress(r.address, address)) ?? null
}

/** Whether this address is one A-Identity retired as compromised: never ours, on any network. */
export function isRetiredKey(address: string | null | undefined): boolean {
  return retiredKeyOf(address) !== null
}

/** The ledger's vaults, and any the backend listed as ours, match this network and address. */
export function isOurVault(network: string, address: string, listed: readonly Listed[] = []): boolean {
  return (
    ARC_LEDGER_VAULTS.some((v) => v.network === network && sameAddress(v.address, address)) ||
    listed.some((v) => v.kind === 'ours' && v.network === network && sameAddress(v.address, address))
  )
}

/**
 * The ledger's keys, and any the backend listed, on this network hold this address. A retired address
 * is never one of them, whatever a list says: an older backend still listed the former operating wallet.
 */
export function isOurKey(network: string, address: string, listed: Readonly<Record<string, readonly string[]>> = {}): boolean {
  if (isRetiredKey(address)) return false
  return [...(ARC_LEDGER_KEYS[network] ?? []), ...(listed[network] ?? [])].some((k) => sameAddress(k, address))
}

/** The ledger's own day a vault it lists was retired, or null: a retired vault's owner is a retired address. */
export function retiredVaultOn(network: string, address: string): string | null {
  return ARC_LEDGER_VAULTS.find((v) => v.network === network && sameAddress(v.address, address))?.retiredOn ?? null
}

/**
 * What the ledger itself says of an older build of ours, in plain words, or null when it says
 * nothing: a vault of ours built from an earlier source reads as that, because that is what it
 * is. Only the ledger entry can say this, so a contract anyone else deployed never gets the line.
 */
export function earlierBuildLine(network: string, address: string): string | null {
  const v = ARC_LEDGER_VAULTS.find((x) => x.network === network && sameAddress(x.address, address))
  if (!v?.builtFromCommit) return null
  const verified = v.sourcifyVerified ? ' Its source is verified on Sourcify against that commit.' : ''
  return `Built from an earlier source (commit ${v.builtFromCommit}) than the one this page deploys, so its code is not this page's build.${verified} View only here.`
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
 * Which listed vault a link with no vault opens. The ledger's own, which is labelled for what it is
 * (the launch-day vault A-Identity deployed, retired since 2026-11-11) and offers no fund form, or
 * the connected account's own. Never someone else's owner-held vault: a first-time visitor would
 * land on a stranger's vault and a form to send it money.
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
/** For a contract whose owner() is a retired address. Never "one of our keys": someone else holds it. */
export const NAMES_RETIRED_KEY =
  "This contract names a retired address as its owner. That address is not A-Identity's, and A-Identity does not vouch for it. Do not fund this contract."

/**
 * For a vault whose agent key (operator) is a retired address. The server deployed vaults for their owners
 * with the former operating wallet as the agent key. That key can pay from such a vault within its limits
 * unless the vault is frozen or its session key has lapsed, and it stays the agent key until the owner
 * replaces it either way, so the line says which is true now and how to cut it out with the calls only the
 * owner can make.
 */
export function operatorRetiredLine(r: { label: string; retiredOn: string }, state: { frozen?: boolean; expired?: boolean } = {}): string {
  const head = `This vault's agent key (operator) is ${r.label}, which A-Identity retired on ${r.retiredOn}. It is not A-Identity's, and A-Identity does not vouch for it`
  if (state.frozen) {
    return `${head}. It cannot pay while the vault is frozen, but it stays the agent key until you replace it. If you own this vault, set a new agent key you hold (setOperator) before you unfreeze it (setFrozen), or withdraw its USDC (withdraw).`
  }
  if (state.expired) {
    return `${head}. It cannot pay while its session key has lapsed, but it stays the agent key until you replace it. If you own this vault, set a new agent key you hold (setOperator) before you renew the session key (setSessionKeyExpiry), or freeze the vault (setFrozen) or withdraw its USDC (withdraw).`
  }
  return `${head}, but that key can still pay from this vault within its limits. If you own this vault, cut it out now: set a new agent key you hold (setOperator), freeze the vault (setFrozen), or withdraw its USDC (withdraw).`
}
