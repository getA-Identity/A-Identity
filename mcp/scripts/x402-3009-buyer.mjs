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
 * Usage:
 *   node --env-file=.env scripts/x402-3009-buyer.mjs --url http://localhost:3399/api/x402/tools/risk_check --agent '#0' [--dry-run]
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

// 1. Read the challenge.
const challengeRes = await fetch(URL_)
const challenge = await challengeRes.json()
if (challengeRes.status !== 402 || !challenge.accepts?.length) {
  console.error(`error: expected a 402 challenge, got ${challengeRes.status}:`, JSON.stringify(challenge).slice(0, 400))
  process.exit(1)
}
const accepts = challenge.accepts[0]
const extra = accepts.extra
if (!extra?.name || !extra?.version || !extra?.chainId || !extra?.verifyingContract) {
  console.error('error: the challenge carries no complete EIP-712 domain in `extra`. Refusing to sign a guessed domain.')
  process.exit(1)
}

console.log(`Resource: ${accepts.resource}`)
console.log(`Asset:    ${accepts.assetSymbol ?? ''} ${accepts.asset} (${accepts.decimals ?? '?'} decimals)`)
console.log(`Price:    ${accepts.maxAmountRequired} base units to ${accepts.payTo}`)
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
  console.log(JSON.stringify({ executed: false, wouldSign: { domain: extra, value: accepts.maxAmountRequired, to: accepts.payTo } }, null, 2))
  process.exit(0)
}
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)

// 4. Sign and pay.
const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600)
const authorization = {
  from: account.address,
  to: accepts.payTo,
  value: BigInt(accepts.maxAmountRequired),
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
const header = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    scheme: 'exact',
    network: accepts.network,
    payload: {
      signature,
      authorization: {
        from: authorization.from, to: authorization.to, value: authorization.value.toString(),
        validAfter: '0', validBefore: validBefore.toString(), nonce,
      },
    },
  }),
).toString('base64')

console.log(`Payer:    ${account.address}`)
console.log('Paying...')
const paid = await fetch(URL_, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-PAYMENT': header },
  body: JSON.stringify({ agentId: AGENT }),
})
const body = await paid.json()
console.log(`\nHTTP ${paid.status}`)
if (body.settlement?.transaction) {
  console.log(`Settled:  ${body.settlement.transaction}`)
  console.log(`Explorer: ${body.settlement.explorerUrl}`)
  console.log(`Value:    ${body.settlement.value} base units of ${body.settlement.assetSymbol}`)
}
console.log(JSON.stringify(body, null, 2).slice(0, 1600))
process.exit(paid.status === 200 ? 0 : 1)
