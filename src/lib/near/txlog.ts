/**
 * The transactions this browser sent to a NEAR vault, kept so their events can be read again.
 *
 * NEAR's RPC cannot search a contract's events by account, so a page with no indexer only knows
 * the transactions it was told about: the ones it sent, and any a person looks up by hash. This
 * keeps the first kind, per vault, newest first. It stores hashes and labels, nothing secret, and
 * a browser that clears its storage loses only this list: every event on the page is still read
 * from the chain, never from here.
 */

export type KnownTx = {
  hash: string
  /** The account that signed it, which the RPC needs to find it. */
  signerId: string
  /** What it was, in words, as the page described it before the wallet opened. */
  what: string
  /** When this browser handed it to the wallet (ISO). */
  at: string
}

const KEEP = 20
const key = (vaultId: string) => `aid-near-txs:${vaultId}`

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function storage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const isKnownTx = (v: unknown): v is KnownTx => {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  return typeof t.hash === 'string' && typeof t.signerId === 'string' && typeof t.what === 'string' && typeof t.at === 'string'
}

export function loadKnownTxs(vaultId: string, store: StorageLike | null = storage()): KnownTx[] {
  try {
    const raw = store?.getItem(key(vaultId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isKnownTx).slice(0, KEEP) : []
  } catch {
    return []
  }
}

/** Remember one transaction, newest first, without duplicates. Returns the list as stored. */
export function rememberTx(vaultId: string, tx: KnownTx, store: StorageLike | null = storage()): KnownTx[] {
  const next = [tx, ...loadKnownTxs(vaultId, store).filter((t) => t.hash !== tx.hash)].slice(0, KEEP)
  try {
    store?.setItem(key(vaultId), JSON.stringify(next))
  } catch {
    // Storage full or blocked: the page still has the receipt on screen; only the list is lost.
  }
  return next
}
