import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as algosdk from 'algosdk'
import { Keypair } from '@stellar/stellar-base'
import { advanceBuy, loadBuy, saveBuy, statusLines, type BuyCtx } from './buy.js'
import { retireFiles } from './bridge.js'
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

test('buy spends nothing on its own: the XLM becomes USDC, the spare ALGO too, and it waits for the agent', async () => {
  const { ctx, w, lines } = setup()
  w.xlm.set(ctx.stellar.address, 250)
  assert.equal(await advanceBuy(ctx, 0), 'done')
  assert.equal(w.paid.length, 0, 'not one check was bought without the agent asking for it')
  const left = w.algo.get(ctx.algorand.address)!
  assert.ok((left.usdc ?? 0) > 50, `the whole amount is USDC for checks: ${left.usdc}`)
  assert.ok(left.algo >= 0.2 && left.algo < 0.25, `only what holding USDC needs is left as ALGO: ${left.algo}`)
  assert.ok(lines.some((l) => /Exchanging the 26\.\d+ ALGO left over for USDC/.test(l)))
  assert.ok(lines.some((l) => /^All of it is exchanged: 5\d\.\d+ USDC is in the wallet for checks/.test(l)))
  assert.ok(loadBuy(ctx.buyPath).funded)

  const sends = w.sends.length
  assert.equal(await advanceBuy(ctx, 0), 'done')
  assert.equal(w.sends.length, sends, 'nothing is exchanged twice')
})

function cliWorld(extra: Partial<Parameters<typeof runCli>[4]> = {}) {
  const { w, dir } = setup()
  const env = {
    A_IDENTITY_KEYFILE: join(dir, 'algorand-wallet.json'),
    A_IDENTITY_STELLAR_KEYFILE: join(dir, 'stellar-wallet.json'),
    A_IDENTITY_BRIDGE_STATE: join(dir, 'bridge.json'),
    A_IDENTITY_BUY_STATE: join(dir, 'buy.json'),
    A_IDENTITY_CHECKS_LEDGER: join(dir, 'checks.json'),
    A_IDENTITY_ALGOD_URL: ALGOD,
    A_IDENTITY_HORIZON_URL: HORIZON,
    A_IDENTITY_BASE_URL: ORACLE,
  }
  const calls = { spawns: 0, stopped: [] as number[], code: 0 }
  const clock = { t: Date.parse('2026-09-28T12:00:00Z') }
  const deps = {
    spawnWorker: () => (calls.spawns++, 1),
    isAlive: () => true,
    stopWorker: (pid: number) => void calls.stopped.push(pid),
    sleep: async () => {},
    now: () => clock.t,
    ...extra,
  }
  const run = async (...argv: string[]) => {
    const lines: string[] = []
    calls.code = await runCli(argv, env, (l) => lines.push(l), w.fetchImpl, deps)
    return lines.join('\n')
  }
  const wallets = () => ({ algorand: loadWallet(env.A_IDENTITY_KEYFILE)!.address, stellar: loadStellarWallet(env.A_IDENTITY_STELLAR_KEYFILE)!.address })
  const burner = (text: string) => text.match(/\n {2}(G[A-Z2-7]{55})\n/)![1]
  return { w, env, run, calls, wallets, clock, burner, dir }
}

test('buy says what the money is for and where to send it, the worker only exchanges, and the agent spends it one new check at a time', async () => {
  const { w, run, calls, burner, wallets } = cliWorld({ isAlive: () => false })
  const home = Keypair.random().publicKey()
  w.xlm.set(home, 5)

  const old = await run('buy', '--return', home)
  assert.equal(calls.code, 1)
  assert.match(old, /--return is gone since 0\.4\.5/)
  assert.match(old, /refund --to <YOUR STELLAR ADDRESS>/)
  assert.equal(calls.spawns, 0, 'nothing starts with a flag that no longer exists')

  const start = await run('buy')
  assert.equal(calls.code, 0)
  assert.match(
    start,
    /^Everything you send is spent by your agent on checks of the targets it chooses, each one a different check\.\nIf no new target is left, what remains waits in the wallet; get it back with: npx -y @a-identity\/trust-mcp@0\.4\.5 refund --to <YOUR STELLAR ADDRESS>\n/,
  )
  assert.match(start, /at least 44 XLM/)
  assert.match(start, /claude mcp add a-identity-trust -- npx -y @a-identity\/trust-mcp@0\.4\.5/)
  assert.match(start, /npx -y @a-identity\/trust-mcp@0\.4\.5 status/)
  assert.equal(calls.spawns, 1)
  assert.match(await run('status'), /^Status: Idle \| Spent: 0 USDC \(0 checks\) \| Left: 0 USDC\nPaused/)

  w.xlm.set(burner(start), 250)
  await run('buy', '--worker')
  assert.equal(w.paid.length, 0)
  assert.match(await run('status'), /^Status: Idle \| Spent: 0 USDC \(0 checks\) \| Left: 5\d\.\d+ USDC\nReady: the USDC waits in the wallet/)

  const first = await run('check', '#849980', '20')
  assert.match(first, /^ALLOW: Safe to pay/)
  assert.match(first, /Payment decision: ALLOW {2}\[paid 5 USDC\]/)
  const again = await run('check', '849980', '20')
  assert.match(again, /saved answer from 2026-09-28 12:00 UTC, free/)
  const ask = await run('ask', 'risk', '#849980', '30')
  assert.match(ask, /Saved answer from 2026-09-28 12:00 UTC: nothing was paid this time/)
  assert.equal(w.paid.length, 1, 'one target, one payment')

  const status = await run('status')
  assert.match(status, /^Status: Idle \| Spent: 5 USDC \(1 check\) \| Left: /)
  assert.match(status, /\n1\. Payment decision \(#849980\): ALLOW {2}\[5 USDC\]/)

  // The agent spends what is left down to under a dollar: Finished.
  w.algo.get(wallets().algorand)!.usdc = 0.4
  assert.match(await run('status'), /^Status: Finished \| Spent: 5 USDC \(1 check\) \| Left: 0\.4 USDC/)
})

test('refund sends the USDC and the ALGO back as XLM, merges the Stellar wallet, and stops a worker that was waiting for XLM', async () => {
  const { w, run, calls, burner, wallets, env } = cliWorld({ isAlive: (pid) => pid === 1 })
  const shown = burner(await run('buy'))
  w.xlm.set(shown, 250)
  await run('buy', '--worker')
  await run('check', '#849980', '20')
  await run('buy') // a second round, its worker waiting for XLM that never comes
  const before = wallets()
  const usdc = w.algo.get(before.algorand)!.usdc!
  const home = Keypair.random().publicKey()
  w.xlm.set(home, 5)

  const bad = await run('refund', '--to', before.stellar)
  assert.equal(calls.code, 1)
  assert.match(bad, /is not your Stellar address/)

  const out = await run('refund', '--to', home)
  assert.equal(calls.code, 0, out)
  assert.deepEqual(calls.stopped, [1], 'the waiting worker was stopped first')
  assert.ok(!w.xlm.has(shown), 'the Stellar wallet was merged into the address')
  assert.equal(w.algo.get(before.algorand)?.usdc ?? null, null, 'no USDC is left behind')
  assert.ok((w.xlm.get(home) ?? 0) > 5 + 1.4 + usdc * 4.7 * 0.99, `the USDC came home as XLM: ${w.xlm.get(home)}`)
  assert.match(out, /Done\. Everything that could go back was sent to/)
  assert.match(await run('status'), /^Status: Finished \| Spent: 5 USDC \(1 check\) \| Left: 0 USDC\nRefunded: everything that could go back was sent to G/)

  const sends = w.sends.length
  assert.match(await run('refund', '--to', home), /Nothing to send back/)
  assert.equal(w.sends.length, sends, 'a finished refund sends nothing again')
  assert.ok(loadWallet(env.A_IDENTITY_KEYFILE), 'the wallets stay where they are until the next buy')
})

test('refund also empties wallets an earlier run moved aside', async () => {
  const { w, run, wallets, env } = cliWorld({ isAlive: () => false })
  await run('stellar', 'start')
  const old = wallets()
  w.xlm.set(old.stellar, 30) // XLM sent and never exchanged
  w.algo.set(old.algorand, { algo: 0.5, usdc: 12 }) // USDC no check was bought with
  retireFiles([env.A_IDENTITY_KEYFILE, env.A_IDENTITY_STELLAR_KEYFILE], 1_700_000_000_000)
  const home = Keypair.random().publicKey()
  w.xlm.set(home, 5)

  const out = await run('refund', '--to', home)
  assert.match(out, /Wallets moved aside on 2023-11-14 22:13 UTC/)
  assert.ok(!w.xlm.has(old.stellar), 'the old Stellar wallet was merged into the address')
  assert.equal(w.algo.get(old.algorand)?.usdc ?? null, null, 'the old USDC went back')
  assert.ok((w.xlm.get(home) ?? 0) > 5 + 30 + 12 * 4.7 * 0.99, `everything came home as XLM: ${w.xlm.get(home)}`)

  const sends = w.sends.length
  await run('refund', '--to', home)
  assert.equal(w.sends.length, sends, 'a second refund sends nothing twice')
})

test('refund waits while XLM is still being exchanged, and USDC under the minimum is reported with the way back on Algorand', async () => {
  const { w, run, calls, env, wallets } = cliWorld({ isAlive: () => false })
  await run('stellar', 'start')
  const home = Keypair.random().publicKey()
  w.xlm.set(home, 5)
  writeFileSync(env.A_IDENTITY_BRIDGE_STATE, JSON.stringify({ version: 1, fundIn: { algo: { id: 's9', depositAddress: home, depositMemo: '1', amount: '15', tx: 'abc', sent: true } } }))
  assert.match(await run('refund', '--to', home), /still being exchanged/)
  assert.equal(calls.code, 2)
  assert.equal(w.sends.length, 0)

  writeFileSync(env.A_IDENTITY_BRIDGE_STATE, JSON.stringify({ version: 1, fundIn: { done: true } }))
  w.algo.set(wallets().algorand, { algo: 0.3, usdc: 2 })
  const out = await run('refund', '--to', home)
  assert.match(out, /2 USDC and 0\.3 ALGO in [A-Z2-7]{58} are under SideShift's minimum/)
  assert.match(out, /wallet sweep <YOUR ALGORAND ADDRESS>/)
})

test('each buy after a funded round starts a new one, which waits for new XLM and adds it to the budget', async () => {
  const { w, run, calls, wallets, burner } = cliWorld({ isAlive: () => false })
  const shown = burner(await run('buy'))
  w.xlm.set(shown, 60)
  await run('buy', '--worker')
  const first = w.algo.get(wallets().algorand)!.usdc!
  assert.match(await run('status'), /^Status: Idle/)

  const again = await run('buy')
  assert.equal(calls.spawns, 2, 'a new round starts')
  assert.match(again, /at least 15 XLM/, 'the ALGO is already there, so only the USDC minimum applies')
  assert.doesNotMatch(again, /becomes ALGO/)

  w.xlm.set(shown, (w.xlm.get(shown) ?? 0) + 100)
  await run('buy', '--worker')
  assert.ok(w.algo.get(wallets().algorand)!.usdc! > first + 15, 'the new XLM became USDC too')
  assert.equal(w.paid.length, 0)
  assert.match(await run('status'), /^Status: Idle/)
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
  assert.match(start, /already holds 1\.07 USDC from before; it is part of the same budget/)
  assert.match(await run('status'), /^Status: Running .*\nWaiting for your XLM at G/, 'not funded before any XLM was sent')

  const log = await run('buy', '--worker')
  assert.ok(sent, 'the worker waited for the XLM instead of finishing')
  assert.doesNotMatch(log, /Ready:/, 'waiting on funded wallets does not log the same line on every pass')
  assert.match(await run('status'), /^Status: Idle/)
  assert.ok(w.algo.get(wallets().algorand)!.usdc! > 45, 'the old USDC and the new XLM are one budget')
  assert.equal(w.paid.length, 0)
})

test('buy --new moves wallets someone used up before aside and starts this person on new ones', async () => {
  const { w, run, calls, wallets, env, burner } = cliWorld({ isAlive: () => false })
  const first = burner(await run('buy'))
  w.xlm.set(first, 60)
  const worker = await run('buy', '--worker')
  assert.equal((worker.match(/Ready:/g) ?? []).length, 1, 'the way in reports Ready once')
  const before = wallets()
  w.algo.get(before.algorand)!.usdc = 0.5 // that person's agent spent it

  const fresh = await run('buy', '--new')
  assert.match(fresh, /Made new wallets\. The earlier ones .* were moved aside, not deleted/)
  const after = wallets()
  assert.notEqual(after.stellar, before.stellar)
  assert.notEqual(after.algorand, before.algorand)
  assert.match(fresh, new RegExp(`\\n {2}${after.stellar}\\n`), 'the address shown is the new one')
  assert.match(fresh, /at least 44 XLM/, 'a fresh start, with its own ALGO for fees')
  assert.equal(calls.spawns, 2)
  const kept = readdirSync(join(env.A_IDENTITY_KEYFILE, '..')).filter((f) => f.includes('.closed-'))
  assert.equal(kept.length, 4, `the old wallet files and states were kept: ${kept.join(', ')}`)

  // Run again during the new round, --new continues it instead of starting yet another.
  const again = await run('buy', '--new')
  assert.match(again, /continuing it/)
  assert.equal(wallets().stellar, after.stellar)
})

test('buy --new refuses to set aside wallets that still hold unspent money', async () => {
  const { w, run, calls, wallets } = cliWorld({ isAlive: () => false })
  await run('stellar', 'start')
  w.xlm.set(wallets().stellar, 30)
  const before = wallets()
  const refused = await run('buy', '--new')
  assert.match(refused, /still hold money that was not spent \(30 XLM/)
  assert.match(refused, /refund --to <YOUR STELLAR ADDRESS>/)
  assert.deepEqual(wallets(), before)
  assert.equal(calls.spawns, 0)
})

test('status says the XLM is being exchanged while a later deposit turns into USDC', async () => {
  const { ctx, dir } = setup()
  saveBuy(ctx.buyPath, { version: 1, round: 1, waitForXlm: true })
  writeFileSync(ctx.statePath, JSON.stringify({ version: 1, fundIn: { done: true, topUps: [{ id: 's1', depositAddress: 'G', depositMemo: '1', amount: '240', sent: true }] } }))
  const lines = await statusLines({ ...ctx, ledgerPath: join(dir, 'checks.json') }, true)
  assert.match(lines[0], /^Status: Running \| /)
  assert.match(lines[1], /Your XLM arrived\. Exchanging it for USDC/)
})

test('the checks an earlier version bought count in what was spent', async () => {
  const { ctx, dir, w } = setup()
  w.algo.set(ctx.algorand.address, { algo: 0.2, usdc: 3 })
  writeFileSync(ctx.buyPath, JSON.stringify({ version: 1, cursor: 9, skip: [], finished: '2026-09-28T12:00:00.000Z', purchases: [
    { tool: 'agent_batch_audit', usd: 16, subject: ['#0', '#1', '#2', '#3'], status: 'paid', n: 1, index: 5, answer: '4 agents: 4 allow, 0 warn, 0 deny', receipt: 'TX1' },
    { tool: 'pay_check', usd: 5, subject: 'proofmint.app', status: 'failed', n: 2, index: 6 },
  ] }))
  assert.ok(loadBuy(ctx.buyPath).funded, 'finished in an old state reads as funded')
  const lines = await statusLines({ ...ctx, ledgerPath: join(dir, 'checks.json') }, false)
  assert.match(lines[0], /^Status: Idle \| Spent: 16 USDC \(1 check\) \| Left: 3 USDC$/)
  assert.ok(lines.some((l) => /Group check \(4 agents\).*bought by 0\.4\.4/.test(l)))
})

test('buy --new sets aside an old round that is still waiting for XLM and got none, stopping its worker', async () => {
  // As on a shared computer: someone's round from hours ago, waiting for XLM, its worker still up.
  const { w, run, calls, wallets, clock, burner } = cliWorld({ isAlive: (pid) => pid === 1 })
  const first = burner(await run('buy'))
  w.xlm.set(first, 60)
  await run('buy', '--worker')
  w.algo.get(wallets().algorand)!.usdc = 0.5
  await run('buy') // a new round on funded wallets: waits for XLM that never comes
  const old = wallets()
  clock.t += 2 * 60 * 60 * 1000

  const fresh = await run('buy', '--new')
  assert.deepEqual(calls.stopped, [1], 'the idle worker was stopped')
  assert.match(fresh, /Made new wallets\./)
  assert.match(fresh, /Do not send anything to the earlier Stellar address/)
  assert.match(fresh, /at least 44 XLM/, 'a fresh start, not the funded minimum')
  assert.notEqual(wallets().stellar, old.stellar)
  assert.notEqual(wallets().algorand, old.algorand)
})

test('buy --new run again a few minutes later continues the round this person just started, same address', async () => {
  const { run, calls, wallets, clock, burner } = cliWorld({ isAlive: () => false })
  const shown = burner(await run('buy', '--new'))
  clock.t += 5 * 60 * 1000
  const again = await run('buy', '--new')
  assert.match(again, /continuing it/)
  assert.equal(wallets().stellar, shown)
  assert.match(again, new RegExp(`\\n {2}${shown}\\n`))
  assert.deepEqual(calls.stopped, [])
})

test('state left without its wallets is set aside, so new wallets are never taken for funded ones', async () => {
  const { run, env } = cliWorld({ isAlive: () => false })
  writeFileSync(env.A_IDENTITY_BRIDGE_STATE, JSON.stringify({ version: 1, fundIn: { done: true } }))
  saveBuy(env.A_IDENTITY_BUY_STATE, { version: 1, round: 2, waitForXlm: true })
  const out = await run('buy')
  assert.match(out, /at least 44 XLM/)
  assert.doesNotMatch(out, /at least 15 XLM/)
  assert.equal(loadBuy(env.A_IDENTITY_BUY_STATE).round, 1)
})
