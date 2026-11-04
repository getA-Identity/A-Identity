/**
 * How the deploy page keeps its read of the vault current between steps. Pure, with no runtime
 * imports, so mcp/src/frontend-arc-copy.test.ts holds it directly.
 */
import type { SetupStep } from './tx-rules'

/** While a step waits on the chain, the vault is read again this often. */
export const REREAD_MS = 10_000
/** How soon a read from before the funding's block is tried again: a host catches up in seconds. */
export const BEHIND_MS = 3_000

/**
 * How often to read the vault again at this step, or null for not at all. The steps with no record
 * count too: a wallet that shows an error may already have broadcast, and then there is no hash and
 * no receipt to wait on, so the vault's own expiry or balance is the only way the page ever hears.
 * The last screen keeps reading until it has a read at all, or one from after its own write.
 */
export function rereadMs(step: SetupStep, readBehind: boolean, haveRead = true): number | null {
  if (readBehind) return BEHIND_MS
  if (step === 'done' && !haveRead) return REREAD_MS
  return step === 'expiry' || step === 'expiry-pending' || step === 'fund' || step === 'fund-pending' ? REREAD_MS : null
}

type Read = { address: string; network: string; block: bigint }

/**
 * Which of two reads to keep. Reads repeat and can come from different hosts, so one from an older
 * block of the same vault must not put a step that has moved on back where it was.
 */
export function newerRead<T extends Read>(held: T | null, read: T): T {
  if (!held || held.address.toLowerCase() !== read.address.toLowerCase() || held.network !== read.network) return read
  return read.block < held.block ? held : read
}
