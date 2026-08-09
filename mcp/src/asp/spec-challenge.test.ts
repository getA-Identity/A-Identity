import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withSpecChallenge } from './payment.js'

/**
 * The ASP rail serves its x402 challenge only in the base64 `PAYMENT-REQUIRED` header,
 * which is what the OKX buyer reads. A generic x402 client reads the BODY, finds no
 * challenge, and cannot pay. withSpecChallenge folds the header's own challenge into the
 * body so both kinds of client work.
 *
 * The property these tests exist to protect: the body is a DECODE of the header, never a
 * second hand-written challenge. If someone later replaces this with typed-out values,
 * the "same values as the header" tests below are what should stop them.
 */

const challenge = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'https://asp.example/tools/verify_agent', description: 'Verify an agent.', mimeType: '' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:196',
      amount: '1000',
      asset: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
      payTo: '0x6a5f1b8e56a19d456b799c2fa00e513244f58ce6',
      maxTimeoutSeconds: 300,
      extra: { name: 'USD₮0', version: '1' },
    },
  ],
  extensions: { outputSchema: { input: { type: 'http' } } },
}
const header = Buffer.from(JSON.stringify(challenge)).toString('base64')
const body = JSON.stringify({ error: 'Payment required', tool: 'verify_agent', required: ['agentId'] })

test('the challenge lands in the body with the header values, not invented ones', () => {
  const out = JSON.parse(withSpecChallenge(body, header))
  assert.equal(out.x402Version, 2)
  assert.equal(out.accepts.length, 1)
  const a = out.accepts[0]
  assert.equal(a.scheme, 'exact')
  assert.equal(a.network, 'eip155:196')
  assert.equal(a.amount, '1000')
  assert.equal(a.asset, '0x779ded0c9e1022225f8e0630b35a9b54be713736')
  assert.equal(a.payTo, '0x6a5f1b8e56a19d456b799c2fa00e513244f58ce6')
  assert.deepEqual(out.resource, challenge.resource)
})

test('every accepts entry carries both amount spellings, at the same value', () => {
  const a = JSON.parse(withSpecChallenge(body, header)).accepts[0]
  // `amount` is this SDK's field; `maxAmountRequired` is the older Coinbase name. A
  // client reading either must be quoted the same price.
  assert.equal(a.maxAmountRequired, a.amount)
})

test('an existing maxAmountRequired from the header is not overwritten', () => {
  const v1 = { ...challenge, accepts: [{ scheme: 'exact', network: 'eip155:196', maxAmountRequired: '5000' }] }
  const a = JSON.parse(withSpecChallenge(body, Buffer.from(JSON.stringify(v1)).toString('base64'))).accepts[0]
  assert.equal(a.maxAmountRequired, '5000')
  assert.equal(a.amount, undefined)
})

test('the existing calling contract survives untouched', () => {
  const out = JSON.parse(withSpecChallenge(body, header))
  assert.equal(out.tool, 'verify_agent')
  assert.deepEqual(out.required, ['agentId'])
})

test('the body wins on a key collision, because its contract is the richer one', () => {
  const collide = JSON.stringify({ error: 'Payment required. Call with POST.', tool: 'verify_agent' })
  assert.equal(JSON.parse(withSpecChallenge(collide, header)).error, 'Payment required. Call with POST.')
})

test('a missing header leaves the body exactly as it was', () => {
  assert.equal(withSpecChallenge(body, undefined), body)
  assert.equal(withSpecChallenge(body, ''), body)
  assert.equal(withSpecChallenge(body, ['a']), body)
})

test('a malformed header or body degrades to the original, it never throws', () => {
  assert.equal(withSpecChallenge(body, 'not-base64-json'), body)
  assert.equal(withSpecChallenge('not json', header), 'not json')
  assert.equal(withSpecChallenge(body, Buffer.from('[1,2]').toString('base64')), body)
  assert.equal(withSpecChallenge('[1,2]', header), '[1,2]')
})

test('a challenge with no accepts array is copied through as-is', () => {
  const bare = Buffer.from(JSON.stringify({ x402Version: 2 })).toString('base64')
  const out = JSON.parse(withSpecChallenge(body, bare))
  assert.equal(out.x402Version, 2)
  assert.equal(out.accepts, undefined)
  assert.equal(out.tool, 'verify_agent')
})

test('a non-object accepts entry is left alone rather than reshaped', () => {
  const odd = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [null, 'x'] })).toString('base64')
  assert.deepEqual(JSON.parse(withSpecChallenge(body, odd)).accepts, [null, 'x'])
})

test('extensions are only added when the header actually carries them', () => {
  const none = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [] })).toString('base64')
  assert.equal('extensions' in JSON.parse(withSpecChallenge(body, none)), false)
  assert.deepEqual(JSON.parse(withSpecChallenge(body, header)).extensions, challenge.extensions)
})
