/**
 * What this browser remembers about transactions it handed to a wallet, so a reload or a closed
 * tab never loses a hash: the latest transaction per vault, and the one vault setup in progress.
 *
 * Only public facts are stored (hashes, addresses, amounts, the setup's chosen limits): never a
 * key, never a signature. BigInts travel as tagged decimal strings so nothing is rounded. When
 * storage is blocked, the records still hold for this tab, in memory.
 *
 * There is one setup slot per browser, shared by every tab. A setup is known by its startedAt, and
 * a tab writes to the slot only while it still holds the setup that tab is showing, so one tab
 * can never overwrite or bring back another tab's setup (src/components/app/arc/useArcSetup.ts).
 */
import type { Hex } from 'viem'
import type { Expectation } from './tx-rules'
import type { TxAction } from './vault-write'

/**
 * 'replaced': this hash's nonce went to another transaction and no RPC has a receipt for it, so
 * it can no longer land (or, for a deploy, a vault that reads back as asked exists at its address).
 * 'untracked': no receipt was seen and the page stopped waiting on it (the person chose to, or its
 * account moved on with this hash never seen); it may still land.
 */
export type TxOutcome = 'pending' | 'settled' | 'unexpected' | 'reverted' | 'replaced' | 'untracked'

/** What a deploy must read back as before it counts. */
export type DeployArgs = { owner: string; operator: string; usdc: string; dailyCap: bigint; autoApproveMax: bigint }

export type TxRecord = {
  hash: Hex
  action: TxAction
  what: string
  /** CAIP-2. */
  network: string
  from: string
  /** The vault the transaction acts on. For a deploy, the address the receipt names, once it does. */
  vault: string | null
  submittedAt: string
  expect: Expectation[]
  /** A deploy: the CREATE address at the nonce read when it was prepared. */
  predicted?: string
  /** The nonce read when it was prepared (a deploy's predicted address comes from it). The wallet may pick another. */
  nonce?: number
  /** The max fee per gas this page handed the wallet, in native wei. The wallet may send another. */
  proposedMaxFee?: bigint
  /** No host has shown this transaction 30 seconds after it was handed over. */
  unseen?: boolean
  /** Untracked because the account moved on with this hash never seen: most likely a speed-up or a cancel. */
  likelyReplaced?: boolean
  /** A deploy: what the vault must read back as before the deploy counts. */
  deployArgs?: DeployArgs
  /** A session key write: the value sessionKeyExpiry must read back as. */
  expiry?: bigint
  /** A funding transfer: the vault's balance must read back at least this. */
  amount?: bigint
  outcome: TxOutcome
  block?: bigint
  /** gasUsed * effectiveGasPrice, in native wei. */
  feeWei?: bigint
  /** The host whose receipt decided. */
  host?: string
  contractAddress?: string
  note?: string
  /** Read back from the transaction after the wallet signed it: what the wallet actually sent. */
  sent?: { maxFeePerGas: bigint | null; gasPrice: bigint | null; nonce: number; belowFloor: boolean; from: string }
  /** When this hash's own nonce was first seen used with no receipt for the hash (ISO). */
  nonceUsedAt?: string
  /** Read-backs tried since the receipt arrived. */
  readBackTries?: number
  /** The receipt carried every event this write was expected to emit. */
  logsMatched?: boolean
}

export type SetupState = {
  v: 1
  /** CAIP-2. */
  network: string
  owner: string
  operator: string
  dailyCap: bigint
  autoApproveMax: bigint
  sessionSeconds: number
  funding: bigint
  /** When the setup started (ISO), and the setup's identity across tabs. */
  startedAt: string
  /**
   * Saved right BEFORE the wallet is asked to send the deploy, so a deploy whose hash never comes
   * back (a closed tab, a phone wallet that approves later) still leaves the address to look at.
   */
  intent?: { from: string; nonce: number; predicted: string; deployArgs: DeployArgs; at: string }
  deploy?: TxRecord
  /** The deployed vault, once its receipt (or a replacement's code) read back as this setup's. */
  vault?: string
  expiryTx?: TxRecord
  fundTx?: TxRecord
  fundSkipped?: boolean
}

/** The storage key of the one setup slot, exported so a tab can tell another tab's write to it. */
export const SETUP_KEY = 'aid-arc-vault-setup'
const txKey = (network: string, vault: string) => `aid-arc-vault-tx:${network}:${vault.toLowerCase()}`

/** Where records live while storage is blocked: this tab only, until it closes. */
const memory = new Map<string, string>()

function getRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return memory.get(key) ?? null
  }
}

function setRaw(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    if (value === null) memory.delete(key)
    else memory.set(key, value)
  }
}

function replacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? { $n: v.toString() } : v
}

function reviver(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v)
    const n = (v as { $n?: unknown }).$n
    if (keys.length === 1 && typeof n === 'string' && /^-?\d+$/.test(n)) return BigInt(n)
  }
  return v
}

export const toStored = (value: unknown): string => JSON.stringify(value, replacer)
export const fromStored = <T>(text: string): T => JSON.parse(text, reviver) as T

function read<T>(key: string): T | null {
  try {
    const raw = getRaw(key)
    return raw ? fromStored<T>(raw) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  setRaw(key, value === null ? null : toStored(value))
}

export function loadTx(network: string, vault: string): TxRecord | null {
  const r = read<TxRecord>(txKey(network, vault))
  return r && typeof r.hash === 'string' && r.network === network ? r : null
}

export function saveTx(r: TxRecord): void {
  if (r.vault) write(txKey(r.network, r.vault), r)
}

export function clearTx(network: string, vault: string): void {
  write(txKey(network, vault), null)
}

export function loadSetup(): SetupState | null {
  const s = read<SetupState>(SETUP_KEY)
  return s && s.v === 1 && typeof s.network === 'string' && typeof s.owner === 'string' && typeof s.startedAt === 'string' ? s : null
}

/** Write the setup slot, or clear it with null. Callers go through useArcSetup, which checks whose setup the slot holds first. */
export function saveSetup(s: SetupState | null): void {
  write(SETUP_KEY, s)
}
