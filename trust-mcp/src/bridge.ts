/**
 * From XLM to paid checks, and back, with one deposit from the user.
 *
 *   in:   the user sends XLM once to a one-time Stellar wallet. Then, with no further input:
 *         XLM -> ALGO (SideShift) to the one-time Algorand wallet, which opts in to USDC, then
 *         the rest of the XLM -> USDC on Algorand (SideShift). The wallet can now pay.
 *   back: the Stellar wallet is merged into the user's own Stellar address, USDC left on
 *         Algorand -> XLM and the ALGO -> XLM (SideShift), both settled to that address.
 *
 * SideShift has minimums (about 14 XLM in, about 25 ALGO or 3 USDC back), so the ALGO leg is
 * sized to clear the way-back minimum, and USDC left under 3 cannot go back and is reported.
 *
 * Every step is written to a state file BEFORE anything is sent, with the transaction id or
 * hash computed ahead of submitting, so a run that is interrupted resumes by checking what
 * landed instead of paying twice. Each call advances as far as it can within `maxWaitMs`, then
 * says what it is waiting for; calling it again continues.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FetchLike } from '@a-identity/trust-guard'
import { createShift, pair, shiftStatus, type Coin } from './sideshift.js'
import { buildXlmPayment, HORIZON, isStellarAddress, readXlm, STELLAR_KEEP_XLM, stellarTxLanded, submitStellar, type StellarWalletFile } from './stellar.js'
import { algorandTxLanded, buildTransfer, DEFAULT_ALGOD, optIn, params, readStatus, submit, usdcCreator, type WalletFile } from './wallet.js'

/** ALGO to land: enough to hold USDC and pay fees, and enough to clear SideShift's minimum on the way back. */
export const TARGET_ALGO = 26.5
/** One address check, and a little over for the exchange's spread. */
export const USDC_FOR_ONE_CHECK = 5.1

type ShiftRec = { id: string; depositAddress: string; depositMemo: string | null; amount: string; tx?: string; sent?: boolean; settled?: boolean; settleHash?: string | null }
export type BridgeState = {
  version: 1
  fundIn: { algo?: ShiftRec; usdc?: ShiftRec; done?: boolean; topUps?: ShiftRec[] }
  back?: { to: string; merge?: { hash?: string; done?: boolean }; usdc?: ShiftRec; algo?: ShiftRec; usdcLeft?: number; done?: boolean }
}

export type Ctx = {
  algorand: WalletFile
  stellar: StellarWalletFile
  statePath: string
  algod?: string
  horizon?: string
  fetchImpl?: FetchLike
  out: (line: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export function bridgeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.A_IDENTITY_BRIDGE_STATE?.trim() || join(homedir(), '.a-identity', 'bridge-state.json')
}

export function loadState(path: string): BridgeState {
  if (!existsSync(path)) return { version: 1, fundIn: {} }
  return JSON.parse(readFileSync(path, 'utf8')) as BridgeState
}

function saveState(path: string, s: BridgeState) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
}

const round7 = (n: number) => (Math.floor(n * 1e7) / 1e7).toFixed(7)

/** How much XLM to send in, from live SideShift rates. */
export function planIn(algoPair: { min: number; rate: number }, usdcPair: { min: number; rate: number }, checks = 1) {
  const algoXlm = Math.max(algoPair.min * 1.02, TARGET_ALGO / algoPair.rate)
  const usdcXlm = Math.max(usdcPair.min * 1.02, (USDC_FOR_ONE_CHECK * checks) / usdcPair.rate)
  return { algoXlm, usdcXlm, totalXlm: Math.ceil(algoXlm + usdcXlm + STELLAR_KEEP_XLM + 1), perExtraCheckXlm: Math.ceil(5 / usdcPair.rate) }
}

async function waitFor<T>(ctx: Ctx, deadline: number, probe: () => Promise<T | null>): Promise<T | null> {
  const now = ctx.now ?? Date.now
  const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  for (;;) {
    const v = await probe()
    if (v !== null) return v
    if (now() + 10_000 > deadline) return null
    await sleep(10_000)
  }
}

/** Send XLM from the Stellar wallet into a shift, once. */
async function sendXlmOnce(ctx: Ctx, st: BridgeState, rec: ShiftRec) {
  const horizon = ctx.horizon ?? HORIZON
  const f = ctx.fetchImpl ?? fetch
  if (rec.sent) return
  if (rec.tx && (await stellarTxLanded(rec.tx, horizon, f))) {
    rec.sent = true
    saveState(ctx.statePath, st)
    return
  }
  const acct = await readXlm(ctx.stellar.address, horizon, f)
  if (!acct.sequence) throw new Error('The Stellar wallet does not exist on the ledger yet.')
  const { hash, xdr } = buildXlmPayment(ctx.stellar, acct.sequence, { kind: 'pay', to: rec.depositAddress, amountXlm: rec.amount, memo: rec.depositMemo })
  rec.tx = hash
  saveState(ctx.statePath, st)
  await submitStellar(xdr, horizon, f)
  rec.sent = true
  saveState(ctx.statePath, st)
}

/** Send ALGO or USDC from the Algorand wallet into a shift, once. */
async function sendAlgorandOnce(ctx: Ctx, st: BridgeState, rec: ShiftRec, a: { asset: 'algo' | 'usdc'; micro: number; close: boolean }) {
  const algod = ctx.algod ?? DEFAULT_ALGOD
  const f = ctx.fetchImpl ?? fetch
  if (rec.sent) return
  if (rec.tx && (await algorandTxLanded(rec.tx, algod, f))) {
    rec.sent = true
    saveState(ctx.statePath, st)
    return
  }
  const { txId, signed } = buildTransfer(ctx.algorand, { asset: a.asset, to: rec.depositAddress, micro: a.micro, close: a.close }, await params(algod, f))
  rec.tx = txId
  saveState(ctx.statePath, st)
  await submit(algod, f, [signed])
  rec.sent = true
  saveState(ctx.statePath, st)
}

/** Waits for a shift to settle; throws if it ended any other way. */
async function settled(ctx: Ctx, st: BridgeState, rec: ShiftRec, label: string, deadline: number): Promise<boolean> {
  if (rec.settled) return true
  const f = ctx.fetchImpl ?? fetch
  const s = await waitFor(ctx, deadline, async () => {
    const x = await shiftStatus(rec.id, f)
    if (x.status === 'settled') return x
    if (['refund', 'refunding', 'refunded', 'expired'].includes(x.status)) {
      throw new Error(`The ${label} exchange ended as "${x.status}" (SideShift shift ${rec.id}). Its deposit is returned to the wallet it came from.`)
    }
    return null
  })
  if (!s) {
    ctx.out(`Waiting for the ${label} exchange (SideShift shift ${rec.id}). Run the same command again to keep going.`)
    return false
  }
  rec.settled = true
  rec.settleHash = s.settleHash
  saveState(ctx.statePath, st)
  ctx.out(`The ${label} exchange is done${s.settleAmount !== null ? `: ${s.settleAmount} received` : ''}.`)
  return true
}

/** Advance the way in. Returns true once the Algorand wallet holds USDC and can pay. */
export async function runIn(ctx: Ctx, maxWaitMs = 80_000): Promise<boolean> {
  const f = ctx.fetchImpl ?? fetch
  const horizon = ctx.horizon ?? HORIZON
  const algod = ctx.algod ?? DEFAULT_ALGOD
  const deadline = (ctx.now ?? Date.now)() + maxWaitMs
  const st = loadState(ctx.statePath)
  if (st.fundIn.done) {
    const s = await readStatus(ctx.algorand.address, algod, f)
    ctx.out(`Ready: the Algorand wallet holds ${s.usdc} USDC.`)
    return true
  }

  const [algoPair, usdcPair] = await Promise.all([pair('xlm-stellar', 'algo-algorand', f), pair('xlm-stellar', 'usdc-algorand', f)])
  const plan = planIn(algoPair, usdcPair)

  // 1. XLM in, and the ALGO leg.
  if (!st.fundIn.algo) {
    const xlm = await waitFor(ctx, deadline, async () => {
      const a = await readXlm(ctx.stellar.address, horizon, f)
      return a.xlm >= plan.totalXlm ? a.xlm : null
    })
    if (xlm === null) {
      ctx.out(`Waiting for XLM. Send at least ${plan.totalXlm} XLM to ${ctx.stellar.address} (each extra ${plan.perExtraCheckXlm} XLM is about one more 5 USDC check). Run the same command again to keep going.`)
      return false
    }
    const shift = await createShift({ from: 'xlm-stellar', to: 'algo-algorand', settleAddress: ctx.algorand.address, refundAddress: ctx.stellar.address }, f)
    st.fundIn.algo = { id: shift.id, depositAddress: shift.depositAddress, depositMemo: shift.depositMemo, amount: round7(plan.algoXlm) }
    saveState(ctx.statePath, st)
    ctx.out(`${xlm} XLM arrived. Exchanging ${st.fundIn.algo.amount} XLM for ALGO.`)
  }
  await sendXlmOnce(ctx, st, st.fundIn.algo)
  if (!(await settled(ctx, st, st.fundIn.algo, 'XLM to ALGO', deadline))) return false

  // 2. Let the wallet hold USDC.
  const before = await readStatus(ctx.algorand.address, algod, f)
  if (!before.usdcOptedIn) {
    const landed = await waitFor(ctx, deadline, async () => ((await readStatus(ctx.algorand.address, algod, f)).algo >= 0.202 ? true : null))
    if (!landed) {
      ctx.out('The ALGO is on its way to the Algorand wallet. Run the same command again to keep going.')
      return false
    }
    await optIn(ctx.algorand, algod, f)
    ctx.out('The Algorand wallet can now hold USDC.')
  }

  // 3. The rest of the XLM, less what the Stellar wallet must keep, into USDC.
  if (!st.fundIn.usdc) {
    const a = await readXlm(ctx.stellar.address, horizon, f)
    const spend = a.xlm - STELLAR_KEEP_XLM
    if (spend < usdcPair.min * 1.02) {
      ctx.out(`Only ${a.xlm} XLM is left, under the ${Math.ceil(usdcPair.min * 1.02 + STELLAR_KEEP_XLM)} XLM needed to buy USDC. Send more XLM to ${ctx.stellar.address}, then run the same command again.`)
      return false
    }
    const shift = await createShift({ from: 'xlm-stellar', to: 'usdc-algorand', settleAddress: ctx.algorand.address, refundAddress: ctx.stellar.address }, f)
    st.fundIn.usdc = { id: shift.id, depositAddress: shift.depositAddress, depositMemo: shift.depositMemo, amount: round7(spend) }
    saveState(ctx.statePath, st)
    ctx.out(`Exchanging ${st.fundIn.usdc.amount} XLM for USDC on Algorand.`)
  }
  await sendXlmOnce(ctx, st, st.fundIn.usdc)
  if (!(await settled(ctx, st, st.fundIn.usdc, 'XLM to USDC', deadline))) return false

  st.fundIn.done = true
  saveState(ctx.statePath, st)
  const s = await readStatus(ctx.algorand.address, algod, f)
  ctx.out(`Ready: the Algorand wallet holds ${s.usdc} USDC, enough for ${Math.floor(s.usdc / 5)} address check(s) at 5 USDC.`)
  return true
}

/**
 * XLM that arrives after the way in finished (a second deposit) goes into USDC too, so every
 * XLM sent is spent. 'none' when there is nothing to exchange, 'settled' when a top-up landed.
 */
export async function runTopUp(ctx: Ctx, maxWaitMs = 80_000): Promise<'none' | 'waiting' | 'settled'> {
  const f = ctx.fetchImpl ?? fetch
  const horizon = ctx.horizon ?? HORIZON
  const deadline = (ctx.now ?? Date.now)() + maxWaitMs
  const st = loadState(ctx.statePath)
  if (!st.fundIn.done || st.back) return 'none'
  const topUps = (st.fundIn.topUps = st.fundIn.topUps ?? [])
  let rec = topUps.find((r) => !r.settled)
  if (!rec) {
    const a = await readXlm(ctx.stellar.address, horizon, f)
    const spend = a.xlm - STELLAR_KEEP_XLM
    // Under SideShift's minimum there is nothing to do; its pair is read only when it might pass.
    if (spend < 10) return 'none'
    const usdcPair = await pair('xlm-stellar', 'usdc-algorand', f)
    if (spend < usdcPair.min * 1.02) return 'none'
    const shift = await createShift({ from: 'xlm-stellar', to: 'usdc-algorand', settleAddress: ctx.algorand.address, refundAddress: ctx.stellar.address }, f)
    rec = { id: shift.id, depositAddress: shift.depositAddress, depositMemo: shift.depositMemo, amount: round7(spend) }
    topUps.push(rec)
    saveState(ctx.statePath, st)
    ctx.out(`More XLM arrived. Exchanging ${rec.amount} XLM for USDC on Algorand.`)
  }
  await sendXlmOnce(ctx, st, rec)
  return (await settled(ctx, st, rec, 'XLM to USDC', deadline)) ? 'settled' : 'waiting'
}

/** Advance the way back to `to`, the user's own Stellar address. Returns true when done. */
export async function runBack(ctx: Ctx, to: string, maxWaitMs = 80_000): Promise<boolean> {
  const f = ctx.fetchImpl ?? fetch
  const horizon = ctx.horizon ?? HORIZON
  const algod = ctx.algod ?? DEFAULT_ALGOD
  const deadline = (ctx.now ?? Date.now)() + maxWaitMs
  if (!isStellarAddress(to)) throw new Error(`${to} is not a Stellar address (it starts with G and is 56 characters).`)
  if (to === ctx.stellar.address) throw new Error('Name your own Stellar address, not the one-time wallet.')
  const st = loadState(ctx.statePath)
  if (st.back && st.back.to !== to) throw new Error(`A return to ${st.back.to} is already under way; finish it with that address.`)
  st.back = st.back ?? { to }
  if (st.back.done) {
    ctx.out(`Already returned to ${to}.`)
    return true
  }
  const dest = await readXlm(to, horizon, f)
  if (!dest.exists) throw new Error(`${to} does not exist on Stellar yet. Use an address that already holds XLM.`)

  // 1. The Stellar wallet: merge it, which sends every XLM it holds, reserve included.
  st.back.merge = st.back.merge ?? {}
  if (!st.back.merge.done) {
    const me = await readXlm(ctx.stellar.address, horizon, f)
    if (st.back.merge.hash && (await stellarTxLanded(st.back.merge.hash, horizon, f))) st.back.merge.done = true
    else if (!me.exists) st.back.merge.done = true
    else {
      const { hash, xdr } = buildXlmPayment(ctx.stellar, me.sequence!, { kind: 'merge', to })
      st.back.merge.hash = hash
      saveState(ctx.statePath, st)
      await submitStellar(xdr, horizon, f)
      st.back.merge.done = true
      ctx.out(`Sent the Stellar wallet's ${me.xlm} XLM back to ${to}.`)
    }
    saveState(ctx.statePath, st)
  }

  // 2. USDC on Algorand, if SideShift will take it.
  const s = await readStatus(ctx.algorand.address, algod, f)
  if (s.usdcOptedIn && s.usdc > 0 && !st.back.usdc && st.back.usdcLeft === undefined) {
    const p = await pair('usdc-algorand', 'xlm-stellar', f)
    if (s.usdc >= p.min * 1.01) {
      const shift = await createShift({ from: 'usdc-algorand', to: 'xlm-stellar', settleAddress: to, refundAddress: ctx.algorand.address }, f)
      st.back.usdc = { id: shift.id, depositAddress: shift.depositAddress, depositMemo: shift.depositMemo, amount: String(s.usdc) }
    } else {
      st.back.usdcLeft = s.usdc
    }
    saveState(ctx.statePath, st)
  }
  if (st.back.usdc) await sendAlgorandOnce(ctx, st, st.back.usdc, { asset: 'usdc', micro: 0, close: true })

  // An empty USDC holding still blocks closing the account; close it to the asset's creator.
  if (!st.back.algo && st.back.usdcLeft === undefined && !st.back.usdc) {
    const h = await readStatus(ctx.algorand.address, algod, f)
    if (h.usdcOptedIn && h.usdc === 0) {
      const { signed } = buildTransfer(ctx.algorand, { asset: 'usdc', to: await usdcCreator(algod, f), micro: 0, close: true }, await params(algod, f))
      await submit(algod, f, [signed])
    }
  }

  // 3. ALGO: everything if the USDC holding is closed, otherwise all but the reserve it needs.
  if (!st.back.algo) {
    const now = await readStatus(ctx.algorand.address, algod, f)
    const holdingUsdc = now.usdcOptedIn && (st.back.usdcLeft ?? 0) > 0
    const sendable = holdingUsdc ? now.algo - now.minBalanceAlgo - 0.002 : now.algo - 0.002
    const p = await pair('algo-algorand', 'xlm-stellar', f)
    if (!now.exists || sendable < p.min * 1.01) {
      ctx.out(`The Algorand wallet's ${now.algo} ALGO is under SideShift's ${p.min} ALGO minimum, so it stays in the wallet.`)
    } else {
      const shift = await createShift({ from: 'algo-algorand', to: 'xlm-stellar', settleAddress: to, refundAddress: ctx.algorand.address }, f)
      st.back.algo = { id: shift.id, depositAddress: shift.depositAddress, depositMemo: shift.depositMemo, amount: holdingUsdc ? String(sendable) : 'all' }
      saveState(ctx.statePath, st)
    }
  }
  if (st.back.algo) {
    const close = st.back.algo.amount === 'all'
    await sendAlgorandOnce(ctx, st, st.back.algo, { asset: 'algo', micro: close ? 0 : Math.floor(Number(st.back.algo.amount) * 1e6), close })
  }

  // 4. Both exchanges settle to the user's address.
  if (st.back.usdc && !(await settled(ctx, st, st.back.usdc, 'USDC to XLM', deadline))) return false
  if (st.back.algo && !(await settled(ctx, st, st.back.algo, 'ALGO to XLM', deadline))) return false

  st.back.done = true
  saveState(ctx.statePath, st)
  if (st.back.usdcLeft) {
    ctx.out(`${st.back.usdcLeft} USDC was under SideShift's minimum and stays in the Algorand wallet ${ctx.algorand.address}; it still pays for a 1 or 2 USDC agent check.`)
  }
  ctx.out(`Done. Everything that could go back was sent to ${to} as XLM.`)
  return true
}

/** After a finished return, move the key files out of the way so a new session starts clean. */
export function retireFiles(paths: string[], stamp = Date.now()) {
  for (const p of paths) if (existsSync(p)) renameSync(p, p.replace(/\.json$/, '') + `.closed-${stamp}.json`)
}

export type { Coin }
