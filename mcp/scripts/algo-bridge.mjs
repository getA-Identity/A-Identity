/**
 * Fund the Algorand mainnet go-live from a Stellar XLM treasury, end to end.
 *
 *   XLM (treasury G...) --SideShift--> ALGO  (payTo account: MBR + opt-in + fees)
 *                       --SideShift--> USDC  (buyer account, algorand network)
 *   plus the two USDC ASA opt-ins in between, because SideShift cannot settle
 *   USDC into an account that has not opted in.
 *
 * Usage (from mcp/):
 *   npm run build && CONFIRM=yes node --env-file=.env scripts/algo-bridge.mjs
 *
 * Env: ALGO_BRIDGE_STELLAR_SECRET, ALGORAND_MAINNET_SIGNER_MNEMONIC,
 *      X402_ALGORAND_MAINNET_PAYTO, X402_ALGORAND_BUYER_MNEMONIC,
 *      SIDESHIFT_AFFILIATE_ID (the anonymous account id from sideshift.ai).
 *
 * Idempotent: every shift id and every sent transaction lands in
 * data/algo-bridge-state.json before anything else happens, and a re-run picks
 * up where the last one stopped instead of paying twice. Without CONFIRM=yes
 * it prints what it WOULD do and exits, the same contract every money-moving
 * script in this repo honors.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import algosdk from 'algosdk'
import { Horizon, Keypair, TransactionBuilder, Networks, Operation, Asset, Memo, BASE_FEE } from '@stellar/stellar-sdk'
import { getChainById } from '../dist/chains/registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = join(__dirname, '..', 'data', 'algo-bridge-state.json')
const SIDESHIFT = 'https://sideshift.ai/api/v2'
const HORIZON = 'https://horizon.stellar.org'

// Per-shift XLM. The pair minimum was 16.70 XLM when this was written; the
// script re-reads the live minimum and refuses rather than under-sending.
const SHIFT_XLM = { algo: '17.5', usdc: '17.5' }
// Keep at least this much behind: the 1 XLM base reserve plus fee headroom.
const TREASURY_KEEP_XLM = 1.5

const env = process.env
const CONFIRM = env.CONFIRM === 'yes'
const log = (...a) => console.log('[algo-bridge]', ...a)

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
function saveState(s) {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
}

function need(name) {
  const v = (env[name] ?? '').trim()
  if (!v) { console.error(`Missing ${name} in mcp/.env; nothing was sent.`); process.exit(1) }
  return v
}

const chain = getChainById('algorand')
const USDC_ASA = Number(chain.settlementTokens[0].address)
const ALGOD = env[chain.rpcEnvVar] || chain.rpcUrls[0]

async function jfetch(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${JSON.stringify(body)}`)
  return body
}

async function algoAccount(addr) {
  try {
    return await jfetch(`${ALGOD}/v2/accounts/${addr}`)
  } catch (e) {
    if (String(e).includes('404')) return { amount: 0, assets: [] }
    throw e
  }
}
const microToAlgo = (n) => Number(n) / 1e6
const usdcOf = (acct) => microToAlgo((acct.assets ?? []).find((a) => a['asset-id'] === USDC_ASA)?.amount ?? 0)
const optedIn = (acct) => (acct.assets ?? []).some((a) => a['asset-id'] === USDC_ASA)

async function xlmBalance(server, pub) {
  try {
    const a = await server.loadAccount(pub)
    return Number(a.balances.find((b) => b.asset_type === 'native')?.balance ?? 0)
  } catch {
    return 0 // unfunded accounts do not exist yet on Stellar
  }
}

async function createShift(settle, settleAddress, refundAddress, affiliateId) {
  const [settleCoin, settleNetwork] = settle
  const body = {
    depositCoin: 'XLM', depositNetwork: 'stellar',
    settleCoin, settleNetwork, settleAddress, refundAddress, affiliateId,
  }
  const post = (b) =>
    jfetch(`${SIDESHIFT}/shifts/variable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    })
  try {
    return await post(body)
  } catch (e) {
    // A Stellar refund address is only valid once the account exists on-ledger;
    // if SideShift still rejects it, a shift without one beats no shift, because
    // a variable shift refunds are the edge case and the deposit itself is small.
    if (String(e).includes('Invalid refund address')) {
      log('refund address rejected; creating the shift without one')
      const { refundAddress: _drop, ...rest } = body
      return post(rest)
    }
    throw e
  }
}

async function sendXlm(server, kp, dest, memoText, amountXlm) {
  const account = await server.loadAccount(kp.publicKey())
  const tx = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.payment({ destination: dest, asset: Asset.native(), amount: amountXlm }))
    .addMemo(Memo.text(String(memoText)))
    .setTimeout(300)
    .build()
  tx.sign(kp)
  const res = await server.submitTransaction(tx)
  return res.hash
}

async function waitShift(id, label) {
  for (let i = 0; i < 60; i++) {
    const s = await jfetch(`${SIDESHIFT}/shifts/${id}`)
    log(`${label}: shift ${id} status=${s.status}${s.settleHash ? ` settle=${s.settleHash}` : ''}`)
    if (s.status === 'settled') return s
    if (['refunded', 'expired'].includes(s.status)) throw new Error(`${label}: shift ended as ${s.status}; XLM refunds to the treasury`)
    await new Promise((r) => setTimeout(r, 15_000))
  }
  throw new Error(`${label}: still not settled after 15 minutes; re-run to resume polling (nothing is lost)`)
}

async function algodParams() {
  const p = await jfetch(`${ALGOD}/v2/transactions/params`)
  return {
    fee: 1000, flatFee: true, minFee: 1000,
    firstValid: p['last-round'] + 1, lastValid: p['last-round'] + 1000,
    genesisID: p['genesis-id'], genesisHash: new Uint8Array(Buffer.from(p['genesis-hash'], 'base64')),
  }
}

async function submitAlgo(stx) {
  const res = await fetch(`${ALGOD}/v2/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-binary' }, body: stx,
    signal: AbortSignal.timeout(30_000),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`algod submit -> HTTP ${res.status}: ${JSON.stringify(body)}`)
  return body.txId
}

async function main() {
  const affiliateId = need('SIDESHIFT_AFFILIATE_ID')
  const treasury = Keypair.fromSecret(need('ALGO_BRIDGE_STELLAR_SECRET'))
  const payToAcct = algosdk.mnemonicToSecretKey(need('ALGORAND_MAINNET_SIGNER_MNEMONIC'))
  const buyerAcct = algosdk.mnemonicToSecretKey(need('X402_ALGORAND_BUYER_MNEMONIC'))
  const payTo = need('X402_ALGORAND_MAINNET_PAYTO')
  if (payToAcct.addr.toString() !== payTo) { console.error('X402_ALGORAND_MAINNET_PAYTO does not match the signer mnemonic.'); process.exit(1) }

  const server = new Horizon.Server(HORIZON)
  const state = loadState()

  const bal = await xlmBalance(server, treasury.publicKey())
  const pairAlgo = await jfetch(`${SIDESHIFT}/pair/xlm-stellar/algo-algorand`)
  const pairUsdc = await jfetch(`${SIDESHIFT}/pair/xlm-stellar/usdc-algorand`)
  const needXlm = Number(SHIFT_XLM.algo) + Number(SHIFT_XLM.usdc) + TREASURY_KEEP_XLM
  log(`treasury ${treasury.publicKey()}`)
  log(`treasury balance: ${bal} XLM (needs ~${needXlm}); pair minimums: ${pairAlgo.min} / ${pairUsdc.min} XLM`)
  const payToInfo = await algoAccount(payTo)
  const buyerInfo = await algoAccount(buyerAcct.addr.toString())
  log(`payTo ${payTo}: ${microToAlgo(payToInfo.amount)} ALGO, ${usdcOf(payToInfo)} USDC, optedIn=${optedIn(payToInfo)}`)
  log(`buyer ${buyerAcct.addr}: ${microToAlgo(buyerInfo.amount)} ALGO, ${usdcOf(buyerInfo)} USDC, optedIn=${optedIn(buyerInfo)}`)

  if (Number(SHIFT_XLM.algo) < Number(pairAlgo.min) || Number(SHIFT_XLM.usdc) < Number(pairUsdc.min)) {
    console.error('The live pair minimum rose above the configured shift size; raise SHIFT_XLM.'); process.exit(1)
  }
  if (!CONFIRM) { log('Dry run (set CONFIRM=yes to execute). Nothing was sent.'); return }
  if (bal < needXlm && !state.shift1?.sentTx) {
    console.error(`Treasury holds ${bal} XLM; fund it with at least ${needXlm} XLM first. Nothing was sent.`); process.exit(1)
  }

  // ── Step 1: XLM -> ALGO into payTo ─────────────────────────────────────────
  if (!state.shift1?.settled) {
    if (!state.shift1?.id) {
      const s = await createShift(['ALGO', 'algorand'], payTo, treasury.publicKey(), affiliateId)
      state.shift1 = { id: s.id, depositAddress: s.depositAddress, depositMemo: s.depositMemo ?? s.depositMemoId ?? null }
      saveState(state)
      log(`shift1 created: ${s.id} deposit=${s.depositAddress} memo=${state.shift1.depositMemo}`)
    }
    if (!state.shift1.sentTx) {
      state.shift1.sentTx = await sendXlm(server, treasury, state.shift1.depositAddress, state.shift1.depositMemo, SHIFT_XLM.algo)
      saveState(state)
      log(`shift1: sent ${SHIFT_XLM.algo} XLM, tx ${state.shift1.sentTx}`)
    }
    const settled = await waitShift(state.shift1.id, 'shift1 XLM->ALGO')
    state.shift1.settled = true
    state.shift1.settleHash = settled.settleHash ?? null
    saveState(state)
  }

  // ── Step 2: opt-ins (payTo, then fund + opt-in the buyer) ─────────────────
  const payToNow = await algoAccount(payTo)
  if (!optedIn(payToNow)) {
    const sp = await algodParams()
    const tx = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: payToAcct.addr, receiver: payToAcct.addr, assetIndex: USDC_ASA, amount: 0, suggestedParams: sp,
    })
    log(`payTo USDC opt-in: ${await submitAlgo(tx.signTxn(payToAcct.sk))}`)
  }
  const buyerNow = await algoAccount(buyerAcct.addr.toString())
  if (microToAlgo(buyerNow.amount) < 0.3) {
    const sp = await algodParams()
    const tx = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: payToAcct.addr, receiver: buyerAcct.addr, amount: 400_000, suggestedParams: sp,
    })
    log(`buyer funded with 0.4 ALGO: ${await submitAlgo(tx.signTxn(payToAcct.sk))}`)
    await new Promise((r) => setTimeout(r, 4000))
  }
  if (!optedIn(buyerNow)) {
    const sp = await algodParams()
    const tx = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: buyerAcct.addr, receiver: buyerAcct.addr, assetIndex: USDC_ASA, amount: 0, suggestedParams: sp,
    })
    log(`buyer USDC opt-in: ${await submitAlgo(tx.signTxn(buyerAcct.sk))}`)
    await new Promise((r) => setTimeout(r, 4000))
  }

  // ── Step 3: XLM -> USDC (algorand) into the buyer ─────────────────────────
  if (!state.shift2?.settled) {
    if (!state.shift2?.id) {
      const s = await createShift(['USDC', 'algorand'], buyerAcct.addr.toString(), treasury.publicKey(), affiliateId)
      state.shift2 = { id: s.id, depositAddress: s.depositAddress, depositMemo: s.depositMemo ?? s.depositMemoId ?? null }
      saveState(state)
      log(`shift2 created: ${s.id} deposit=${s.depositAddress} memo=${state.shift2.depositMemo}`)
    }
    if (!state.shift2.sentTx) {
      state.shift2.sentTx = await sendXlm(server, treasury, state.shift2.depositAddress, state.shift2.depositMemo, SHIFT_XLM.usdc)
      saveState(state)
      log(`shift2: sent ${SHIFT_XLM.usdc} XLM, tx ${state.shift2.sentTx}`)
    }
    const settled = await waitShift(state.shift2.id, 'shift2 XLM->USDC')
    state.shift2.settled = true
    state.shift2.settleHash = settled.settleHash ?? null
    saveState(state)
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const p = await algoAccount(payTo)
  const b = await algoAccount(buyerAcct.addr.toString())
  log('DONE.')
  log(`payTo ${payTo}: ${microToAlgo(p.amount)} ALGO, ${usdcOf(p)} USDC, optedIn=${optedIn(p)}`)
  log(`buyer ${buyerAcct.addr}: ${microToAlgo(b.amount)} ALGO, ${usdcOf(b)} USDC, optedIn=${optedIn(b)}`)
  log('Next: set X402_ALGORAND_NETWORKS + X402_ALGORAND_MAINNET_PAYTO (+ TAG) on Render, then run the first paid call.')
}

main().catch((e) => { console.error('[algo-bridge] failed:', e.message ?? e); process.exit(1) })
