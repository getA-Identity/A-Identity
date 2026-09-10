#!/usr/bin/env node
/**
 * The buyer side of the Circle Gateway batched rail: read a 402, check the Gateway
 * domain against the facilitator's own word, sign an authorization from a Gateway
 * balance, and pay.
 *
 * What it refuses to do: sign against an `accepts` entry whose verifyingContract is not
 * the one Gateway's live /v1/x402/supported advertises for that network. The seller
 * already proved that pair against its registry; this script proves it again from the
 * buyer's side, because a buyer who trusts a 402 unread is a buyer who can be shown one
 * domain and charged through another.
 *
 * It reads the challenge from the x402 v2 PAYMENT-REQUIRED header and checks the body
 * says the same thing. It pays the v2 way: PAYMENT-SIGNATURE carrying {x402Version,
 * accepted, payload:{signature, authorization}}, which is what Circle CLI and the
 * @circle-fin/x402-batching client send.
 *
 * Usage:
 *   node --env-file=.env scripts/x402-gateway-buyer.mjs --url http://localhost:3399/api/x402/gateway/tools/verify_agent --agent '#73232' [--network eip155:5042002] [--dry-run] [--key-env ARC_SIGNER_KEY]
 * Env:
 *   X402_GATEWAY_BUYER_KEY (or --key-env)   the wallet that pays, with a Gateway balance on the chosen chain
 */
import { privateKeyToAccount } from 'viem/accounts'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const URL_ = arg('url', '')
const AGENT = arg('agent', '#73232')
const WANT_NETWORK = arg('network', '')
const KEY_ENV = arg('key-env', 'X402_GATEWAY_BUYER_KEY')
const DRY = process.argv.includes('--dry-run')
if (!URL_) {
  console.error('usage: --url <tool endpoint> [--agent "#73232"] [--network <caip2>] [--dry-run] [--key-env <VAR>]')
  process.exit(1)
}

let getChain
try {
  ;({ getChain } = await import('../dist/chains/registry.js'))
} catch {
  console.error('error: mcp/dist not built. Run: cd mcp && npm run build')
  process.exit(1)
}

// 1. The challenge, header first, body cross-checked.
const challengeRes = await fetch(URL_)
if (challengeRes.status !== 402) {
  console.error(`expected 402, got ${challengeRes.status}:`, (await challengeRes.text()).slice(0, 400))
  process.exit(1)
}
const body = await challengeRes.json()
const rawHeader = challengeRes.headers.get('payment-required')
if (!rawHeader) {
  console.error('no PAYMENT-REQUIRED header; a v2 client would see no challenge at all')
  process.exit(1)
}
const header = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8'))
if (JSON.stringify(header.accepts) !== JSON.stringify(body.accepts)) {
  console.error('header and body disagree on accepts; refusing')
  process.exit(1)
}
const accepts = header.accepts ?? []
const offer = WANT_NETWORK ? accepts.find((a) => a.network === WANT_NETWORK) : accepts[0]
if (!offer) {
  console.error(`no accepts entry for ${WANT_NETWORK || '(first)'}; offered: ${accepts.map((a) => a.network).join(', ')}`)
  process.exit(1)
}
const chain = getChain(offer.network)
if (!chain?.gateway) {
  console.error(`${offer.network} declares no Gateway in the registry`)
  process.exit(1)
}
if (offer.extra?.name !== 'GatewayWalletBatched') {
  console.error(`offer is not a Gateway batched kind (extra.name=${offer.extra?.name})`)
  process.exit(1)
}

// 2. The buyer-side proof: Gateway itself must advertise this verifyingContract.
const supported = await (await fetch(`${chain.gateway.facilitator}/v1/x402/supported`)).json()
const live = supported.kinds?.find((k) => k.network === offer.network && k.scheme === 'exact')
if (!live) {
  console.error(`Gateway does not advertise ${offer.network} right now`)
  process.exit(1)
}
if (live.extra.verifyingContract.toLowerCase() !== offer.extra.verifyingContract.toLowerCase()) {
  console.error(`REFUSING: the 402 says verifyingContract ${offer.extra.verifyingContract}, Gateway says ${live.extra.verifyingContract}`)
  process.exit(1)
}
if (live.extra.verifyingContract.toLowerCase() !== chain.gateway.wallet.toLowerCase()) {
  console.error(`REFUSING: Gateway says ${live.extra.verifyingContract}, the registry says ${chain.gateway.wallet}`)
  process.exit(1)
}
const asset = live.extra.assets?.find((a) => a.address.toLowerCase() === offer.asset.toLowerCase())
if (!asset) {
  console.error(`REFUSING: the offered asset ${offer.asset} is not one Gateway settles on ${offer.network}`)
  process.exit(1)
}

console.log('challenge ok:', {
  tool: body.tool?.name,
  network: offer.network,
  chain: chain.id,
  testnet: chain.testnet,
  amountUnits: offer.amount,
  amountUsd: Number(offer.amount) / 10 ** asset.decimals,
  asset: `${asset.symbol} ${offer.asset}`,
  payTo: offer.payTo,
  verifyingContract: offer.extra.verifyingContract,
  facilitator: chain.gateway.facilitator,
})
if (!chain.testnet) console.log('NOTE: this is MAINNET. The authorization spends real USDC from your Gateway balance.')

// 3. The buyer key and its Gateway balance on this chain.
const key = process.env[KEY_ENV]
if (!key) {
  console.error(`no ${KEY_ENV} set; nothing signed`)
  process.exit(DRY ? 0 : 1)
}
const account = privateKeyToAccount(key)
if (account.address.toLowerCase() === offer.payTo.toLowerCase()) {
  console.error('REFUSING: buyer and payTo are the same address; Gateway rejects a self-transfer')
  process.exit(1)
}
const bal = await fetch(`${chain.gateway.facilitator}/v1/balances`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: 'USDC', sources: [{ domain: chain.cctpDomain, depositor: account.address }] }),
})
const balJson = bal.ok ? await bal.json() : null
const available = Number(balJson?.balances?.[0]?.balance ?? 0)
console.log('buyer:', account.address, 'gateway balance on', chain.id, ':', available, 'USDC')
if (available * 10 ** asset.decimals < Number(offer.amount)) {
  console.error(`insufficient Gateway balance for ${offer.amount} units; deposit first (circle gateway deposit, or gateway.ts on Arc testnet)`)
  process.exit(1)
}
if (DRY) {
  console.log('dry run: nothing signed, nothing paid')
  process.exit(0)
}

// 4. Sign with the SDK's own scheme, exactly as a stock buyer would.
const { BatchEvmScheme } = await import('@circle-fin/x402-batching/client')
const scheme = new BatchEvmScheme({ address: account.address, signTypedData: (p) => account.signTypedData(p) })
const created = await scheme.createPaymentPayload(2, offer)
const payload = { x402Version: 2, accepted: offer, payload: created.payload }
console.log('signed authorization:', { from: created.payload.authorization.from, to: created.payload.authorization.to, value: created.payload.authorization.value, nonce: created.payload.authorization.nonce })

// 5. Pay.
const input = body.tool?.name === 'counterparty_check' ? { from: AGENT, to: arg('to', '#1259') } : { agentId: AGENT }
const paid = await fetch(URL_, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload)).toString('base64') },
  body: JSON.stringify(input),
})
const receipt = paid.headers.get('payment-response')
const out = await paid.json()
console.log('status:', paid.status)
if (receipt) console.log('PAYMENT-RESPONSE:', JSON.parse(Buffer.from(receipt, 'base64').toString('utf8')))
console.log(JSON.stringify(paid.status === 200 ? { settlement: out.settlement, keys: Object.keys(out) } : out, null, 2).slice(0, 3000))
process.exit(paid.status === 200 ? 0 : 1)
