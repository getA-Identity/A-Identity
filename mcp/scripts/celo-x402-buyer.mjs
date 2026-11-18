#!/usr/bin/env node
/**
 * Minimal x402 v2 buyer for the Celo rail: pays one of our /api/celo/tools endpoints end to
 * end and prints the served result. Used for the honest smoke settlement and the demo:
 * nothing here is mocked, the wallet signs a real EIP-3009 authorization and the server's
 * facilitator settles real USDC.
 *
 * The x402 v2 HTTP transport (https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md):
 *  1. The 402 carries the PaymentRequired object base64 in the PAYMENT-REQUIRED header (the
 *     body carries the same fields too). Its accepts entry names scheme 'exact', the CAIP-2
 *     network, `amount` in atomic units, asset, payTo, maxTimeoutSeconds and the token's
 *     EIP-712 domain in `extra` (read live from the Celo USDC contracts on 2026-08-09:
 *     name "USDC", version "2").
 *  2. The authorization is USDC `TransferWithAuthorization` (EIP-3009) typed data with that
 *     domain, chainId parsed from the CAIP-2 network, verifyingContract = the asset.
 *     value = amount exactly (scheme 'exact'), validAfter = 0,
 *     validBefore = now + maxTimeoutSeconds (default 600), nonce = 32 random bytes.
 *  3. PAYMENT-SIGNATURE header = base64(JSON of
 *       { x402Version: 2, resource, accepted: <the accepts entry, unchanged>,
 *         payload: { signature, authorization: { from, to, value, validAfter,
 *                                                validBefore, nonce } } })
 *  4. A settled answer carries the receipt base64 in the PAYMENT-RESPONSE header, whenever the
 *     settlement hash is known. A settlement the facilitator refuses while the authorization
 *     stays unspent on-chain is a 402 whose PAYMENT-RESPONSE says success false: nothing moved.
 *
 * Usage:
 *   node --env-file=.env scripts/celo-x402-buyer.mjs \
 *     --url https://<host>/api/celo/tools/verify_agent --agent '#1'
 *
 * Env:
 *   CELO_BUYER_KEY  required - a wallet holding USDC on the challenge's network.
 *                   Use a DEDICATED buyer wallet, never the server signer.
 */
import { randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const URL_ARG = arg('url', '')
const AGENT = arg('agent', '#1')
if (!URL_ARG) {
  console.error('error: pass --url https://<host>/api/celo/tools/<tool>')
  process.exit(1)
}
const key = process.env.CELO_BUYER_KEY
if (!key) {
  console.error('error: CELO_BUYER_KEY not set (a funded USDC wallet; never the server signer)')
  process.exit(1)
}
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const fromBase64Json = (v) => JSON.parse(Buffer.from(v, 'base64').toString('utf8'))

// -- 1. quote: GET the 402 challenge -------------------------------------------------
console.log(`Buyer:  ${account.address}`)
console.log(`GET     ${URL_ARG}`)
const quoteRes = await fetch(URL_ARG, { signal: AbortSignal.timeout(15000) })
const quoteBody = await quoteRes.json().catch(() => null)
const requiredHeader = quoteRes.headers.get('payment-required')
const quote = requiredHeader ? fromBase64Json(requiredHeader) : quoteBody
if (quoteRes.status !== 402 || quote?.x402Version !== 2 || !Array.isArray(quote.accepts) || !quote.accepts[0]) {
  console.error(`error: expected an x402 v2 402 challenge, got ${quoteRes.status}:`)
  console.error(JSON.stringify(quoteBody, null, 2))
  process.exit(1)
}
const req = quote.accepts[0]
if (typeof req.amount !== 'string' || !/^\d+$/.test(req.amount)) {
  console.error('error: the accepts entry names no amount')
  process.exit(1)
}
console.log(`Quote:  ${req.amount} base units of ${req.asset} on ${req.network} -> ${req.payTo}${requiredHeader ? ' (from PAYMENT-REQUIRED)' : ' (from the body)'}`)

const chainId = Number(/^eip155:(\d+)$/.exec(req.network)?.[1])
if (!Number.isFinite(chainId)) {
  console.error(`error: cannot parse an EVM chain id from network '${req.network}'`)
  process.exit(1)
}

// -- 2. sign the EIP-3009 TransferWithAuthorization ----------------------------------
const now = Math.floor(Date.now() / 1000)
const authorization = {
  from: account.address,
  to: req.payTo,
  value: BigInt(req.amount),
  validAfter: 0n,
  validBefore: BigInt(now + (Number(req.maxTimeoutSeconds) || 600)),
  nonce: `0x${randomBytes(32).toString('hex')}`,
}
const signature = await account.signTypedData({
  domain: {
    name: req.extra?.name ?? 'USDC',
    version: req.extra?.version ?? '2',
    chainId,
    verifyingContract: req.asset,
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: authorization,
})

const paymentPayload = {
  x402Version: 2,
  ...(quote.resource ? { resource: quote.resource } : {}),
  accepted: req,
  payload: {
    signature,
    authorization: {
      ...authorization,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
    },
  },
}
const header = Buffer.from(JSON.stringify(paymentPayload)).toString('base64')

// -- 3. pay: POST with PAYMENT-SIGNATURE ---------------------------------------------
console.log(`POST    ${URL_ARG} (agentId=${AGENT}, PAYMENT-SIGNATURE attached)`)
const payRes = await fetch(URL_ARG, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': header },
  body: JSON.stringify({ agentId: AGENT }),
  signal: AbortSignal.timeout(30000),
})
const body = await payRes.json()
console.log(`\nHTTP ${payRes.status}`)
const receipt = payRes.headers.get('payment-response')
if (receipt) console.log(`PAYMENT-RESPONSE: ${JSON.stringify(fromBase64Json(receipt))}`)
console.log(JSON.stringify(body, null, 2))
if (payRes.status === 200 && body.paid === true) {
  console.log('\nSETTLED: the facilitator moved real USDC and the tool was served.')
  console.log('Proof:   GET /api/celo/proof on the same host now includes this settlement.')
  process.exit(0)
}
process.exit(1)
