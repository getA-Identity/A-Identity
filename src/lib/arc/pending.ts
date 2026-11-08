/**
 * What this browser remembers about transactions it handed to a wallet, so a reload or a closed
 * tab never loses a hash: the latest transaction per vault, the one vault setup in progress, the
 * deploy hash of each vault it saw settle, and what it sent for each flow an owner approved.
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
import type { HeldDeploy } from './vault-count'
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
  /**
   * Read back from the transaction after the wallet signed it: what the wallet actually sent. `host`
   * is where it was read, absent on a record from before it was kept.
   */
  sent?: { maxFeePerGas: bigint | null; gasPrice: bigint | null; nonce: number; belowFloor: boolean; from: string; host?: string }
  /** When this hash's own nonce was first seen used with no receipt for the hash (ISO). */
  nonceUsedAt?: string
  /** Read-backs tried since the receipt arrived. */
  readBackTries?: number
  /** The receipt carried every event this write was expected to emit. */
  logsMatched?: boolean
}

/**
 * What this browser did about one flow an owner approved. Written BEFORE the wallet is asked, so a
 * closed tab or a phone wallet that approves later still leaves the record that stops a second send.
 * Shared by every tab, because a second tab that does not know about the first pays twice.
 */
export type HandoffSend = {
  v: 1
  /** CAIP-2. */
  network: string
  vault: string
  flowId: string
  payee: string
  amount: bigint
  from: string
  askedAt: string
  /** Which tab's claim this is. A claim another tab overwrote is not this tab's to send on. */
  token: string
  /** The transaction the wallet handed back, the first one if there were more. */
  tx?: TxRecord
  /**
   * Any other transaction sent for this flow. The page stops waiting on a prompt after two minutes, so a
   * person can say nothing was sent and send again with the first prompt still open, and answer both. A hash
   * can also come back after the read found a payment under another one, and a new claim keeps a send the
   * person let go of, which can still land. Each one that lands pays, so each one stays on the record until
   * it has an answer. One that was replaced can no longer land, and it stops counting: see otherSends.
   */
  alsoSent?: TxRecord[]
  /** A payment of this flow's amount to its payee found on chain, under another hash than tx: a speed-up, usually. */
  paidBy?: string
  /**
   * A payment of this flow's amount to its payee from the agent's key, found on chain after the check while this
   * claim's prompt had no answer. The card says to decline that prompt, and one signed anyway is a second payment,
   * which the server's record of this request does not name.
   */
  agentPaid?: string
  /** A hash came back for this claim and went to alsoSent, so tx is empty and the wallet has still answered. Read on a record from before `answered`. */
  hashBack?: boolean
  /**
   * Whether this claim's own prompt has had its answer: a hash back to the run that asked, or a no from it. Written
   * false with the claim and true with that answer. A hash an earlier claim's run hands back is a send, and answers
   * nothing here, so the prompt this claim opened stays open beside it. Absent on a record from before it was kept,
   * where tx and hashBack say it.
   */
  answered?: boolean
  /** When tx was first seen replaced with no payment of it found. A host can lag, so one read is not the answer. */
  replacedSeenAt?: string
  /** tx was replaced, and the Paid events, read well after that, hold no payment: it can no longer land and nothing replaced it with a payment. */
  replacedClear?: boolean
  /** The person said they checked their wallet and nothing is on its way. */
  released?: boolean
  /** When they said so (ISO). A slow wallet can still send it, so the page keeps looking for a while. */
  releasedAt?: string
  /** The server's final answer on a hash. Absent until it gave one. */
  server?: { state: 'settled' | 'ended' | 'moved' | 'refused'; txHash: string; flowId: string; code?: string; reason?: string; at: string }
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
  /**
   * Saved right BEFORE the wallet is asked to send the funding and cleared when its hash comes back
   * or the person says nothing was sent. While it is here, this page cannot say the USDC did not leave.
   */
  fundIntent?: { amount: bigint; at: string }
  fundSkipped?: boolean
}

/** The storage key of the one setup slot, exported so a tab can tell another tab's write to it. */
export const SETUP_KEY = 'aid-arc-vault-setup'
/** The deploys this browser saw settle, oldest first. Outlives the setup slot, which an owner can forget. */
const DEPLOYS_KEY = 'aid-arc-vault-deploys'
/** More than anyone deploys by hand from one browser: a bound on what is kept, not a rule. */
const DEPLOYS_KEPT = 50
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

const handoffPrefix = (network: string, vault: string) => `aid-arc-handoff:${network}:${vault.toLowerCase()}:`
const declinedKey = (network: string, vault: string) => `aid-arc-handoff-declined:${network}:${vault.toLowerCase()}`
/** More than anyone approves by hand from one browser in the time these matter: a bound on what is kept, not a rule. */
const HANDOFFS_KEPT = 50
const DECLINED_KEPT = 50

/** Every key in this browser's records that starts so, storage or the memory standing in for it. */
function keysWith(prefix: string): string[] {
  const out = new Set<string>()
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(prefix)) out.add(k)
    }
  } catch {
    /* storage is blocked: memory below is all there is */
  }
  for (const k of memory.keys()) if (k.startsWith(prefix)) out.add(k)
  return [...out]
}

/** The record is about this flow. */
export function holdsFlow(r: HandoffSend, flowId: string): boolean {
  return r.flowId.toLowerCase() === flowId.toLowerCase()
}

function isHandoff(r: HandoffSend | null): r is HandoffSend {
  return Boolean(r && r.v === 1 && typeof r.flowId === 'string' && typeof r.payee === 'string' && typeof r.amount === 'bigint')
}

/** Everything this browser did about flows on this vault. */
export function loadHandoffs(network: string, vault: string): HandoffSend[] {
  return keysWith(handoffPrefix(network, vault))
    .map((k) => read<HandoffSend>(k))
    .filter(isHandoff)
    .sort((a, b) => (a.askedAt < b.askedAt ? 1 : -1))
}

export function saveHandoff(r: HandoffSend): void {
  write(`${handoffPrefix(r.network, r.vault)}${r.flowId.toLowerCase()}`, r)
  // Only a record with a final answer is ever dropped to keep this bounded: an open one stops a second send,
  // and one of more than one send, or of the agent's payment beside one, names a payment the server's record of it does not.
  const all = loadHandoffs(r.network, r.vault)
  for (const old of all.filter((x) => x.server && !x.alsoSent?.length && !x.agentPaid).slice(HANDOFFS_KEPT)) clearHandoff(old.network, old.vault, old.flowId)
}

export function clearHandoff(network: string, vault: string, flowId: string): void {
  write(`${handoffPrefix(network, vault)}${flowId.toLowerCase()}`, null)
}

/** The record this flow has in this browser right now, whoever wrote it. */
function storedHandoff(r: Pick<HandoffSend, 'network' | 'vault' | 'flowId'>): HandoffSend | null {
  const now = read<HandoffSend>(`${handoffPrefix(r.network, r.vault)}${r.flowId.toLowerCase()}`)
  return isHandoff(now) ? now : null
}

const sameHash = (a: TxRecord, b: TxRecord) => a.hash.toLowerCase() === b.hash.toLowerCase()

/**
 * The wallet said no to this claim's prompt, or was never asked. A run can outlive its claim, and its prompt
 * can be answered long after a later claim took the record: see alsoSent. So the record goes only if it is
 * still this claim and holds nothing sent or paid. Anything else it holds is another prompt's or another key's,
 * and it stays, with this claim's prompt answered on it, so nothing goes on saying that prompt may be open.
 * A send this claim carried stays followed, and nothing is asked any more, so the record goes back to what
 * the person said before they tried again.
 */
export function dropClaim(claim: HandoffSend): void {
  const now = storedHandoff(claim)
  if (now?.token !== claim.token) return
  if (now.tx || now.paidBy || now.server) return saveHandoff({ ...now, answered: true })
  if (now.alsoSent?.some((t) => t.outcome !== 'replaced')) saveHandoff({ ...now, released: true, releasedAt: new Date().toISOString(), answered: true })
  else clearHandoff(claim.network, claim.vault, claim.flowId)
}

/**
 * The person says no prompt for this record's claim is open in their wallet: a run lost to a reload or a closed tab
 * cannot hear its answer, so this is the only way that prompt ends. Only on the claim it was said about.
 */
export function noPromptOpen(r: HandoffSend): void {
  const now = storedHandoff(r)
  if (now?.token === r.token) saveHandoff({ ...now, answered: true })
}

/**
 * The hash a wallet handed back for this claim, on the record as it stands now and not as the claim left it,
 * whichever prompt answers first. The first hash is the record's tx, and any other goes beside it, as does one
 * that comes back after the read found a payment under another hash, which it may have paid beside. A new hash
 * also ends what was said about nothing being on its way, because something now is, and a replaced hash's watch
 * starts over, because only a read well after the latest replacement can speak for it. It answers the prompt of
 * the claim whose run asked, and only while that claim is the record's: a later claim's prompt is still open.
 */
export function saveSentHash(claim: HandoffSend, tx: TxRecord): void {
  const now = storedHandoff(claim)
  if (!now) return saveHandoff({ ...claim, tx, answered: true })
  const answer = now.token === claim.token ? { answered: true } : {}
  // A wallet that signs the same transaction again hands back a hash the record already holds: one send, and an answer.
  if ((now.tx && sameHash(now.tx, tx)) || now.alsoSent?.some((t) => sameHash(t, tx))) {
    if (now.token === claim.token && now.answered !== true) saveHandoff({ ...now, answered: true })
    return
  }
  const open = { ...now, released: undefined, releasedAt: undefined, replacedClear: undefined, replacedSeenAt: undefined, ...answer }
  if (now.tx || (now.paidBy && now.paidBy.toLowerCase() !== tx.hash.toLowerCase())) return saveHandoff({ ...open, alsoSent: [...(now.alsoSent ?? []), tx] })
  saveHandoff({ ...open, tx })
}

/** This record, with one of its transactions as it stands now. */
export function withTx(r: HandoffSend, tx: TxRecord): HandoffSend {
  return r.alsoSent?.some((t) => sameHash(t, tx)) ? { ...r, alsoSent: r.alsoSent.map((t) => (sameHash(t, tx) ? tx : t)) } : { ...r, tx }
}

/** The flows the person said no to in this browser. Nothing else knows: a flow has no such state. */
export function loadDeclined(network: string, vault: string): string[] {
  const rows = read<string[]>(declinedKey(network, vault))
  return Array.isArray(rows) ? rows.filter((x) => typeof x === 'string') : []
}

export function saveDeclined(network: string, vault: string, flowId: string, declined: boolean): void {
  const rest = loadDeclined(network, vault).filter((x) => x !== flowId.toLowerCase())
  write(declinedKey(network, vault), (declined ? [...rest, flowId.toLowerCase()] : rest).slice(-DECLINED_KEPT))
}

/** The Web Locks a browser offers, or a stand-in in a test. */
export type SendLocks = { request: <T>(name: string, fn: () => T) => Promise<T> }

/**
 * A new claim takes the record's place, and what the record held is not over because the person said so: a send
 * they let go of can still be queued in a wallet, and if it lands it pays. So it stays on the new record, and
 * it is followed again. One that was replaced can no longer land, and stays behind.
 */
function withCarried(r: HandoffSend, was: HandoffSend | null): HandoffSend {
  const sends = was ? [...(was.tx ? [was.tx] : []), ...(was.alsoSent ?? [])] : []
  const alsoSent = sends.filter((t) => t.outcome !== 'replaced').map((t): TxRecord => (t.outcome === 'untracked' ? { ...t, outcome: 'pending', note: undefined, nonceUsedAt: undefined, unseen: undefined, likelyReplaced: undefined } : t))
  return alsoSent.length ? { ...r, alsoSent } : r
}

/**
 * Take the send for a flow, or say another send holds it. `refused` is asked inside the lock, with every
 * record read fresh. Two tabs reach this at the same moment, and only one of them gets to open a wallet.
 * With no Web Locks the record is written and read back, which leaves a window of a few milliseconds
 * between two tabs a person would have to click in at once. The claim is a prompt about to open, with no answer.
 */
export async function claimHandoff(r: HandoffSend, refused: (records: HandoffSend[]) => boolean, locks: SendLocks | null | undefined = defaultLocks()): Promise<boolean> {
  const take = () => {
    if (refused(loadHandoffs(r.network, r.vault))) return false
    saveHandoff(withCarried({ ...r, answered: false }, storedHandoff(r)))
    return read<HandoffSend>(`${handoffPrefix(r.network, r.vault)}${r.flowId.toLowerCase()}`)?.token === r.token
  }
  return locks ? locks.request(`aid-arc-handoff:${r.vault.toLowerCase()}`, take) : take()
}

function defaultLocks(): SendLocks | null {
  try {
    const l = (navigator as Navigator & { locks?: { request: (name: string, fn: () => unknown) => Promise<unknown> } }).locks
    return l ? { request: (name, fn) => l.request(name, fn) as Promise<never> } : null
  } catch {
    return null
  }
}

export function loadDeploys(): HeldDeploy[] {
  const rows = read<HeldDeploy[]>(DEPLOYS_KEY)
  return Array.isArray(rows) ? rows.filter((d) => typeof d?.network === 'string' && typeof d?.vault === 'string' && typeof d?.hash === 'string') : []
}

export function rememberDeploy(d: HeldDeploy): void {
  const rest = loadDeploys().filter((x) => x.network !== d.network || x.vault.toLowerCase() !== d.vault.toLowerCase())
  write(DEPLOYS_KEY, [...rest, d].slice(-DEPLOYS_KEPT))
}

export function loadSetup(): SetupState | null {
  const s = read<SetupState>(SETUP_KEY)
  return s && s.v === 1 && typeof s.network === 'string' && typeof s.owner === 'string' && typeof s.startedAt === 'string' ? s : null
}

/** Write the setup slot, or clear it with null. Callers go through useArcSetup, which checks whose setup the slot holds first. */
export function saveSetup(s: SetupState | null): void {
  write(SETUP_KEY, s)
}
