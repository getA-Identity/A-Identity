#!/usr/bin/env node
/**
 * The buyer side of the self-facilitated EIP-3009 rail: read a 402, sign an
 * authorization, and pay.
 *
 * The one rule this script exists to demonstrate: it NEVER signs against a domain it has
 * not checked itself. It recomputes the EIP-712 domain separator from the challenge's
 * own fields, then reads DOMAIN_SEPARATOR directly off the token over the chain's public
 * RPC, and refuses to sign unless all three agree. There is deliberately no fallback to
 * a guessed name or version: on this rail a guessed domain produces an authorization
 * that can never settle, and guessing is precisely the practice the rail replaces.
 *
 * It reads the challenge from the x402 v2 `PAYMENT-REQUIRED` header when the seller sends
 * one, checks it against the JSON body, and refuses if the two disagree: the header is a
 * re-encoding of the same object, so a difference means one of them was hand-written and a
 * buyer could be shown one price and charged another. With `--v2` it also PAYS the v2 way,
 * sending a `PaymentPayload` (the chosen offer under `accepted`) in `PAYMENT-SIGNATURE`
 * instead of the v1 `X-PAYMENT`. Both shapes are exercised from here rather than trusted.
 *
 * Usage:
 *   node --env-file=.env scripts/x402-3009-buyer.mjs --url http://localhost:3399/api/x402/tools/risk_check --agent '#0' [--dry-run] [--v2]
 * Env:
 *   X402_3009_BUYER_KEY   the wallet that pays (never the server's signer)
 */
import { createPublicClient, http, keccak256, stringToHex, encodeAbiParameters } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const URL_ = arg('url', '')
const AGENT = arg('agent', '#0')
const DRY = process.argv.includes('--dry-run')
if (!URL_) {
  console.error('usage: --url <tool endpoint> [--agent "#0"] [--dry-run]')
  process.exit(1)
}

let getChain, resolveRpcUrls
try {
  ;({ getChain } = await import('../dist/chains/registry.js'))
  ;({ resolveRpcUrls } = await import('../dist/chains/evm/client.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}

// 1. Read the challenge, from the header first.
//
// x402 v2 puts the PaymentRequired object in the `PAYMENT-REQUIRED` header and treats the
// response body as a server implementation detail; v1 put it in the body. A stock v2
// client reads ONLY the header, so reading it here is how this script stays a witness to
// what such a client sees rather than a witness to what our own body happens to say.
const V2 = process.argv.includes('--v2')
const challengeRes = await fetch(URL_)
const bodyChallenge = await challengeRes.json().catch(() => null)
const rawHeader = challengeRes.headers.get('payment-required')
let headerChallenge = null
if (rawHeader) {
  try {
    headerChallenge = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8'))
  } catch {
    console.error('error: PAYMENT-REQUIRED is present but is not base64-encoded JSON. Refusing to guess.')
    process.exit(1)
  }
}
const challenge = headerChallenge ?? bodyChallenge
if (challengeRes.status !== 402 || !challenge?.accepts?.length) {
  console.error(`error: expected a 402 challenge, got ${challengeRes.status}:`, JSON.stringify(challenge).slice(0, 400))
  process.exit(1)
}
if (!headerChallenge) {
  // Not fatal for us, because we can read the body. Fatal for every off-the-shelf v2
  // client, which is why it is worth saying out loud.
  console.log('Transport: body only (no PAYMENT-REQUIRED header). A stock x402 v2 client could not read this challenge.')
} else {
  // The two must describe the same offers. Same object, encoded twice.
  const key = (a) => [a.network, a.asset, a.payTo, a.amount ?? a.maxAmountRequired].join('|')
  const fromHeader = headerChallenge.accepts.map(key).sort().join(' ; ')
  const fromBody = (bodyChallenge?.accepts ?? []).map(key).sort().join(' ; ')
  if (fromBody && fromHeader !== fromBody) {
    console.error(`error: the PAYMENT-REQUIRED header and the body offer different terms.\n  header ${fromHeader}\n  body   ${fromBody}\nRefusing to pay against either.`)
    process.exit(1)
  }
  console.log(`Transport: PAYMENT-REQUIRED header${fromBody ? ' (agrees with the body)' : ''}`)
}
// The seller may offer several chains; pick the one asked for, else the first.
const wantNetwork = arg('network', '')
const accepts = wantNetwork
  ? challenge.accepts.find((a) => a.network === wantNetwork || a.network?.endsWith(':' + wantNetwork))
  : challenge.accepts[0]
if (!accepts) {
  console.error(`error: the seller does not offer '${wantNetwork}'. Offered: ${challenge.accepts.map((a) => a.network).join(', ')}`)
  process.exit(1)
}
const extra = accepts.extra
if (!extra?.name || !extra?.version || !extra?.chainId || !extra?.verifyingContract) {
  console.error('error: the challenge carries no complete EIP-712 domain in `extra`. Refusing to sign a guessed domain.')
  process.exit(1)
}

// v2 renamed `maxAmountRequired` to `amount` and hoisted `resource` out of each entry into
// one object on the challenge. A seller may send either spelling; refusing to read the new
// one would make this buyer as narrow as the sellers it exists to test.
const amountRaw = accepts.amount ?? accepts.maxAmountRequired
if (!amountRaw) {
  console.error('error: the offer names no amount, under either spelling. Refusing to sign a blank cheque.')
  process.exit(1)
}
console.log(`Resource: ${accepts.resource ?? challenge.resource?.url ?? '(none)'}`)
console.log(`Asset:    ${accepts.assetSymbol ?? ''} ${accepts.asset} (${accepts.decimals ?? '?'} decimals)`)
console.log(`Price:    ${amountRaw} base units to ${accepts.payTo}`)
if (accepts.extra?.assetTransferMethod && accepts.extra.assetTransferMethod !== 'eip3009') {
  console.error(`error: the offer settles by '${accepts.extra.assetTransferMethod}', and this script only signs EIP-3009 authorizations.`)
  process.exit(1)
}
if (challenge.tool?.price) {
  const p = challenge.tool.price
  console.log(`          base $${p.baseUsd} + settlement fee $${p.settlementFeeUsd} = $${p.totalUsd}`)
}

// 2. Recompute the domain separator from the challenge's own fields.
const TYPEHASH = keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'))
const computed = keccak256(
  encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [TYPEHASH, keccak256(stringToHex(extra.name)), keccak256(stringToHex(extra.version)), BigInt(extra.chainId), extra.verifyingContract],
  ),
)
if (extra.domainSeparator && computed.toLowerCase() !== String(extra.domainSeparator).toLowerCase()) {
  console.error(`error: the challenge's domain does not hash to the separator it published.\n  computed ${computed}\n  published ${extra.domainSeparator}`)
  process.exit(1)
}

// 3. Read DOMAIN_SEPARATOR off the token ourselves. This is the check that makes the
//    seller's claim unnecessary rather than merely plausible.
const chain = getChain(accepts.network)
if (!chain) {
  console.error(`error: the challenge names network '${accepts.network}', which is not in our registry.`)
  process.exit(1)
}
const pub = createPublicClient({ transport: http(resolveRpcUrls(chain, process.env)[0], { timeout: 15000, retryCount: 2 }) })
const onchain = await pub.readContract({
  address: accepts.asset,
  abi: [{ type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }],
  functionName: 'DOMAIN_SEPARATOR',
})
if (String(onchain).toLowerCase() !== computed.toLowerCase()) {
  console.error(`error: the token's live DOMAIN_SEPARATOR does not match the challenge.\n  token    ${onchain}\n  computed ${computed}\nRefusing to sign.`)
  process.exit(1)
}
console.log(`Domain:   verified against the token itself (${extra.name} v${extra.version})`)

if (DRY) {
  console.log('\n--dry-run: nothing was signed and nothing was sent.')
  process.exit(0)
}

const key = process.env.X402_3009_BUYER_KEY
if (!key) {
  console.log('\nNo X402_3009_BUYER_KEY set - PREPARED (nothing signed):')
  console.log(JSON.stringify({ executed: false, wouldSign: { domain: extra, value: amountRaw, to: accepts.payTo } }, null, 2))
  process.exit(0)
}
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)

// 4. Sign and pay.
const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600)
const authorization = {
  from: account.address,
  to: accepts.payTo,
  value: BigInt(amountRaw),
  validAfter: 0n,
  validBefore,
  nonce,
}
const signature = await account.signTypedData({
  domain: { name: extra.name, version: extra.version, chainId: Number(extra.chainId), verifyingContract: extra.verifyingContract },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: authorization,
})
const credential = {
  signature,
  authorization: {
    from: authorization.from, to: authorization.to, value: authorization.value.toString(),
    validAfter: '0', validBefore: validBefore.toString(), nonce,
  },
}
// Two payment shapes, one signature. v1 puts the chosen network at the top level and rides
// in `X-PAYMENT`; v2 carries the whole offer under `accepted` and rides in
// `PAYMENT-SIGNATURE`. The bytes the buyer signed are identical in both, which is the point:
// the envelope changed, the authorization did not.
const payment = V2
  ? { x402Version: 2, resource: challenge.resource, accepted: accepts, payload: credential }
  : { x402Version: 2, scheme: 'exact', network: accepts.network, payload: credential }
const header = Buffer.from(JSON.stringify(payment)).toString('base64')

console.log(`Payer:    ${account.address}`)
console.log(`Paying... (${V2 ? 'v2: PAYMENT-SIGNATURE' : 'v1: X-PAYMENT'})`)
const paid = await fetch(URL_, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(V2 ? { 'PAYMENT-SIGNATURE': header } : { 'X-PAYMENT': header }) },
  body: JSON.stringify({ agentId: AGENT }),
})
const body = await paid.json()
console.log(`\nHTTP ${paid.status}`)
// v2 returns the settlement result in `PAYMENT-RESPONSE`, so a client can read its receipt
// without parsing a body shaped for humans. Reported rather than required: the body carries
// the same transaction, and this script says which transports it actually saw.
const rawReceipt = paid.headers.get('payment-response') ?? paid.headers.get('x-payment-response')
if (rawReceipt) {
  try {
    const receipt = JSON.parse(Buffer.from(rawReceipt, 'base64').toString('utf8'))
    console.log(`Receipt:  PAYMENT-RESPONSE ${receipt.success ? 'success' : 'failure'} tx ${receipt.transaction} on ${receipt.network}`)
    if (body.settlement?.transaction && body.settlement.transaction !== receipt.transaction) {
      console.error('error: the PAYMENT-RESPONSE header and the body name different transactions.')
      process.exit(1)
    }
  } catch {
    console.log('Receipt:  PAYMENT-RESPONSE present but not base64-encoded JSON')
  }
} else if (paid.status === 200) {
  console.log('Receipt:  no PAYMENT-RESPONSE header (the body carries the settlement).')
}
if (body.settlement?.transaction) {
  console.log(`Settled:  ${body.settlement.transaction}`)
  console.log(`Explorer: ${body.settlement.explorerUrl}`)
  console.log(`Value:    ${body.settlement.value} base units of ${body.settlement.assetSymbol}`)
}
if (V2 && paid.status === 402 && !body.verifyError && !body.reason) {
  // A plain challenge back means the seller never saw a credential at all, which on the v2
  // path usually means it reads only `X-PAYMENT`. Said plainly, because the alternative is
  // an operator concluding the signature was rejected.
  console.log('hint:     the seller answered with a fresh challenge and named no fault, so it may not read PAYMENT-SIGNATURE yet. Retry without --v2 to check.')
}
if (body.verifyError) console.log('verifyError:', body.verifyError)
if (body.reason) console.log('reason:', body.code ? body.code + ' - ' + body.reason : body.reason)
if (!body.settlement && !body.verifyError && !body.reason) console.log(JSON.stringify(body, null, 2).slice(0, 900))
process.exit(paid.status === 200 ? 0 : 1)
