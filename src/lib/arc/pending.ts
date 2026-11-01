/**
 * What this browser remembers about transactions it handed to a wallet, so a reload or a closed
 * tab never loses a hash: the latest transaction per vault, and the one vault setup in progress.
 *
 * Only public facts are stored (hashes, addresses, amounts, the setup's chosen limits): never a
 * key, never a signature. BigInts travel as tagged decimal strings so nothing is rounded.
 */
import type { Hex } from 'viem'
import type { Expectation } from './vault-read'
import type { TxAction } from './vault-write'

export type TxOutcome = 'pending' | 'settled' | 'unexpected' | 'reverted' | 'replaced'

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
  /** A deploy: what the vault must read back as before the deploy counts. */
  deployArgs?: { owner: string; operator: string; usdc: string; dailyCap: bigint; autoApproveMax: bigint }
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
  startedAt: string
  deploy?: TxRecord
  /** The deployed vault, once its receipt (or a replacement's code) read back as this setup's. */
  vault?: string
  expiryTx?: TxRecord
  fundTx?: TxRecord
  fundSkipped?: boolean
}

const SETUP_KEY = 'aid-arc-vault-setup'
const txKey = (network: string, vault: string) => `aid-arc-vault-tx:${network}:${vault.toLowerCase()}`

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
    const raw = localStorage.getItem(key)
    return raw ? fromStored<T>(raw) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, toStored(value))
  } catch {
    /* storage blocked: the record still holds for this tab */
  }
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
  return s && s.v === 1 && typeof s.network === 'string' && typeof s.owner === 'string' ? s : null
}

export function saveSetup(s: SetupState | null): void {
  write(SETUP_KEY, s)
}
