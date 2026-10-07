/**
 * `refund --to <G...>`: everything left in the one-time wallets on this computer, back to the
 * user's own Stellar address as XLM.
 *
 * It covers the current wallets and every set moved aside earlier (see `parseAsideName` for the
 * file names a wallet directory accumulates): a
 * Stellar wallet is merged into that address, which sends all of its XLM, and USDC and ALGO on
 * Algorand are exchanged back to XLM through SideShift (bridge.ts, runBack). What is under
 * SideShift's minimum (about 3 USDC, about 25 ALGO) cannot go that way; it is reported with the
 * command that returns it on Algorand directly. Each set keeps its progress in a state file, so
 * a refund that is waiting for an exchange continues where it stopped when run again. The
 * current wallets stay where they are, marked as returned, so `status` says Finished; the next
 * `buy` sets them aside and starts new ones.
 */
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { FetchLike } from '@a-identity/trust-guard'
import { loadState, runBack } from './bridge.js'
import { pair } from './sideshift.js'
import { loadStellarWallet, readXlm, type StellarWalletFile } from './stellar.js'
import { loadWallet, readStatus, type WalletFile } from './wallet.js'
import { CMD } from './version.js'

export type RefundCtx = {
  algorandPath: string
  stellarPath: string
  statePath: string
  to: string
  algod: string
  horizon: string
  fetchImpl: FetchLike
  out: (line: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  maxWaitMs?: number
}

export type WalletSet = {
  /** null for the current wallets, otherwise the key their files were moved aside under. */
  stamp: string | null
  /** When the set was first moved aside (ms since the epoch); 0 for the current wallets or an unknown date. */
  movedAsideMs: number
  algorand: WalletFile | null
  algorandPath: string | null
  stellar: StellarWalletFile | null
  statePath: string
}

/**
 * A wallet file this directory keeps but no longer uses: `<base>.closed-<ms>.json` when `buy --new`
 * or a finished return moved a set aside; `<base>.closed-<ms>.closed-<ms>.json` when such a set
 * was later swept, which retires the file once more; and `<base>.old-<tag>.json` for a file
 * someone renamed by hand. Any chain of `.closed-` and `.old-` parts counts, so no set is skipped
 * because of how many times it was set aside or what it was called.
 */
const ASIDE = /^((?:\.(?:closed|old)-[0-9A-Za-z]+)+)\.json$/

export type AsideName = { stamp: string; movedAsideMs: number }

/** The set key and the time the set was first moved aside, or null when `file` is not such a file. */
export function parseAsideName(file: string, base: string): AsideName | null {
  if (!file.startsWith(base)) return null
  const m = file.slice(base.length).match(ASIDE)
  if (!m) return null
  const parts = m[1].slice(1).split('.')
  // A plain `.closed-<ms>.json` keeps the bare stamp as its key, so refund state written by earlier
  // versions (`refund-<ms>.json`) still belongs to it; every other shape keys on its whole suffix.
  const stamp = parts.length === 1 && parts[0].startsWith('closed-') ? parts[0].slice('closed-'.length) : parts.join('.')
  const first = parts[0].replace(/^(?:closed|old)-/, '')
  const movedAsideMs = /^\d{13}$/.test(first)
    ? Number(first)
    : /^\d{8}$/.test(first)
      ? Date.UTC(Number(first.slice(0, 4)), Number(first.slice(4, 6)) - 1, Number(first.slice(6, 8)))
      : 0
  return { stamp, movedAsideMs }
}

function closedFiles(path: string): (AsideName & { path: string })[] {
  const dir = dirname(path)
  if (!existsSync(dir)) return []
  const base = basename(path).replace(/\.json$/, '')
  const found: (AsideName & { path: string })[] = []
  for (const f of readdirSync(dir)) {
    const a = parseAsideName(f, base)
    if (a) found.push({ ...a, path: join(dir, f) })
  }
  return found
}

const readable = <T>(f: () => T): T | null => {
  try {
    return f()
  } catch {
    return null
  }
}

/** The current wallets, then every set moved aside, oldest first. */
export function walletSets(c: Pick<RefundCtx, 'algorandPath' | 'stellarPath' | 'statePath'>): WalletSet[] {
  const sets: WalletSet[] = []
  const aw = loadWallet(c.algorandPath)
  const sw = loadStellarWallet(c.stellarPath)
  if (aw || sw) sets.push({ stamp: null, movedAsideMs: 0, algorand: aw, algorandPath: aw ? c.algorandPath : null, stellar: sw, statePath: c.statePath })
  const closed = new Map<string, WalletSet>()
  const at = (a: AsideName) => {
    if (!closed.has(a.stamp)) {
      closed.set(a.stamp, { stamp: a.stamp, movedAsideMs: a.movedAsideMs, algorand: null, algorandPath: null, stellar: null, statePath: join(dirname(c.statePath), `refund-${a.stamp}.json`) })
    }
    return closed.get(a.stamp)!
  }
  for (const x of closedFiles(c.algorandPath)) {
    const w = readable(() => loadWallet(x.path))
    if (w) Object.assign(at(x), { algorand: w, algorandPath: x.path })
  }
  for (const x of closedFiles(c.stellarPath)) {
    const w = readable(() => loadStellarWallet(x.path))
    if (w) at(x).stellar = w
  }
  return [...sets, ...[...closed.values()].sort((a, b) => a.movedAsideMs - b.movedAsideMs || (a.stamp ?? '').localeCompare(b.stamp ?? ''))]
}

/** How a set is named in the output: by the day it was moved aside when the file name carries one. */
export const asideLabel = (s: WalletSet): string =>
  !s.stamp
    ? 'The current wallets'
    : s.movedAsideMs > 0
      ? `Wallets moved aside on ${new Date(s.movedAsideMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : `Wallets moved aside (${s.stamp})`

const sweepCommand = (s: WalletSet) => `${s.stamp ? `A_IDENTITY_KEYFILE=${s.algorandPath} ` : ''}${CMD} wallet sweep <YOUR ALGORAND ADDRESS>`

/** Whether a set holds anything SideShift can send back, and what it cannot. */
async function inspect(c: RefundCtx, s: WalletSet, mins: { usdc: number; algo: number }): Promise<{ go: boolean; dust: string | null }> {
  const xlm = s.stellar ? await readXlm(s.stellar.address, c.horizon, c.fetchImpl) : null
  const a = s.algorand ? await readStatus(s.algorand.address, c.algod, c.fetchImpl) : null
  const usdcGoes = Boolean(a?.usdcOptedIn && a.usdc >= mins.usdc * 1.01)
  const usdcStays = Boolean(a?.usdcOptedIn && a.usdc > 0 && !usdcGoes)
  // With the USDC holding closed, all the ALGO can go; with USDC staying, all but what holding it needs.
  const algoSendable = a?.exists ? a.algo - (usdcStays ? a.minBalanceAlgo : 0) - 0.002 : 0
  const go = Boolean(xlm?.exists) || usdcGoes || algoSendable >= mins.algo * 1.01
  const dust =
    a && (usdcStays || (!go && a.algo >= 1))
      ? `${a.usdc} USDC and ${a.algo} ALGO in ${a.address} are under SideShift's minimum (${mins.usdc} USDC, ${mins.algo} ALGO), so they cannot come back as XLM. To get them back on Algorand: ${sweepCommand(s)}`
      : null
  return { go, dust }
}

/** Returns true when every set is done (or held nothing to send), false while an exchange is still on its way. */
export async function refundAll(c: RefundCtx): Promise<boolean> {
  const now = c.now ?? Date.now
  const deadline = now() + (c.maxWaitMs ?? 80_000)
  if (!(await readXlm(c.to, c.horizon, c.fetchImpl)).exists) throw new Error(`${c.to} does not exist on Stellar yet. Use an address that already holds XLM.`)
  const sets = walletSets(c)
  if (!sets.length) {
    c.out('Nothing to send back: there are no one-time wallets on this computer.')
    return true
  }
  const [u, a] = await Promise.all([pair('usdc-algorand', 'xlm-stellar', c.fetchImpl), pair('algo-algorand', 'xlm-stellar', c.fetchImpl)])
  const mins = { usdc: u.min, algo: a.min }
  let allDone = true
  let acted = false
  for (const s of sets) {
    const name = asideLabel(s)
    const look = await inspect(c, s, mins)
    const before = loadState(s.statePath).back
    if (!look.go && !(before && !before.done)) {
      if (look.dust) c.out(`${name}: ${look.dust}`)
      continue
    }
    // Returned before, and money arrived since (a late exchange): a new return for this set.
    if (before?.done && look.go && existsSync(s.statePath)) renameSync(s.statePath, s.statePath.replace(/\.json$/, `.done-${now()}.json`))
    acted = true
    c.out(`${name} (${[s.stellar && `Stellar ${s.stellar.address}`, s.algorand && `Algorand ${s.algorand.address}`].filter(Boolean).join(', ')}):`)
    try {
      const ctx = { algorand: s.algorand, stellar: s.stellar, statePath: s.statePath, algod: c.algod, horizon: c.horizon, fetchImpl: c.fetchImpl, out: c.out, now: c.now, sleep: c.sleep }
      if (!(await runBack(ctx, c.to, Math.max(0, deadline - now())))) {
        allDone = false
        continue
      }
      const usdcLeft = loadState(s.statePath).back?.usdcLeft ?? 0
      if (usdcLeft > 0) c.out(`To get those ${usdcLeft} USDC back on Algorand instead: ${sweepCommand(s)}`)
    } catch (e) {
      allDone = false
      c.out(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (!acted && allDone) c.out('Nothing to send back: the wallets on this computer hold nothing SideShift can return.')
  if (!allDone) c.out(`Not finished yet. Run the same command again in a few minutes: ${CMD} refund --to ${c.to}`)
  return allDone
}
