/**
 * The Milestone 1 run: the rules behind scripts/arc-vtp-runner.mjs, kept here so they are
 * unit-tested with fakes. Nothing in this file reads a network, holds a key or sends anything;
 * the script hands it what it read and the functions that act.
 *
 * Milestone 1 needs 100 verify-then-pay flows through the launch-day vault, each a settled
 * Gateway check followed by a vault payment or a refusal. What these rules promise:
 *
 *   - The budget binds across runs. The log is read back on every start: finished flows cost
 *     what they cost, and a flow whose log line says it began and no line says how it ended
 *     costs its whole upper bound, because it may have paid.
 *   - The log is written ahead. An intent line reaches the disk before a flow can spend, so a
 *     crash cannot lose money from the count.
 *   - A flow expected to DENY cannot pay. Its operator is a signer whose sendTransaction always
 *     refuses, so an ALLOW where DENY was expected stops the run with nothing sent, instead of
 *     being found after the money moved.
 *   - Nothing is retried. Any outcome other than the expected one ends the run, and when the
 *     outcome leaves money unknown (a payment with no receipt, a check with no answer) or moved
 *     without the server recording it, the next run refuses to start until a human has looked
 *     and said so.
 *   - A paid flow the server did not record can still count. A hash with no verified record is
 *     posted again before the next plan (reconcileReceipts), which sends nothing and only ever
 *     adds a line saying what the server read from the chain.
 *   - The log is bound to one vault and one base amount by a header line, so a change of either
 *     cannot reuse an amount, and readRunLog refuses a log in which one repeats.
 *   - The check is bought at the decided price. A quote that differs refuses the plan, and the
 *     signing cap never rises above the decision (checkSigningCap).
 *   - Each flow pays an amount no other flow uses, one base unit apart (flowAmountUnits). A
 *     vault payment names no check, so verify-then-pay/receipt.ts links it to the latest open
 *     check on the same vault, payee and amount; a unique amount keeps that link unambiguous.
 *
 * Refusals run first (runQueue). They spend nothing from the vault, while its balance, daily
 * cap and the operator's gas have to pass the free preflight for them all the same, so running
 * them before the payments asks the least of all three.
 */

export type PayeeRole = 'allow' | 'deny'
export type ExpectedVerdict = 'ALLOW' | 'DENY'

export type PayeeSpec = {
  role: PayeeRole
  label: string
  address: string
  /** Sent as payeeAgentId, so the registry has to say this agent is the payee's. */
  agentId: string
  /** What to do when the plan says this payee will not reach its expected verdict. */
  note: string
}

export const expectedFor = (role: PayeeRole): ExpectedVerdict => (role === 'allow' ? 'ALLOW' : 'DENY')

export type Decimals = { usdc: number; native: number }

// ── amounts ───────────────────────────────────────────────────────────────────────

/** The amount a flow pays: the base plus its sequence number, so no two flows share one. */
export function flowAmountUnits(baseUnits: bigint, seq: number): bigint {
  return baseUnits + BigInt(seq - 1)
}

/** Wei of native USDC as 6-decimal units, rounded up: a cost is never understated. */
export function weiToUnitsCeil(wei: bigint, d: Decimals): bigint {
  const per = 10n ** BigInt(d.native - d.usdc)
  return (wei + per - 1n) / per
}

/** Base units as a fixed-point string. String math only. */
export function formatUnits(units: bigint, decimals: number): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  return `${negative ? '-' : ''}${whole}.${digits.slice(digits.length - decimals)}`
}

// ── the log ───────────────────────────────────────────────────────────────────────

export type FlowCosts = {
  checkUnits: string
  paymentUnits: string
  gasWei: string
  /** All three in USDC base units, the gas rounded up. What the budget counts. */
  totalUnits: string
  /** actual: read from a receipt or an answer. upper_bound: what it could have cost. */
  basis: 'actual' | 'upper_bound'
}

/** Written before the flow can spend. */
export type IntentLine = {
  v: 1
  kind: 'intent'
  seq: number
  at: string
  payee: string
  payeeLabel: string
  expected: ExpectedVerdict
  amountUnits: string
  upperBoundUnits: string
}

export type FlowOutcome = {
  flowId: string | null
  flowUrl: string | null
  verdict: string | null
  reputation: number | null
  outcome: string
  txHash: string | null
  recorded: boolean
  costs: FlowCosts
  /** The expected result, recorded by the server: the flow counts as done. */
  counted: boolean
  /** The server read this transaction's receipt from the chain and wrote it down. */
  receiptVerified: boolean
  /** Why this ended the run; null when it did not. */
  unexpected: string | null
  /** Money may have moved in a way nobody has read yet. Blocks the next run until acknowledged. */
  unresolved: boolean
  detail: string | null
}

export type FlowLine = FlowOutcome & {
  v: 1
  kind: 'flow'
  seq: number
  at: string
  payee: string
  payeeLabel: string
  expected: ExpectedVerdict
  amountUnits: string
}

/** A human looked at these flows and chose to go on. */
export type AckLine = { v: 1; kind: 'ack'; at: string; seqs: number[] }

/** The first line of a log: what its budget and its amounts belong to. */
export type HeaderLine = { v: 1; kind: 'header'; at: string; vault: string; baseAmountUnits: string }

/** A hash posted again after the run, and what the server read from the chain for it. */
export type ReconcileLine = { v: 1; kind: 'reconcile'; at: string; seq: number; flowId: string; txHash: string; recorded: boolean; outcome: string | null; detail: string | null; reason: string | null }

export type RunLogLine = HeaderLine | IntentLine | FlowLine | AckLine | ReconcileLine

export type LogState = {
  header: HeaderLine | null
  doneAllow: number
  doneDeny: number
  spentUnits: bigint
  /** The sequence number the next flow takes. */
  nextSeq: number
  /** Flows whose money nobody has read, not yet acknowledged. */
  unresolved: number[]
  flows: FlowLine[]
}

export class RunLogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunLogError'
  }
}

const DIGITS = /^[0-9]+$/
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseLine(raw: string, n: number): RunLogLine {
  const bad = (why: string) =>
    new RunLogError(`the log's line ${n} ${why}. The budget is counted from this file, so nothing runs on a log that cannot be read whole: repair the line and look at what it said. Do not move or replace the file: a new log starts the budget, the flow count and the unique amounts again.`)
  let p: unknown
  try {
    p = JSON.parse(raw)
  } catch {
    throw bad('is not JSON (a crash can tear the last line)')
  }
  if (!isRecord(p) || p.v !== 1) throw bad('is not a v1 log line')
  if (p.kind === 'ack') {
    if (!Array.isArray(p.seqs) || !p.seqs.every((s) => Number.isInteger(s))) throw bad('is an ack with no sequence numbers')
    return p as unknown as AckLine
  }
  if (p.kind === 'header') {
    if (typeof p.vault !== 'string' || typeof p.baseAmountUnits !== 'string' || !DIGITS.test(p.baseAmountUnits)) throw bad('is a header with no vault or base amount')
    return p as unknown as HeaderLine
  }
  if (p.kind !== 'intent' && p.kind !== 'flow' && p.kind !== 'reconcile') throw bad(`has an unknown kind ${JSON.stringify(p.kind)}`)
  if (!Number.isInteger(p.seq) || (p.seq as number) < 1) throw bad('has no usable seq')
  if (p.kind === 'reconcile') {
    if (typeof p.txHash !== 'string' || typeof p.recorded !== 'boolean') throw bad('is a reconcile with no hash or result')
    return p as unknown as ReconcileLine
  }
  if (typeof p.amountUnits !== 'string' || !DIGITS.test(p.amountUnits)) throw bad('has no amountUnits')
  if (p.kind === 'intent') {
    if (typeof p.upperBoundUnits !== 'string' || !DIGITS.test(p.upperBoundUnits)) throw bad('has no upperBoundUnits')
    return p as unknown as IntentLine
  }
  if (!isRecord(p.costs) || typeof p.costs.totalUnits !== 'string' || !DIGITS.test(p.costs.totalUnits)) throw bad('has no costs.totalUnits')
  if (p.expected !== 'ALLOW' && p.expected !== 'DENY') throw bad('has no expected verdict')
  return p as unknown as FlowLine
}

/** Read the whole log back. Throws RunLogError rather than guess at a line it cannot read. */
export function readRunLog(text: string): LogState {
  const intents = new Map<number, IntentLine>()
  const flows = new Map<number, FlowLine>()
  const acked = new Set<number>()
  const reconciled = new Map<number, ReconcileLine>()
  const amountOwner = new Map<string, number>()
  let header: HeaderLine | null = null
  let lines = 0
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return
    const line = parseLine(raw, i + 1)
    lines += 1
    if (line.kind === 'header') {
      if (lines !== 1) throw new RunLogError(`the log's line ${i + 1} is a header, and a header is only ever the first line`)
      header = line
    } else if (line.kind === 'ack') {
      line.seqs.forEach((s) => acked.add(s))
    } else if (line.kind === 'reconcile') {
      reconciled.set(line.seq, line)
    } else {
      // A vault payment names no check, so the server links it by its amount: one amount per flow.
      const owner = amountOwner.get(line.amountUnits)
      if (owner !== undefined && owner !== line.seq) throw new RunLogError(`the log's line ${i + 1} gives flow ${line.seq} the amount ${line.amountUnits} that flow ${owner} already has, and a receipt is linked by that amount`)
      amountOwner.set(line.amountUnits, line.seq)
      const other = line.kind === 'intent' ? flows.get(line.seq) : intents.get(line.seq)
      if (other && other.amountUnits !== line.amountUnits) throw new RunLogError(`the log's line ${i + 1} gives flow ${line.seq} the amount ${line.amountUnits} and another line gives it ${other.amountUnits}`)
      if (line.kind === 'intent') {
        if (intents.has(line.seq)) throw new RunLogError(`the log's line ${i + 1} repeats the intent of flow ${line.seq}`)
        intents.set(line.seq, line)
      } else {
        if (flows.has(line.seq)) throw new RunLogError(`the log's line ${i + 1} repeats the result of flow ${line.seq}`)
        flows.set(line.seq, line)
      }
    }
  })
  for (const [seq, r] of reconciled) {
    if (flows.get(seq)?.txHash !== r.txHash) throw new RunLogError(`the log holds a reconcile for flow ${seq} that names a hash the flow's own line does not`)
  }
  let spentUnits = 0n
  const unresolved: number[] = []
  let doneAllow = 0
  let doneDeny = 0
  for (const [seq, raw] of flows) {
    const f = withReconcile(raw, reconciled.get(seq))
    flows.set(seq, f)
    spentUnits += BigInt(f.costs.totalUnits)
    if (f.counted && f.expected === 'ALLOW') doneAllow += 1
    if (f.counted && f.expected === 'DENY') doneDeny += 1
    if (f.unresolved && !acked.has(seq)) unresolved.push(seq)
  }
  for (const [seq, intent] of intents) {
    if (flows.has(seq)) continue
    spentUnits += BigInt(intent.upperBoundUnits)
    if (!acked.has(seq)) unresolved.push(seq)
  }
  const seqs = [...intents.keys(), ...flows.keys()]
  return {
    header,
    doneAllow,
    doneDeny,
    spentUnits,
    nextSeq: seqs.length ? Math.max(...seqs) + 1 : 1,
    unresolved: unresolved.sort((a, b) => a - b),
    flows: [...flows.values()].sort((a, b) => a.seq - b.seq),
  }
}

/**
 * A flow after what the chain said when its hash was posted again. Its cost stays what the line
 * said, which is at most an upper bound: a reconcile can make a flow count, never make it cheaper.
 * A payment recorded as executed counts only where ALLOW was expected and nothing said otherwise;
 * one that moved money anywhere else stays unresolved for a human. A recorded revert moved nothing.
 */
function withReconcile(f: FlowLine, r: ReconcileLine | undefined): FlowLine {
  if (!r?.recorded) return f
  const verified = { ...f, recorded: true, receiptVerified: true }
  if (r.outcome === 'executed') {
    if (f.expected === 'ALLOW' && (f.verdict === null || f.verdict === 'ALLOW')) return { ...verified, counted: true, unresolved: false }
    return verified
  }
  return { ...verified, unresolved: false }
}

export type RunBinding = { vault: string; baseAmountUnits: bigint }

/** Why this log cannot be resumed with these flags, or null. Amounts derive from the base and the
 *  sequence number, so 995 + flow 11 and 1000 + flow 6 would name the same amount. */
export function logBindingError(log: LogState, run: RunBinding): string | null {
  const h = log.header
  if (!h) return log.nextSeq > 1 ? 'the log has flows and no header line, so what its budget and amounts belong to is not known' : null
  if (h.vault.toLowerCase() !== run.vault.toLowerCase()) return `the log belongs to vault ${h.vault}, not ${run.vault}`
  if (BigInt(h.baseAmountUnits) !== run.baseAmountUnits) return `the log's base amount is ${h.baseAmountUnits} and --amount-units says ${run.baseAmountUnits}: a change would reuse an amount, and a receipt is linked by its amount`
  return null
}

/** What the public proof holds from this payer. Null: it could not be read. */
export type PriorChecks = { count: number; latest: string | null }

/**
 * A new log knows nothing the old one spent or the amounts it used, so starting one is only safe
 * on purpose. Null when this run may go on. Read from the proof's retained window, so an empty
 * answer is not a proof of nothing older.
 */
export function freshLogBlocker(a: { log: LogState; acknowledged: boolean; prior: PriorChecks | null }): string | null {
  if (a.log.nextSeq > 1 || a.acknowledged) return null
  if (a.prior === null) return 'this log is empty and the public proof could not be read, so whether this payer has run flows under another log is not known. Pass --ack-fresh-log to start anyway'
  if (a.prior.count === 0) return null
  return `this log is empty and the public proof shows ${a.prior.count} risk_check(s) from this payer on this chain, the latest at ${a.prior.latest ?? 'an unknown time'}. If they came from an earlier log, use that log: a new one starts the budget and the amounts again. Pass --ack-fresh-log if they did not`
}

/** A flow whose transaction has no verified record yet. */
export type ReceiptGap = { seq: number; flowId: string; txHash: string }

export function receiptGaps(log: LogState): ReceiptGap[] {
  return log.flows.flatMap((f) => (f.txHash && f.flowId && !f.receiptVerified ? [{ seq: f.seq, flowId: f.flowId, txHash: f.txHash }] : []))
}

/** What the SDK's recordFlowReceipt reports. */
export type ReceiptReport = { recorded: boolean; outcome?: string; detail?: string; code?: string; reason?: string; answersFlow?: string }

/**
 * Post each hash again, one at a time. Posting a hash is safe to repeat and this sends nothing:
 * the server reads the chain itself. Each result is written as its own line before the next post,
 * and a write that fails stops here, with the same line still to be had by posting again.
 */
export async function reconcileReceipts(d: {
  gaps: ReceiptGap[]
  post(g: ReceiptGap): Promise<ReceiptReport>
  append(line: ReconcileLine): void
  print(s: string): void
  sleep(ms: number): Promise<void>
  pauseMs: number
  now(): string
}): Promise<{ posted: number; recorded: number }> {
  let posted = 0
  let recorded = 0
  for (const g of d.gaps) {
    if (posted > 0) await d.sleep(d.pauseMs)
    let r: ReceiptReport
    try {
      r = await d.post(g)
    } catch (e) {
      r = { recorded: false, reason: `the receipt could not be posted: ${firstLine(String(e))}` }
    }
    // Linked to some other flow, it says nothing about this one.
    const proved = r.recorded && (r.answersFlow === undefined || r.answersFlow.toLowerCase() === g.flowId.toLowerCase())
    const reason = proved ? null : (r.reason ?? r.code ?? (r.answersFlow ? `the payment answers flow ${r.answersFlow}` : 'the server did not record it'))
    d.append({ v: 1, kind: 'reconcile', at: d.now(), seq: g.seq, flowId: g.flowId, txHash: g.txHash, recorded: proved, outcome: r.outcome ?? null, detail: r.detail ?? null, reason })
    d.print(`receipt for flow #${g.seq} ${g.txHash}: ${proved ? `recorded, ${r.outcome ?? 'no outcome'}` : `not recorded (${reason})`}`)
    posted += 1
    if (proved) recorded += 1
  }
  return { posted, recorded }
}

// ── what risk_check will say ──────────────────────────────────────────────────────

/** POST /api/x402/gateway/tools/trust_preview, free. */
export type PreviewRead = { verified: boolean; kyaStatus: string; scoreBand: string; revoked: boolean; sybilSuspected: boolean }

/** GET /api/reputation, free. found:false: the platform does not know this address. */
export type ReputationRead = { found: true; score: number; tenurePoints: number | null; sybil: string | null } | { found: false }

export type VerdictForecast = {
  verdict: 'ALLOW' | 'WARN' | 'DENY' | 'UNKNOWN'
  /** What stands between this payee and ALLOW, one rule per entry. Empty on ALLOW. */
  missing: string[]
  /** A limit of the forecast, stated rather than implied. */
  caveat: string | null
}

const ALLOW_REPUTATION = 500
const DENY_REPUTATION = 200
/** The scorer gives Math.round(days / 2) tenure points, so 4 points is exactly 7 days. */
const TENURE_POINTS_AT_7_DAYS = 4

/**
 * What the paid risk_check is expected to answer, from the free reads, by asp/risk.ts's rules
 * at a small amount. A forecast only: the paid verdict is what the flow acts on.
 */
export function forecastVerdict(preview: PreviewRead | null, rep: ReputationRead | null): VerdictForecast {
  if (!preview) return { verdict: 'UNKNOWN', missing: ['the free trust_preview could not be read'], caveat: null }
  const deny: string[] = []
  const warn: string[] = []
  const score = rep?.found ? rep.score : null
  if (preview.revoked) deny.push('its KYA is revoked')
  if (!preview.verified) deny.push('it has no verifiable on-chain identity')
  if (score !== null ? score < DENY_REPUTATION : preview.scoreBand === 'very-low') {
    deny.push(score !== null ? `reputation ${score} is below ${DENY_REPUTATION}, where risk_check denies` : `its score band is very-low (under ${DENY_REPUTATION}, where risk_check denies)`)
  }
  if (rep?.found && rep.sybil === 'high') deny.push('its reputation reads as wash-traded (sybil high)')
  if (preview.kyaStatus !== 'verified') warn.push(`its KYA is ${preview.kyaStatus}, and ALLOW needs it attested`)
  if (score !== null ? score >= DENY_REPUTATION && score < ALLOW_REPUTATION : preview.scoreBand === 'low') {
    warn.push(score !== null ? `reputation ${score}, and ALLOW needs >= ${ALLOW_REPUTATION}: short by ${ALLOW_REPUTATION - score}` : `its score band is low (under ${ALLOW_REPUTATION}), and ALLOW needs >= ${ALLOW_REPUTATION}`)
  }
  if (preview.sybilSuspected) warn.push('its sybil signals are medium or high')
  let caveat: string | null = null
  if (rep?.found && rep.tenurePoints !== null) {
    if (rep.tenurePoints < TENURE_POINTS_AT_7_DAYS) warn.push('its tenure is under 7 days, and ALLOW needs >= 7')
  } else {
    caveat = 'tenure is not in the free reads for this payee, so the >= 7 days ALLOW needs was not checked'
  }
  if (deny.length) return { verdict: 'DENY', missing: [...deny, ...warn], caveat: null }
  if (warn.length) return { verdict: 'WARN', missing: warn, caveat }
  return { verdict: 'ALLOW', missing: [], caveat }
}

// ── the plan ──────────────────────────────────────────────────────────────────────

export type VaultFacts = {
  owner: string
  operator: string
  frozen: boolean
  /** Unix seconds; 0n means no time bound. */
  sessionKeyExpiry: bigint
  allowlistEnabled: boolean
  autoApproveMax: bigint
  dailyCap: bigint
  spentToday: bigint
  balanceUnits: bigint
  blockTimestamp: bigint
}

export type PayeeRead = {
  spec: PayeeSpec
  forecast: VerdictForecast
  /** balanceOf on the identity registry; null when it could not be read. */
  agentsHeld: bigint | null
  /** pay() to this payee, estimate plus headroom, from the free preflight. Null when refused. */
  gasLimit: bigint | null
  /** The free preflight's refusal, in the same words a flow would get. */
  preflightError: string | null
  /** The hosted route's refusal of the free call, when it refused. */
  routeError: string | null
}

export type PlanInput = {
  allow: number
  deny: number
  baseAmountUnits: bigint
  budgetUnits: bigint
  log: LogState
  operator: string
  capWei: bigint
  tipWei: bigint
  /** Where Arc silently drops a transaction. */
  minFeeWei: bigint
  /** Null means it could not be read, which refuses the run. */
  priceUnits: bigint | null
  gatewayUnits: bigint | null
  gasPriceWei: bigint | null
  operatorGasWei: bigint | null
  vault: VaultFacts | null
  payees: PayeeRead[]
  decimals: Decimals
}

export type Plan = {
  remaining: { allow: number; deny: number }
  /** Inclusive sequence numbers, refusals first. Null when none are left. */
  seqs: { deny: [number, number] | null; allow: [number, number] | null }
  /** The largest single amount any remaining flow names. */
  largestAmountUnits: bigint
  gasLimit: bigint
  /** The fee a payment would use at today's gas price, and whether a gas price was read. */
  feeWei: bigint | null
  upperBound: {
    checksUnits: bigint
    paymentsUnits: bigint
    gasWei: bigint
    gasUnits: bigint
    totalUnits: bigint
  }
  /** Already spent according to the log, plus this run's upper bound. */
  worstCaseUnits: bigint
  /** What the vault's balance and daily cap have to cover: see the note on runQueue. */
  vaultNeedUnits: bigint
  gatewayNeedUnits: bigint
  gasNeedWei: bigint
  /** Each reason this run is refused, with the exact shortfall. Empty means it may run. */
  blockers: string[]
  notes: string[]
}

/** The decided price of risk_check through Gateway on Arc Mainnet: 0.005 USDC. */
export const DECIDED_CHECK_UNITS = 5000n

/** The most any check in a run may be signed for: the decision, or a lower quote. A quote from
 *  the server can never raise it. */
export function checkSigningCap(priceUnits: bigint): bigint {
  return priceUnits < DECIDED_CHECK_UNITS ? priceUnits : DECIDED_CHECK_UNITS
}

/** Used for the bound only when no live estimate could be had, and then the run is refused
 *  anyway: a payment the vault would refuse has no estimate. */
const FALLBACK_GAS_LIMIT = 120_000n

const remainingOf = (target: number, done: number): number => Math.max(0, target - done)

/** The fee rule the server and the SDK share: twice the price plus the tip, above Arc's floor. */
export function wantedFeeWei(gasPriceWei: bigint, tipWei: bigint, minFeeWei: bigint): bigint {
  const wanted = 2n * gasPriceWei + tipWei
  return wanted > minFeeWei ? wanted : minFeeWei
}

function rangeSum(baseUnits: bigint, from: number, count: number): bigint {
  let sum = 0n
  for (let i = 0; i < count; i++) sum += flowAmountUnits(baseUnits, from + i)
  return sum
}

/** Everything the run would need, and every reason it would be refused. Pure. */
export function buildPlan(p: PlanInput): Plan {
  const u = (n: bigint) => `${formatUnits(n, p.decimals.usdc)} USDC`
  const remaining = { allow: remainingOf(p.allow, p.log.doneAllow), deny: remainingOf(p.deny, p.log.doneDeny) }
  const first = p.log.nextSeq
  const firstAllow = first + remaining.deny
  const lastSeq = firstAllow + remaining.allow - 1
  const seqs = {
    deny: remaining.deny ? ([first, firstAllow - 1] as [number, number]) : null,
    allow: remaining.allow ? ([firstAllow, lastSeq] as [number, number]) : null,
  }
  const largestDeny = remaining.deny ? flowAmountUnits(p.baseAmountUnits, firstAllow - 1) : 0n
  const largestAmountUnits = remaining.allow ? flowAmountUnits(p.baseAmountUnits, lastSeq) : largestDeny
  const allowRead = p.payees.find((r) => r.spec.role === 'allow')
  const denyRead = p.payees.find((r) => r.spec.role === 'deny')
  const liveLimits = [allowRead?.gasLimit, denyRead?.gasLimit].filter((g): g is bigint => typeof g === 'bigint')
  const gasLimit = (remaining.allow ? allowRead?.gasLimit : null) ?? liveLimits[0] ?? FALLBACK_GAS_LIMIT

  const paymentsUnits = rangeSum(p.baseAmountUnits, firstAllow, remaining.allow)
  const checksUnits = (p.priceUnits ?? 0n) * BigInt(remaining.allow + remaining.deny)
  const perPaymentGasWei = gasLimit * p.capWei
  const gasWei = perPaymentGasWei * BigInt(remaining.allow)
  const gasUnits = weiToUnitsCeil(gasWei, p.decimals)
  const totalUnits = checksUnits + paymentsUnits + gasUnits
  const worstCaseUnits = p.log.spentUnits + totalUnits

  // The vault and the gas have to pass the free preflight on every flow, refusals included.
  // Refusals run first and spend nothing, so the larger of the two is what must be there.
  const vaultNeedUnits = paymentsUnits > largestDeny ? paymentsUnits : largestDeny
  const gatewayNeedUnits = checksUnits
  const denyGasWei = remaining.deny ? perPaymentGasWei : 0n
  const gasNeedWei = gasWei > denyGasWei ? gasWei : denyGasWei

  const blockers: string[] = []
  const notes: string[] = []
  const flowsLeft = remaining.allow + remaining.deny

  if (p.log.unresolved.length) {
    blockers.push(`the log holds flow(s) ${p.log.unresolved.join(', ')} whose money nobody has read (each is counted at its upper bound). Look them up, then pass --ack-stop to go on`)
  }

  for (const r of p.payees) {
    const wanted = remaining[r.spec.role]
    if (wanted === 0) continue
    const expected = expectedFor(r.spec.role)
    if (r.forecast.verdict !== expected) {
      const missing = r.forecast.missing.length ? ` Missing: ${r.forecast.missing.join('; ')}.` : ''
      blockers.push(`${r.spec.label} is planned for ${wanted} ${expected} flow(s) and is expected to answer ${r.forecast.verdict} today.${missing} ${r.spec.note}`.trim())
    }
    if (r.agentsHeld === null) blockers.push(`the identity registry's balanceOf(${r.spec.label}) could not be read`)
    else if (r.agentsHeld <= 0n) blockers.push(`${r.spec.label} holds no agent on the identity registry, so the vault flow refuses it`)
    if (r.preflightError) blockers.push(`the free preflight refuses ${r.spec.label}: ${r.preflightError}`)
    if (r.routeError) blockers.push(`the hosted route refuses ${r.spec.label}: ${r.routeError}`)
  }

  if (flowsLeft > 0) {
    if (p.priceUnits === null) blockers.push('the check price could not be read from the hosted route')
    else if (p.priceUnits !== DECIDED_CHECK_UNITS) blockers.push(`check price: the hosted route quotes ${u(p.priceUnits)} and the decided price is ${u(DECIDED_CHECK_UNITS)}. Nothing is signed at a price nobody decided`)
    if (p.gatewayUnits === null) blockers.push("the operator's Gateway balance could not be read from Circle's /v1/balances")
    else if (p.gatewayUnits < gatewayNeedUnits) {
      blockers.push(`Gateway balance: the operator holds ${u(p.gatewayUnits)} and ${flowsLeft} check(s) can cost ${u(gatewayNeedUnits)}: short by ${u(gatewayNeedUnits - p.gatewayUnits)}. Deposit first (scripts/gateway-deposit.mjs)`)
    }
    if (worstCaseUnits > p.budgetUnits) {
      blockers.push(`budget: this run can cost ${u(totalUnits)} on top of the ${u(p.log.spentUnits)} the log has spent, ${u(worstCaseUnits)} in all, against --budget ${u(p.budgetUnits)}: short by ${u(worstCaseUnits - p.budgetUnits)}`)
    }
    if (p.operatorGasWei === null) blockers.push("the operator's gas balance could not be read")
    else if (p.operatorGasWei < gasNeedWei) {
      const short = gasNeedWei - p.operatorGasWei
      blockers.push(`gas: the operator holds ${formatUnits(p.operatorGasWei, p.decimals.native)} USDC of native gas and the run can need ${formatUnits(gasNeedWei, p.decimals.native)}: short by ${formatUnits(short, p.decimals.native)} USDC`)
    }
    if (p.gasPriceWei === null) blockers.push('the gas price could not be read')
    else {
      const wanted = wantedFeeWei(p.gasPriceWei, p.tipWei, p.minFeeWei)
      if (wanted > p.capWei) blockers.push(`gas price: at ${p.gasPriceWei} wei a payment wants a fee of ${wanted} wei, above --max-fee-gwei's ${p.capWei} wei. Wait, or raise it (the gas bound rises with it)`)
    }
    if (p.vault === null) blockers.push('the vault could not be read')
    else {
      const v = p.vault
      if (v.operator !== p.operator) blockers.push(`the vault's operator is ${v.operator}, not ${p.operator}`)
      if (v.frozen) blockers.push('the vault is frozen by its owner')
      if (v.sessionKeyExpiry !== 0n && v.blockTimestamp >= v.sessionKeyExpiry) blockers.push(`the operator's session key expired at ${v.sessionKeyExpiry} (unix)`)
      if (v.autoApproveMax !== 0n && largestAmountUnits > v.autoApproveMax) {
        blockers.push(`auto-approve: the largest flow pays ${u(largestAmountUnits)} and the vault's per-payment ceiling is ${u(v.autoApproveMax)}: over by ${u(largestAmountUnits - v.autoApproveMax)}`)
      }
      if (v.balanceUnits < vaultNeedUnits) {
        blockers.push(`vault balance: the vault holds ${u(v.balanceUnits)} and the run can need ${u(vaultNeedUnits)}: short by ${u(vaultNeedUnits - v.balanceUnits)}. The owner funds it`)
      }
      if (v.dailyCap !== 0n && v.spentToday + vaultNeedUnits > v.dailyCap) {
        blockers.push(`daily cap: the vault has spent ${u(v.spentToday)} of its ${u(v.dailyCap)} today and the run can add ${u(vaultNeedUnits)}: over by ${u(v.spentToday + vaultNeedUnits - v.dailyCap)}`)
      }
    }
  }

  for (const r of p.payees) {
    if (remaining[r.spec.role] > 0 && r.forecast.caveat) notes.push(`${r.spec.label}: ${r.forecast.caveat}`)
  }
  if (remaining.allow > 0 && allowRead?.gasLimit == null) {
    notes.push(`no live gas estimate for a payment, so the gas bound uses ${FALLBACK_GAS_LIMIT} gas`)
  }

  return {
    remaining,
    seqs,
    largestAmountUnits,
    gasLimit,
    feeWei: p.gasPriceWei === null ? null : wantedFeeWei(p.gasPriceWei, p.tipWei, p.minFeeWei),
    upperBound: { checksUnits, paymentsUnits, gasWei, gasUnits, totalUnits },
    worstCaseUnits,
    vaultNeedUnits,
    gatewayNeedUnits,
    gasNeedWei,
    blockers,
    notes,
  }
}

// ── what one flow came to ─────────────────────────────────────────────────────────

export type FlowSettled = { ok: true; result: unknown } | { ok: false; error: unknown }

type ClassifyInput = {
  expected: ExpectedVerdict
  settled: FlowSettled
  /** The DENY signer's sendTransaction was called: the verdict was not DENY and nothing was sent. */
  guardTripped: boolean
  priceUnits: bigint
  amountUnits: bigint
  /** What the payment's gas could cost. 0n for a flow that cannot pay. */
  gasUpperWei: bigint
  decimals: Decimals
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const big = (v: unknown): bigint | null => {
  if (typeof v === 'bigint') return v
  return typeof v === 'string' && DIGITS.test(v) ? BigInt(v) : null
}
const firstLine = (s: string): string => s.split('\n')[0].slice(0, 500)

function costOf(c: { check: bigint; payment: bigint; gasWei: bigint; basis: FlowCosts['basis'] }, d: Decimals): FlowCosts {
  return {
    checkUnits: c.check.toString(),
    paymentUnits: c.payment.toString(),
    gasWei: c.gasWei.toString(),
    totalUnits: (c.check + c.payment + weiToUnitsCeil(c.gasWei, d)).toString(),
    basis: c.basis,
  }
}

/** Payment codes where the transaction was not sent, or the chain has said what it did. */
const NOT_SENT_CODES = new Set(['PREPARED_MISMATCH'])

/**
 * Read one flow's result or error. Decides what it cost, whether it counts, and whether it ends
 * the run. Errors are told apart by name and code, as the SDK documents them, because this file
 * does not import the SDK.
 */
export function classifyFlow(x: ClassifyInput): FlowOutcome {
  const { expected, settled, priceUnits, amountUnits, gasUpperWei, decimals: d } = x
  const base = { flowId: null, flowUrl: null, verdict: null, reputation: null, txHash: null, recorded: false, counted: false, receiptVerified: false, unresolved: false, detail: null }
  const noCost = costOf({ check: 0n, payment: 0n, gasWei: 0n, basis: 'actual' }, d)
  const checkOnly = (check: bigint = priceUnits) => costOf({ check, payment: 0n, gasWei: 0n, basis: 'actual' }, d)
  const worst = costOf({ check: priceUnits, payment: amountUnits, gasWei: gasUpperWei, basis: 'upper_bound' }, d)

  if (settled.ok) {
    const r = isRecord(settled.result) ? settled.result : {}
    const verdict = isRecord(r.verdict) ? r.verdict : {}
    const check = isRecord(r.check) ? r.check : {}
    const record = isRecord(r.record) ? r.record : {}
    const decision = str(verdict.decision)
    const reputation = isRecord(verdict.signals) ? num(verdict.signals.reputationScore) : null
    const seen = { flowId: str(r.flowId), flowUrl: str(record.url), verdict: decision, reputation, recorded: record.recorded === true }
    const paidForCheck = big(check.amountUnits) ?? priceUnits

    if (r.outcome === 'awaiting_human') {
      const pay = isRecord(r.ownerPay) ? r.ownerPay : {}
      return {
        ...base,
        ...seen,
        outcome: 'awaiting_human',
        costs: checkOnly(paidForCheck),
        unexpected: `${decision ?? 'WARN'} where ${expected} was expected: no automatic payment, and the owner's ownerPay is prepared, not sent`,
        detail: `ownerPay from ${String(pay.from)} to ${String(pay.to)}, data ${String(pay.data)}`,
      }
    }
    if (r.outcome === 'executed') {
      const payment = isRecord(r.payment) ? r.payment : {}
      const gasUsed = big(payment.gasUsed) ?? 0n
      const price = big(payment.effectiveGasPrice) ?? 0n
      const paid = big(payment.amountUnits) ?? amountUnits
      // A receipt with no gas figures still cost gas, so the bound stands in for them.
      const read = gasUsed > 0n && price > 0n
      const costs = costOf({ check: paidForCheck, payment: paid, gasWei: read ? gasUsed * price : gasUpperWei, basis: read ? 'actual' : 'upper_bound' }, d)
      const txHash = str(payment.txHash)
      const recordProblem = record.recorded !== true ? `recorded:false (${str(record.reason) ?? str(record.code) ?? 'the server did not record the receipt'})` : record.outcome !== 'executed' ? `the record says ${String(record.outcome)}, not executed` : null
      const wrongVerdict = expected !== 'ALLOW' || decision !== 'ALLOW' ? `${decision} paid where ${expected} was expected` : null
      const unexpected = wrongVerdict ?? (recordProblem ? `the payment went through and ${recordProblem}` : null)
      // The money moved and it does not count, so the next run must not pass this in silence: it
      // would pay a new flow while this one stays pending on the server.
      return { ...base, ...seen, outcome: 'executed', txHash, costs, counted: unexpected === null, receiptVerified: record.recorded === true, unresolved: unexpected !== null, unexpected, detail: payment.transactionReadBack === false ? 'no RPC returned the transaction itself, so only its receipt was compared' : null }
    }
    return { ...base, ...seen, outcome: `unknown:${String(r.outcome)}`, costs: worst, unexpected: `verifyThenPay returned an unknown outcome ${String(r.outcome)}`, unresolved: true }
  }

  const e = isRecord(settled.error) ? settled.error : {}
  const name = str(e.name) ?? 'Error'
  const code = str(e.code)
  const message = firstLine(str(e.message) ?? String(settled.error))
  const said = `${name}${code ? ` ${code}` : ''}: ${message}`

  if (name === 'TrustDenyError') {
    const context = isRecord(e.context) ? e.context : {}
    const check = isRecord(context.check) ? context.check : {}
    const verdict = isRecord(e.verdict) ? e.verdict : {}
    const url = str(context.recordUrl)
    const seen = {
      flowId: str(context.flowId),
      flowUrl: url,
      verdict: str(verdict.decision) ?? 'DENY',
      reputation: isRecord(verdict.signals) ? num(verdict.signals.reputationScore) : null,
      recorded: url !== null,
    }
    const costs = checkOnly(big(check.amountUnits) ?? priceUnits)
    const unexpected = expected !== 'DENY' ? `DENY where ${expected} was expected: ${message}` : url === null ? 'DENY as expected and recorded:false: the check was paid and the server did not write the flow, so it cannot count' : null
    return { ...base, ...seen, outcome: 'refused_deny', costs, counted: unexpected === null, unexpected, detail: Array.isArray(verdict.reasons) ? verdict.reasons.filter((s) => typeof s === 'string').join('; ').slice(0, 500) : null }
  }

  const flowId = str(e.flowId) ?? str(e.authNonce)
  const flowUrl = str(e.recordUrl)
  const seen = { flowId, flowUrl, txHash: str(e.txHash), recorded: flowUrl !== null }

  if (x.guardTripped) {
    return {
      ...base,
      ...seen,
      verdict: 'ALLOW',
      outcome: 'unexpected_allow_not_sent',
      costs: checkOnly(),
      unexpected: `the verdict let the payment through where DENY was expected, and the signer for a DENY flow refused to send it. Nothing moved from the vault. The flow is open on the server: ${message}`,
    }
  }
  if (name === 'GatewayCheckError') {
    const paid = e.paid
    return {
      ...base,
      ...seen,
      outcome: `gateway_error:${code}`,
      costs: paid === false ? noCost : paid === true ? checkOnly() : costOf({ check: priceUnits, payment: 0n, gasWei: 0n, basis: 'upper_bound' }, d),
      unexpected: said,
      unresolved: paid !== true && paid !== false,
      detail: paid === null || paid === undefined ? 'whether the check was paid is not known: look the nonce up on GET /api/x402/gateway/proof' : `check paid: ${String(paid)}`,
    }
  }
  if (name === 'UnusableVerdictError') {
    return { ...base, ...seen, outcome: `verdict_unusable:${code}`, costs: checkOnly(), unexpected: said }
  }
  if (name === 'VaultPolicyError') {
    const afterCheck = e.stage === 'simulation'
    return { ...base, ...seen, outcome: `vault_refused:${code}`, costs: afterCheck ? checkOnly() : noCost, unexpected: said, detail: afterCheck ? 'after the check, which was paid' : 'before the check: nothing was bought' }
  }
  if (name === 'ArcAssetError' || name === 'PayeeNotRegisteredError' || name === 'ArcDependencyError') {
    return { ...base, ...seen, outcome: `refused:${code ?? name}`, costs: noCost, unexpected: said, detail: 'before the check: nothing was bought' }
  }
  if (name === 'VaultPaymentError') {
    if (code !== null && NOT_SENT_CODES.has(code)) return { ...base, ...seen, outcome: `payment_error:${code}`, costs: checkOnly(), unexpected: said, detail: 'nothing was sent' }
    if (code === 'REVERTED') {
      const posted = isRecord(e.record) ? e.record : {}
      return { ...base, ...seen, receiptVerified: posted.recorded === true, outcome: `payment_error:${code}`, costs: costOf({ check: priceUnits, payment: 0n, gasWei: gasUpperWei, basis: 'upper_bound' }, d), unexpected: said, detail: 'the chain says nothing moved; the gas figure is its upper bound' }
    }
    return { ...base, ...seen, outcome: `payment_error:${code}`, costs: worst, unexpected: said, unresolved: true, detail: 'look the hash up (or the nonce, with no hash) before anything else: never send again with a new nonce' }
  }
  return { ...base, ...seen, outcome: `error:${name}`, costs: worst, unexpected: said, unresolved: true, detail: 'an error this runner does not know: counted at the upper bound until someone has looked' }
}

// ── the signer a refusal gets ─────────────────────────────────────────────────────

export type RunSigner = {
  readonly address: string
  signTypedData(r: never): Promise<string>
  sendTransaction(tx: never): Promise<string>
}

/**
 * The signer for a flow expected to DENY: it can sign the Gateway check and it can never send.
 * verifyThenPay pays on ALLOW by itself, so this is what makes "an ALLOW where DENY was
 * expected" a stopped run and not a payment to find afterwards.
 */
export function denyFlowSigner(real: RunSigner): { signer: RunSigner; tripped: () => boolean } {
  let tripped = false
  return {
    tripped: () => tripped,
    signer: {
      address: real.address,
      signTypedData: (r) => real.signTypedData(r),
      sendTransaction: async () => {
        tripped = true
        throw new Error('a flow expected to DENY does not send transactions')
      },
    },
  }
}

// ── the run ───────────────────────────────────────────────────────────────────────

export type RunDeps = {
  allow: number
  deny: number
  baseAmountUnits: bigint
  budgetUnits: bigint
  priceUnits: bigint
  capWei: bigint
  decimals: Decimals
  state: LogState
  payees: { allow: PayeeSpec; deny: PayeeSpec }
  signer: RunSigner
  /** The free checks for this flow. Throws what the flow would throw before its check. */
  preflight(a: { payee: PayeeSpec; amountUnits: bigint }): Promise<{ gasLimit: bigint }>
  verifyThenPay(a: { payee: PayeeSpec; amountUnits: bigint; signer: RunSigner }): Promise<unknown>
  /** Durable before it returns. A throw on an intent means nothing is bought. */
  append(line: RunLogLine): void
  print(s: string): void
  sleep(ms: number): Promise<void>
  pauseMs: number
  now(): string
}

export type RunStop = 'complete' | 'budget' | 'unexpected' | 'log_failed'

export type RunResult = {
  stop: RunStop
  doneAllow: number
  doneDeny: number
  spentUnits: bigint
  ranThisTime: number
  reason: string | null
}

/** One line for one flow. Names the public record whenever the server wrote one. */
function flowReport(progress: string, seq: number, p: PayeeSpec, o: FlowOutcome, spentUnits: bigint, d: Decimals): string {
  const u = (n: bigint) => formatUnits(n, d.usdc)
  const parts = [
    `#${seq}`,
    `payee=${p.label}`,
    `expected=${expectedFor(p.role)}`,
    `verdict=${o.verdict ?? 'none'}`,
    `outcome=${o.outcome}`,
    `cost=${u(BigInt(o.costs.totalUnits))}${o.costs.basis === 'upper_bound' ? ' (upper bound)' : ''}`,
    `spent=${u(spentUnits)}`,
    `counted=${o.counted ? 'yes' : 'no'}`,
    `done=${progress}`,
  ]
  if (o.txHash) parts.push(`tx=${o.txHash}`)
  parts.push(o.flowUrl ? `flow=${o.flowUrl}` : 'flow=none, the server wrote no record')
  if (o.flowUrl && !o.recorded) parts.push('recorded=false')
  return parts.join(' ')
}

/**
 * Run what the log says is left, strictly one flow at a time, refusals first. Returns at the
 * first thing that is not the expected outcome, and at the first flow that could pass the
 * budget. Nothing in here calls verifyThenPay twice for one flow.
 */
export async function runFlows(d: RunDeps): Promise<RunResult> {
  let spentUnits = d.state.spentUnits
  let doneAllow = d.state.doneAllow
  let doneDeny = d.state.doneDeny
  let seq = d.state.nextSeq
  let ranThisTime = 0
  const total = d.allow + d.deny
  const finish = (stop: RunStop, reason: string | null): RunResult => ({ stop, doneAllow, doneDeny, spentUnits, ranThisTime, reason })
  const u = (n: bigint) => `${formatUnits(n, d.decimals.usdc)} USDC`

  for (;;) {
    const role: PayeeRole | null = doneDeny < d.deny ? 'deny' : doneAllow < d.allow ? 'allow' : null
    if (role === null) return finish('complete', null)
    if (ranThisTime > 0) await d.sleep(d.pauseMs)

    const payee = d.payees[role]
    const expected = expectedFor(role)
    const amountUnits = flowAmountUnits(d.baseAmountUnits, seq)
    const lineBase = { v: 1 as const, seq, payee: payee.address, payeeLabel: payee.label, expected, amountUnits: amountUnits.toString() }

    // The free checks first: a vault that would refuse costs nothing to find out about.
    let gasLimit: bigint
    try {
      ;({ gasLimit } = await d.preflight({ payee, amountUnits }))
    } catch (e) {
      const o = classifyFlow({ expected, settled: { ok: false, error: e }, guardTripped: false, priceUnits: d.priceUnits, amountUnits, gasUpperWei: 0n, decimals: d.decimals })
      const line: FlowLine = { ...lineBase, ...o, costs: costOf({ check: 0n, payment: 0n, gasWei: 0n, basis: 'actual' }, d.decimals), unresolved: false, kind: 'flow', at: d.now(), detail: 'the free preflight refused: nothing was bought' }
      d.print(flowReport(`${doneAllow + doneDeny}/${total}`, seq, payee, line, spentUnits, d.decimals))
      d.print(`  ${line.detail}`)
      try {
        d.append(line)
      } catch (err) {
        return finish('log_failed', `the log could not be written: ${String(err)}`)
      }
      ranThisTime += 1
      return finish('unexpected', line.unexpected)
    }

    const gasUpperWei = role === 'allow' ? gasLimit * d.capWei : 0n
    const upperBoundUnits = d.priceUnits + (role === 'allow' ? amountUnits + weiToUnitsCeil(gasUpperWei, d.decimals) : 0n)
    if (spentUnits + upperBoundUnits > d.budgetUnits) {
      return finish('budget', `the next flow can cost ${u(upperBoundUnits)} and ${u(spentUnits)} is already spent, which would pass --budget ${u(d.budgetUnits)}`)
    }

    // The intent reaches the disk before anything can be spent.
    try {
      d.append({ ...lineBase, kind: 'intent', at: d.now(), upperBoundUnits: upperBoundUnits.toString() })
    } catch (err) {
      return finish('log_failed', `the intent could not be written, so nothing was bought: ${String(err)}`)
    }

    const guard = role === 'deny' ? denyFlowSigner(d.signer) : null
    let settled: FlowSettled
    try {
      settled = { ok: true, result: await d.verifyThenPay({ payee, amountUnits, signer: guard ? guard.signer : d.signer }) }
    } catch (e) {
      settled = { ok: false, error: e }
    }
    const o = classifyFlow({ expected, settled, guardTripped: guard?.tripped() ?? false, priceUnits: d.priceUnits, amountUnits, gasUpperWei, decimals: d.decimals })
    const line: FlowLine = { ...lineBase, ...o, kind: 'flow', at: d.now() }

    spentUnits += BigInt(o.costs.totalUnits)
    if (o.counted && role === 'allow') doneAllow += 1
    if (o.counted && role === 'deny') doneDeny += 1
    ranThisTime += 1
    seq += 1

    // Printed first: if the disk fails now, the operator still sees what the money did.
    d.print(flowReport(`${doneAllow + doneDeny}/${total}`, line.seq, payee, o, spentUnits, d.decimals))
    if (o.detail) d.print(`  ${o.detail}`)
    try {
      d.append(line)
    } catch (err) {
      return finish('log_failed', `the flow's result could not be written, and the line above is the only record of it here: ${String(err)}`)
    }
    if (o.unexpected) return finish('unexpected', o.unexpected)
  }
}
