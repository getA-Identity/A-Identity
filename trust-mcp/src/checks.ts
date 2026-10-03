/**
 * The one gate every paid check goes through: the MCP tools, `check` and `ask`.
 *
 * The agent names the target and the amount it is about to pay; this module picks the checks
 * that amount calls for and pays only for the ones it does not already know. Every answer is
 * kept in a ledger on this computer (~/.a-identity/checks.json), and the same check of the same
 * target is never paid for twice within CACHE_HOURS: asking again returns the saved answer, free.
 * The rule lives here, in code, so no prompt, tool or command can get around it, and the time
 * an answer is kept can be made longer but never shorter.
 *
 * A check is written to the ledger as "paying" before anything is signed, and the id of its
 * payment the moment it is signed. A second call (in this process, in another one, or after a
 * crash) finds it and asks the ledger whether that payment landed instead of paying again; a
 * signed payment counts as possibly landing until its last valid round has passed.
 *
 * A loop guard stops the tool when checks are asked for faster than an agent paying for things
 * needs: every call in the pause that follows is refused, with the reason and when it resumes.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import * as algosdk from 'algosdk'
import { PaymentRequiredError, TrustGuard, TrustOracleError, type FetchLike, type TrustGuardOptions } from '@a-identity/trust-guard'
import { AlgorandPaymentError, algorandPayer, readAlgorandQuote, SpendCapError } from '@a-identity/trust-guard/algorand'
import { algorandTxLanded, DEFAULT_ALGOD, params, readStatus } from './wallet.js'

export type Tool = 'pay_check' | 'agent_passport' | 'risk_check' | 'reputation_score' | 'verify_agent' | 'agent_batch_audit'
export type Decision = 'ALLOW' | 'WARN' | 'DENY'
export type Tier = 'small' | 'large'

/** How long an answer is kept, in hours. A_IDENTITY_CACHE_HOURS can raise it, never lower it. */
export const CACHE_HOURS = 24
/** Above this a payment is large: the oracle's own line, above which it may DENY an agent it allows below (asp/risk.ts HIGH_VALUE_USD). */
export const LARGE_PAYMENT_USD = 100
/** The most targets one check_batch call takes. */
export const BATCH_MAX = 20
/** A check reserved but never signed is taken to be abandoned after this long. */
const UNSIGNED_GRACE_MS = 90_000
/** More than burstMax checks in burstWindowMs, or one target more than repeatMax times in repeatWindowMs, pauses every check for pauseMs. */
export const GUARD = { burstWindowMs: 60_000, burstMax: 30, repeatWindowMs: 10 * 60_000, repeatMax: 5, pauseMs: 10 * 60_000 }

export const LABELS: Record<Tool, string> = {
  pay_check: 'Is it safe to pay',
  agent_passport: 'Agent passport',
  risk_check: 'Payment decision',
  reputation_score: 'Reputation score',
  verify_agent: 'Agent check',
  agent_batch_audit: 'Group check',
}

export type Entry = {
  key: string
  tool: Tool
  target: string
  /** The deal a sized check (risk_check, batch audit) was asked for. */
  deal?: number
  status: 'paying' | 'paid'
  /** The Algorand address that paid, or '' when nothing was paid. */
  payer: string
  startedAt: number
  txId?: string
  lastValid?: number
  signedAt?: number
  paidAt?: number
  usd?: number
  /** The full answer; dropped once the entry is older than the time answers are kept. */
  answer?: Record<string, unknown> | null
  line?: string
  receipt?: string
  /** Paid, but the answer never arrived (the call stopped after the payment landed). */
  lost?: boolean
}

export type Ledger = {
  version: 1
  entries: Entry[]
  /** Recent check requests, for the loop guard. */
  requests: { at: number; target: string }[]
  pausedUntil?: number
  pausedWhy?: string
}

export function checksLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.A_IDENTITY_CHECKS_LEDGER?.trim() || join(homedir(), '.a-identity', 'checks.json')
}

export function loadLedger(path: string): Ledger {
  if (!existsSync(path)) return { version: 1, entries: [], requests: [] }
  let l: Partial<Ledger>
  try {
    l = JSON.parse(readFileSync(path, 'utf8')) as Partial<Ledger>
  } catch (e) {
    throw new Error(`${path} could not be read as the checks ledger (${e instanceof Error ? e.message : String(e)}), so nothing was paid.`)
  }
  return { version: 1, entries: l.entries ?? [], requests: l.requests ?? [], pausedUntil: l.pausedUntil, pausedWhy: l.pausedWhy }
}

function saveLedger(path: string, l: Ledger) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Reads, changes and writes the ledger with no other process in between. Never held across a network call. */
function update<T>(path: string, f: (l: Ledger) => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lock = `${path}.lock`
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, 'wx', 0o600))
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5_000) unlinkSync(lock)
      } catch {
        /* released meanwhile */
      }
      if (i >= 400) throw new Error(`The checks ledger ${path} stayed busy, so nothing was paid. Try again in a moment.`)
      pause(25)
    }
  }
  try {
    const l = loadLedger(path)
    const r = f(l)
    saveLedger(path, l)
    return r
  } finally {
    try {
      unlinkSync(lock)
    } catch {
      /* already gone */
    }
  }
}

// ── targets ──────────────────────────────────────────────────────────────────────────

export type Target = { raw: string; key: string; kind: 'payee' | 'agent' }

/**
 * What is being checked, and the one key it is known by, so two spellings of the same target
 * ("#849980" and "849980", "https://Seller.xyz/" and "seller.xyz") are one target.
 * A payee is an Algorand address or an x402 seller; anything else is an agent.
 */
export function parseTarget(input: string): Target {
  const raw = input.trim()
  if (!raw) throw new Error('Name a target: an Algorand address, an x402 seller link, or an agent id.')
  const upper = raw.toUpperCase()
  if (/^[A-Z2-7]{58}$/.test(upper) && algosdk.isValidAddress(upper)) return { raw: upper, key: upper, kind: 'payee' }
  if (/^https?:\/\//i.test(raw)) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      throw new Error(`${raw} is not a valid link.`)
    }
    return { raw, key: `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`, kind: 'payee' }
  }
  const domain = raw.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/.*)?$/i)
  if (domain && !/^\d+(\.\d+)*$/.test(domain[1])) {
    return { raw, key: `${domain[1].toLowerCase()}${(domain[2] ?? '').replace(/\/+$/, '')}`, kind: 'payee' }
  }
  const token = raw.match(/^#?(\d+)$/)
  if (token) return { raw, key: `#${BigInt(token[1]).toString()}`, kind: 'agent' }
  if (/^0x[0-9a-f]{40}$/i.test(raw) || /^eip155:/i.test(raw)) return { raw, key: raw.toLowerCase(), kind: 'agent' }
  return { raw, key: raw, kind: 'agent' }
}

export type Spec = { tool: Tool; subject: Target | Target[]; deal?: number }

export const tierOf = (amount?: number): Tier => (typeof amount === 'number' && amount > LARGE_PAYMENT_USD ? 'large' : 'small')

/**
 * The ledger key of a check. risk_check and the batch audit are sized to the deal, and the
 * oracle may DENY above LARGE_PAYMENT_USD an agent it allows below, so for those a small and a
 * large payment are two different checks; within one, the deal changes nothing worth paying for.
 */
export function keyOf(s: Spec): string {
  const sized = s.tool === 'risk_check' || s.tool === 'agent_batch_audit'
  const subject = Array.isArray(s.subject) ? [...new Set(s.subject.map((t) => t.key))].sort().join(',') : s.subject.key
  return `${s.tool}${sized ? `@${tierOf(s.deal)}` : ''}:${subject}`
}

const subjectText = (s: Spec) => (Array.isArray(s.subject) ? `${new Set(s.subject.map((t) => t.key)).size} agents` : s.subject.raw)

/** The checks a payment of `amount` to `t` calls for. */
export function planFor(t: Target, amount: number): Spec[] {
  if (t.kind === 'payee') return [{ tool: 'pay_check', subject: t }]
  const decision: Spec = { tool: 'risk_check', subject: t, deal: amount }
  return tierOf(amount) === 'large' ? [decision, { tool: 'agent_passport', subject: t }] : [decision]
}

// ── answers ──────────────────────────────────────────────────────────────────────────

const text = (v: unknown) => (typeof v === 'string' ? v : '')
const asDecision = (v: unknown): Decision | undefined => (v === 'ALLOW' || v === 'WARN' || v === 'DENY' ? v : undefined)

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

/** The verdict inside an answer, for the checks that give one. */
export function decisionOf(tool: Tool, r: Record<string, unknown> | null | undefined): Decision | undefined {
  if (!r) return undefined
  if (tool === 'pay_check') return r.verdict === 'safe' ? 'ALLOW' : r.verdict === 'dont_pay' ? 'DENY' : 'WARN'
  if (tool === 'risk_check') return asDecision(r.decision)
  if (tool === 'agent_passport') return asDecision((r.risk as { decision?: unknown } | undefined)?.decision)
  if (tool === 'agent_batch_audit') {
    const s = (r.summary ?? {}) as Record<string, number>
    return s.DENY ? 'DENY' : s.WARN ? 'WARN' : 'ALLOW'
  }
  return undefined
}

const RANK: Record<Decision, number> = { ALLOW: 0, WARN: 1, DENY: 2 }
const worst = (ds: Decision[]): Decision => ds.reduce<Decision>((a, b) => (RANK[b] > RANK[a] ? b : a), 'ALLOW')

const LOST_LINE = 'Paid, but the answer was lost when the call stopped. The receipt is on the ledger; treat this target as not checked.'

// ── errors ───────────────────────────────────────────────────────────────────────────

export class LoopGuardError extends Error {
  constructor(
    readonly why: string,
    readonly resumesAt: number,
    now: number,
  ) {
    super(
      `Stopped: ${why}, which looks like a loop. Every check is refused until ${new Date(resumesAt).toISOString()} ` +
        `(in ${Math.max(1, Math.ceil((resumesAt - now) / 60_000))} minutes). Do not retry before then, and do not check a target again: its saved answer does not change.`,
    )
    this.name = 'LoopGuardError'
  }
}

export class BudgetError extends Error {
  constructor(
    readonly priceUsd: number,
    readonly leftUsd: number,
  ) {
    super(`Not paid: this check costs ${priceUsd} USDC and the wallet holds ${leftUsd} USDC, so the budget is spent. Nothing was signed; targets already checked still answer for free.`)
    this.name = 'BudgetError'
  }
}

export class InFlightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InFlightError'
  }
}

/** Any way a check can stop, as a sentence an agent can act on. */
export function explain(e: unknown, hasWallet: boolean): { error: string; extra: Record<string, unknown> } {
  if (e instanceof LoopGuardError) return { error: e.message, extra: { resumesAt: new Date(e.resumesAt).toISOString() } }
  if (e instanceof BudgetError) return { error: e.message, extra: { priceUsd: e.priceUsd, leftUsd: e.leftUsd } }
  if (e instanceof PaymentRequiredError) {
    let price: unknown = null
    try {
      const q = readAlgorandQuote(e.challenge)
      price = { usd: q.amountUsd, network: q.label, payTo: q.accept.payTo }
    } catch {
      /* the quote is a courtesy; the refusal stands without it */
    }
    if (!hasWallet) {
      return {
        error: 'This check is paid per call in USDC on Algorand. Set A_IDENTITY_ALGORAND_MNEMONIC to an account holding USDC, or fund the one-time wallet with buy, to let this server pay.',
        extra: { price },
      }
    }
    const reason = (e.challenge as { reason?: unknown; error?: unknown } | null)?.reason ?? (e.challenge as { error?: unknown } | null)?.error
    return {
      error: `The payment was not accepted${typeof reason === 'string' ? ` (${reason})` : ''}. This check is not paid for again until the ledger shows that payment can no longer land.`,
      extra: { price },
    }
  }
  if (e instanceof SpendCapError) {
    return { error: `The price ${e.amountUsd} USDC is above this server's per-call cap of ${e.capUsd} USDC. Nothing was signed. Raise A_IDENTITY_MAX_USD_PER_CALL to allow it.`, extra: {} }
  }
  if (e instanceof AlgorandPaymentError) return { error: `Payment refused before signing: ${e.message}`, extra: {} }
  if (e instanceof TrustOracleError) return { error: e.message, extra: { status: e.status, detail: e.data } }
  return { error: e instanceof Error ? e.message : String(e), extra: {} }
}

// ── the gate ─────────────────────────────────────────────────────────────────────────

export type Gate = {
  ledgerPath: string
  baseUrl: string
  fetchImpl: FetchLike
  /** The paying wallet's 25 words. Unset: saved answers are served, anything new returns its price. */
  mnemonic?: string
  algod?: string
  maxUsdPerCall: number
  /** Hours an answer is kept; anything under CACHE_HOURS is read as CACHE_HOURS. */
  cacheHours?: number
  now?: () => number
}

export type CheckResult = {
  check: Tool
  label: string
  target: string
  source: 'paid' | 'cache'
  paidUsd: number
  checkedAt: string
  cachedUntil: string
  sizedForUsd?: number
  decision?: Decision
  summary: string
  receipt?: string
  answer: Record<string, unknown> | null
}

const keepMs = (g: Gate) => Math.max(CACHE_HOURS, Number.isFinite(g.cacheHours) ? Number(g.cacheHours) : CACHE_HOURS) * 3_600_000
const nowOf = (g: Gate) => (g.now ?? Date.now)()
const payerOf = (g: Gate) => (g.mnemonic ? algosdk.mnemonicToSecretKey(g.mnemonic).addr.toString() : '')

function savedAnswer(l: Ledger, key: string, now: number, keep: number): Entry | undefined {
  for (let i = l.entries.length - 1; i >= 0; i--) {
    const e = l.entries[i]
    if (e.key === key && e.status === 'paid' && (e.paidAt ?? 0) + keep > now) return e
  }
  return undefined
}

function toResult(e: Entry, source: 'paid' | 'cache', keep: number): CheckResult {
  const at = e.paidAt ?? e.startedAt
  return {
    check: e.tool,
    label: LABELS[e.tool],
    target: e.target,
    source,
    paidUsd: source === 'paid' ? (e.usd ?? 0) : 0,
    checkedAt: new Date(at).toISOString(),
    cachedUntil: new Date(at + keep).toISOString(),
    ...(e.deal !== undefined ? { sizedForUsd: e.deal } : {}),
    ...(e.lost ? {} : { decision: decisionOf(e.tool, e.answer) }),
    summary: e.line ?? '',
    ...(e.receipt ? { receipt: e.receipt } : {}),
    answer: e.answer ?? null,
  }
}

/** The id, last valid round and amount of the USDC payment inside a PAYMENT-SIGNATURE header. */
export function signedPayment(header: string): { txId: string; lastValid: number; usd: number } {
  const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { payload: { paymentGroup: string[]; paymentIndex: number } }
  const { paymentGroup, paymentIndex } = payload.payload
  const txn = algosdk.decodeSignedTransaction(Buffer.from(paymentGroup[paymentIndex], 'base64')).txn
  return { txId: txn.txID(), lastValid: Number(txn.lastValid), usd: Number(txn.assetTransfer?.amount ?? 0n) / 1e6 }
}

const sameEntry = (a: Entry) => (b: Entry) => b.key === a.key && b.startedAt === a.startedAt && b.status === 'paying'

/**
 * A check another call left as "paying": did its payment land ('paid'), can it never land
 * ('abandoned'), or might it still ('wait')? The ledger is updated to match.
 */
async function settleOpen(g: Gate, open: Entry): Promise<'paid' | 'abandoned' | 'wait'> {
  const algod = g.algod ?? DEFAULT_ALGOD
  const now = nowOf(g)
  const drop = () => update(g.ledgerPath, (l) => void (l.entries = l.entries.filter((e) => !sameEntry(open)(e))))
  if (!open.txId) {
    if (now - open.startedAt < UNSIGNED_GRACE_MS) return 'wait'
    drop()
    return 'abandoned'
  }
  if (await algorandTxLanded(open.txId, algod, g.fetchImpl)) {
    update(g.ledgerPath, (l) => {
      const e = l.entries.find(sameEntry(open))
      if (!e) return
      e.status = 'paid'
      e.paidAt = e.signedAt ?? now
      e.lost = true
      e.answer = null
      e.line = LOST_LINE
      e.receipt = e.txId
    })
    return 'paid'
  }
  const round = (await params(algod, g.fetchImpl)).firstValid - 1
  if (open.lastValid !== undefined && round > open.lastValid) {
    drop()
    return 'abandoned'
  }
  return 'wait'
}

function oracleFor(g: Gate, onPaymentRequired?: TrustGuardOptions['onPaymentRequired']) {
  return new TrustGuard({ rail: 'algorand', baseUrl: g.baseUrl, fetch: g.fetchImpl, onPaymentRequired })
}

async function ask(oracle: TrustGuard, s: Spec): Promise<Record<string, unknown>> {
  const one = Array.isArray(s.subject) ? '' : s.subject.raw
  const deal = s.deal === undefined ? undefined : { amountUsd: s.deal }
  switch (s.tool) {
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
    case 'agent_batch_audit': {
      const ids = Array.isArray(s.subject) ? [...new Map(s.subject.map((t) => [t.key, t.raw])).values()] : [one]
      return (await oracle.batchAudit(ids, deal)) as unknown as Record<string, unknown>
    }
  }
}

const inflight = new Map<string, Promise<CheckResult>>()

/** One check: the saved answer if there is one, otherwise paid for once and saved. */
export async function runCheck(g: Gate, s: Spec): Promise<CheckResult> {
  const key = keyOf(s)
  const id = `${g.ledgerPath}\n${key}`
  const running = inflight.get(id)
  // The same check asked for twice at once in this process: the second waits for the first.
  if (running) return { ...(await running), source: 'cache', paidUsd: 0 }
  const p = runCheckOnce(g, s, key).finally(() => inflight.delete(id))
  inflight.set(id, p)
  return p
}

async function runCheckOnce(g: Gate, s: Spec, key: string): Promise<CheckResult> {
  const keep = keepMs(g)
  for (let pass = 0; ; pass++) {
    const l = loadLedger(g.ledgerPath)
    const saved = savedAnswer(l, key, nowOf(g), keep)
    if (saved) return toResult(saved, 'cache', keep)
    const open = l.entries.find((e) => e.key === key && e.status === 'paying')
    if (!open) break
    const r = await settleOpen(g, open)
    if (r === 'wait' || pass >= 3) {
      throw new InFlightError(
        open.txId
          ? `A payment for this check (${LABELS[s.tool]}, ${subjectText(s)}) was signed and has not landed; it could still land until Algorand round ${open.lastValid}, about 45 minutes after signing. It is not paid for again before then.`
          : `This check (${LABELS[s.tool]}, ${subjectText(s)}) is being paid for by another call right now. Ask again in a minute; it will be saved by then.`,
      )
    }
  }

  const payer = payerOf(g)
  const reserved = update(g.ledgerPath, (l) => {
    if (savedAnswer(l, key, nowOf(g), keep) || l.entries.some((e) => e.key === key && e.status === 'paying')) return null
    const e: Entry = { key, tool: s.tool, target: subjectText(s), ...(s.deal !== undefined ? { deal: s.deal } : {}), status: 'paying', payer, startedAt: nowOf(g) }
    l.entries.push(e)
    return e
  })
  // Another process reserved it between the read and the write: look again.
  if (!reserved) return runCheckOnce(g, s, key)

  const algod = g.algod ?? DEFAULT_ALGOD
  const paid: { signed?: ReturnType<typeof signedPayment> } = {}
  const pay = g.mnemonic ? algorandPayer({ mnemonic: g.mnemonic, maxUsdPerCall: g.maxUsdPerCall, algodUrl: algod, fetch: g.fetchImpl }) : undefined
  const oracle = oracleFor(
    g,
    pay &&
      (async (challenge, info) => {
        // Within the cap, the price has to fit what is left of the budget before anything is signed.
        const price = readAlgorandQuote(challenge).amountUsd
        if (price <= g.maxUsdPerCall) {
          const left = (await readStatus(payer, algod, g.fetchImpl)).usdc
          if (left + 1e-9 < price) throw new BudgetError(price, left)
        }
        const headers = await pay(challenge, info)
        const sig = headers?.['PAYMENT-SIGNATURE']
        if (sig) {
          const sp = signedPayment(sig)
          paid.signed = sp
          update(g.ledgerPath, (l) => {
            const e = l.entries.find(sameEntry(reserved))
            if (e) Object.assign(e, { txId: sp.txId, lastValid: sp.lastValid, signedAt: nowOf(g), usd: sp.usd })
          })
        }
        return headers
      }),
  )
  try {
    const r = await ask(oracle, s)
    const done = update(g.ledgerPath, (l) => {
      const now = nowOf(g)
      const e = l.entries.find(sameEntry(reserved)) ?? (l.entries.push({ ...reserved }), l.entries[l.entries.length - 1])
      const sp = paid.signed
      Object.assign(e, {
        status: 'paid',
        paidAt: now,
        answer: r,
        line: oneLine(s.tool, r),
        usd: sp?.usd ?? 0,
        receipt: (r.settlement as { transaction?: string } | undefined)?.transaction ?? sp?.txId,
      })
      // Old answers are dropped from the ledger; the line, price and receipt stay for the totals.
      for (const x of l.entries) if (x.status === 'paid' && (x.paidAt ?? 0) + keep < now) delete x.answer
      return { ...e }
    })
    return toResult(done, 'paid', keep)
  } catch (e) {
    // Signed: whether it was paid is for the ledger to say, on the next call. Not signed: nothing happened.
    if (!paid.signed) update(g.ledgerPath, (l) => void (l.entries = l.entries.filter((x) => !sameEntry(reserved)(x))))
    throw e
  }
}

/**
 * Counts the targets of one request and stops when the pace looks like a loop. Paused, every
 * request is refused until the pause ends. Kept in the ledger, so a loop of separate commands is
 * caught as well as a loop inside one server.
 */
export function guard(g: Gate, keys: string[]): void {
  const now = nowOf(g)
  const stop = update(g.ledgerPath, (l) => {
    if (l.pausedUntil && l.pausedUntil > now) return { until: l.pausedUntil, why: l.pausedWhy ?? 'too many checks were asked for' }
    l.requests = l.requests.filter((r) => now - r.at < GUARD.repeatWindowMs)
    for (const k of keys) l.requests.push({ at: now, target: k })
    const burst = l.requests.filter((r) => now - r.at < GUARD.burstWindowMs).length
    const repeated = keys.find((k) => l.requests.filter((r) => r.target === k).length > GUARD.repeatMax)
    const why =
      burst > GUARD.burstMax
        ? `${burst} checks were asked for in one minute (the limit is ${GUARD.burstMax})`
        : repeated
          ? `${repeated} was asked for more than ${GUARD.repeatMax} times in 10 minutes`
          : ''
    if (!why) return null
    l.pausedUntil = now + GUARD.pauseMs
    l.pausedWhy = why
    return { until: l.pausedUntil, why }
  })
  if (stop) throw new LoopGuardError(stop.why, stop.until, now)
}

// ── what the agent calls ─────────────────────────────────────────────────────────────

export type PayDecision = {
  target: string
  kind: 'payee' | 'agent'
  amount: number
  tier: Tier
  decision: Decision
  advice: string
  checks: CheckResult[]
  failed?: { check: Tool; label: string; error: string }[]
  spentUsd: number
  budgetLeftUsd?: number | null
}

const ADVICE: Record<Decision, string> = {
  ALLOW: 'Safe to pay, as far as these checks can tell.',
  WARN: 'Be careful: read the reasons before paying.',
  DENY: 'Do not pay.',
}

async function decide(g: Gate, t: Target, amount: number): Promise<PayDecision> {
  const checks: CheckResult[] = []
  const failed: { check: Tool; label: string; error: string }[] = []
  let first: unknown = null
  for (const s of planFor(t, amount)) {
    try {
      checks.push(await runCheck(g, s))
    } catch (e) {
      if (e instanceof LoopGuardError) throw e
      first = first ?? e
      failed.push({ check: s.tool, label: LABELS[s.tool], error: explain(e, Boolean(g.mnemonic)).error })
    }
  }
  if (!checks.length) throw first
  // A check that gave no verdict (an answer lost, a check that could not run) is never read as ALLOW.
  let decision = worst(checks.map((c) => c.decision ?? 'WARN'))
  if (failed.length && decision === 'ALLOW') decision = 'WARN'
  return {
    target: t.raw,
    kind: t.kind,
    amount,
    tier: tierOf(amount),
    decision,
    advice: ADVICE[decision],
    checks,
    ...(failed.length ? { failed } : {}),
    spentUsd: Number(checks.reduce((n, c) => n + c.paidUsd, 0).toFixed(6)),
  }
}

async function budgetLeft(g: Gate): Promise<number | null> {
  if (!g.mnemonic) return null
  return readStatus(payerOf(g), g.algod ?? DEFAULT_ALGOD, g.fetchImpl)
    .then((s) => s.usdc)
    .catch(() => null)
}

/** Before a payment of `amount` USD to `target`: the checks that amount calls for, each paid for at most once. */
export async function checkBeforePay(g: Gate, target: string, amount: number): Promise<PayDecision> {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('amount is what you are about to pay, in USD: a number, 0 or more.')
  const t = parseTarget(target)
  guard(g, [t.key])
  const d = await decide(g, t, amount)
  d.budgetLeftUsd = await budgetLeft(g)
  return d
}

export type BatchResult = {
  results: (PayDecision | { target: string; error: string })[]
  spentUsd: number
  budgetLeftUsd: number | null
  /** Items that named a target already in the list, so were not checked twice. */
  duplicates: number
}

/** check_before_pay for several targets. A target named twice is checked once, at the larger amount. */
export async function checkBatch(g: Gate, items: { target: string; amount: number }[]): Promise<BatchResult> {
  if (!items.length || items.length > BATCH_MAX) throw new Error(`check_batch takes 1 to ${BATCH_MAX} targets.`)
  const byKey = new Map<string, { t: Target; amount: number }>()
  for (const i of items) {
    if (!Number.isFinite(i.amount) || i.amount < 0) throw new Error(`The amount for ${i.target} must be a number, 0 or more.`)
    const t = parseTarget(i.target)
    const prev = byKey.get(t.key)
    byKey.set(t.key, { t: prev?.t ?? t, amount: Math.max(prev?.amount ?? 0, i.amount) })
  }
  guard(g, [...byKey.keys()])
  const results: BatchResult['results'] = []
  let first: unknown = null
  for (const { t, amount } of byKey.values()) {
    try {
      results.push(await decide(g, t, amount))
    } catch (e) {
      if (e instanceof LoopGuardError) throw e
      first = first ?? e
      results.push({ target: t.raw, error: explain(e, Boolean(g.mnemonic)).error })
    }
  }
  if (first && results.every((r) => 'error' in r)) throw first
  const spentUsd = results.reduce((n, r) => n + ('spentUsd' in r ? r.spentUsd : 0), 0)
  return { results, spentUsd: Number(spentUsd.toFixed(6)), budgetLeftUsd: await budgetLeft(g), duplicates: items.length - byKey.size }
}

/** One named tool on one target (or a shortlist, for the batch audit), through the same gate. */
export async function askOne(g: Gate, tool: Tool, subject: string | string[], amount?: number): Promise<Record<string, unknown>> {
  const sized = tool === 'risk_check' || tool === 'agent_batch_audit'
  const s: Spec = { tool, subject: Array.isArray(subject) ? subject.map(parseTarget) : parseTarget(subject), ...(sized && amount !== undefined ? { deal: amount } : {}) }
  guard(g, [Array.isArray(s.subject) ? keyOf(s) : s.subject.key])
  const r = await runCheck(g, s)
  return {
    ...(r.answer ?? { note: r.summary }),
    cache: { source: r.source, paidUsd: r.paidUsd, checkedAt: r.checkedAt, cachedUntil: r.cachedUntil, ...(r.receipt ? { receipt: r.receipt } : {}) },
  }
}

/** What one wallet has paid for checks, from the ledger. */
export function spentBy(l: Ledger, payer: string): { usd: number; count: number; entries: Entry[] } {
  const entries = l.entries.filter((e) => e.status === 'paid' && e.payer === payer && (e.usd ?? 0) > 0)
  return { usd: Number(entries.reduce((n, e) => n + (e.usd ?? 0), 0).toFixed(6)), count: entries.length, entries }
}
