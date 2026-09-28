import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as algosdk from 'algosdk'
import { Keypair } from '@stellar/stellar-base'
import { advanceBuy, itemAt, loadBuy, nextAffordable, ROUND_USD, saveBuy, statusLines, type BuyCtx } from './buy.js'
import { runCli } from './cli.js'
import { loadWallet } from './wallet.js'
import { loadStellarWallet } from './stellar.js'
import { ALGOD, HORIZON, ORACLE, world } from './world.fixture.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aid-buy-'))
  const a = algosdk.generateAccount()
  const s = Keypair.random()
  const lines: string[] = []
  const w = world()
  const ctx: BuyCtx = {
    algorand: { version: 1, network: 'algorand-mainnet', address: a.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(a.sk), createdAt: '', purpose: '' },
    stellar: { version: 1, network: 'stellar-pubnet', address: s.publicKey(), secret: s.secret(), createdAt: '', purpose: '' },
    statePath: join(dir, 'bridge-state.json'),
    buyPath: join(dir, 'buy-state.json'),
    baseUrl: ORACLE,
    algod: ALGOD,
    horizon: HORIZON,
    fetchImpl: w.fetchImpl,
    out: (l) => lines.push(l),
    now: () => 0,
    sleep: async () => {},
  }
  return { ctx, w, lines, dir }
}

const usdcOf = (w: ReturnType<typeof world>, ctx: BuyCtx) => w.algo.get(ctx.algorand.address)?.usdc ?? 0

test('one round buys all six checks for 44 USDC, and what is left is filled with the cheaper ones', () => {
  assert.equal(ROUND_USD, 44)
  const tools = new Set(Array.from({ length: 7 }, (_, i) => itemAt(i).tool))
  assert.deepEqual([...tools].sort(), ['agent_batch_audit', 'agent_passport', 'pay_check', 'reputation_score', 'risk_check', 'verify_agent'])
  // 3.6 USDC after a full round: the 5 and 10 USDC checks are passed over for a 2 and then a 1.
  const a = nextAffordable(7, 3.6, [])!
  assert.equal(a.item.tool, 'reputation_score')
  const b = nextAffordable(a.index + 1, 1.6, [])!
  assert.equal(b.item.tool, 'verify_agent')
  assert.equal(nextAffordable(b.index + 1, 0.6, []), null)
})

test('250 XLM is spent to the last dollar, then what is left goes home, and a second run pays nothing', async () => {
  const { ctx, w, dir } = setup()
  const home = Keypair.random().publicKey()
  w.xlm.set(home, 5)
  saveBuy(ctx.buyPath, { ...loadBuy(ctx.buyPath), returnTo: home })
  w.xlm.set(ctx.stellar.address, 250)

  assert.equal(await advanceBuy(ctx, 0), 'done')
  const st = loadBuy(ctx.buyPath)
  const paid = st.purchases.filter((p) => p.status === 'paid')
  assert.equal(new Set(paid.map((p) => p.tool)).size, 6, 'every paid check was bought at least once')
  assert.equal(paid.length, w.paid.length, 'one payment per check')
  assert.equal(paid.reduce((s, p) => s + p.usd, 0), 47)
  assert.ok(paid.every((p) => p.receipt && p.answer), 'each check has its answer and its receipt')
  assert.ok(usdcOf(w, ctx) < 1, `under a dollar is left: ${usdcOf(w, ctx)}`)
  assert.ok(!w.xlm.has(ctx.stellar.address), 'the Stellar wallet went home')
  assert.ok((w.xlm.get(home) ?? 0) > 5 + 14, `the ALGO came home as XLM: ${w.xlm.get(home)}`)
  assert.equal(readdirSync(join(dir, 'answers')).length, paid.length, 'every full answer is saved')

  const payments = w.paid.length
  assert.equal(await advanceBuy(ctx, 0), 'done')
  assert.equal(w.paid.length, payments)
})

test('a run that stops after a payment was sent does not pay for that check again', async () => {
  const { ctx, w, lines } = setup()
  w.xlm.set(ctx.stellar.address, 100)
  w.faults.dropAfterSettle = true
  await assert.rejects(() => advanceBuy(ctx, 0), /fetch failed/)
  const stopped = loadBuy(ctx.buyPath).purchases[0]
  assert.equal(stopped.status, 'paying')
  assert.ok(stopped.txId, 'the payment id was written before it was sent')

  assert.equal(await advanceBuy(ctx, 0), 'done')
  const st = loadBuy(ctx.buyPath)
  assert.equal(st.purchases[0].status, 'paid')
  assert.equal(st.purchases[0].receipt, stopped.txId)
  assert.equal(w.paid.filter((p) => p.txId === stopped.txId).length, 1)
  assert.equal(st.purchases.filter((p) => p.status === 'paid').length, w.paid.length, 'no check was paid twice')
  assert.ok(lines.some((l) => /before the run stopped/.test(l)))
})

test('a check whose price went up is refused before signing and skipped, and the rest is still spent', async () => {
  const { ctx, w } = setup()
  w.prices.agent_passport = 12
  w.xlm.set(ctx.stellar.address, 250)
  assert.equal(await advanceBuy(ctx, 0), 'done')
  const st = loadBuy(ctx.buyPath)
  assert.deepEqual(st.skip, ['agent_passport'])
  assert.ok(!w.paid.some((p) => p.tool === 'agent_passport'), 'nothing was paid at the new price')
  assert.ok(usdcOf(w, ctx) < 1, `the money went to the other checks: ${usdcOf(w, ctx)} left`)
})

test('a server error is not an answer: the check is tried again, not skipped', async () => {
  const { ctx, w } = setup()
  w.xlm.set(ctx.stellar.address, 100)
  w.faults.serverErrors = 1
  await assert.rejects(() => advanceBuy(ctx, 0), /upstream unavailable/)
  assert.deepEqual(loadBuy(ctx.buyPath).purchases, [], 'nothing recorded, nothing skipped')
  assert.equal(await advanceBuy(ctx, 0), 'done')
  const first = loadBuy(ctx.buyPath).purchases[0]
  assert.equal(first.tool, 'pay_check')
  assert.equal(first.status, 'paid')
})

test('payments that are signed and turned down stop the run after three, with nothing charged', async () => {
  const { ctx, w } = setup()
  let t = 0
  ctx.now = () => t
  w.xlm.set(ctx.stellar.address, 100)
  w.faults.refusePayment = true
  const usdc = async () => {
    await advanceBuy(ctx, 0).catch(() => undefined)
    return usdcOf(w, ctx)
  }
  const before = await usdc()
  for (let i = 0; i < 3; i++) {
    t += 100_000 // past the wait for a payment that might still land
    await usdc()
  }
  t += 100_000
  await assert.rejects(() => advanceBuy(ctx, 0), /never went through 3 times/)
  assert.equal(usdcOf(w, ctx), before, 'no USDC left the wallet')
  assert.equal(w.paid.length, 0)
})

test('the command says where to send XLM, then the background worker buys everything and sends the rest home', async () => {
  const { w, dir } = setup()
  const env = {
    A_IDENTITY_KEYFILE: join(dir, 'algorand-wallet.json'),
    A_IDENTITY_STELLAR_KEYFILE: join(dir, 'stellar-wallet.json'),
    A_IDENTITY_BRIDGE_STATE: join(dir, 'bridge.json'),
    A_IDENTITY_BUY_STATE: join(dir, 'buy.json'),
    A_IDENTITY_ALGOD_URL: ALGOD,
    A_IDENTITY_HORIZON_URL: HORIZON,
    A_IDENTITY_BASE_URL: ORACLE,
  }
  const spawned: string[][] = []
  const deps = { spawnWorker: (args: string[]) => (spawned.push(args), 4242), isAlive: () => false, sleep: async () => {}, now: () => Date.parse('2026-09-28T12:00:00Z') }
  const home = Keypair.random().publicKey()
  w.xlm.set(home, 5)
  const run = async (...argv: string[]) => {
    const lines: string[] = []
    const code = await runCli(argv, env, (l) => lines.push(l), w.fetchImpl, deps)
    return { code, text: lines.join('\n') }
  }

  const bad = await run('buy', '--return', 'GNOTANADDRESS')
  assert.equal(bad.code, 1)
  assert.equal(spawned.length, 0, 'nothing starts with a wrong return address')

  const start = await run('buy', '--return', home)
  assert.equal(start.code, 0)
  const burner = start.text.match(/\n {2}(G[A-Z2-7]{55})\n/)?.[1]
  assert.ok(burner, start.text)
  assert.match(start.text, /at least 44 XLM/)
  assert.match(start.text, /npx -y @a-identity\/trust-mcp@0\.4\.2 status/)
  assert.deepEqual(spawned, [['buy', '--worker']])
  assert.equal(loadBuy(env.A_IDENTITY_BUY_STATE).worker?.pid, 4242)
  assert.match((await run('status')).text, /Paused/)

  // The worker, run here in the foreground: the XLM lands, the checks are bought, the rest goes home.
  w.xlm.set(burner!, 250)
  assert.equal((await run('buy', '--worker')).code, 0)
  const done = await run('status')
  assert.match(done.text, /^Finished\./)
  assert.match(done.text, /Bought 9 check\(s\) for 47 USDC/)
  assert.equal(loadBuy(env.A_IDENTITY_BUY_STATE).worker, undefined)
})

function cliWorld(extra: Partial<Parameters<typeof runCli>[4]> = {}) {
  const { w, dir } = setup()
  const env = {
    A_IDENTITY_KEYFILE: join(dir, 'algorand-wallet.json'),
    A_IDENTITY_STELLAR_KEYFILE: join(dir, 'stellar-wallet.json'),
    A_IDENTITY_BRIDGE_STATE: join(dir, 'bridge.json'),
    A_IDENTITY_BUY_STATE: join(dir, 'buy.json'),
    A_IDENTITY_ALGOD_URL: ALGOD,
    A_IDENTITY_HORIZON_URL: HORIZON,
    A_IDENTITY_BASE_URL: ORACLE,
  }
  const calls = { spawns: 0 }
  const deps = { spawnWorker: () => (calls.spawns++, 1), isAlive: () => true, sleep: async () => {}, now: () => Date.parse('2026-09-28T12:00:00Z'), ...extra }
  const run = async (...argv: string[]) => {
    const lines: string[] = []
    await runCli(argv, env, (l) => lines.push(l), w.fetchImpl, deps)
    return lines.join('\n')
  }
  const wallets = () => ({ algorand: loadWallet(env.A_IDENTITY_KEYFILE)!.address, stellar: loadStellarWallet(env.A_IDENTITY_STELLAR_KEYFILE)!.address })
  return { w, env, run, calls, wallets }
}

test('each buy after a finished round starts a new one, which waits for new XLM and spends it', async () => {
  const { w, run, calls, wallets } = cliWorld({ isAlive: () => false })
  const burner = (await run('buy')).match(/\n {2}(G[A-Z2-7]{55})\n/)![1]
  w.xlm.set(burner, 60)
  await run('buy', '--worker')
  const first = w.paid.length
  assert.match(await run('status'), /^Finished\./)

  const again = await run('buy')
  assert.equal(calls.spawns, 2, 'a new round starts')
  assert.match(again, /at least 15 XLM/, 'the ALGO is already there, so only the USDC minimum applies')
  assert.doesNotMatch(again, /becomes ALGO/)

  w.xlm.set(burner, (w.xlm.get(burner) ?? 0) + 100)
  await run('buy', '--worker')
  assert.ok(w.paid.length > first, `the new XLM was spent: ${first} then ${w.paid.length} checks`)
  assert.ok((w.algo.get(wallets().algorand)?.usdc ?? 0) < 1, 'to under a dollar')
  assert.match(await run('status'), /^Finished\./)
})

test('on wallets an earlier stellar run funded, buy waits for the new XLM instead of finishing at once', async () => {
  // The worker's first pause is when the XLM arrives, as it would while the person sends it.
  let sent = false
  const { w, run, calls, wallets } = cliWorld({
    sleep: async () => {
      if (!sent) w.xlm.set(wallets().stellar, (w.xlm.get(wallets().stellar) ?? 0) + 250)
      sent = true
    },
  })
  // An earlier session: the wallets were funded and one check was bought, 1.07 USDC is left.
  await run('stellar', 'start')
  w.xlm.set(wallets().stellar, 44)
  await run('stellar', 'run')
  w.algo.get(wallets().algorand)!.usdc = 1.07

  const start = await run('buy')
  assert.equal(calls.spawns, 1)
  assert.match(start, /at least 15 XLM/)
  assert.doesNotMatch(start, /at least 44 XLM/)
  assert.match(start, /already holds 1\.07 USDC from before; that is spent on checks too/)
  assert.match(await run('status'), /^Waiting for your XLM at G/, 'not Finished before any XLM was sent')

  const log = await run('buy', '--worker')
  assert.ok(sent, 'the worker waited for the XLM instead of finishing')
  assert.doesNotMatch(log, /Ready:/, 'waiting on funded wallets does not log the same line on every pass')
  const status = await run('status')
  assert.match(status, /^Finished\./)
  assert.ok(w.paid.length >= 9, `the old USDC and the new XLM were both spent: ${w.paid.length} checks`)
  assert.equal(w.paid[0].tool, 'verify_agent', 'the 1.07 USDC left from before went first, on a 1 USDC check')
  assert.ok((w.algo.get(wallets().algorand)?.usdc ?? 0) < 1)
})

test('buy --new moves wallets someone used before aside and starts this person on new ones', async () => {
  const { w, run, calls, wallets, env } = cliWorld({ isAlive: () => false })
  const first = (await run('buy')).match(/\n {2}(G[A-Z2-7]{55})\n/)![1]
  w.xlm.set(first, 60)
  const worker = await run('buy', '--worker')
  assert.equal((worker.match(/Ready:/g) ?? []).length, 1, 'the way in reports Ready once')
  const before = wallets()

  const fresh = await run('buy', '--new')
  assert.match(fresh, /Made new wallets\. The earlier ones .* were moved aside, not deleted/)
  const after = wallets()
  assert.notEqual(after.stellar, before.stellar)
  assert.notEqual(after.algorand, before.algorand)
  assert.match(fresh, new RegExp(`\\n {2}${after.stellar}\\n`), 'the address shown is the new one')
  assert.match(fresh, /at least 44 XLM/, 'a fresh start, with its own ALGO for fees')
  assert.equal(calls.spawns, 2)
  const kept = readdirSync(join(env.A_IDENTITY_KEYFILE, '..')).filter((f) => f.includes('.closed-'))
  assert.equal(kept.length, 5, `the old wallet files, states and answers were kept: ${kept.join(', ')}`)
  assert.deepEqual(loadBuy(env.A_IDENTITY_BUY_STATE).purchases, [], 'the new person starts with an empty list')

  // Run again during the new round, --new continues it instead of starting yet another.
  const again = await run('buy', '--new')
  assert.match(again, /already under way/)
  assert.equal(wallets().stellar, after.stellar)
})

test('buy --new refuses to set aside wallets that still hold unspent money', async () => {
  const { w, run, calls, wallets } = cliWorld({ isAlive: () => false })
  await run('stellar', 'start')
  w.xlm.set(wallets().stellar, 30)
  const before = wallets()
  const refused = await run('buy', '--new')
  assert.match(refused, /still hold money that was not spent \(30 XLM/)
  assert.deepEqual(wallets(), before)
  assert.equal(calls.spawns, 0)
})

test('status says the XLM is being exchanged while a later deposit turns into USDC', async () => {
  const { ctx } = setup()
  saveBuy(ctx.buyPath, { version: 1, cursor: 0, skip: [], purchases: [], round: 1, waitForXlm: true })
  writeFileSync(ctx.statePath, JSON.stringify({ version: 1, fundIn: { done: true, topUps: [{ id: 's1', depositAddress: 'G', depositMemo: '1', amount: '240', sent: true }] } }))
  const lines = await statusLines(ctx, true)
  assert.match(lines[0], /Your XLM arrived\. Exchanging it for USDC/)
})
