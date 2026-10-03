/**
 * A small fake of everything the XLM flow talks to, for tests: Horizon, algod and its indexer,
 * SideShift, the x402 facilitator and the A-Identity oracle. Payments land, shifts settle once
 * their deposit arrived, paid checks move USDC, and every send is counted, so a test can prove
 * nothing is sent or paid twice.
 */
import * as algosdk from 'algosdk'
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-base'
import { USDC_ASSET } from './wallet.js'

export const HORIZON = 'https://horizon.test'
export const ALGOD = 'https://mainnet-api.test'
export const ORACLE = 'https://oracle.test'
export const RATE = { algo: 1.694, usdc: 0.2045, algoBack: 0.565, usdcBack: 4.7, algoUsdc: 0.126 }
const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='

/** The oracle's prices, as the live Algorand rail sells them. */
export const PRICES: Record<string, number> = { verify_agent: 1, reputation_score: 2, risk_check: 5, agent_passport: 10, pay_check: 5 }

export function world() {
  const xlm = new Map<string, number>()
  const seq = new Map<string, bigint>()
  const algo = new Map<string, { algo: number; usdc: number | null }>()
  const shifts = new Map<string, { from: string; to: string; settle: string; deposit: string; memo: string | null; received: number }>()
  const sends: string[] = []
  const landed = new Set<string>()
  const paid: { tool: string; usd: number; txId: string; body: Record<string, unknown> }[] = []
  const payTo = algosdk.generateAccount().addr.toString()
  const feePayer = algosdk.generateAccount().addr.toString()
  const prices = { ...PRICES }
  /** risk_check (and the passport's risk) per agent id; ALLOW unless set. */
  const decisions: Record<string, 'ALLOW' | 'WARN' | 'DENY'> = {}
  /** The chain's last round; tests move it on to let a signed payment expire. */
  const chain = { round: 1000 }
  /**
   * dropAfterSettle: the next paid call settles, then the connection drops before the answer.
   * serverErrors: that many oracle calls answer 503. refusePayment: every payment is turned down.
   */
  const faults = { dropAfterSettle: false, serverErrors: 0, refusePayment: false }
  let n = 0
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })

  const deposit = (to: string, amount: number, via: string) => {
    for (const [, s] of shifts) if (s.deposit === to) s.received += amount
    sends.push(`${via}:${to}:${amount}`)
  }

  const answer = (tool: string, body: Record<string, unknown>): Record<string, unknown> => {
    if (tool === 'pay_check') return { address: body.address, verdict: 'safe', headline: 'Looks safe to pay', reasons: [{ text: 'On Algorand since 2025.' }] }
    if (tool === 'risk_check') {
      const decision = decisions[String(body.agentId)] ?? 'ALLOW'
      return { tool, agentId: body.agentId, decision, reasons: decision === 'ALLOW' ? [] : ['Reputation is below the safe threshold'], txContext: body.txContext ?? null }
    }
    if (tool === 'reputation_score') return { tool, agentId: body.agentId, score: 612 }
    if (tool === 'verify_agent') return { tool, agentId: body.agentId, verified: true, kya_status: 'verified', revoked: false }
    if (tool === 'agent_passport') return { tool, agentId: body.agentId, verified: true, reputation: { score: 612 }, risk: { decision: decisions[String(body.agentId)] ?? 'ALLOW' } }
    const ids = body.agentIds as string[]
    return { tool, count: ids.length, summary: { ALLOW: ids.length, WARN: 0, DENY: 0 } }
  }

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const path = url.pathname
    // The A-Identity oracle: 402 until paid, then the payment settles and the answer comes back.
    if (url.origin === ORACLE) {
      const tool = path.split('/').pop()!
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      const usd = tool === 'agent_batch_audit' ? 4 * (body.agentIds as string[]).length : prices[tool]
      const sig = (init?.headers as Record<string, string> | undefined)?.['PAYMENT-SIGNATURE']
      if (faults.serverErrors > 0) {
        faults.serverErrors--
        return json({ error: 'upstream unavailable' }, 503)
      }
      if (sig && faults.refusePayment) return json({ x402Version: 2, error: 'payment refused', accepts: [] }, 402)
      if (!sig) {
        return json(
          {
            x402Version: 2,
            resource: { url: input, description: tool, mimeType: 'application/json' },
            accepts: [{ scheme: 'exact', network: MAINNET, amount: String(Math.round(usd * 1e6)), asset: String(USDC_ASSET), payTo, extra: { decimals: 6 } }],
          },
          402,
        )
      }
      const p = JSON.parse(Buffer.from(sig, 'base64').toString('utf8')) as { payload: { paymentGroup: string[]; paymentIndex: number } }
      const t = algosdk.decodeSignedTransaction(Buffer.from(p.payload.paymentGroup[p.payload.paymentIndex], 'base64')).txn
      const from = algo.get(t.sender.toString())!
      const amount = Number(t.assetTransfer!.amount) / 1e6
      if ((from.usdc ?? 0) + 1e-9 < amount) return json({ error: 'insufficient funds' }, 402)
      from.usdc = (from.usdc ?? 0) - amount
      landed.add(t.txID())
      paid.push({ tool, usd: amount, txId: t.txID(), body })
      if (faults.dropAfterSettle) {
        faults.dropAfterSettle = false
        throw new TypeError('fetch failed')
      }
      return json({ ...answer(tool, body), settlement: { success: true, transaction: t.txID() } })
    }
    if (url.origin === 'https://facilitator.goplausible.xyz' && path === '/supported') {
      return json({ kinds: [{ network: MAINNET, extra: { feePayer } }] })
    }
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
          'algo-algorand>usdc-algorand': [23.24, RATE.algoUsdc],
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
            s.to === 'algo-algorand'
              ? s.received * RATE.algo
              : s.to === 'usdc-algorand'
                ? s.received * (s.from === 'algo-algorand' ? RATE.algoUsdc : RATE.usdc)
                : s.from === 'algo-algorand'
                  ? s.received * RATE.algoBack
                  : s.received * RATE.usdcBack
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
    if (path === '/v2/transactions/params') return json({ 'last-round': chain.round, 'min-fee': 1000, 'genesis-id': 'mainnet-v1.0', 'genesis-hash': 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' })
    if (path === '/v2/assets/' + USDC_ASSET) return json({ params: { creator: algosdk.generateAccount().addr.toString() } })
    if (path.startsWith('/v2/transactions/pending/')) {
      return landed.has(path.split('/').pop()!) ? json({ 'confirmed-round': 5 }) : json({ message: 'not found' }, 404)
    }
    if (path.startsWith('/v2/transactions/') && url.hostname.includes('-idx.')) return json({}, 404)
    if (path === '/v2/transactions' && init?.method === 'POST') {
      const stx = algosdk.decodeSignedTransaction(init.body as Uint8Array)
      const t = stx.txn
      const from = t.sender.toString()
      const a = algo.get(from)!
      a.algo -= 0.001
      landed.add(t.txID())
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
  return { fetchImpl: fetchImpl as never, xlm, algo, sends, paid, prices, faults, decisions, chain }
}
