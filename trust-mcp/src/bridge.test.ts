import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as algosdk from 'algosdk'
import { Keypair } from '@stellar/stellar-base'
import { planIn, runBack, runIn, loadState, type Ctx } from './bridge.js'
import { ALGOD, HORIZON, RATE, world } from './world.fixture.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aid-bridge-'))
  const a = algosdk.generateAccount()
  const s = Keypair.random()
  const lines: string[] = []
  const w = world()
  const ctx: Ctx = {
    algorand: { version: 1, network: 'algorand-mainnet', address: a.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(a.sk), createdAt: '', purpose: '' },
    stellar: { version: 1, network: 'stellar-pubnet', address: s.publicKey(), secret: s.secret(), createdAt: '', purpose: '' },
    statePath: join(dir, 'state.json'),
    algod: ALGOD,
    horizon: HORIZON,
    fetchImpl: w.fetchImpl,
    out: (l) => lines.push(l),
    now: () => 0,
    sleep: async () => {},
  }
  return { ctx, w, lines }
}

test('the XLM needed for one check is sized from live rates, with the ALGO leg big enough to come back', () => {
  const p = planIn({ min: 14.39, rate: RATE.algo }, { min: 14.39, rate: RATE.usdc })
  assert.ok(p.algoXlm * RATE.algo >= 26.5, 'the ALGO received clears the way-back minimum with room for fees')
  assert.ok(p.usdcXlm * RATE.usdc >= 5.1, 'enough USDC for one 5 USDC check')
  assert.equal(p.totalXlm, 44)
  assert.equal(p.perExtraCheckXlm, 25)
})

test('one XLM deposit becomes ALGO, an opt-in and USDC, and running again sends nothing twice', async () => {
  const { ctx, w, lines } = setup()
  assert.equal(await runIn(ctx, 0), false, 'waits while nothing has arrived')
  assert.match(lines.join('\n'), /Send at least 44 XLM/)

  w.xlm.set(ctx.stellar.address, 60)
  assert.equal(await runIn(ctx), true)
  const a = w.algo.get(ctx.algorand.address)!
  assert.ok(a.algo > 26, `ALGO landed: ${a.algo}`)
  assert.ok((a.usdc ?? 0) >= 5, `USDC landed: ${a.usdc}`)
  assert.ok(Math.abs((w.xlm.get(ctx.stellar.address) ?? 0) - 1.5) < 0.01, 'only the reserve is left on Stellar')
  const sent = w.sends.length
  assert.deepEqual(w.sends.map((x) => x.split(':')[0]), ['xlm', 'xlm'], 'XLM into the ALGO shift, then into the USDC shift')
  assert.notEqual(a.usdc, null, 'the wallet opted in to USDC in between')

  assert.equal(await runIn(ctx), true)
  assert.equal(w.sends.length, sent, 'a second run sends nothing')
  assert.equal(loadState(ctx.statePath).fundIn.done, true)
})

test('the way back merges the Stellar wallet and sends the ALGO and the USDC home as XLM', async () => {
  const { ctx, w } = setup()
  w.xlm.set(ctx.stellar.address, 60)
  await runIn(ctx)
  const home = Keypair.random().publicKey()
  w.xlm.set(home, 5)
  await assert.rejects(() => runBack(ctx, 'not-an-address'), /not a Stellar address/)

  assert.equal(await runBack(ctx, home), true)
  assert.ok(!w.xlm.has(ctx.stellar.address), 'the Stellar wallet was merged away')
  assert.ok(!w.algo.has(ctx.algorand.address), 'the Algorand wallet was closed')
  assert.ok((w.xlm.get(home) ?? 0) > 5 + 1.4 + 14, `XLM came home: ${w.xlm.get(home)}`)
  const sent = w.sends.length
  assert.equal(await runBack(ctx, home), true)
  assert.equal(w.sends.length, sent, 'a finished return sends nothing again')
  await assert.rejects(() => runBack(ctx, Keypair.random().publicKey()), /already under way/)
})
