/**
 * `refund --to <G...>`: everything left in the one-time wallets on this computer, back to the
 * user's own Stellar address as XLM.
 *
 * It covers the current wallets and every set an earlier run moved aside (*.closed-*.json): a
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
  /** null for the current wallets, otherwise the stamp their files were moved aside with. */
  stamp: string | null
  algorand: WalletFile | null
  algorandPath: string | null
  stellar: StellarWalletFile | null
  statePath: string
}

function closedFiles(path: string): { stamp: string; path: string }[] {
  const dir = dirname(path)
  if (!existsSync(dir)) return []
  const base = basename(path).replace(/\.json$/, '')
  const found: { stamp: string; path: string }[] = []
  for (const f of readdirSync(dir)) {
    const m = f.startsWith(base) ? f.slice(base.length).match(/^\.closed-(\d+)\.json$/) : null
    if (m) found.push({ stamp: m[1], path: join(dir, f) })
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
  if (aw || sw) sets.push({ stamp: null, algorand: aw, algorandPath: aw ? c.algorandPath : null, stellar: sw, statePath: c.statePath })
  const closed = new Map<string, WalletSet>()
  const at = (stamp: string) => {
    if (!closed.has(stamp)) closed.set(stamp, { stamp, algorand: null, algorandPath: null, stellar: null, statePath: join(dirname(c.statePath), `refund-${stamp}.json`) })
    return closed.get(stamp)!
  }
  for (const x of closedFiles(c.algorandPath)) {
    const w = readable(() => loadWallet(x.path))
    if (w) Object.assign(at(x.stamp), { algorand: w, algorandPath: x.path })
  }
  for (const x of closedFiles(c.stellarPath)) {
    const w = readable(() => loadStellarWallet(x.path))
    if (w) at(x.stamp).stellar = w
  }
  return [...sets, ...[...closed.values()].sort((a, b) => Number(a.stamp) - Number(b.stamp))]
}

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
    const name = s.stamp ? `Wallets moved aside on ${new Date(Number(s.stamp)).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'The current wallets'
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
