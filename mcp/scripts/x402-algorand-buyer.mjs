/**
 * The buyer half of the Algorand x402 loop, for proving the rail end to end:
 * GET the challenge, build the AVM exact-scheme atomic group (unsigned
 * fee-payer pay + the buyer's SIGNED fee-zero USDC transfer), and POST it
 * back with the PAYMENT-SIGNATURE header.
 *
 * Usage (from mcp/):
 *   BASE=http://localhost:3457 TOOL=verify_agent AGENT=849980 CONFIRM=yes \
 *     node --env-file=.env scripts/x402-algorand-buyer.mjs
 *
 * Env: X402_ALGORAND_BUYER_MNEMONIC (the paying account). The fee payer
 * address comes from the facilitator's /supported, never typed here.
 */
import algosdk from 'algosdk'
import { getChainById } from '../dist/chains/registry.js'

const BASE = process.env.BASE ?? 'http://localhost:3457'
const TOOL = process.env.TOOL ?? 'verify_agent'
const AGENT = process.env.AGENT ?? '849980'
const FACILITATOR = process.env.X402_ALGORAND_FACILITATOR ?? 'https://facilitator.goplausible.xyz'
const log = (...a) => console.log('[algo-buyer]', ...a)

const mnemonic = (process.env.X402_ALGORAND_BUYER_MNEMONIC ?? '').trim()
if (!mnemonic) { console.error('X402_ALGORAND_BUYER_MNEMONIC missing; nothing was signed.'); process.exit(1) }
const buyer = algosdk.mnemonicToSecretKey(mnemonic)

const challengeRes = await fetch(`${BASE}/api/x402/algorand/tools/${TOOL}`)
const challenge = await challengeRes.json()
if (challengeRes.status !== 402) { console.error(`expected 402, got ${challengeRes.status}:`, challenge); process.exit(1) }
const accepts = challenge.accepts?.[0]
log(`challenge: pay ${accepts.amount} base units of ASA ${accepts.asset} to ${accepts.payTo} on ${accepts.network}`)

// The chain the challenge names, resolved through the registry for algod access.
const caip2ByFacNet = { 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=': 'algorand', 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=': 'algorand-testnet' }
const chain = getChainById(caip2ByFacNet[accepts.network])
if (!chain) { console.error(`unknown network in challenge: ${accepts.network}`); process.exit(1) }
const ALGOD = process.env[chain.rpcEnvVar] || chain.rpcUrls[0]

const supported = await (await fetch(`${FACILITATOR}/supported`, { headers: { Accept: 'application/json' } })).json()
const kind = (supported.kinds ?? []).find((k) => k.network === accepts.network)
const feePayer = kind?.extra?.feePayer
if (!feePayer) { console.error(`the facilitator lists no feePayer for ${accepts.network}`); process.exit(1) }
log(`facilitator fee payer: ${feePayer}`)

const p = await (await fetch(`${ALGOD}/v2/transactions/params`)).json()
const sp = {
  fee: 0, flatFee: true, minFee: 1000,
  firstValid: p['last-round'] + 1, lastValid: p['last-round'] + 1000,
  genesisID: p['genesis-id'], genesisHash: new Uint8Array(Buffer.from(p['genesis-hash'], 'base64')),
}
const feeTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: feePayer, receiver: feePayer, amount: 0,
  suggestedParams: { ...sp, fee: 2000 },
  note: new TextEncoder().encode('x402-fee-payer'),
})
const payTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: buyer.addr, receiver: accepts.payTo, assetIndex: BigInt(accepts.asset), amount: BigInt(accepts.amount),
  suggestedParams: { ...sp, fee: 0 },
  note: new TextEncoder().encode('x402-payment-v2'),
})
const [fee0, pay1] = algosdk.assignGroupID([feeTxn, payTxn])
const paymentGroup = [
  Buffer.from(algosdk.encodeUnsignedTransaction(fee0)).toString('base64'),
  Buffer.from(pay1.signTxn(buyer.sk)).toString('base64'),
]
log(`payment txid: ${pay1.txID()} (buyer ${buyer.addr}, fee 0)`)

if (process.env.CONFIRM !== 'yes') { log('Dry run (set CONFIRM=yes to pay). Nothing was sent.'); process.exit(0) }

const payload = {
  x402Version: 2, scheme: 'exact', network: accepts.network,
  resource: challenge.resource, accepted: accepts, extensions: {},
  payload: { paymentGroup, paymentIndex: 1 },
}
const header = Buffer.from(JSON.stringify(payload)).toString('base64')
const res = await fetch(`${BASE}/api/x402/algorand/tools/${TOOL}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': header },
  body: JSON.stringify({ agentId: AGENT }),
})
const body = await res.json()
log(`HTTP ${res.status}`)
console.log(JSON.stringify(body, null, 2))
process.exit(res.status === 200 ? 0 : 1)
