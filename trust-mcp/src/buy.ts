/**
 * `buy`: one command that turns whatever XLM the user sends into a budget for checks.
 *
 *   1. The XLM becomes ALGO (network fees) and USDC on Algorand (bridge.ts, runIn). XLM that
 *      arrives later is exchanged too (runTopUp).
 *   2. The ALGO above what the wallet must keep to hold USDC becomes USDC as well
 *      (runAlgoToUsdc), so the whole amount sent can pay for checks.
 *   3. Then it stops. Nothing here chooses what to check or spends anything: the USDC waits in
 *      the wallet until the agent spends it through check_before_pay, which pays only for checks
 *      it does not already know (checks.ts), or until `refund` sends it back (refund.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { exchangeUnderway, loadState, runAlgoToUsdc, runIn, runTopUp, type Ctx } from './bridge.js'
import { LABELS, loadLedger, spentBy, type Tool } from './checks.js'
import type { StellarWalletFile } from './stellar.js'
import { DEFAULT_ALGOD, readStatus, type WalletFile } from './wallet.js'

/** A check the spending loop of 0.4.4 and earlier bought. Read only, for the totals. */
type LegacyPurchase = { tool: Tool; usd: number; subject: string | string[]; status: string; answer?: string; receipt?: string }

export type BuyState = {
  version: 1
  worker?: { pid: number; startedAt: string }
  /** Which round of buying this is; each `buy` after a funded one starts the next. */
  round?: number
  roundStartedAt?: string
  /** Set when a round starts on wallets that were already funded: it waits for new XLM. */
  waitForXlm?: boolean
  /** When all the XLM of this round had become USDC. */
  funded?: string
  stopped?: string
  /** 0.4.4: what `funded` was called then. */
  finished?: string
  /** 0.4.4: the checks its spending loop bought. */
  purchases?: LegacyPurchase[]
}

export function buyStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.A_IDENTITY_BUY_STATE?.trim() || join(homedir(), '.a-identity', 'buy-state.json')
}

export function loadBuy(path: string): BuyState {
  if (!existsSync(path)) return { version: 1 }
  const s = JSON.parse(readFileSync(path, 'utf8')) as BuyState
  if (s.finished && !s.funded) s.funded = s.finished
  delete s.finished
  return s
}

export function saveBuy(path: string, s: BuyState) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
}

export type BuyCtx = Ctx & { buyPath: string; baseUrl?: string }

const usd = (n: number) => String(Number(n.toFixed(6)))

/**
 * Advances the exchange as far as it can: XLM in, any later XLM, the spare ALGO into USDC.
 * 'done' once all of it is USDC waiting in the wallet; call again on 'waiting'.
 */
export async function advanceBuy(ctx: BuyCtx, maxWaitMs = 60_000): Promise<'waiting' | 'done'> {
  if (loadBuy(ctx.buyPath).funded) return 'done'
  // Once the way in is done there is nothing for runIn to say; calling it would only log noise.
  if (!loadState(ctx.statePath).fundIn.done && !(await runIn(ctx, maxWaitMs))) return 'waiting'
  for (;;) {
    const t = await runTopUp(ctx, maxWaitMs)
    if (t === 'waiting') return 'waiting'
    if (t === 'none') break
    const st = loadBuy(ctx.buyPath)
    if (st.waitForXlm) {
      delete st.waitForXlm
      saveBuy(ctx.buyPath, st)
    }
  }
  if (loadBuy(ctx.buyPath).waitForXlm) return 'waiting'
  if ((await runAlgoToUsdc(ctx, maxWaitMs)) === 'waiting') return 'waiting'
  const st = loadBuy(ctx.buyPath)
  st.funded = new Date((ctx.now ?? Date.now)()).toISOString()
  saveBuy(ctx.buyPath, st)
  const w = await readStatus(ctx.algorand.address, ctx.algod ?? DEFAULT_ALGOD, ctx.fetchImpl ?? fetch)
  ctx.out(`All of it is exchanged: ${w.usdc} USDC is in the wallet for checks. Nothing is spent until your agent asks for a check it does not already have.`)
  return 'done'
}

export type StatusCtx = {
  algorand: WalletFile
  stellar: StellarWalletFile | null
  statePath: string
  buyPath: string
  ledgerPath: string
  algod?: string
  fetchImpl?: Ctx['fetchImpl']
}

/**
 * Where things stand, in plain words, from the state files, the checks ledger and the ledger
 * of the chain. The first line is always `Status: Running|Idle|Finished | Spent: .. | Left: ..`.
 */
export async function statusLines(ctx: StatusCtx, workerAlive: boolean): Promise<string[]> {
  const st = loadBuy(ctx.buyPath)
  const br = loadState(ctx.statePath)
  const w = await readStatus(ctx.algorand.address, ctx.algod ?? DEFAULT_ALGOD, ctx.fetchImpl ?? fetch).catch(() => null)
  const spent = spentBy(loadLedger(ctx.ledgerPath), ctx.algorand.address)
  const legacy = (st.purchases ?? []).filter((p) => p.status === 'paid')
  const spentUsd = spent.usd + legacy.reduce((n, p) => n + p.usd, 0)
  const count = spent.count + legacy.length
  const left = w?.usdc ?? 0
  const exchanging = exchangeUnderway(br)
  const refunding = Boolean(br.back && !br.back.done)

  const state = workerAlive || refunding ? 'Running' : br.back?.done || (st.funded && left < 1 && !exchanging) ? 'Finished' : 'Idle'
  const lines = [`Status: ${state} | Spent: ${usd(spentUsd)} USDC (${count} ${count === 1 ? 'check' : 'checks'}) | Left: ${usd(left)} USDC`]

  const where = ctx.stellar ? ` at ${ctx.stellar.address}` : ''
  if (st.stopped) lines.push(`Stopped: ${st.stopped}`)
  else if (refunding) lines.push(`Sending what is left back to ${br.back!.to}. Run the refund command again to keep going.`)
  else if (br.back?.done) lines.push(`Refunded: everything that could go back was sent to ${br.back.to}.`)
  else if (!workerAlive && st.round && !st.funded) lines.push('Paused (the computer restarted or the work was stopped). Run the buy command again to continue.')
  else if (br.fundIn.topUps?.some((r) => !r.settled)) lines.push('Your XLM arrived. Exchanging it for USDC on Algorand (a few minutes).')
  else if (br.fundIn.algoToUsdc && !br.fundIn.algoToUsdc.settled) lines.push('Exchanging the ALGO left over for USDC, so all of it can pay for checks (a few minutes).')
  else if (st.waitForXlm) lines.push(`Waiting for your XLM${where}.`)
  else if (st.funded || (!st.round && w?.usdcOptedIn)) {
    lines.push(
      left >= 1
        ? 'Ready: the USDC waits in the wallet. Your agent spends it with check_before_pay, only on checks it does not already have.'
        : 'Spent: less than 1 USDC is left, under the price of the cheapest check.',
    )
  } else if (br.fundIn.usdc) lines.push('Your XLM arrived. Exchanging it for USDC on Algorand (a few minutes).')
  else if (br.fundIn.algo) lines.push('Your XLM arrived. Exchanging a small part of it for ALGO, for the network fees (a few minutes).')
  else lines.push(`Waiting for your XLM${where}.`)

  let n = 0
  for (const p of legacy) {
    lines.push(`${++n}. ${LABELS[p.tool]} (${Array.isArray(p.subject) ? `${p.subject.length} agents` : p.subject}): ${p.answer ?? ''}  [${p.usd} USDC, bought by 0.4.4]`)
    if (p.receipt) lines.push(`   Receipt: https://allo.info/tx/${p.receipt}`)
  }
  for (const e of spent.entries) {
    lines.push(`${++n}. ${LABELS[e.tool]} (${e.target}): ${e.line ?? ''}  [${usd(e.usd ?? 0)} USDC]`)
    if (e.receipt) lines.push(`   Receipt: https://allo.info/tx/${e.receipt}`)
  }
  if (w?.exists) lines.push(`In the Algorand wallet: ${w.usdc} USDC and ${w.algo} ALGO.`)
  if (spent.count) lines.push(`Full answers: ${ctx.ledgerPath}`)
  return lines
}
