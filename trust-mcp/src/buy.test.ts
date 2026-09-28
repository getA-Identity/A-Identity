import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as algosdk from 'algosdk'
import { Keypair } from '@stellar/stellar-base'
import { advanceBuy, itemAt, loadBuy, nextAffordable, ROUND_USD, saveBuy, type BuyCtx } from './buy.js'
import { runCli } from './cli.js'
import { loadWallet } from './wallet.js'
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
  assert.match(start.text, /npx -y @a-identity\/trust-mcp@0\.4\.0 status/)
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

test('without a return address, XLM sent after the checks were bought starts the worker again', async () => {
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
  let spawns = 0
  const deps = { spawnWorker: () => (spawns++, 1), isAlive: () => false, sleep: async () => {}, now: () => Date.parse('2026-09-28T12:00:00Z') }
  const run = async (...argv: string[]) => {
    const lines: string[] = []
    await runCli(argv, env, (l) => lines.push(l), w.fetchImpl, deps)
    return lines.join('\n')
  }
  const burner = (await run('buy')).match(/\n {2}(G[A-Z2-7]{55})\n/)![1]
  w.xlm.set(burner, 60)
  await run('buy', '--worker')
  const first = w.paid.length
  assert.match(await run('status'), /^Finished\./)

  assert.doesNotMatch(await run('buy'), /Send XLM/, 'finished and nothing new: it only reports')
  assert.equal(spawns, 1)

  w.xlm.set(burner, (w.xlm.get(burner) ?? 0) + 100)
  await run('buy')
  assert.equal(spawns, 2, 'more XLM arrived, so the worker starts again')
  await run('buy', '--worker')
  assert.ok(w.paid.length > first, `the later XLM was spent too: ${first} then ${w.paid.length} checks`)
  assert.ok((w.algo.get(loadWallet(env.A_IDENTITY_KEYFILE)!.address)?.usdc ?? 0) < 1, 'and spent to under a dollar')
})
