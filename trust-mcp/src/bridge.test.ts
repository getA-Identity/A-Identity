import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as algosdk from 'algosdk'
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-base'
import { planIn, runBack, runIn, loadState, type Ctx } from './bridge.js'
import { USDC_ASSET } from './wallet.js'

const HORIZON = 'https://horizon.test'
const ALGOD = 'https://mainnet-api.test'
const RATE = { algo: 1.694, usdc: 0.2045, algoBack: 0.565, usdcBack: 4.7 }

/**
 * A small ledger for both chains plus SideShift: payments land, shifts settle once their deposit
 * arrived, and every send is counted, so a test can prove nothing is sent twice.
 */
function world() {
  const xlm = new Map<string, number>()
  const seq = new Map<string, bigint>()
  const algo = new Map<string, { algo: number; usdc: number | null }>()
  const shifts = new Map<string, { from: string; to: string; settle: string; deposit: string; memo: string | null; received: number }>()
  const sends: string[] = []
  let n = 0
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })

  const deposit = (to: string, amount: number, via: string) => {
    for (const [, s] of shifts) if (s.deposit === to) s.received += amount
    sends.push(`${via}:${to}:${amount}`)
  }

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const path = url.pathname
    // SideShift
    if (url.hostname === 'sideshift.ai') {
      const pm = path.match(/\/pair\/([a-z]+-[a-z]+)\/([a-z]+-[a-z]+)$/)
      if (pm) {
        const key = `${pm[1]}>${pm[2]}`
        const rates: Record<string, [number, number]> = {
          'xlm-stellar>algo-algorand': [14.39, RATE.algo],
          'xlm-stellar>usdc-algorand': [14.39, RATE.usdc],
          'algo-algorand>xlm-stellar': [24.86, RATE.algoBack],
          'usdc-algorand>xlm-stellar': [3.0, RATE.usdcBack],
        }
        const [min, rate] = rates[key]
        return json({ min: String(min), max: '100000', rate: String(rate) })
      }
      if (path.endsWith('/shifts/variable')) {
        const b = JSON.parse(String(init!.body))
        const id = `s${++n}`
        const fromStellar = b.depositNetwork === 'stellar'
        const dep = fromStellar ? Keypair.random().publicKey() : algosdk.generateAccount().addr.toString()
        if (fromStellar) xlm.set(dep, 10)
        else algo.set(dep, { algo: 1, usdc: 0 })
        shifts.set(id, { from: `${b.depositCoin}-${b.depositNetwork}`, to: `${b.settleCoin}-${b.settleNetwork}`, settle: b.settleAddress, deposit: dep, memo: fromStellar ? String(1000 + n) : null, received: 0 })
        return json({ id, depositAddress: dep, depositMemo: fromStellar ? String(1000 + n) : undefined, depositMin: '1', status: 'waiting' })
      }
      const sm = path.match(/\/shifts\/(s\d+)$/)
      if (sm) {
        const s = shifts.get(sm[1])!
        if (s.received <= 0) return json({ status: 'waiting' })
        if (!(s as { paid?: boolean }).paid) {
          ;(s as { paid?: boolean }).paid = true
          const out =
            s.to === 'algo-algorand' ? s.received * RATE.algo : s.to === 'usdc-algorand' ? s.received * RATE.usdc : s.from === 'algo-algorand' ? s.received * RATE.algoBack : s.received * RATE.usdcBack
          if (s.to === 'xlm-stellar') xlm.set(s.settle, (xlm.get(s.settle) ?? 0) + out)
          else {
            const a = algo.get(s.settle) ?? { algo: 0, usdc: null }
            if (s.to === 'algo-algorand') a.algo += out
            else a.usdc = (a.usdc ?? 0) + out
            algo.set(s.settle, a)
          }
        }
        return json({ status: 'settled', settleHash: `h-${sm[1]}`, settleAmount: '1' })
      }
    }
    // Horizon
    if (url.hostname === 'horizon.test') {
      const am = path.match(/^\/accounts\/(G[A-Z2-7]{55})$/)
      if (am) {
        if (!xlm.has(am[1])) return json({}, 404)
        return json({ sequence: String(seq.get(am[1]) ?? 100n), subentry_count: 0, balances: [{ asset_type: 'native', balance: String(xlm.get(am[1])) }] })
      }
      if (path.startsWith('/transactions/')) return json({}, 404)
      if (path === '/transactions') {
        const tx = TransactionBuilder.fromXDR(decodeURIComponent(String(init!.body).slice(3)), Networks.PUBLIC) as unknown as { source: string; operations: { type: string; destination: string; amount?: string }[]; hash(): Buffer }
        const op = tx.operations[0]
        const from = tx.source
        seq.set(from, (seq.get(from) ?? 100n) + 1n)
        if (op.type === 'payment') {
          xlm.set(from, (xlm.get(from) ?? 0) - Number(op.amount))
          xlm.set(op.destination, (xlm.get(op.destination) ?? 0) + Number(op.amount))
          deposit(op.destination, Number(op.amount), 'xlm')
        } else {
          xlm.set(op.destination, (xlm.get(op.destination) ?? 0) + (xlm.get(from) ?? 0))
          sends.push(`merge:${op.destination}`)
          xlm.delete(from)
        }
        return json({ hash: tx.hash().toString('hex') })
      }
    }
    // algod and indexer
    const acc = path.match(/^\/v2\/accounts\/([A-Z2-7]{58})$/)
    if (acc) {
      const a = algo.get(acc[1])
      if (!a) return json({ message: 'no accounts found' }, 404)
      return json({ amount: Math.round(a.algo * 1e6), 'min-balance': a.usdc === null ? 100_000 : 200_000, assets: a.usdc === null ? [] : [{ 'asset-id': USDC_ASSET, amount: Math.round(a.usdc * 1e6) }] })
    }
    if (path === '/v2/transactions/params') return json({ 'last-round': 1000, 'min-fee': 1000, 'genesis-id': 'mainnet-v1.0', 'genesis-hash': 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' })
    if (path === '/v2/assets/' + USDC_ASSET) return json({ params: { creator: algosdk.generateAccount().addr.toString() } })
    if (path.startsWith('/v2/transactions/pending/')) return json({ 'confirmed-round': 5 })
    if (path.startsWith('/v2/transactions/') && url.hostname.includes('-idx.')) return json({}, 404)
    if (path === '/v2/transactions' && init?.method === 'POST') {
      const stx = algosdk.decodeSignedTransaction(init.body as Uint8Array)
      const t = stx.txn
      const from = t.sender.toString()
      const a = algo.get(from)!
      a.algo -= 0.001
      if (t.type === 'axfer') {
        const to = t.assetTransfer!.receiver.toString()
        const close = t.assetTransfer!.closeRemainderTo?.toString()
        if (to === from && !close) a.usdc = a.usdc ?? 0
        else {
          const amt = close ? a.usdc ?? 0 : Number(t.assetTransfer!.amount) / 1e6
          a.usdc = close ? null : (a.usdc ?? 0) - amt
          deposit(close ?? to, amt, 'usdc')
        }
      } else {
        const close = t.payment!.closeRemainderTo?.toString()
        const amt = close ? a.algo : Number(t.payment!.amount) / 1e6
        a.algo -= amt
        if (close) algo.delete(from)
        deposit(close ?? t.payment!.receiver.toString(), amt, 'algo')
      }
      return json({ txId: t.txID() })
    }
    return json({ message: `unexpected ${input}` }, 500)
  }
  return { fetchImpl: fetchImpl as never, xlm, algo, sends }
}

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
