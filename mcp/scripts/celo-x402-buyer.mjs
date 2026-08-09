#!/usr/bin/env node
/**
 * Minimal x402 v2 buyer for the Celo rail — pays one of our /api/celo/tools endpoints
 * end to end and prints the served result. Used for the honest smoke settlement and
 * the demo: nothing here is mocked, the wallet signs a real EIP-3009 authorization
 * and the server's facilitator settles real USDC.
 *
 * ASSUMPTIONS (x402 v2 exact scheme; noted per the integration handoff):
 *  1. X-PAYMENT header = base64(JSON of
 *       { x402Version: 2, scheme: 'exact', network: <caip2>,
 *         payload: { signature, authorization: { from, to, value, validAfter,
 *                                                validBefore, nonce } } })
 *     — the same client shape our OKX x402 flow uses for the exact scheme.
 *  2. The authorization is USDC `TransferWithAuthorization` (EIP-3009) typed data with
 *     domain { name, version } taken from the challenge's `extra` (read live from the
 *     Celo USDC contracts on 2026-08-09: name "USDC", version "2"), chainId parsed from
 *     the challenge's CAIP-2 `network`, verifyingContract = the challenge's `asset`.
 *  3. value = maxAmountRequired exactly (scheme 'exact'), validAfter = 0,
 *     validBefore = now + maxTimeoutSeconds (default 600), nonce = 32 random bytes.
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

// ── 1. quote: GET the 402 challenge ───────────────────────────────────────────────
console.log(`Buyer:  ${account.address}`)
console.log(`GET     ${URL_ARG}`)
const quoteRes = await fetch(URL_ARG, { signal: AbortSignal.timeout(15000) })
const quote = await quoteRes.json()
if (quoteRes.status !== 402 || !Array.isArray(quote.accepts) || !quote.accepts[0]) {
  console.error(`error: expected a 402 challenge, got ${quoteRes.status}:`)
  console.error(JSON.stringify(quote, null, 2))
  process.exit(1)
}
const req = quote.accepts[0]
console.log(`Quote:  ${req.maxAmountRequired} base units of ${req.asset} on ${req.network} -> ${req.payTo}`)

const chainId = Number(/^eip155:(\d+)$/.exec(req.network)?.[1])
if (!Number.isFinite(chainId)) {
  console.error(`error: cannot parse an EVM chain id from network '${req.network}'`)
  process.exit(1)
}

// ── 2. sign the EIP-3009 TransferWithAuthorization ────────────────────────────────
const now = Math.floor(Date.now() / 1000)
const authorization = {
  from: account.address,
  to: req.payTo,
  value: BigInt(req.maxAmountRequired),
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
  scheme: 'exact',
  network: req.network,
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

// ── 3. pay: POST with X-PAYMENT ───────────────────────────────────────────────────
console.log(`POST    ${URL_ARG} (agentId=${AGENT}, X-PAYMENT attached)`)
const payRes = await fetch(URL_ARG, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-PAYMENT': header },
  body: JSON.stringify({ agentId: AGENT }),
  signal: AbortSignal.timeout(30000),
})
const body = await payRes.json()
console.log(`\nHTTP ${payRes.status}`)
console.log(JSON.stringify(body, null, 2))
if (payRes.status === 200 && body.paid === true) {
  console.log('\nSETTLED: the facilitator moved real USDC and the tool was served.')
  console.log('Proof:   GET /api/celo/proof on the same host now includes this settlement.')
  process.exit(0)
}
process.exit(1)
