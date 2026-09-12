import { test } from 'node:test'
import assert from 'node:assert/strict'
import algosdk from 'algosdk'
import { TrustGuard } from './index.js'
import { algorandPayer, readAlgorandQuote, SpendCapError, AlgorandPaymentError } from './algorand.js'

const TESTNET = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='
const buyer = algosdk.generateAccount()
const feePayer = algosdk.generateAccount()
const payTo = algosdk.generateAccount().addr.toString()
const mnemonic = algosdk.secretKeyToMnemonic(buyer.sk)

const challenge = (amount: string, asset = '10458941') => ({
  x402Version: 2,
  resource: { url: 'https://a-identity.xyz/api/x402/algorand/tools/risk_check', description: 'risk', mimeType: 'application/json' },
  accepts: [{ scheme: 'exact', network: TESTNET, amount, asset, payTo, maxTimeoutSeconds: 120, extra: { decimals: 6, tag: 'x402-global-challenge' } }],
  extensions: { bazaar: { info: { input: { type: 'http', method: 'POST' } } } },
})

/** Routes the facilitator's /supported and algod's params; counts every call. */
function network() {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    if (url.endsWith('/supported')) {
      return new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: TESTNET, extra: { feePayer: feePayer.addr.toString() } }] }))
    }
    if (url.endsWith('/v2/transactions/params')) {
      return new Response(JSON.stringify({ 'last-round': 5000, 'genesis-id': 'testnet-v1.0', 'genesis-hash': TESTNET.slice('algorand:'.length), 'min-fee': 1000 }))
    }
    return new Response('{}', { status: 404 })
  }
  return { fetch, calls }
}

test('a challenge above the per-call cap is refused before any network call or signature', async () => {
  const net = network()
  const pay = algorandPayer({ mnemonic, maxUsdPerCall: 0.01, fetch: net.fetch })
  await assert.rejects(() => pay(challenge('50000'), { resource: 'r', body: {} }), (e: unknown) => {
    assert.ok(e instanceof SpendCapError)
    assert.equal(e.amountUsd, 0.05)
    assert.equal(e.capUsd, 0.01)
    return true
  })
  assert.equal(net.calls.length, 0)
})

test('only native USDC on a known Algorand network is payable, and a malformed mnemonic is refused up front', () => {
  assert.throws(() => readAlgorandQuote(challenge('10000', '31566704')), AlgorandPaymentError, 'mainnet USDC id on testnet')
  assert.throws(() => readAlgorandQuote({ accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '1', asset: '0x', payTo }] }), AlgorandPaymentError)
  assert.throws(() => readAlgorandQuote(challenge('0')), AlgorandPaymentError)
  assert.throws(() => algorandPayer({ mnemonic: 'not twenty five words' }), AlgorandPaymentError)
  assert.equal(readAlgorandQuote(challenge('50000')).amountUsd, 0.05)
})

test('the payer signs exactly the quoted fee-zero USDC transfer, grouped with an unsigned fee-payer transaction', async () => {
  const net = network()
  const pay = algorandPayer({ mnemonic, fetch: net.fetch })
  const headers = await pay(challenge('50000'), { resource: 'r', body: {} })
  assert.ok(headers?.['PAYMENT-SIGNATURE'])
  const payload = JSON.parse(Buffer.from(headers['PAYMENT-SIGNATURE'], 'base64').toString('utf8'))
  assert.equal(payload.x402Version, 2)
  assert.equal(payload.network, TESTNET)
  assert.deepEqual(payload.extensions, challenge('50000').extensions, 'the discovery declaration is echoed')
  assert.equal(payload.payload.paymentIndex, 1)
  const [feeB64, payB64] = payload.payload.paymentGroup as string[]
  const fee = algosdk.decodeUnsignedTransaction(Buffer.from(feeB64, 'base64'))
  const signed = algosdk.decodeSignedTransaction(Buffer.from(payB64, 'base64'))
  assert.equal(fee.sender.toString(), feePayer.addr.toString())
  assert.equal(signed.txn.sender.toString(), buyer.addr.toString())
  assert.equal(signed.txn.assetTransfer?.receiver.toString(), payTo)
  assert.equal(signed.txn.assetTransfer?.amount, 50000n)
  assert.equal(signed.txn.assetTransfer?.assetIndex, 10458941n)
  assert.equal(signed.txn.fee, 0n)
  assert.equal(Buffer.from(fee.group!).toString('base64'), Buffer.from(signed.txn.group!).toString('base64'))
})

test('a TrustGuard on the Algorand rail pays the 402 with the payer and returns the verdict', async () => {
  const net = network()
  let oracleCalls = 0
  const fetch = async (url: string, init?: RequestInit) => {
    if (!url.includes('/api/x402/algorand/tools/')) return net.fetch(url)
    oracleCalls += 1
    const paid = (init?.headers as Record<string, string>)?.['PAYMENT-SIGNATURE']
    if (!paid) return new Response(JSON.stringify(challenge('50000')), { status: 402 })
    return new Response(JSON.stringify({ tool: 'risk_check', agentId: '#7', decision: 'ALLOW', risk: 'low', reasons: [] }), { status: 200 })
  }
  const oracle = new TrustGuard({ rail: 'algorand', fetch, onPaymentRequired: algorandPayer({ mnemonic, fetch }) })
  const verdict = await oracle.guard('#7', { txContext: { amountUsd: 20 } })
  assert.equal(verdict.decision, 'ALLOW')
  assert.equal(oracleCalls, 2)
})
