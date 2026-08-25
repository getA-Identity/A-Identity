import { test } from 'node:test'
import assert from 'node:assert/strict'
import type * as http from 'node:http'
import { sendChallenge } from './shared.js'

/**
 * The x402 v2 challenge has to travel in the PAYMENT-REQUIRED header, and the oracle for
 * that is the reference implementation rather than our reading of the spec. These tests
 * decode what we emit with @x402/core's own decoder, so a change that satisfies us and not
 * a real buyer fails here.
 *
 * The defect this pins: our EIP-3009 and Stellar rails served `x402Version: 2` in the body
 * with no header, which is v1 transport under a v2 number. @x402/core's
 * `getPaymentRequiredResponse` reads the header and falls back to the body ONLY when
 * `x402Version === 1`, so a stock v2 buyer threw "Invalid payment required response"
 * before ever seeing the price. It survived because our own buyer scripts read the body
 * directly: the rails were only ever tested with the one client that did not need it.
 */
function fakeRes() {
  const headers: Record<string, unknown> = {}
  let status = 0
  let payload = ''
  return {
    headers,
    get status() { return status },
    get payload() { return payload },
    res: {
      setHeader: (k: string, v: unknown) => { headers[k] = v },
      writeHead: (s: number) => { status = s },
      end: (b?: string) => { payload = b ?? '' },
    } as unknown as http.ServerResponse,
  }
}

const CHALLENGE = {
  x402Version: 2,
  error: 'payment required',
  accepts: [{ scheme: 'exact', network: 'stellar:testnet', maxAmountRequired: '50000' }],
}

test('a 402 carries the challenge in the header as well as the body', () => {
  const f = fakeRes()
  sendChallenge(f.res, 402, CHALLENGE)
  assert.ok(f.headers['PAYMENT-REQUIRED'], 'a v2 challenge with no header is unreadable to a stock client')
  assert.deepEqual(JSON.parse(f.payload), CHALLENGE, 'the body still carries it, so existing callers keep working')
})

test('what we emit decodes with the reference implementation, not just with ours', async () => {
  const { decodePaymentRequiredHeader } = await import('@x402/core/http')
  const f = fakeRes()
  sendChallenge(f.res, 402, CHALLENGE)
  const decoded = decodePaymentRequiredHeader(String(f.headers['PAYMENT-REQUIRED']))
  assert.equal(decoded.accepts[0].network, 'stellar:testnet')
  assert.equal((decoded.accepts[0] as unknown as { amount?: string }).amount ?? (decoded.accepts[0] as unknown as { maxAmountRequired?: string }).maxAmountRequired, '50000')
})

test('the reference client rejects a v2 body with no header, which is what we were sending', async () => {
  // The negative control. If this ever stops throwing, the fallback widened and the header
  // is no longer load-bearing; until then it is the reason this helper exists.
  const { x402HTTPClient } = await import('@x402/core/client')
  const parse = (hdr?: string) =>
    (x402HTTPClient.prototype as unknown as {
      getPaymentRequiredResponse: (g: (k: string) => string | undefined, b: unknown) => unknown
    }).getPaymentRequiredResponse.call({}, () => hdr, CHALLENGE)

  assert.throws(() => parse(undefined), /Invalid payment required response/)
  assert.doesNotThrow(() => parse(Buffer.from(JSON.stringify(CHALLENGE)).toString('base64')))
})

test('a status that is not 402 gets no payment header', () => {
  // 501 unconfigured, 502 our failure, 202 broadcast-but-unconfirmed. None of those is a
  // price, and labelling them as one would tell a buyer to pay for an outage.
  for (const status of [200, 202, 501, 502]) {
    const f = fakeRes()
    sendChallenge(f.res, status, { error: 'not a price' })
    assert.equal(f.headers['PAYMENT-REQUIRED'], undefined, `${status} must not carry a challenge header`)
  }
})
