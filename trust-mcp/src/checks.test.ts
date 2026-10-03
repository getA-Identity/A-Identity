import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as algosdk from 'algosdk'
import { askOne, BudgetError, checkBatch, checkBeforePay, keyOf, loadLedger, LoopGuardError, parseTarget, type Gate } from './checks.js'
import { ALGOD, ORACLE, world } from './world.fixture.js'

function setup(usdc = 100) {
  const dir = mkdtempSync(join(tmpdir(), 'aid-checks-'))
  const w = world()
  const a = algosdk.generateAccount()
  const address = a.addr.toString()
  w.algo.set(address, { algo: 1, usdc })
  const clock = { t: Date.parse('2026-10-03T12:00:00Z') }
  const gate: Gate = {
    ledgerPath: join(dir, 'checks.json'),
    baseUrl: ORACLE,
    fetchImpl: w.fetchImpl,
    mnemonic: algosdk.secretKeyToMnemonic(a.sk),
    algod: ALGOD,
    maxUsdPerCall: 10,
    now: () => clock.t,
  }
  const usdcLeft = () => w.algo.get(address)!.usdc ?? 0
  return { w, gate, clock, usdcLeft }
}

const HOUR = 3_600_000
const seller = () => algosdk.generateAccount().addr.toString()

test('the same check of the same target is paid for once; asking again returns the saved answer for free', async () => {
  const { w, gate, usdcLeft } = setup()
  const first = await checkBeforePay(gate, '#849980', 20)
  assert.equal(first.checks[0].source, 'paid')
  assert.equal(first.spentUsd, 5)
  assert.equal(first.budgetLeftUsd, 95)

  const again = await checkBeforePay(gate, '#849980', 20)
  assert.equal(again.checks[0].source, 'cache')
  assert.equal(again.spentUsd, 0)
  assert.deepEqual(again.checks[0].answer, first.checks[0].answer, 'the saved answer is the one that was paid for')
  assert.equal(w.paid.length, 1, 'one payment')
  assert.equal(usdcLeft(), 95)

  // The single tools read the same ledger: the same check through them is not paid again either.
  const single = await askOne(gate, 'risk_check', '849980', 50)
  assert.equal((single.cache as { source: string }).source, 'cache')
  assert.equal(w.paid.length, 1)
})

test('two spellings of one target are one target', async () => {
  const { w, gate } = setup()
  await checkBeforePay(gate, 'https://Proofmint.app/', 0)
  await checkBeforePay(gate, 'proofmint.app', 0)
  const addr = seller()
  await checkBeforePay(gate, addr, 10)
  await checkBeforePay(gate, addr.toLowerCase(), 10)
  assert.equal(w.paid.length, 2)
  assert.equal(parseTarget('#00042').key, '#42')
  assert.equal(parseTarget('42').key, '#42')
  assert.equal(parseTarget(addr).kind, 'payee')
  assert.equal(parseTarget('eip155:8453:8004/73232').kind, 'agent')
})

test('two calls for the same check at the same moment pay once', async () => {
  const { w, gate } = setup()
  const [a, b] = await Promise.all([checkBeforePay(gate, '#7', 20), checkBeforePay(gate, '#7', 20)])
  assert.equal(w.paid.length, 1)
  assert.deepEqual([a.spentUsd, b.spentUsd].sort(), [0, 5])
})

test('a check another process is paying for right now is not paid again, and is taken as abandoned only once it can no longer be', async () => {
  const { w, gate, clock } = setup()
  const key = keyOf({ tool: 'risk_check', subject: parseTarget('#12'), deal: 20 })
  writeFileSync(gate.ledgerPath, JSON.stringify({ version: 1, entries: [{ key, tool: 'risk_check', target: '#12', status: 'paying', payer: '', startedAt: clock.t }], requests: [] }))
  await assert.rejects(() => checkBeforePay(gate, '#12', 20), /being paid for by another call right now/)
  assert.equal(w.paid.length, 0)
  clock.t += 91_000 // reserved and never signed: that call is gone
  assert.equal((await checkBeforePay(gate, '#12', 20)).checks[0].source, 'paid')
  assert.equal(w.paid.length, 1)
})

test('after 24 hours a check is bought again, and the time it is kept cannot be made shorter', async () => {
  const { w, gate, clock } = setup()
  await checkBeforePay(gate, '#9', 20)
  clock.t += 23 * HOUR
  assert.equal((await checkBeforePay(gate, '#9', 20)).checks[0].source, 'cache')
  clock.t += 2 * HOUR
  assert.equal((await checkBeforePay(gate, '#9', 20)).checks[0].source, 'paid')
  assert.equal(w.paid.length, 2)

  clock.t += 2 * HOUR
  const short = await checkBeforePay({ ...gate, cacheHours: 1 }, '#9', 20)
  assert.equal(short.checks[0].source, 'cache', 'cacheHours under 24 reads as 24')
  assert.equal(w.paid.length, 2)
  const zero = await checkBeforePay({ ...gate, cacheHours: 0 }, '#9', 20)
  assert.equal(zero.checks[0].source, 'cache')
})

test('a small payment buys a payment decision, a large one adds the passport, and nothing already known is bought again', async () => {
  const { w, gate } = setup()
  const small = await checkBeforePay(gate, '#11', 20)
  assert.deepEqual(small.checks.map((c) => c.check), ['risk_check'])
  assert.equal(small.tier, 'small')

  const large = await checkBeforePay(gate, '#11', 500)
  assert.deepEqual(large.checks.map((c) => [c.check, c.source]), [['risk_check', 'paid'], ['agent_passport', 'paid']])
  assert.equal(large.checks[0].sizedForUsd, 500)
  assert.deepEqual(w.paid.at(-2)!.body.txContext, { amountUsd: 500 }, 'the decision was sized to the large payment')

  const again = await checkBeforePay(gate, '#11', 800)
  assert.deepEqual(again.checks.map((c) => c.source), ['cache', 'cache'])
  assert.equal((await checkBeforePay(gate, '#11', 20)).checks[0].source, 'cache')
  assert.equal(w.paid.length, 3)

  // An address or a seller gets the one check that takes an address, at any amount.
  const payee = await checkBeforePay(gate, seller(), 5000)
  assert.deepEqual(payee.checks.map((c) => c.check), ['pay_check'])
  assert.deepEqual(w.paid.map((p) => p.tool), ['risk_check', 'risk_check', 'agent_passport', 'pay_check'])
})

test('DENY from any check makes the decision DENY, and the advice is not to pay', async () => {
  const { w, gate } = setup()
  w.decisions['#5'] = 'DENY'
  w.decisions['#6'] = 'WARN'
  const deny = await checkBeforePay(gate, '#5', 500)
  assert.equal(deny.decision, 'DENY')
  assert.equal(deny.advice, 'Do not pay.')
  assert.equal((await checkBeforePay(gate, '#6', 20)).decision, 'WARN')
  assert.equal((await checkBeforePay(gate, '#8', 20)).decision, 'ALLOW')
})

test('check_batch checks a target named twice once, at the larger amount, and pays only for what is new', async () => {
  const { w, gate } = setup()
  await checkBeforePay(gate, '#1', 20)
  const r = await checkBatch(gate, [
    { target: '#1', amount: 20 },
    { target: '#2', amount: 20 },
    { target: '2', amount: 300 },
    { target: 'proofmint.app', amount: 5 },
  ])
  assert.equal(r.duplicates, 1)
  assert.equal(r.results.length, 3)
  const [one, two] = r.results as Awaited<ReturnType<typeof checkBeforePay>>[]
  assert.equal(one.checks[0].source, 'cache')
  assert.deepEqual(two.checks.map((c) => c.check), ['risk_check', 'agent_passport'], '#2 was checked at 300 USD')
  assert.equal(r.spentUsd, 20)
  assert.equal(w.paid.length, 4)
  await assert.rejects(() => checkBatch(gate, Array.from({ length: 21 }, (_, i) => ({ target: `#${i}`, amount: 1 }))), /1 to 20 targets/)
})

test('a call that stops after its payment landed never pays for that check again', async () => {
  const { w, gate } = setup()
  w.faults.dropAfterSettle = true
  await assert.rejects(() => checkBeforePay(gate, '#3', 20), /fetch failed/)
  const open = loadLedger(gate.ledgerPath).entries[0]
  assert.equal(open.status, 'paying')
  assert.ok(open.txId, 'the payment id was written before the answer came back')

  const again = await checkBeforePay(gate, '#3', 20)
  assert.equal(again.checks[0].source, 'cache')
  assert.match(again.checks[0].summary, /answer was lost/)
  assert.equal(again.decision, 'WARN', 'a check without its answer is never read as ALLOW')
  assert.equal(again.checks[0].receipt, open.txId)
  assert.equal(w.paid.length, 1)
})

test('a signed payment that did not land blocks paying for that check again until its last valid round has passed', async () => {
  const { w, gate, clock } = setup()
  w.faults.refusePayment = true
  await assert.rejects(() => checkBeforePay(gate, '#4', 20))
  w.faults.refusePayment = false
  clock.t += 5 * 60_000
  await assert.rejects(() => checkBeforePay(gate, '#4', 20), /could still land until Algorand round 2000/)
  assert.equal(w.paid.length, 0)
  w.chain.round = 3000 // that payment can never land now
  assert.equal((await checkBeforePay(gate, '#4', 20)).checks[0].source, 'paid')
  assert.equal(w.paid.length, 1)
})

test('one target asked for over and over, or many asked for too fast, stops every check for 10 minutes', async () => {
  const { w, gate, clock } = setup(500)
  for (let i = 0; i < 5; i++) await checkBeforePay(gate, '#21', 20)
  assert.equal(w.paid.length, 1)
  await assert.rejects(
    () => checkBeforePay(gate, '#21', 20),
    (e: unknown) => e instanceof LoopGuardError && /#21 was asked for more than 5 times in 10 minutes/.test(e.message) && /Do not retry before then/.test(e.message),
  )
  // Every check is refused during the pause, from this server or another process on the same ledger.
  await assert.rejects(() => checkBeforePay({ ...gate }, '#22', 20), LoopGuardError)
  await assert.rejects(() => askOne(gate, 'verify_agent', '#23'), LoopGuardError)
  assert.equal(w.paid.length, 1)
  clock.t += 10 * 60_000 + 1
  assert.equal((await checkBeforePay(gate, '#22', 20)).checks[0].source, 'paid')

  clock.t += 11 * 60_000
  await checkBatch(gate, Array.from({ length: 20 }, (_, i) => ({ target: `#${100 + i}`, amount: 1 })))
  const paid = w.paid.length
  await assert.rejects(() => checkBatch(gate, Array.from({ length: 11 }, (_, i) => ({ target: `#${200 + i}`, amount: 1 }))), /31 checks were asked for in one minute/)
  assert.equal(w.paid.length, paid)
})

test('without enough USDC nothing is signed, and saved answers are still free', async () => {
  const { w, gate } = setup(12)
  await checkBeforePay(gate, '#31', 20)
  // A large payment: the sized decision fits the budget, the passport does not.
  const partial = await checkBeforePay(gate, '#31', 500)
  assert.deepEqual(partial.checks.map((c) => c.check), ['risk_check'])
  assert.equal(partial.failed?.[0].check, 'agent_passport')
  assert.match(partial.failed![0].error, /costs 10 USDC and the wallet holds 2 USDC/)
  assert.equal(partial.decision, 'WARN', 'an incomplete check is never ALLOW')
  await assert.rejects(() => checkBeforePay(gate, '#32', 20), (e: unknown) => e instanceof BudgetError && e.leftUsd === 2)
  assert.equal((await checkBeforePay(gate, '#31', 20)).checks[0].source, 'cache')
  assert.equal(w.paid.length, 2)
})
