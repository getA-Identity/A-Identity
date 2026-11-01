import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessRisk } from './asp/risk.js'
import {
  buildPlan,
  checkSigningCap,
  classifyFlow,
  DECIDED_CHECK_UNITS,
  denyFlowSigner,
  flowAmountUnits,
  forecastVerdict,
  formatUnits,
  freshLogBlocker,
  logBindingError,
  readRunLog,
  receiptGaps,
  reconcileReceipts,
  runFlows,
  RunLogError,
  weiToUnitsCeil,
  type FlowLine,
  type FlowSettled,
  type LogState,
  type PayeeRead,
  type PayeeSpec,
  type PlanInput,
  type RunDeps,
  type RunLogLine,
  type RunSigner,
} from './arc-vtp-run.js'

const D = { usdc: 6, native: 18 }
const GWEI = 1_000_000_000n
const NO_LOG: LogState = { header: null, doneAllow: 0, doneDeny: 0, spentUnits: 0n, nextSeq: 1, unresolved: [], flows: [] }
const ALLOW_PAYEE: PayeeSpec = { role: 'allow', label: 'showcase', address: '0xa', agentId: '#1', note: 'Lift it first.' }
const DENY_PAYEE: PayeeSpec = { role: 'deny', label: 'internal', address: '0xd', agentId: '#0', note: '' }
const CLEAN_ALLOW = { verdict: 'ALLOW' as const, missing: [], caveat: null }
const CLEAN_DENY = { verdict: 'DENY' as const, missing: ['reputation 60 is below 200'], caveat: null }

function read(spec: PayeeSpec, over: Partial<PayeeRead> = {}): PayeeRead {
  return { spec, forecast: spec.role === 'allow' ? CLEAN_ALLOW : CLEAN_DENY, agentsHeld: 1n, gasLimit: 100_000n, preflightError: null, routeError: null, ...over }
}

function planInput(over: Partial<PlanInput> = {}): PlanInput {
  return {
    allow: 2,
    deny: 2,
    baseAmountUnits: 1000n,
    budgetUnits: 750_000n,
    log: NO_LOG,
    operator: '0xop',
    capWei: 60n * GWEI,
    tipWei: GWEI,
    minFeeWei: 20n * GWEI,
    priceUnits: 5000n,
    gatewayUnits: 1_000_000n,
    gasPriceWei: 25n * GWEI,
    operatorGasWei: 10n ** 18n,
    vault: {
      owner: '0xown',
      operator: '0xop',
      frozen: false,
      sessionKeyExpiry: 2000n,
      allowlistEnabled: false,
      autoApproveMax: 250_000n,
      dailyCap: 1_000_000n,
      spentToday: 0n,
      balanceUnits: 1_000_000n,
      blockTimestamp: 1000n,
    },
    payees: [read(ALLOW_PAYEE), read(DENY_PAYEE)],
    decimals: D,
    ...over,
  }
}

function flowLine(seq: number, over: Partial<FlowLine> = {}): FlowLine {
  return {
    v: 1,
    kind: 'flow',
    seq,
    at: '2026-11-01T00:00:00.000Z',
    payee: '0xd',
    payeeLabel: 'internal',
    expected: 'DENY',
    amountUnits: String(999 + seq),
    flowId: `0x${seq}`,
    flowUrl: 'https://x/flows/1',
    verdict: 'DENY',
    reputation: 60,
    outcome: 'refused_deny',
    txHash: null,
    recorded: true,
    costs: { checkUnits: '5000', paymentUnits: '0', gasWei: '0', totalUnits: '5000', basis: 'actual' },
    counted: true,
    receiptVerified: false,
    unexpected: null,
    unresolved: false,
    detail: null,
    ...over,
  }
}

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const intent = (seq: number, upperBoundUnits = '20000') => ({ v: 1, kind: 'intent', seq, at: 'now', payee: '0xa', payeeLabel: 'showcase', expected: 'ALLOW', amountUnits: String(999 + seq), upperBoundUnits })

const executed = (over: Record<string, unknown> = {}) => ({
  outcome: 'executed',
  flowId: '0xflow',
  verdict: { decision: 'ALLOW', signals: { reputationScore: 545 } },
  check: { amountUnits: '5000' },
  payment: { txHash: '0xtx', amountUnits: 1000n, gasUsed: 90_000n, effectiveGasPrice: 25n * GWEI, transactionReadBack: true },
  record: { url: 'https://x/flows/0xflow', recorded: true, outcome: 'executed' },
  ...over,
})

function named(name: string, fields: Record<string, unknown>, message = 'it failed'): Error {
  return Object.assign(new Error(message), { name, ...fields })
}

const denied = (recordUrl: string | undefined = 'https://x/flows/0xflow') =>
  named('TrustDenyError', { verdict: { decision: 'DENY', reasons: ['reputation 60'], signals: { reputationScore: 60 } }, context: { flowId: '0xflow', check: { amountUnits: '5000' }, ...(recordUrl ? { recordUrl } : {}) } })

function classify(settled: FlowSettled, expected: 'ALLOW' | 'DENY' = 'ALLOW', guardTripped = false) {
  return classifyFlow({ expected, settled, guardTripped, priceUnits: 5000n, amountUnits: 1000n, gasUpperWei: expected === 'ALLOW' ? 100_000n * 60n * GWEI : 0n, decimals: D })
}

const realSigner = (sent: unknown[] = []): RunSigner => ({
  address: '0xop',
  signTypedData: async () => '0xsig',
  sendTransaction: async (tx: never) => {
    sent.push(tx)
    return '0xtx'
  },
})

function deps(over: Partial<RunDeps> & { lines?: RunLogLine[]; printed?: string[] } = {}): RunDeps {
  const lines = over.lines ?? []
  const printed = over.printed ?? []
  return {
    allow: 1,
    deny: 1,
    baseAmountUnits: 1000n,
    budgetUnits: 750_000n,
    priceUnits: 5000n,
    capWei: 60n * GWEI,
    decimals: D,
    state: NO_LOG,
    payees: { allow: ALLOW_PAYEE, deny: DENY_PAYEE },
    signer: realSigner(),
    preflight: async () => ({ gasLimit: 100_000n }),
    verifyThenPay: async ({ payee }) => {
      if (payee.role === 'deny') throw denied()
      return executed()
    },
    append: (l) => {
      lines.push(l)
    },
    print: (s) => {
      printed.push(s)
    },
    sleep: async () => {},
    pauseMs: 0,
    now: () => '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

test('every flow pays its own amount, one base unit apart, and gas rounds up rather than down', () => {
  assert.equal(flowAmountUnits(1000n, 1), 1000n)
  assert.equal(flowAmountUnits(1000n, 100), 1099n)
  assert.equal(weiToUnitsCeil(1n, D), 1n)
  assert.equal(weiToUnitsCeil(10n ** 12n, D), 1n)
  assert.equal(weiToUnitsCeil(10n ** 12n + 1n, D), 2n)
  assert.equal(formatUnits(5000n, 6), '0.005000')
  assert.equal(formatUnits(1_250_000n, 6), '1.250000')
})

test('the log counts what is done and what was spent, and a flow with no result costs its whole bound', () => {
  const s = readRunLog(jsonl([intent(1, '5000'), flowLine(1), intent(2), flowLine(2, { expected: 'ALLOW', counted: false, unexpected: 'WARN', costs: { checkUnits: '5000', paymentUnits: '0', gasWei: '0', totalUnits: '5000', basis: 'actual' } }), intent(3, '12345')]))
  assert.equal(s.doneDeny, 1)
  assert.equal(s.doneAllow, 0)
  assert.equal(s.spentUnits, 5000n + 5000n + 12345n)
  assert.equal(s.nextSeq, 4)
  assert.deepEqual(s.unresolved, [3])
})

test('an unresolved flow stays blocked until a human acknowledges it, and still costs its bound after', () => {
  const unknown = flowLine(1, { unresolved: true, counted: false, costs: { checkUnits: '5000', paymentUnits: '1000', gasWei: '0', totalUnits: '6000', basis: 'upper_bound' } })
  assert.deepEqual(readRunLog(jsonl([intent(1), unknown])).unresolved, [1])
  const acked = readRunLog(jsonl([intent(1), unknown, intent(2), { v: 1, kind: 'ack', at: 'now', seqs: [1, 2] }]))
  assert.deepEqual(acked.unresolved, [])
  assert.equal(acked.spentUnits, 6000n + 20000n)
})

test('a log that cannot be read whole refuses to run instead of undercounting', () => {
  assert.throws(() => readRunLog(jsonl([intent(1)]) + '{"v":1,"kind":"fl'), RunLogError)
  assert.throws(() => readRunLog(jsonl([{ v: 2, kind: 'intent', seq: 1 }])), RunLogError)
  assert.throws(() => readRunLog(jsonl([flowLine(1), flowLine(1)])), /repeats the result/)
  assert.throws(() => readRunLog(jsonl([intent(1), intent(1)])), /repeats the intent/)
  assert.equal(readRunLog('').nextSeq, 1)
})

test('the forecast agrees with asp/risk.ts on what each set of signals decides', () => {
  const cases = [
    { score: 545, kya: true, tenure: 100, verified: true, revoked: false, sybil: 'none' as const },
    { score: 470, kya: true, tenure: 100, verified: true, revoked: false, sybil: 'none' as const },
    { score: 60, kya: false, tenure: 0, verified: true, revoked: false, sybil: 'none' as const },
    { score: 545, kya: false, tenure: 100, verified: true, revoked: false, sybil: 'none' as const },
    { score: 545, kya: true, tenure: 3, verified: true, revoked: false, sybil: 'none' as const },
    { score: 545, kya: true, tenure: 100, verified: false, revoked: false, sybil: 'none' as const },
    { score: 545, kya: true, tenure: 100, verified: true, revoked: true, sybil: 'none' as const },
    { score: 545, kya: true, tenure: 100, verified: true, revoked: false, sybil: 'medium' as const },
    { score: 545, kya: true, tenure: 100, verified: true, revoked: false, sybil: 'high' as const },
    { score: 200, kya: true, tenure: 100, verified: true, revoked: false, sybil: 'none' as const },
    { score: 500, kya: true, tenure: 7, verified: true, revoked: false, sybil: 'none' as const },
    { score: 500, kya: true, tenure: 6, verified: true, revoked: false, sybil: 'none' as const },
  ]
  for (const c of cases) {
    const truth = assessRisk({ onchainVerified: c.verified, kyaVerified: c.kya, reputationScore: c.score, tenureDays: c.tenure, revoked: c.revoked, sybil: c.sybil }).decision
    const forecast = forecastVerdict(
      { verified: c.verified, kyaStatus: c.revoked ? 'revoked' : c.kya ? 'verified' : 'unknown', scoreBand: 'ignored when the exact score is there', revoked: c.revoked, sybilSuspected: c.sybil === 'medium' || c.sybil === 'high' },
      { found: true, score: c.score, tenurePoints: Math.round(c.tenure / 2), sybil: c.sybil },
    )
    assert.equal(forecast.verdict, truth, JSON.stringify(c))
  }
})

test('with no exact score the bands decide, and what could not be read is said', () => {
  const preview = { verified: true, kyaStatus: 'verified', scoreBand: 'medium', revoked: false, sybilSuspected: false }
  const medium = forecastVerdict(preview, null)
  assert.equal(medium.verdict, 'ALLOW')
  assert.match(medium.caveat ?? '', /tenure/)
  assert.equal(forecastVerdict({ ...preview, scoreBand: 'low' }, null).verdict, 'WARN')
  assert.equal(forecastVerdict({ ...preview, scoreBand: 'very-low' }, { found: false }).verdict, 'DENY')
  assert.equal(forecastVerdict(null, null).verdict, 'UNKNOWN')
  const short = forecastVerdict(preview, { found: true, score: 470, tenurePoints: 57, sybil: 'none' })
  assert.equal(short.verdict, 'WARN')
  assert.match(short.missing.join(), /short by 30/)
})

test('a clean plan has no blockers, and its bounds are exact: refusals first, unique amounts, gas at the cap', () => {
  const plan = buildPlan(planInput())
  assert.deepEqual(plan.blockers, [])
  assert.deepEqual(plan.remaining, { allow: 2, deny: 2 })
  assert.deepEqual(plan.seqs, { deny: [1, 2], allow: [3, 4] })
  assert.equal(plan.upperBound.checksUnits, 20_000n)
  assert.equal(plan.upperBound.paymentsUnits, 1002n + 1003n)
  assert.equal(plan.upperBound.gasWei, 2n * 100_000n * 60n * GWEI)
  assert.equal(plan.upperBound.gasUnits, 12_000n)
  assert.equal(plan.upperBound.totalUnits, 20_000n + 2005n + 12_000n)
  assert.equal(plan.largestAmountUnits, 1003n)
  assert.equal(plan.feeWei, 51n * GWEI)
})

test('every shortfall refuses the run and names its exact size', () => {
  const says = (over: Partial<PlanInput>, pattern: RegExp) => {
    const { blockers } = buildPlan(planInput(over))
    assert.ok(blockers.some((b) => pattern.test(b)), `${pattern} not in ${JSON.stringify(blockers)}`)
  }
  const vault = planInput().vault!
  says({ budgetUnits: 30_000n }, /--budget 0\.030000 USDC: short by 0\.004005 USDC/)
  says({ gatewayUnits: 15_000n }, /holds 0\.015000 USDC and 4 check\(s\) can cost 0\.020000 USDC: short by 0\.005000 USDC/)
  says({ vault: { ...vault, balanceUnits: 2000n } }, /holds 0\.002000 USDC and the run can need 0\.002005 USDC: short by 0\.000005 USDC/)
  says({ vault: { ...vault, dailyCap: 2000n } }, /daily cap.*over by 0\.000005 USDC/)
  says({ operatorGasWei: 10n ** 16n }, /native gas and the run can need 0\.012000000000000000: short by 0\.002000000000000000 USDC/)
  says({ gatewayUnits: null }, /Gateway balance could not be read/)
  says({ priceUnits: null }, /check price could not be read/)
  says({ operatorGasWei: null }, /gas balance could not be read/)
  says({ gasPriceWei: null }, /gas price could not be read/)
  says({ vault: null }, /vault could not be read/)
  says({ vault: { ...vault, frozen: true } }, /frozen/)
  says({ vault: { ...vault, operator: '0xother' } }, /operator is 0xother/)
  says({ vault: { ...vault, sessionKeyExpiry: 1000n } }, /session key expired/)
  says({ vault: { ...vault, autoApproveMax: 1000n } }, /auto-approve.*over by 0\.000003 USDC/)
  says({ gasPriceWei: 40n * GWEI }, /wants a fee of 81000000000 wei/)
})

test('refusals still need the vault and the gas to pass, with no payment left to pay', () => {
  const vault = planInput().vault!
  const onlyDeny = (over: Partial<PlanInput>) => buildPlan(planInput({ allow: 0, deny: 3, ...over }))
  assert.equal(onlyDeny({}).vaultNeedUnits, 1002n)
  assert.equal(onlyDeny({}).upperBound.gasUnits, 0n)
  assert.equal(onlyDeny({}).upperBound.totalUnits, 15_000n)
  assert.match(onlyDeny({ vault: { ...vault, balanceUnits: 0n } }).blockers.join(), /vault balance/)
  assert.match(onlyDeny({ operatorGasWei: 0n }).blockers.join(), /^gas: /m)
})

test('a payee that will not reach its verdict refuses the run and says what is missing', () => {
  const warn = { verdict: 'WARN' as const, missing: ['reputation 470, and ALLOW needs >= 500: short by 30'], caveat: null }
  const blockers = buildPlan(planInput({ payees: [read(ALLOW_PAYEE, { forecast: warn }), read(DENY_PAYEE, { forecast: warn })] })).blockers
  assert.match(blockers[0], /showcase is planned for 2 ALLOW flow\(s\) and is expected to answer WARN today\. Missing: reputation 470.*short by 30\. Lift it first\./)
  assert.match(blockers[1], /internal is planned for 2 DENY flow\(s\) and is expected to answer WARN/)
  assert.deepEqual(buildPlan(planInput({ allow: 0, payees: [read(ALLOW_PAYEE, { forecast: warn }), read(DENY_PAYEE)] })).blockers, [])
  const noAgent = buildPlan(planInput({ payees: [read(ALLOW_PAYEE, { agentsHeld: 0n }), read(DENY_PAYEE, { agentsHeld: null, routeError: 'PAYEE_UNREGISTERED', preflightError: 'IsFrozen' })] })).blockers.join('|')
  assert.match(noAgent, /showcase holds no agent/)
  assert.match(noAgent, /balanceOf\(internal\) could not be read/)
  assert.match(noAgent, /hosted route refuses internal: PAYEE_UNREGISTERED/)
  assert.match(noAgent, /free preflight refuses internal: IsFrozen/)
})

test('a second run cannot overspend: what the log spent counts against the budget, and only what is left is planned', () => {
  const log: LogState = { ...NO_LOG, doneDeny: 2, doneAllow: 1, spentUnits: 740_000n, nextSeq: 4 }
  const plan = buildPlan(planInput({ log }))
  assert.deepEqual(plan.remaining, { allow: 1, deny: 0 })
  assert.deepEqual(plan.seqs, { deny: null, allow: [4, 4] })
  assert.equal(plan.upperBound.paymentsUnits, 1003n)
  assert.equal(plan.worstCaseUnits, 740_000n + plan.upperBound.totalUnits)
  assert.match(plan.blockers.join(), /on top of the 0\.740000 USDC the log has spent.*short by/)
  const done = buildPlan(planInput({ log: { ...NO_LOG, doneDeny: 2, doneAllow: 2, spentUnits: 900_000n, nextSeq: 5 } }))
  assert.deepEqual(done.remaining, { allow: 0, deny: 0 })
  assert.deepEqual(done.blockers, [])
  assert.match(buildPlan(planInput({ log: { ...NO_LOG, unresolved: [7] } })).blockers.join(), /flow\(s\) 7 whose money nobody has read.*--ack-stop/)
})

test('an executed flow counts at what its receipt says it cost', () => {
  const o = classify({ ok: true, result: executed() })
  assert.equal(o.counted, true)
  assert.equal(o.unexpected, null)
  assert.equal(o.txHash, '0xtx')
  assert.equal(o.reputation, 545)
  assert.deepEqual(o.costs, { checkUnits: '5000', paymentUnits: '1000', gasWei: (90_000n * 25n * GWEI).toString(), totalUnits: (5000n + 1000n + 2250n).toString(), basis: 'actual' })
})

test('a payment the server did not record ends the run and does not count, whatever the chain says', () => {
  const o = classify({ ok: true, result: executed({ record: { url: 'https://x/f', recorded: false, reason: 'TX_ANSWERS_LATER_CHECK' } }) })
  assert.equal(o.counted, false)
  assert.match(o.unexpected ?? '', /recorded:false \(TX_ANSWERS_LATER_CHECK\)/)
  assert.equal(o.costs.basis, 'actual')
  const noGas = classify({ ok: true, result: executed({ payment: { txHash: '0xtx' } }) })
  assert.equal(noGas.costs.basis, 'upper_bound')
  assert.equal(noGas.costs.totalUnits, (5000n + 1000n + 6000n).toString())
})

test('a WARN pays nothing, hands the call to the owner, and ends the run', () => {
  const o = classify({ ok: true, result: { outcome: 'awaiting_human', flowId: '0xflow', verdict: { decision: 'WARN', signals: { reputationScore: 470 } }, check: { amountUnits: '5000' }, ownerPay: { from: '0xown', to: '0xv', data: '0xdata' }, record: { url: 'https://x/f', recorded: true } } })
  assert.equal(o.outcome, 'awaiting_human')
  assert.equal(o.counted, false)
  assert.match(o.unexpected ?? '', /WARN where ALLOW was expected/)
  assert.match(o.detail ?? '', /ownerPay from 0xown/)
  assert.equal(o.costs.totalUnits, '5000')
  assert.equal(o.unresolved, false)
})

test('a DENY counts only where DENY was expected and only when the flow was recorded', () => {
  const good = classify({ ok: false, error: denied() }, 'DENY')
  assert.equal(good.counted, true)
  assert.equal(good.flowUrl, 'https://x/flows/0xflow')
  assert.equal(good.costs.totalUnits, '5000')
  const unrecorded = classify({ ok: false, error: named('TrustDenyError', { verdict: { decision: 'DENY' }, context: { flowId: '0xflow' } }) }, 'DENY')
  assert.equal(unrecorded.counted, false)
  assert.match(unrecorded.unexpected ?? '', /recorded:false/)
  const surprise = classify({ ok: false, error: denied() }, 'ALLOW')
  assert.equal(surprise.counted, false)
  assert.match(surprise.unexpected ?? '', /DENY where ALLOW was expected/)
})

test('every failure is priced by what is known: nothing, the check, or the whole bound until someone looks', () => {
  const failed = (name: string, fields: Record<string, unknown>) => classify({ ok: false, error: named(name, fields) })
  const whole = (5000n + 1000n + 6000n).toString()
  const table: [string, Record<string, unknown>, string, boolean][] = [
    ['GatewayCheckError', { code: 'INSUFFICIENT_GATEWAY_BALANCE', paid: false }, '0', false],
    ['GatewayCheckError', { code: 'TOOL_FAILED_AFTER_SETTLEMENT', paid: true }, '5000', false],
    ['GatewayCheckError', { code: 'NETWORK', paid: null, authNonce: '0xn' }, '5000', true],
    ['UnusableVerdictError', { code: 'SETTLEMENT_MISMATCH', flowId: '0xf' }, '5000', false],
    ['VaultPolicyError', { code: 'IsFrozen', stage: 'preflight' }, '0', false],
    ['VaultPolicyError', { code: 'DailyCapExceeded', stage: 'simulation', flowId: '0xf' }, '5000', false],
    ['PayeeNotRegisteredError', { code: 'PAYEE_UNREGISTERED' }, '0', false],
    ['ArcAssetError', { code: 'WRONG_ASSET' }, '0', false],
    ['VaultPaymentError', { code: 'PREPARED_MISMATCH', flowId: '0xf' }, '5000', false],
    ['VaultPaymentError', { code: 'REVERTED', flowId: '0xf', txHash: '0xt' }, (5000n + 6000n).toString(), false],
    ['VaultPaymentError', { code: 'BROADCAST_FAILED', flowId: '0xf' }, whole, true],
    ['VaultPaymentError', { code: 'UNCONFIRMED', flowId: '0xf', txHash: '0xt' }, whole, true],
    ['VaultPaymentError', { code: 'DROPPED', flowId: '0xf', txHash: '0xt' }, whole, true],
    ['VaultPaymentError', { code: 'LOGS_MISMATCH', flowId: '0xf', txHash: '0xt' }, whole, true],
    ['TypeError', {}, whole, true],
  ]
  for (const [name, fields, total, unresolved] of table) {
    const o = failed(name, fields)
    const where = `${name} ${String(fields.code)}`
    assert.equal(o.costs.totalUnits, total, where)
    assert.equal(o.unresolved, unresolved, where)
    assert.equal(o.counted, false, where)
    assert.ok(o.unexpected, where)
  }
})

test('the signer a refusal gets signs the check and can never send', async () => {
  const sent: unknown[] = []
  const { signer, tripped } = denyFlowSigner(realSigner(sent))
  assert.equal(signer.address, '0xop')
  assert.equal(await signer.signTypedData({} as never), '0xsig')
  assert.equal(tripped(), false)
  await assert.rejects(() => signer.sendTransaction({} as never), /does not send/)
  assert.equal(tripped(), true)
  assert.deepEqual(sent, [])
})

test('a run does the refusals first, one at a time, writes the intent before spending, and reports each flow', async () => {
  const lines: RunLogLine[] = []
  const printed: string[] = []
  const events: string[] = []
  let active = 0
  const result = await runFlows(
    deps({
      allow: 2,
      deny: 2,
      lines,
      printed,
      append: (l) => {
        lines.push(l)
        events.push(l.kind)
      },
      verifyThenPay: async ({ payee, amountUnits }) => {
        active += 1
        assert.equal(active, 1)
        events.push(`pay:${payee.role}:${amountUnits}`)
        await Promise.resolve()
        active -= 1
        if (payee.role === 'deny') throw denied()
        return executed()
      },
    }),
  )
  assert.equal(result.stop, 'complete')
  assert.deepEqual(events, ['intent', 'pay:deny:1000', 'flow', 'intent', 'pay:deny:1001', 'flow', 'intent', 'pay:allow:1002', 'flow', 'intent', 'pay:allow:1003', 'flow'])
  assert.equal(result.doneAllow, 2)
  assert.equal(result.doneDeny, 2)
  assert.equal(result.spentUnits, 2n * 5000n + 2n * (5000n + 1000n + 2250n))
  assert.match(printed.join('\n'), /#1 payee=internal expected=DENY verdict=DENY outcome=refused_deny .*flow=https:\/\/x\/flows\/0xflow/)
  assert.match(printed.join('\n'), /#3 payee=showcase expected=ALLOW verdict=ALLOW outcome=executed .*tx=0xtx/)
  // The log it wrote reads back to the same state.
  const back = readRunLog(jsonl(lines))
  assert.equal(back.spentUnits, result.spentUnits)
  assert.equal(back.doneAllow, 2)
  assert.deepEqual(back.unresolved, [])
})

test('a run stops at the first unexpected outcome and never tries that flow or any other again', async () => {
  for (const [name, flow] of [
    ['WARN where ALLOW was expected', async () => ({ outcome: 'awaiting_human', flowId: '0xf', verdict: { decision: 'WARN' }, check: {}, ownerPay: {}, record: { url: 'u', recorded: true } })],
    ['a Gateway failure', async () => { throw named('GatewayCheckError', { code: 'REFUSED', paid: false }) }],
    ['a receipt failure', async () => { throw named('VaultPaymentError', { code: 'UNCONFIRMED', flowId: '0xf', txHash: '0xt' }) }],
    ['recorded:false', async () => executed({ record: { url: 'u', recorded: false, reason: 'no' } })],
  ] as [string, () => Promise<unknown>][]) {
    let calls = 0
    const lines: RunLogLine[] = []
    const result = await runFlows(deps({ allow: 5, deny: 0, lines, verifyThenPay: () => { calls += 1; return flow() } }))
    assert.equal(result.stop, 'unexpected', name)
    assert.equal(calls, 1, name)
    assert.equal(result.doneAllow, 0, name)
    assert.equal(lines.filter((l) => l.kind === 'flow').length, 1, name)
  }
})

test('an ALLOW where DENY was expected stops with nothing sent', async () => {
  const sent: unknown[] = []
  const result = await runFlows(
    deps({
      allow: 3,
      deny: 3,
      signer: realSigner(sent),
      verifyThenPay: async ({ signer }) => {
        // What verifyThenPay does on ALLOW: it sends, and wraps a failed send.
        try {
          await signer.sendTransaction({} as never)
        } catch (e) {
          throw named('VaultPaymentError', { code: 'BROADCAST_FAILED', flowId: '0xf', recordUrl: 'https://x/f' }, String(e))
        }
        return executed()
      },
    }),
  )
  assert.equal(result.stop, 'unexpected')
  assert.match(result.reason ?? '', /where DENY was expected.*Nothing moved from the vault/)
  assert.deepEqual(sent, [])
  assert.equal(result.spentUnits, 5000n)
})

test('a run stops before the flow that could pass the budget, counting what the log already spent', async () => {
  const lines: RunLogLine[] = []
  let calls = 0
  const result = await runFlows(
    deps({
      allow: 2,
      deny: 0,
      lines,
      // spent 740000; a payment's bound is 5000 + 1000 + 6000 = 12000; the budget is 750000.
      state: { ...NO_LOG, spentUnits: 740_000n },
      verifyThenPay: async () => {
        calls += 1
        return executed()
      },
    }),
  )
  assert.equal(result.stop, 'budget')
  assert.equal(calls, 0)
  assert.deepEqual(lines, [])
  assert.match(result.reason ?? '', /next flow can cost 0\.012000 USDC and 0\.740000 USDC is already spent/)
  // A refusal cannot pay, so its bound is the check alone and it still fits.
  const refusal = await runFlows(deps({ allow: 0, deny: 1, state: { ...NO_LOG, spentUnits: 740_000n } }))
  assert.equal(refusal.stop, 'complete')
})

test('resuming runs only what is left, with new amounts, and a finished log runs nothing', async () => {
  const log = jsonl([intent(1, '5000'), flowLine(1), intent(2, '5000'), flowLine(2)])
  const seen: bigint[] = []
  const state = readRunLog(log)
  const result = await runFlows(deps({ allow: 1, deny: 2, state, verifyThenPay: async ({ payee, amountUnits }) => { assert.equal(payee.role, 'allow'); seen.push(amountUnits); return executed() } }))
  assert.equal(result.stop, 'complete')
  assert.deepEqual(seen, [1002n])
  assert.equal(result.ranThisTime, 1)
  assert.equal(result.spentUnits, 10_000n + 8250n)
  const none = await runFlows(deps({ allow: 0, deny: 2, state }))
  assert.equal(none.stop, 'complete')
  assert.equal(none.ranThisTime, 0)
})

test('the free preflight refusing a flow costs nothing, buys nothing and leaves nothing to acknowledge', async () => {
  const lines: RunLogLine[] = []
  let calls = 0
  const printed: string[] = []
  const result = await runFlows(
    deps({
      lines,
      printed,
      preflight: async () => {
        throw named('VaultPolicyError', { code: 'InsufficientVaultBalance', stage: 'preflight' }, 'the vault holds 0 units')
      },
      verifyThenPay: async () => {
        calls += 1
        return executed()
      },
    }),
  )
  assert.equal(result.stop, 'unexpected')
  assert.equal(calls, 0)
  assert.equal(result.spentUnits, 0n)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'flow')
  const back = readRunLog(jsonl(lines))
  assert.equal(back.spentUnits, 0n)
  assert.deepEqual(back.unresolved, [])
  assert.equal(back.nextSeq, 2)
  assert.match(printed.join('\n'), /nothing was bought/)
})

test('a log that cannot be written stops the run: before a flow nothing is bought, after one the result is printed first', async () => {
  let calls = 0
  const noIntent = await runFlows(deps({ append: () => { throw new Error('disk full') }, verifyThenPay: async () => { calls += 1; return executed() } }))
  assert.equal(noIntent.stop, 'log_failed')
  assert.equal(calls, 0)
  const printed: string[] = []
  const noResult = await runFlows(deps({ printed, append: (l) => { if (l.kind === 'flow') throw new Error('disk full') } }))
  assert.equal(noResult.stop, 'log_failed')
  assert.match(printed.join('\n'), /outcome=refused_deny/)
  assert.match(noResult.reason ?? '', /only record of it here/)
})

// ── a paid flow the server did not record ─────────────────────────────────────────

const TX = '0x' + '77'.repeat(32)
const FLOW = '0x' + 'ab'.repeat(32)
const paidNotRecorded = (seq: number, over: Partial<FlowLine> = {}) =>
  flowLine(seq, {
    payee: '0xa',
    expected: 'ALLOW',
    verdict: 'ALLOW',
    outcome: 'executed',
    flowId: FLOW,
    txHash: TX,
    recorded: false,
    counted: false,
    unresolved: true,
    unexpected: 'the payment went through and recorded:false',
    costs: { checkUnits: '5000', paymentUnits: '1000', gasWei: '0', totalUnits: '6000', basis: 'actual' },
    ...over,
  })
const reconcile = (seq: number, over: Record<string, unknown> = {}) => ({ v: 1, kind: 'reconcile', at: 'now', seq, flowId: FLOW, txHash: TX, recorded: true, outcome: 'executed', detail: 'agent_paid', reason: null, ...over })

test('a payment the server did not record blocks the next run instead of paying a new flow beside it', () => {
  const o = classify({ ok: true, result: executed({ record: { url: 'https://x/f', recorded: false, reason: 'db down' } }) })
  assert.equal(o.unresolved, true)
  assert.equal(o.receiptVerified, false)
  const state = readRunLog(jsonl([intent(1), { ...flowLine(1), ...o, flowId: FLOW, txHash: TX }]))
  assert.deepEqual(state.unresolved, [1])
  assert.equal(state.doneAllow + state.doneDeny, 0)
  assert.match(buildPlan(planInput({ log: state })).blockers.join(), /flow\(s\) 1 whose money nobody has read/)
})

test('a recorded payment is the normal case: verified, counted, and nothing left open', () => {
  const o = classify({ ok: true, result: executed() })
  assert.equal(o.receiptVerified, true)
  assert.equal(o.unresolved, false)
})

test('the record saying anything but executed does not count, and leaves the flow open', () => {
  const o = classify({ ok: true, result: executed({ record: { url: 'https://x/f', recorded: true, outcome: 'blocked' } }) })
  assert.equal(o.counted, false)
  assert.match(o.unexpected ?? '', /the record says blocked, not executed/)
  assert.equal(o.receiptVerified, true)
  assert.equal(o.unresolved, true)
})

for (const [expected, decision] of [['ALLOW', 'WARN'], ['DENY', 'ALLOW']] as const) {
  test(`a payment on ${decision} where ${expected} was expected does not count, and leaves the flow open`, () => {
    const o = classify({ ok: true, result: executed({ verdict: { decision, signals: { reputationScore: 545 } } }) }, expected)
    assert.equal(o.counted, false)
    assert.match(o.unexpected ?? '', new RegExp(`${decision} paid where ${expected} was expected`))
    assert.equal(o.unresolved, true)
  })
}

test('an outcome nobody knows costs the whole bound until someone has looked', () => {
  const o = classify({ ok: true, result: executed({ outcome: 'sideways' }) })
  assert.equal(o.outcome, 'unknown:sideways')
  assert.equal(o.costs.totalUnits, (5000n + 1000n + 6000n).toString())
  assert.equal(o.costs.basis, 'upper_bound')
  assert.equal(o.counted, false)
  assert.equal(o.unresolved, true)
})

test('a revert is verified only when the server said it recorded the revert', () => {
  const failed = (record?: Record<string, unknown>) => classify({ ok: false, error: named('VaultPaymentError', { code: 'REVERTED', flowId: FLOW, txHash: TX, recordUrl: 'https://x/f', ...(record ? { record } : {}) }) })
  assert.equal(failed({ recorded: true }).receiptVerified, true)
  assert.equal(failed({ recorded: false }).receiptVerified, false)
  assert.equal(failed().receiptVerified, false)
})

test('the hashes to post again are the ones with no verified record, acknowledged or not', () => {
  const log = readRunLog(
    jsonl([
      intent(1),
      paidNotRecorded(1),
      intent(2),
      flowLine(2, { txHash: '0x22', flowId: '0xf2', receiptVerified: true, counted: true }),
      intent(3),
      flowLine(3),
      intent(4),
      flowLine(4, { txHash: '0x44', flowId: null, unresolved: true }),
      intent(5),
      flowLine(5, { txHash: '0x55', flowId: '0xf5', outcome: 'payment_error:DROPPED', unresolved: true, counted: false }),
      { v: 1, kind: 'ack', at: 'now', seqs: [5] },
    ]),
  )
  assert.deepEqual(receiptGaps(log), [
    { seq: 1, flowId: FLOW, txHash: TX },
    { seq: 5, flowId: '0xf5', txHash: '0x55' },
  ])
})

test('posting a hash again lets a paid flow count, and changes neither its cost nor the next amount', () => {
  const before = readRunLog(jsonl([intent(1), paidNotRecorded(1)]))
  const after = readRunLog(jsonl([intent(1), paidNotRecorded(1), reconcile(1)]))
  assert.equal(before.doneAllow, 0)
  assert.equal(after.doneAllow, 1)
  assert.deepEqual(after.unresolved, [])
  assert.deepEqual(receiptGaps(after), [])
  assert.equal(after.flows[0].receiptVerified, true)
  assert.equal(after.spentUnits, before.spentUnits)
  assert.equal(after.nextSeq, before.nextSeq)
})

test('a transaction reported as dropped that landed later counts once its hash is recorded, at its bound', () => {
  const dropped = paidNotRecorded(1, { outcome: 'payment_error:DROPPED', verdict: null, costs: { checkUnits: '5000', paymentUnits: '1000', gasWei: '0', totalUnits: '12000', basis: 'upper_bound' } })
  const acked = { v: 1, kind: 'ack', at: 'now', seqs: [1] }
  const after = readRunLog(jsonl([intent(1), dropped, acked, reconcile(1)]))
  assert.equal(after.doneAllow, 1)
  assert.equal(after.spentUnits, 12_000n)
})

test('what the server read decides: a revert closes the flow uncounted, and no record leaves it open', () => {
  const reverted = readRunLog(jsonl([intent(1), paidNotRecorded(1), reconcile(1, { outcome: 'blocked', detail: 'reverted_onchain' })]))
  assert.equal(reverted.doneAllow, 0)
  assert.deepEqual(reverted.unresolved, [])
  const still = readRunLog(jsonl([intent(1), paidNotRecorded(1), reconcile(1, { recorded: false, outcome: null, reason: 'db down' })]))
  assert.equal(still.doneAllow, 0)
  assert.deepEqual(still.unresolved, [1])
  assert.equal(receiptGaps(still).length, 1)
})

test('a payment recorded on a flow that expected DENY never counts as ALLOW, and stays with a human', () => {
  const after = readRunLog(jsonl([intent(1), paidNotRecorded(1, { expected: 'DENY' }), reconcile(1)]))
  assert.equal(after.doneDeny, 0)
  assert.equal(after.doneAllow, 0)
  assert.deepEqual(after.unresolved, [1])
  const wrongVerdict = readRunLog(jsonl([intent(1), paidNotRecorded(1, { verdict: 'WARN' }), reconcile(1)]))
  assert.equal(wrongVerdict.doneAllow, 0)
  assert.deepEqual(wrongVerdict.unresolved, [1])
})

test('a reconcile for a hash the flow never had is refused rather than believed', () => {
  assert.throws(() => readRunLog(jsonl([intent(1), paidNotRecorded(1), reconcile(1, { txHash: '0xother' })])), /names a hash/)
  assert.throws(() => readRunLog(jsonl([reconcile(9)])), /names a hash/)
  assert.throws(() => readRunLog(jsonl([{ v: 1, kind: 'reconcile', seq: 1 }])), /no hash or result/)
})

function reconcileDeps(post: (g: { seq: number }) => Promise<Record<string, unknown>>, gaps = [{ seq: 1, flowId: FLOW, txHash: TX }]) {
  const lines: RunLogLine[] = []
  const printed: string[] = []
  return {
    lines,
    printed,
    run: () =>
      reconcileReceipts({
        gaps,
        post: post as never,
        append: (l) => {
          lines.push(l)
        },
        print: (s) => {
          printed.push(s)
        },
        sleep: async () => {},
        pauseMs: 0,
        now: () => 'now',
      }),
  }
}

test('reconciling writes what the server said, one line per hash, and reads back as counted', async () => {
  const d = reconcileDeps(async () => ({ recorded: true, outcome: 'executed', detail: 'agent_paid' }))
  assert.deepEqual(await d.run(), { posted: 1, recorded: 1 })
  assert.equal(d.lines.length, 1)
  assert.match(d.printed[0], /recorded, executed/)
  assert.equal(readRunLog(jsonl([intent(1), paidNotRecorded(1), ...d.lines])).doneAllow, 1)
})

test('a post that fails or names another flow is written as not recorded, and the rest still go', async () => {
  const seen: number[] = []
  const d = reconcileDeps(
    async (g) => {
      seen.push(g.seq)
      if (g.seq === 1) throw new Error('no route')
      if (g.seq === 2) return { recorded: true, outcome: 'executed', answersFlow: '0x' + 'cd'.repeat(32) }
      return { recorded: false, code: 'TX_ANSWERS_LATER_CHECK' }
    },
    [1, 2, 3].map((seq) => ({ seq, flowId: FLOW, txHash: TX })),
  )
  assert.deepEqual(await d.run(), { posted: 3, recorded: 0 })
  assert.deepEqual(seen, [1, 2, 3])
  const lines = d.lines as { recorded: boolean; reason: string }[]
  assert.deepEqual(lines.map((l) => l.recorded), [false, false, false])
  assert.match(lines[0].reason, /no route/)
  assert.match(lines[1].reason, /answers flow/)
  assert.equal(lines[2].reason, 'TX_ANSWERS_LATER_CHECK')
})

test('a log line that cannot be written stops reconciling before the next post', async () => {
  let posts = 0
  await assert.rejects(
    reconcileReceipts({
      gaps: [1, 2].map((seq) => ({ seq, flowId: FLOW, txHash: TX })),
      post: async () => {
        posts += 1
        return { recorded: true, outcome: 'executed' }
      },
      append: () => {
        throw new Error('disk full')
      },
      print: () => {},
      sleep: async () => {},
      pauseMs: 0,
      now: () => 'now',
    }),
    /disk full/,
  )
  assert.equal(posts, 1)
})

// ── the budget, the amounts and the log they belong to ────────────────────────────

const VAULT_A = '0x' + 'a1'.repeat(20)
const header = (over: Record<string, unknown> = {}) => ({ v: 1, kind: 'header', at: 'now', vault: VAULT_A, baseAmountUnits: '1000', ...over })

test('a header binds a log to one vault and one base amount', () => {
  const run = { vault: VAULT_A, baseAmountUnits: 1000n }
  const log = readRunLog(jsonl([header(), intent(1), flowLine(1)]))
  assert.equal(log.header?.vault, VAULT_A)
  assert.equal(logBindingError(log, run), null)
  assert.equal(logBindingError(log, { ...run, vault: VAULT_A.toUpperCase().replace('0X', '0x') }), null)
  assert.match(logBindingError(log, { ...run, vault: '0x' + 'b2'.repeat(20) }) ?? '', /belongs to vault/)
  assert.match(logBindingError(log, { ...run, baseAmountUnits: 995n }) ?? '', /base amount is 1000 and --amount-units says 995/)
  assert.equal(logBindingError(readRunLog(''), run), null, 'a new log has nothing to disagree with')
  assert.match(logBindingError(readRunLog(jsonl([intent(1), flowLine(1)])), run) ?? '', /no header/)
})

test('a header is only ever the first line, and one with no vault is no header', () => {
  assert.throws(() => readRunLog(jsonl([intent(1), header()])), /only ever the first line/)
  assert.throws(() => readRunLog(jsonl([header(), header()])), /only ever the first line/)
  assert.throws(() => readRunLog(jsonl([header({ vault: undefined })])), /no vault/)
  assert.throws(() => readRunLog(jsonl([header({ baseAmountUnits: 'x' })])), /base amount/)
})

test('an amount two flows share refuses the log: a receipt is linked by its amount', () => {
  // 995 + flow 11 and 1000 + flow 6 both name 1005.
  assert.throws(() => readRunLog(jsonl([{ ...intent(6), amountUnits: '1005' }, { ...intent(11), amountUnits: '1005' }])), /amount 1005 that flow 6 already has/)
  assert.throws(() => readRunLog(jsonl([{ ...intent(1), amountUnits: '1000' }, flowLine(1, { amountUnits: '1001' })])), /another line gives it 1000/)
  assert.throws(() => readRunLog(jsonl([{ ...intent(1), amountUnits: undefined }])), /no amountUnits/)
  assert.throws(() => readRunLog(jsonl([flowLine(1, { amountUnits: 'x' })])), /no amountUnits/)
})

test('a line that cannot be read says to repair the log, and says why moving it is not the way', () => {
  assert.throws(
    () => readRunLog('{"v":1,"kind":"fl'),
    (e: Error) => {
      assert.match(e.message, /repair the line/)
      assert.match(e.message, /Do not move or replace the file/)
      assert.doesNotMatch(e.message, /repair or move/)
      return true
    },
  )
})

test('a new log is refused when the public proof shows this payer has paid checks, unless acknowledged', () => {
  const log = readRunLog('')
  assert.equal(freshLogBlocker({ log, acknowledged: false, prior: { count: 0, latest: null } }), null)
  assert.match(freshLogBlocker({ log, acknowledged: false, prior: { count: 3, latest: '2026-11-01T00:00:00Z' } }) ?? '', /shows 3 risk_check\(s\).*2026-11-01T00:00:00Z.*--ack-fresh-log/)
  assert.match(freshLogBlocker({ log, acknowledged: false, prior: null }) ?? '', /could not be read.*--ack-fresh-log/)
  assert.equal(freshLogBlocker({ log, acknowledged: true, prior: { count: 3, latest: null } }), null)
  assert.equal(freshLogBlocker({ log, acknowledged: true, prior: null }), null)
  const resumed = readRunLog(jsonl([header(), intent(1), flowLine(1)]))
  assert.equal(freshLogBlocker({ log: resumed, acknowledged: false, prior: { count: 3, latest: null } }), null, 'a log with flows is that history')
})

// ── the price ─────────────────────────────────────────────────────────────────────

test('a quote that is not the decided price refuses the plan, and names both', () => {
  assert.equal(DECIDED_CHECK_UNITS, 5000n)
  assert.deepEqual(buildPlan(planInput({ priceUnits: 5000n })).blockers, [])
  const dearer = buildPlan(planInput({ priceUnits: 50_000n, allow: 1, deny: 1, budgetUnits: 10_000_000n })).blockers.join('|')
  assert.match(dearer, /quotes 0\.050000 USDC and the decided price is 0\.005000 USDC/)
  assert.match(buildPlan(planInput({ priceUnits: 4000n })).blockers.join('|'), /quotes 0\.004000 USDC/)
  assert.deepEqual(buildPlan(planInput({ priceUnits: 50_000n, allow: 0, deny: 0 })).blockers, [], 'no flow left, nothing to sign')
})

test('the signing cap never rises above the decided price, whatever the server quotes', () => {
  assert.equal(checkSigningCap(50_000n), 5000n)
  assert.equal(checkSigningCap(5000n), 5000n)
  assert.equal(checkSigningCap(4000n), 4000n)
})
