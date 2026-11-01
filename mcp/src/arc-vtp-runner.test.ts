import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import { readRunLog } from './arc-vtp-run.js'
import { getChainById } from './chains/index.js'
import type { FakeScenario } from './arc-vtp-runner.fake.js'

/**
 * scripts/arc-vtp-runner.mjs itself, spawned, with every network answered by the preload in
 * arc-vtp-runner.fake.ts, so nothing here can reach a chain or a server. The first run of this
 * script for real is with real money, so its gates are asserted on what left the process: a
 * PAYMENT-SIGNATURE on a request is a signature, and an eth_sendRawTransaction is a payment.
 *
 * It needs trust-guard built (scripts/prepare-trust-guard.mjs, part of npm test).
 */
const arc = getChainById('arc-mainnet')!
const SCRIPT = fileURLToPath(new URL('../scripts/arc-vtp-runner.mjs', import.meta.url))
const FAKE = new URL('./arc-vtp-runner.fake.js', import.meta.url).href
const MCP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VAULT = '0xe07819e6d28a5dfd5a9f4cd94dc6dc9aeeda4146'
const BASE = 'https://api.fake.test'
const KEY = `0x${'59'.repeat(32)}`
const OPERATOR = privateKeyToAccount(KEY as `0x${string}`).address.toLowerCase()

type Entry = { kind: string; href?: string; method?: string; paid?: boolean; body?: Record<string, unknown> | null }

type Box = { dir: string; home: string; log: string; lock: string }

function box(): Box {
  const dir = mkdtempSync(join(tmpdir(), 'arc-vtp-runner-'))
  const home = join(dir, 'home')
  mkdirSync(home)
  return { dir, home, log: join(dir, 'run.jsonl'), lock: join(home, '.a-identity', `arc-vtp-${VAULT}.lock`) }
}

type Run = { code: number; stdout: string; stderr: string; entries: Entry[]; signatures: Entry[]; rawTxs: Entry[]; receipts: Entry[]; logText: string }

function runner(b: Box, args: string[], o: { key?: string; confirm?: boolean; scenario?: Partial<FakeScenario> } = {}): Promise<Run> {
  const record = join(b.dir, `requests-${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(record, '')
  const scenario: FakeScenario = { record, operator: OPERATOR, baseUrl: BASE, ...o.scenario }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: b.home, ARC_VTP_FAKE: JSON.stringify(scenario) }
  if (o.key !== undefined) env.X402_3009_BUYER_KEY = o.key
  if (o.confirm) env.CONFIRM_ARC_VTP_RUN = 'yes'
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', FAKE, SCRIPT, '--base-url', BASE, '--pause-ms', '0', ...args], { env, cwd: MCP_ROOT, timeout: 90_000 }, (err, stdout, stderr) => {
      const entries = readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry)
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
      resolve({
        code,
        stdout,
        stderr,
        entries,
        signatures: entries.filter((e) => e.paid),
        rawTxs: entries.filter((e) => e.kind === 'raw_tx'),
        receipts: entries.filter((e) => e.href?.endsWith('/receipt')),
        logText: existsSync(b.log) ? readFileSync(b.log, 'utf8') : '',
      })
    })
  })
}

function assertNoKeyLeft(r: Run) {
  const bare = KEY.slice(2)
  for (const [where, text] of [['stdout', r.stdout], ['stderr', r.stderr], ['the log', r.logText], ['a request', JSON.stringify(r.entries)]] as const) {
    assert.ok(!text.includes(bare), `the key is in ${where}`)
  }
}

function assertSpentNothing(r: Run) {
  assert.equal(r.signatures.length, 0, 'nothing signed')
  assert.equal(r.rawTxs.length, 0, 'nothing sent')
  assert.deepEqual(r.entries.filter((e) => e.kind === 'unplanned'), [])
}

const EXEC = ['--deny', '1', '--ack-fresh-log', '--execute']

test('the fake keeps the runner off the network: a URL nobody planned for is an error, on the record', async () => {
  const b = box()
  const r = await runner(b, ['--deny', '1'])
  for (const e of r.entries) assert.notEqual(e.kind, 'unplanned')
  assert.ok(r.entries.some((e) => e.href?.startsWith(BASE)))
  rmSync(b.dir, { recursive: true })
})

test('prepared by default: it plans, signs nothing, sends nothing, needs no key and writes no log', async () => {
  const b = box()
  const r = await runner(b, ['--allow', '1', '--deny', '1', '--log', b.log, '--ack-fresh-log'])
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /PREPARED \(nothing signed, nothing paid\)/)
  assert.match(r.stdout, /The plan fits/)
  assertSpentNothing(r)
  assert.equal(r.logText, '')
  assert.equal(existsSync(b.lock), false, 'a prepared run takes no lock')
  rmSync(b.dir, { recursive: true })
})

test('--execute with no log is a usage error, before anything is read', async () => {
  const b = box()
  const r = await runner(b, ['--deny', '1', '--execute'], { key: KEY, confirm: true })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /--execute needs --log/)
  assert.deepEqual(r.entries, [])
  rmSync(b.dir, { recursive: true })
})

test('no signature without the confirm variable, even with the key and a clean plan', async () => {
  const b = box()
  const r = await runner(b, [...EXEC, '--log', b.log], { key: KEY })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /NOT EXECUTED: --execute also needs CONFIRM_ARC_VTP_RUN=yes/)
  assertSpentNothing(r)
  assert.equal(r.logText, '')
  assert.equal(existsSync(b.lock), false)
  assertNoKeyLeft(r)
  rmSync(b.dir, { recursive: true })
})

test('no signature without the key, with the confirm variable and a clean plan', async () => {
  const b = box()
  const r = await runner(b, [...EXEC, '--log', b.log], { confirm: true })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /NOT EXECUTED: X402_3009_BUYER_KEY is not set/)
  assertSpentNothing(r)
  assert.equal(r.logText, '')
  assert.equal(existsSync(b.lock), false, 'the lock is released on the way out')
  rmSync(b.dir, { recursive: true })
})

test('no signature with a blocker in the plan, with the key and the confirm variable', async () => {
  const b = box()
  const r = await runner(b, [...EXEC, '--log', b.log], { key: KEY, confirm: true, scenario: { gatewayBalance: '0.000000' } })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /REFUSED: 1 reason/)
  assert.match(r.stdout, /Gateway balance: the operator holds 0\.000000 USDC/)
  assert.match(r.stdout, /NOT EXECUTED: the plan was refused/)
  assertSpentNothing(r)
  assert.equal(r.logText, '')
  rmSync(b.dir, { recursive: true })
})

test("a quote that is not the decided price is a blocker, so nothing is signed at the server's number", async () => {
  const b = box()
  const r = await runner(b, [...EXEC, '--log', b.log, '--budget', '10'], { key: KEY, confirm: true, scenario: { price: '50000' } })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /quotes 0\.050000 USDC and the decided price is 0\.005000 USDC/)
  assertSpentNothing(r)
  rmSync(b.dir, { recursive: true })
})

test('a server that raises its quote after the plan is refused by the signing cap, and nothing is signed', async () => {
  const b = box()
  // Call 1 is the plan's; call 2 is the flow's.
  const r = await runner(b, [...EXEC, '--log', b.log], { key: KEY, confirm: true, scenario: { priceLater: { fromCall: 2, price: '50000' } } })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /outcome=gateway_error:PRICE_ABOVE_CAP/)
  assertSpentNothing(r)
  rmSync(b.dir, { recursive: true })
})

test('a held lock refuses before anything is read or signed, and whichever log is named', async () => {
  const b = box()
  mkdirSync(join(b.home, '.a-identity'))
  writeFileSync(b.lock, 'another run\n')
  for (const log of [b.log, join(b.dir, 'another.jsonl')]) {
    const r = await runner(b, [...EXEC, '--log', log], { key: KEY, confirm: true })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /another run holds this vault/)
    assert.deepEqual(r.entries, [], 'nothing left the process')
    assert.equal(existsSync(log), false)
    assert.equal(readFileSync(b.lock, 'utf8'), 'another run\n', 'a refused run does not take the lock from whoever holds it')
  }
  rmSync(b.dir, { recursive: true })
})

test('a key that does not parse is refused without being printed', async () => {
  const b = box()
  const bad = 'not-a-usable-key-value'
  const r = await runner(b, [...EXEC, '--log', b.log], { key: bad, confirm: true })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /X402_3009_BUYER_KEY is set and is not a usable private key/)
  assert.ok(!(r.stdout + r.stderr).includes(bad))
  assert.deepEqual(r.entries, [])
  rmSync(b.dir, { recursive: true })
})

test('with every gate open a refusal signs one check with payOnWarn false, sends nothing, and keeps the key out of everything', async () => {
  const b = box()
  const r = await runner(b, [...EXEC, '--log', b.log], { key: KEY, confirm: true })
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.equal(r.signatures.length, 1)
  assert.equal(r.signatures[0].body?.payOnWarn, false)
  assert.equal(r.rawTxs.length, 0)
  assertNoKeyLeft(r)
  assert.equal(existsSync(b.lock), false)
  const state = readRunLog(r.logText)
  assert.equal(state.header?.vault, VAULT)
  assert.equal(state.header?.baseAmountUnits, '1000')
  assert.equal(state.doneDeny, 1)
  rmSync(b.dir, { recursive: true })
})

test('an allowed flow sends exactly one pay() to the vault, posts its receipt, and counts', async () => {
  const b = box()
  const r = await runner(b, ['--allow', '1', '--ack-fresh-log', '--execute', '--log', b.log], { key: KEY, confirm: true })
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.equal(r.signatures.length, 1)
  assert.equal(r.signatures[0].body?.payOnWarn, false)
  assert.equal(r.rawTxs.length, 1)
  assert.equal(r.receipts.length, 1)
  assertNoKeyLeft(r)
  const state = readRunLog(r.logText)
  assert.equal(state.doneAllow, 1)
  assert.equal(state.flows[0].receiptVerified, true)
  rmSync(b.dir, { recursive: true })
})

test('an ALLOW on a flow expected to DENY is signed for and never sent: the deny signer is wired in', async () => {
  const b = box()
  const r = await runner(b, [...EXEC, '--log', b.log], { key: KEY, confirm: true, scenario: { denyAnswer: 'ALLOW' } })
  assert.equal(r.code, 1)
  assert.equal(r.signatures.length, 1, 'the check was bought')
  assert.equal(r.rawTxs.length, 0, 'the payment never left')
  assert.match(r.stdout, /outcome=unexpected_allow_not_sent/)
  rmSync(b.dir, { recursive: true })
})

test('a torn log refuses to run and says repair, with nothing signed', async () => {
  const b = box()
  writeFileSync(b.log, '{"v":1,"kind":"fl')
  const r = await runner(b, [...EXEC, '--log', b.log], { key: KEY, confirm: true })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /repair the line/)
  assert.doesNotMatch(r.stderr, /repair or move/)
  assertSpentNothing(r)
  assert.equal(existsSync(b.lock), false, 'the lock is released on the way out')
  rmSync(b.dir, { recursive: true })
})

test('a changed --amount-units refuses a log already bound to another base amount', async () => {
  const b = box()
  const first = await runner(b, [...EXEC, '--log', b.log], { key: KEY, confirm: true })
  assert.equal(first.code, 0, first.stderr + first.stdout)
  const r = await runner(b, ['--deny', '2', '--execute', '--log', b.log, '--amount-units', '995'], { key: KEY, confirm: true })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /base amount is 1000 and --amount-units says 995/)
  assertSpentNothing(r)
  rmSync(b.dir, { recursive: true })
})

test('resuming a log signs only what is left, under the amounts it has not used', async () => {
  const b = box()
  await runner(b, [...EXEC, '--log', b.log], { key: KEY, confirm: true })
  const r = await runner(b, ['--deny', '2', '--execute', '--log', b.log], { key: KEY, confirm: true })
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.equal(r.signatures.length, 1)
  assert.equal(r.signatures[0].body?.amount, '1001')
  assert.equal(readRunLog(r.logText).doneDeny, 2)
  rmSync(b.dir, { recursive: true })
})

const priorRow = { payer: OPERATOR, tool: 'risk_check', network: arc.caip2, outcome: 'credited', ts: '2026-10-30T00:00:00.000Z' }

test('a new log is refused when the public proof shows this payer has paid checks, until acknowledged', async () => {
  const b = box()
  const refused = await runner(b, ['--deny', '1', '--execute', '--log', b.log], { key: KEY, confirm: true, scenario: { proofRows: [priorRow] } })
  assert.equal(refused.code, 1)
  assert.match(refused.stdout, /shows 1 risk_check\(s\) from this payer.*--ack-fresh-log/)
  assertSpentNothing(refused)
  assert.equal(refused.logText, '')
  const unreadable = await runner(b, ['--deny', '1', '--execute', '--log', b.log], { key: KEY, confirm: true, scenario: { proofStatus: 500 } })
  assert.match(unreadable.stdout, /public proof could not be read/)
  assertSpentNothing(unreadable)
  const acked = await runner(b, [...EXEC, '--log', b.log], { key: KEY, confirm: true, scenario: { proofRows: [priorRow] } })
  assert.equal(acked.code, 0, acked.stderr + acked.stdout)
  assert.equal(acked.signatures.length, 1)
  rmSync(b.dir, { recursive: true })
})

test("another payer's rows, another tool and another network do not make a log look used", async () => {
  const b = box()
  const proofRows = [{ ...priorRow, payer: '0x' + '12'.repeat(20) }, { ...priorRow, tool: 'verify_agent' }, { ...priorRow, network: 'eip155:1' }, { ...priorRow, outcome: 'unconfirmed' }]
  const r = await runner(b, ['--deny', '1', '--execute', '--log', b.log], { key: KEY, confirm: true, scenario: { proofRows } })
  assert.equal(r.code, 0, r.stderr + r.stdout)
  rmSync(b.dir, { recursive: true })
})

const unrecorded = { verified: false, reason: 'db down' }

test('a paid flow the server did not record blocks the next run, and a plan posts nothing by itself', async () => {
  const b = box()
  const paid = await runner(b, ['--allow', '2', '--ack-fresh-log', '--execute', '--log', b.log], { key: KEY, confirm: true, scenario: { receipt: unrecorded } })
  assert.equal(paid.code, 1)
  assert.equal(paid.rawTxs.length, 1, 'it stops at the first')
  assert.match(paid.stdout, /recorded:false \(db down\)/)
  assert.deepEqual(readRunLog(paid.logText).unresolved, [1])
  const prepared = await runner(b, ['--allow', '2', '--log', b.log], { scenario: { receipt: unrecorded } })
  assert.equal(prepared.code, 1)
  assert.equal(prepared.receipts.length, 0, 'a prepared run writes nothing, so it posts nothing')
  assert.match(prepared.stdout, /no verified record\. --reconcile posts each hash again/)
  const next = await runner(b, ['--allow', '2', '--execute', '--log', b.log], { key: KEY, confirm: true, scenario: { receipt: unrecorded } })
  assert.equal(next.code, 1)
  assert.match(next.stdout, /flow\(s\) 1 whose money nobody has read/)
  assert.equal(next.receipts.length, 1, 'the hash is posted again before the plan')
  assertSpentNothing(next)
  rmSync(b.dir, { recursive: true })
})

test('--reconcile posts the hash again with no key and no confirm, signs nothing, and the flow counts', async () => {
  const b = box()
  const paid = await runner(b, ['--allow', '1', '--ack-fresh-log', '--execute', '--log', b.log], { key: KEY, confirm: true, scenario: { receipt: unrecorded } })
  assert.equal(paid.code, 1)
  const r = await runner(b, ['--reconcile', '--log', b.log])
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.equal(r.receipts.length, 1)
  assertSpentNothing(r)
  const state = readRunLog(r.logText)
  assert.equal(state.doneAllow, 1)
  assert.deepEqual(state.unresolved, [])
  assert.equal(existsSync(b.lock), false)
  const done = await runner(b, ['--allow', '1', '--execute', '--log', b.log], { key: KEY, confirm: true })
  assert.equal(done.code, 0, done.stderr + done.stdout)
  assert.match(done.stdout, /Nothing left to run/)
  assertSpentNothing(done)
  rmSync(b.dir, { recursive: true })
})

test('--execute posts the hash first, so a flow the server records now is not paid for again', async () => {
  const b = box()
  await runner(b, ['--allow', '1', '--ack-fresh-log', '--execute', '--log', b.log], { key: KEY, confirm: true, scenario: { receipt: unrecorded } })
  const r = await runner(b, ['--allow', '1', '--execute', '--log', b.log], { key: KEY, confirm: true })
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.equal(r.receipts.length, 1)
  assertSpentNothing(r)
  assert.match(r.stdout, /Nothing left to run/)
  rmSync(b.dir, { recursive: true })
})

test('--reconcile with nothing to post posts nothing, and --reconcile cannot be combined with --execute', async () => {
  const b = box()
  const quiet = await runner(b, ['--reconcile', '--log', b.log])
  assert.equal(quiet.code, 0, quiet.stderr + quiet.stdout)
  assert.deepEqual(quiet.entries, [])
  const both = await runner(b, ['--reconcile', '--deny', '1', '--execute', '--log', b.log], { key: KEY, confirm: true })
  assert.equal(both.code, 2)
  assert.match(both.stderr, /--reconcile runs alone/)
  const noLog = await runner(b, ['--reconcile'])
  assert.equal(noLog.code, 2)
  rmSync(b.dir, { recursive: true })
})

test('a base URL that only looks local is refused before anything is read', async () => {
  const b = box()
  const r = await runner(b, ['--deny', '1', '--base-url', 'http://localhost:1@evil.example'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /--base-url/)
  assert.deepEqual(r.entries, [])
  rmSync(b.dir, { recursive: true })
})
