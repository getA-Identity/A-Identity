/**
 * `buy`: one command that turns whatever XLM the user sends into A-Identity checks, all of it.
 *
 *   1. The XLM becomes ALGO (network fees) and USDC on Algorand (bridge.ts, runIn).
 *   2. The USDC is spent on a fixed list of checks, in order, round after round, until what is
 *      left cannot pay for the cheapest one. XLM that arrives later is exchanged and spent too.
 *   3. With a return address, what is left goes back to it as XLM (bridge.ts, runBack).
 *
 * Every paid check is written to a state file before it is paid, and the id of its payment is
 * written the moment it is signed, before it is sent. A run that stops halfway resumes by
 * asking the ledger whether that payment landed, so nothing is paid twice.
 *
 * The prices here are the ones each check is bought at: each is also the spending cap for that
 * one call, so a check whose price went up is refused before anything is signed, and skipped.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import * as algosdk from 'algosdk'
import { TrustGuard, TrustOracleError } from '@a-identity/trust-guard'
import { algorandPayer, SpendCapError } from '@a-identity/trust-guard/algorand'
import { loadState, runBack, runIn, runTopUp, type Ctx } from './bridge.js'
import { algorandTxLanded, DEFAULT_ALGOD, readStatus } from './wallet.js'
import { DEFAULT_BASE_URL } from './server.js'

export type Tool = 'pay_check' | 'agent_passport' | 'risk_check' | 'reputation_score' | 'verify_agent' | 'agent_batch_audit'
export type Item = { tool: Tool; usd: number; subject: string | string[]; deal?: number }

/** Sellers that take USDC on Algorand through the x402 facilitator: addresses a buyer is really asked to pay. */
export const SELLERS = [
  'onestepchess.xyz',
  'proofmint.app',
  '2NBCPOTMFPE2IHA4RDANQDGIRPC2CQ3YVVB5F5W3EYSHTYRUN4EKT4NMLE',
  'QSNLPPXO64ONBD76E2DLZW6XER5GUV4YPQYHDFJUO2N3IO4RYBL5HRU6EY',
  'G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4',
  'FL7U7GHUZB2R6RACPGY5UFD2K47CP2IL4RQWX7LKYE5QSFGXVJCDGPRLBE',
  'R3CUFK5EMFJSHV5TEXMBJOCASYHORZ2F7QCPPVCRWRWVDL5WNLSDOIEHBU',
  'C7IIHG7SPLPZ5H7ZT6HW3UV2OQMQQE6Y2HBNGZXSLRJULE42BEE2OY2XIE',
]
/** AI agents with a public identity, on different chains. */
export const AGENTS = ['#0', 'eip155:8453:8004/73232', '849980', 'eip155:196:8004/6271']
const DEAL_USD = 25

/** One round buys each of the six checks at least once, for 44 USDC. `k` picks what is checked. */
const ROUND: ((k: number) => Item)[] = [
  (k) => ({ tool: 'pay_check', usd: 5, subject: SELLERS[(2 * k) % SELLERS.length] }),
  (k) => ({ tool: 'agent_passport', usd: 10, subject: AGENTS[k % AGENTS.length] }),
  (k) => ({ tool: 'risk_check', usd: 5, subject: AGENTS[(k + 1) % AGENTS.length], deal: DEAL_USD }),
  (k) => ({ tool: 'reputation_score', usd: 2, subject: AGENTS[(k + 2) % AGENTS.length] }),
  (k) => ({ tool: 'verify_agent', usd: 1, subject: AGENTS[(k + 3) % AGENTS.length] }),
  () => ({ tool: 'agent_batch_audit', usd: 4 * AGENTS.length, subject: AGENTS, deal: DEAL_USD }),
  (k) => ({ tool: 'pay_check', usd: 5, subject: SELLERS[(2 * k + 1) % SELLERS.length] }),
]
export const ROUND_USD = ROUND.reduce((sum, at) => sum + at(0).usd, 0)

export const LABELS: Record<Tool, string> = {
  pay_check: 'Is it safe to pay',
  agent_passport: 'Agent passport',
  risk_check: 'Payment decision',
  reputation_score: 'Reputation score',
  verify_agent: 'Agent check',
  agent_batch_audit: 'Group check',
}

/** Where a wallet starts in the lists, so two people buying do not check the same things. */
export function offsetFor(address: string): number {
  let h = 0
  for (const c of address) h = (h * 31 + c.charCodeAt(0)) % 1_000_003
  return h % SELLERS.length
}

export function itemAt(i: number, offset = 0): Item {
  return ROUND[i % ROUND.length](Math.floor(i / ROUND.length) + offset)
}

/** The next check at or after `cursor` that `usdc` can pay for, looking one round ahead. */
export function nextAffordable(cursor: number, usdc: number, skip: Tool[], offset = 0): { index: number; item: Item } | null {
  for (let j = 0; j < ROUND.length; j++) {
    const item = itemAt(cursor + j, offset)
    if (!skip.includes(item.tool) && item.usd <= usdc + 1e-9) return { index: cursor + j, item }
  }
  return null
}

export type Purchase = Item & {
  n: number
  index: number
  status: 'paying' | 'paid' | 'failed'
  txId?: string
  lastValid?: number
  signedAt?: number
  answer?: string
  receipt?: string
  error?: string
}
export type BuyState = {
  version: 1
  returnTo?: string
  cursor: number
  skip: Tool[]
  purchases: Purchase[]
  /** Payments signed but never landed since the last check that was paid; three in a row stop the run. */
  refusals?: number
  worker?: { pid: number; startedAt: string }
  /** Which round of buying this is; each `buy` after a finished one starts the next. */
  round?: number
  /** Set when a round starts on wallets that were already funded: it waits for new XLM. */
  waitForXlm?: boolean
  finished?: string
  stopped?: string
}

export function buyStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.A_IDENTITY_BUY_STATE?.trim() || join(homedir(), '.a-identity', 'buy-state.json')
}

export function loadBuy(path: string): BuyState {
  if (!existsSync(path)) return { version: 1, cursor: 0, skip: [], purchases: [] }
  return JSON.parse(readFileSync(path, 'utf8')) as BuyState
}

export function saveBuy(path: string, s: BuyState) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
}

export type BuyCtx = Ctx & { buyPath: string; baseUrl?: string }

/** The id and last valid round of the USDC payment inside a PAYMENT-SIGNATURE header. */
export function signedPayment(header: string): { txId: string; lastValid: number } {
  const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { payload: { paymentGroup: string[]; paymentIndex: number } }
  const { paymentGroup, paymentIndex } = payload.payload
  const txn = algosdk.decodeSignedTransaction(Buffer.from(paymentGroup[paymentIndex], 'base64')).txn
  return { txId: txn.txID(), lastValid: Number(txn.lastValid) }
}

const text = (v: unknown) => (typeof v === 'string' ? v : '')

/** One line a person reads, from a paid answer. */
export function oneLine(tool: Tool, r: Record<string, unknown>): string {
  if (tool === 'pay_check') {
    const why = (r.reasons as { text?: string }[] | undefined)?.[0]?.text
    return `${text(r.headline) || text(r.verdict)}${why ? `. ${why}` : ''}`
  }
  if (tool === 'risk_check') {
    const why = (r.reasons as string[] | undefined)?.[0]
    return `${text(r.decision)}${why ? `: ${why}` : ''}`
  }
  if (tool === 'reputation_score') return `${String(r.score ?? '?')} out of 1000`
  if (tool === 'verify_agent') return `${r.verified ? 'Verified' : 'Not verified'}${r.revoked ? ', revoked' : ''}${r.kya_status ? `, KYA ${String(r.kya_status)}` : ''}`
  if (tool === 'agent_passport') {
    const rep = r.reputation as { score?: number } | undefined
    const risk = r.risk as { decision?: string } | undefined
    return `${r.verified ? 'Verified' : 'Not verified'}, reputation ${String(rep?.score ?? '?')}, decision ${String(risk?.decision ?? '?')}`
  }
  const s = (r.summary ?? {}) as Record<string, number>
  return `${String(r.count ?? '?')} agents: ${s.ALLOW ?? 0} allow, ${s.WARN ?? 0} warn, ${s.DENY ?? 0} deny`
}

export const subjectText = (p: Item) => (Array.isArray(p.subject) ? `${p.subject.length} agents` : p.subject)

async function buyOne(ctx: BuyCtx, p: Purchase, onSigned: (txId: string, lastValid: number) => void): Promise<Record<string, unknown>> {
  const f = ctx.fetchImpl ?? fetch
  const pay = algorandPayer({ mnemonic: ctx.algorand.mnemonic, maxUsdPerCall: p.usd, algodUrl: ctx.algod ?? DEFAULT_ALGOD, fetch: f })
  const oracle = new TrustGuard({
    rail: 'algorand',
    baseUrl: ctx.baseUrl ?? DEFAULT_BASE_URL,
    fetch: f,
    onPaymentRequired: async (challenge, info) => {
      const headers = await pay(challenge, info)
      const sig = headers?.['PAYMENT-SIGNATURE']
      if (sig) {
        const { txId, lastValid } = signedPayment(sig)
        onSigned(txId, lastValid)
      }
      return headers
    },
  })
  const one = typeof p.subject === 'string' ? p.subject : ''
  const deal = p.deal === undefined ? undefined : { amountUsd: p.deal }
  switch (p.tool) {
    case 'pay_check':
      return oracle.payCheck(one)
    case 'agent_passport':
      return oracle.passport(one)
    case 'risk_check':
      return (await oracle.riskCheck(one, deal)) as unknown as Record<string, unknown>
    case 'reputation_score':
      return oracle.reputation(one)
    case 'verify_agent':
      return oracle.verify(one)
    case 'agent_batch_audit':
      return (await oracle.batchAudit(p.subject as string[], deal)) as unknown as Record<string, unknown>
  }
}

/** How long a signed payment that never landed is waited for before the check is bought again. */
const LANDING_GRACE_MS = 90_000
const MAX_REFUSALS = 3

/** A check left mid-payment by a run that stopped: did its payment land? */
async function resolveInFlight(ctx: BuyCtx, p: Purchase): Promise<'paid' | 'retry' | 'wait'> {
  if (!p.txId) return 'retry'
  const f = ctx.fetchImpl ?? fetch
  if (await algorandTxLanded(p.txId, ctx.algod ?? DEFAULT_ALGOD, f)) return 'paid'
  const now = (ctx.now ?? Date.now)()
  return now - (p.signedAt ?? 0) >= LANDING_GRACE_MS ? 'retry' : 'wait'
}

/** Spends the USDC on checks until the cheapest one no longer fits. */
async function spend(ctx: BuyCtx): Promise<'waiting' | 'spent'> {
  const f = ctx.fetchImpl ?? fetch
  const algod = ctx.algod ?? DEFAULT_ALGOD
  const now = ctx.now ?? Date.now
  const offset = offsetFor(ctx.algorand.address)
  const answers = join(dirname(ctx.buyPath), 'answers')
  for (;;) {
    const st = loadBuy(ctx.buyPath)
    const last = st.purchases.at(-1)
    if (last?.status === 'paying') {
      const r = await resolveInFlight(ctx, last)
      if (r === 'wait') return 'waiting'
      if (r === 'paid') {
        last.status = 'paid'
        last.answer = 'Paid. The answer was lost when the run stopped; the receipt is on the ledger.'
        last.receipt = last.txId
        st.cursor = last.index + 1
        ctx.out(`${last.n}. ${LABELS[last.tool]} (${subjectText(last)}): paid ${last.usd} USDC before the run stopped.`)
      } else {
        st.purchases.pop()
        if (last.txId) st.refusals = (st.refusals ?? 0) + 1
      }
      saveBuy(ctx.buyPath, st)
      continue
    }
    if ((st.refusals ?? 0) >= MAX_REFUSALS) {
      throw new Error(`A payment was signed and never went through ${MAX_REFUSALS} times in a row, so buying stopped. Nothing was charged for those.`)
    }
    // Every check of a whole round refused in a row: something is wrong on the other side.
    let refusedInARow = 0
    while (refusedInARow < st.purchases.length && st.purchases[st.purchases.length - 1 - refusedInARow].status === 'failed') refusedInARow++
    if (refusedInARow >= ROUND.length) throw new Error('The oracle refused every check in a row, so buying stopped. Nothing was charged for those.')

    const w = await readStatus(ctx.algorand.address, algod, f)
    const next = nextAffordable(st.cursor, w.usdc, st.skip, offset)
    if (!next) return 'spent'
    const p: Purchase = { ...next.item, n: st.purchases.filter((x) => x.status === 'paid').length + 1, index: next.index, status: 'paying' }
    st.purchases.push(p)
    saveBuy(ctx.buyPath, st)
    try {
      const r = await buyOne(ctx, p, (txId, lastValid) => {
        p.txId = txId
        p.lastValid = lastValid
        p.signedAt = now()
        saveBuy(ctx.buyPath, st)
      })
      p.status = 'paid'
      st.refusals = 0
      p.answer = oneLine(p.tool, r)
      p.receipt = (r.settlement as { transaction?: string } | undefined)?.transaction ?? p.txId
      st.cursor = p.index + 1
      mkdirSync(answers, { recursive: true, mode: 0o700 })
      writeFileSync(join(answers, `${String(p.n).padStart(2, '0')}-${p.tool}.json`), JSON.stringify(r, null, 2) + '\n', { mode: 0o600 })
      saveBuy(ctx.buyPath, st)
      ctx.out(`${p.n}. ${LABELS[p.tool]} (${subjectText(p)}): ${p.answer}  [${p.usd} USDC]`)
    } catch (e) {
      // Signed: whether it was paid is for the ledger to say, on the next pass.
      if (p.txId) throw e
      const msg = e instanceof Error ? e.message : String(e)
      if (e instanceof SpendCapError || (e instanceof TrustOracleError && e.status >= 400 && e.status < 500)) {
        // Nothing was signed, and trying again will not change the answer: skip it. A server
        // error (5xx) is not an answer, so that check is tried again later instead.
        p.status = 'failed'
        p.error = msg
        st.cursor = p.index + 1
        if (e instanceof SpendCapError) st.skip.push(p.tool)
        saveBuy(ctx.buyPath, st)
        ctx.out(`Skipped ${LABELS[p.tool]} (${subjectText(p)}): ${msg}. Nothing was paid.`)
        continue
      }
      st.purchases.pop()
      saveBuy(ctx.buyPath, st)
      throw e
    }
  }
}

/**
 * Advances as far as it can: XLM in, every check it pays for, any later XLM, the way back.
 * 'done' once there is nothing left to do; call again on 'waiting'.
 */
export async function advanceBuy(ctx: BuyCtx, maxWaitMs = 60_000): Promise<'waiting' | 'done'> {
  if (loadBuy(ctx.buyPath).finished) return 'done'
  if (!(await runIn(ctx, maxWaitMs))) return 'waiting'
  for (;;) {
    if ((await spend(ctx)) === 'waiting') return 'waiting'
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
  const returnTo = loadBuy(ctx.buyPath).returnTo
  if (returnTo && !(await runBack(ctx, returnTo, maxWaitMs))) return 'waiting'
  const st = loadBuy(ctx.buyPath)
  st.finished = new Date((ctx.now ?? Date.now)()).toISOString()
  saveBuy(ctx.buyPath, st)
  for (const line of summary(st)) ctx.out(line)
  return 'done'
}

export function summary(st: BuyState): string[] {
  const paid = st.purchases.filter((p) => p.status === 'paid')
  const usd = paid.reduce((s, p) => s + p.usd, 0)
  const lines = [`Bought ${paid.length} check(s) for ${usd} USDC.`]
  for (const p of paid) {
    lines.push(`${p.n}. ${LABELS[p.tool]} (${subjectText(p)}): ${p.answer ?? ''}  [${p.usd} USDC]`)
    if (p.receipt) lines.push(`   Receipt: https://allo.info/tx/${p.receipt}`)
  }
  return lines
}

/** Where things stand, in plain words, from the state files and the two ledgers. */
export async function statusLines(ctx: BuyCtx, workerAlive: boolean): Promise<string[]> {
  const f = ctx.fetchImpl ?? fetch
  const st = loadBuy(ctx.buyPath)
  const br = loadState(ctx.statePath)
  const lines: string[] = []
  if (st.finished) lines.push('Finished.')
  else if (st.stopped) lines.push(`Stopped: ${st.stopped}`)
  else if (!workerAlive) lines.push('Paused (the computer restarted or the work was stopped). Run the buy command again to continue.')
  else if (st.waitForXlm) lines.push(`Waiting for your XLM at ${ctx.stellar.address}.`)
  else if (br.back) lines.push(`Buying is done. Sending what is left back to ${br.back.to}.`)
  else if (br.fundIn.done) lines.push('Buying checks.')
  else if (br.fundIn.usdc) lines.push('Your XLM arrived. Exchanging it for USDC on Algorand (a few minutes).')
  else if (br.fundIn.algo) lines.push('Your XLM arrived. Exchanging a small part of it for ALGO, for the network fees (a few minutes).')
  else lines.push(`Waiting for your XLM at ${ctx.stellar.address}.`)
  if (st.purchases.some((p) => p.status === 'paid')) lines.push(...summary(st))
  const w = await readStatus(ctx.algorand.address, ctx.algod ?? DEFAULT_ALGOD, f).catch(() => null)
  if (w?.exists) lines.push(`Left in the Algorand wallet: ${w.usdc} USDC and ${w.algo} ALGO.`)
  if (st.purchases.some((p) => p.status === 'paid')) lines.push(`Full answers: ${join(dirname(ctx.buyPath), 'answers')}`)
  return lines
}
