/**
 * Deploy the AgentSpendPolicy vault to Algorand mainnet and walk its policy
 * ladder, mirroring what soroban/releases records for Stellar:
 *
 *   deploy (immutable, constructor-only) -> fund app with ALGO for MBR ->
 *   opt the app in to USDC -> fund it with dust USDC -> an under-limit
 *   operator payment SETTLES -> an over-ceiling payment is REFUSED in
 *   simulation with its typed message -> freeze -> a frozen payment is
 *   REFUSED -> the owner pays through the freeze -> unfreeze -> read policy.
 *
 * Refusals have no transaction hash on this chain for the same reason they
 * have none on Soroban: they fail in simulation and never reach the ledger.
 * What makes them typed here is the ARC-56 source map: the simulate failure
 * carries a program counter, and the map resolves it to the assert label
 * (ABOVE_AUTO_APPROVE, FROZEN, ...), which this script prints verbatim.
 *
 * Usage (from mcp/): npm run build && CONFIRM=yes node --env-file=.env scripts/algo-vault-deploy.mjs
 * Roles: owner = the payTo account, operator = the buyer account.
 * Idempotent: data/algo-vault-state.json records every step.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import algosdk from 'algosdk'
import { getChainById } from '../dist/chains/registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONTRACT_DIR = join(__dirname, '..', '..', 'algorand', 'contracts', 'agent-spend-policy')
const STATE_FILE = join(__dirname, '..', 'data', 'algo-vault-state.json')

const DAILY_CAP = 1_000_000n // 1 USDC
const CEILING = 250_000n // 0.25 USDC
const APP_ALGO_FUND = 300_000n // MBR (0.1 base + 0.1 asset) + headroom
const VAULT_USDC = 300_000n // 0.30 USDC of dust, on purpose
const UNDER_PAY = 50_000n // 0.05 USDC, settles
const OVER_PAY = 500_000n // 0.50 USDC, refused: above the 0.25 ceiling
const FROZEN_PAY = 10_000n // refused while frozen
const OWNER_PAY = 10_000n // the owner pays through the freeze

const env = process.env
const log = (...a) => console.log('[algo-vault]', ...a)
const state = (() => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} } })()
const save = () => { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)) }
const need = (n) => { const v = (env[n] ?? '').trim(); if (!v) { console.error(`Missing ${n}`); process.exit(1) } return v }

const chain = getChainById('algorand')
const USDC = BigInt(chain.settlementTokens[0].address)
const client = new algosdk.Algodv2('', env[chain.rpcEnvVar] || chain.rpcUrls[0], '')

const owner = algosdk.mnemonicToSecretKey(need('ALGORAND_MAINNET_SIGNER_MNEMONIC'))
const operator = algosdk.mnemonicToSecretKey(need('X402_ALGORAND_BUYER_MNEMONIC'))
const arc56 = JSON.parse(readFileSync(join(CONTRACT_DIR, 'AgentSpendPolicy.arc56.json'), 'utf8'))
const abi = new algosdk.ABIContract({ name: arc56.name, methods: arc56.methods })
const errorAt = (pc) => arc56.sourceInfo.approval.sourceInfo.find((e) => e.pc?.includes(pc))?.errorMessage ?? `unmapped pc ${pc}`

async function sp(feeTxns = 1) {
  const p = await client.getTransactionParams().do()
  p.flatFee = true
  p.fee = BigInt(1000 * feeTxns)
  return p
}
const signer = (acct) => algosdk.makeBasicAccountTransactionSigner(acct)

async function methodCall({ from, method, args, fee = 1, extra = {} }) {
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addMethodCall({
    appID: state.appId, method: abi.getMethodByName(method), methodArgs: args,
    sender: from.addr, suggestedParams: await sp(fee), signer: signer(from), ...extra,
  })
  const r = await atc.execute(client, 4)
  return r.txIDs[0]
}

async function simulateCall({ from, method, args, fee = 1 }) {
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addMethodCall({
    appID: state.appId, method: abi.getMethodByName(method), methodArgs: args,
    sender: from.addr, suggestedParams: await sp(fee), signer: signer(from),
  })
  const res = await atc.simulate(client)
  const group = res.simulateResponse.txnGroups[0]
  if (!group.failureMessage) return { refused: false, result: res.methodResults?.[0]?.returnValue }
  const pc = Number((String(group.failureMessage).match(/pc=(\d+)/) ?? [])[1] ?? -1)
  return { refused: true, typed: errorAt(pc), raw: String(group.failureMessage).slice(0, 160) }
}

async function main() {
  log(`owner (payTo) ${owner.addr}  operator (buyer) ${operator.addr}`)
  if (env.CONFIRM !== 'yes') { log('Dry run. Set CONFIRM=yes to deploy on MAINNET. Nothing was sent.'); return }

  // ── deploy, constructor-only ────────────────────────────────────────────────
  if (!state.appId) {
    const approvalTeal = readFileSync(join(CONTRACT_DIR, 'AgentSpendPolicy.approval.teal'))
    const clearTeal = readFileSync(join(CONTRACT_DIR, 'AgentSpendPolicy.clear.teal'))
    const approval = new Uint8Array(Buffer.from((await client.compile(approvalTeal).do()).result, 'base64'))
    const clear = new Uint8Array(Buffer.from((await client.compile(clearTeal).do()).result, 'base64'))
    state.approvalSha256 = createHash('sha256').update(approval).digest('hex')
    const atc = new algosdk.AtomicTransactionComposer()
    atc.addMethodCall({
      appID: 0, onComplete: algosdk.OnApplicationComplete.NoOpOC,
      approvalProgram: approval, clearProgram: clear,
      numGlobalInts: 7, numGlobalByteSlices: 2, numLocalInts: 0, numLocalByteSlices: 0,
      method: abi.getMethodByName('create'),
      methodArgs: [owner.addr.toString(), operator.addr.toString(), USDC, DAILY_CAP, CEILING],
      sender: owner.addr, suggestedParams: await sp(1), signer: signer(owner),
    })
    const r = await atc.execute(client, 4)
    const pending = await client.pendingTransactionInformation(r.txIDs[0]).do()
    state.appId = Number(pending.applicationIndex)
    state.appAddress = algosdk.getApplicationAddress(state.appId).toString()
    state.deployTx = r.txIDs[0]
    save()
    log(`deployed app ${state.appId} at ${state.appAddress} (tx ${state.deployTx}); approval sha256 ${state.approvalSha256}`)
  }

  // ── fund with ALGO for MBR, opt in to USDC, fund with dust USDC ────────────
  if (!state.fundAlgoTx) {
    const tx = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: owner.addr, receiver: state.appAddress, amount: APP_ALGO_FUND, suggestedParams: await sp(1),
    })
    const { txid } = await client.sendRawTransaction(tx.signTxn(owner.sk)).do()
    await algosdk.waitForConfirmation(client, txid, 4)
    state.fundAlgoTx = txid; save()
    log(`app funded with 0.3 ALGO for its minimum balance (tx ${txid})`)
  }
  if (!state.optInTx) {
    state.optInTx = await methodCall({ from: owner, method: 'opt_in_asset', args: [], fee: 2, extra: { appForeignAssets: [USDC] } })
    save()
    log(`app opted in to USDC (tx ${state.optInTx})`)
  }
  if (!state.fundUsdcTx) {
    const tx = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: operator.addr, receiver: state.appAddress, assetIndex: USDC, amount: VAULT_USDC, suggestedParams: await sp(1),
    })
    const { txid } = await client.sendRawTransaction(tx.signTxn(operator.sk)).do()
    await algosdk.waitForConfirmation(client, txid, 4)
    state.fundUsdcTx = txid; save()
    log(`vault funded with 0.30 USDC (tx ${txid})`)
  }

  // ── the ladder ─────────────────────────────────────────────────────────────
  if (!state.underPayTx) {
    state.underPayTx = await methodCall({
      from: operator, method: 'pay', args: [owner.addr.toString(), UNDER_PAY], fee: 2,
      extra: { appForeignAssets: [USDC], appAccounts: [owner.addr.toString()] },
    })
    save()
    log(`under-limit pay of 0.05 USDC SETTLED (tx ${state.underPayTx})`)
  }
  const over = await simulateCall({ from: operator, method: 'pay', args: [owner.addr.toString(), OVER_PAY], fee: 2 })
  log(`over-ceiling pay of 0.50 USDC: refused=${over.refused} typed=${over.typed ?? '-'}`)
  state.overRefusal = over; save()

  if (!state.freezeTx) {
    state.freezeTx = await methodCall({ from: owner, method: 'set_frozen', args: [1n] })
    save()
    log(`frozen (tx ${state.freezeTx})`)
  }
  const frozenTry = await simulateCall({ from: operator, method: 'pay', args: [owner.addr.toString(), FROZEN_PAY], fee: 2 })
  log(`pay while frozen: refused=${frozenTry.refused} typed=${frozenTry.typed ?? '-'}`)
  state.frozenRefusal = frozenTry; save()

  if (!state.ownerPayTx) {
    state.ownerPayTx = await methodCall({
      from: owner, method: 'owner_pay', args: [operator.addr.toString(), OWNER_PAY], fee: 2,
      extra: { appForeignAssets: [USDC], appAccounts: [operator.addr.toString()] },
    })
    save()
    log(`owner paid 0.01 USDC THROUGH the freeze (tx ${state.ownerPayTx})`)
  }
  if (!state.unfreezeTx) {
    state.unfreezeTx = await methodCall({ from: owner, method: 'set_frozen', args: [0n] })
    save()
    log(`unfrozen (tx ${state.unfreezeTx})`)
  }

  const view = await simulateCall({ from: owner, method: 'policy', args: [] })
  log(`policy view: ${JSON.stringify(view.result?.map?.((v) => String(v)) ?? view)}`)
  log('DONE. Record the transactions above in provenance.')
}

main().catch((e) => { console.error('[algo-vault] failed:', e?.message ?? e); process.exit(1) })
