/**
 * A one-time Algorand wallet on the user's own machine, for paying A-Identity checks.
 *
 * The key is generated here, written to a file only its owner can read (0600, in a 0700
 * directory), and never printed: every function that returns something a person or an agent
 * will see returns the address, balances and next step, never the 25 words. Nothing is sent
 * anywhere but the Algorand network. When the user is done, `sweep` sends what is left back to
 * an address they name, closes the account, and retires the file.
 *
 * Reads and writes go through algod's REST API directly (the same public Nodely endpoint the
 * payer uses), so the shapes are the ledger's own JSON rather than one SDK version's models.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import * as algosdk from 'algosdk'
import type { FetchLike } from '@a-identity/trust-guard'
import { ALGORAND_USDC } from '@a-identity/trust-guard/algorand'

type FetchLikeAlgorand = FetchLike

export const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
export const USDC_ASSET = Number(ALGORAND_USDC[MAINNET].asset)
export const DEFAULT_ALGOD = ALGORAND_USDC[MAINNET].algod

/** Enough ALGO to exist (0.1), hold USDC (0.1 more) and pay the opt-in and sweep fees. */
export const ALGO_TO_SEND = 0.3
const MICRO = 1_000_000

export type WalletFile = { version: 1; network: 'algorand-mainnet'; address: string; mnemonic: string; createdAt: string; purpose: string }

export function keyfilePath(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.A_IDENTITY_KEYFILE?.trim()
  return set || join(homedir(), '.a-identity', 'algorand-wallet.json')
}

export function loadWallet(path: string): WalletFile | null {
  if (!existsSync(path)) return null
  const w = JSON.parse(readFileSync(path, 'utf8')) as Partial<WalletFile>
  if (typeof w.address !== 'string' || typeof w.mnemonic !== 'string') throw new Error(`${path} is not an A-Identity wallet file`)
  return w as WalletFile
}

/** Create the wallet, or return the one already there. Returns the address only. */
export function createWallet(path: string, now: () => Date = () => new Date()): { address: string; created: boolean } {
  const existing = loadWallet(path)
  if (existing) return { address: existing.address, created: false }
  const account = algosdk.generateAccount()
  const file: WalletFile = {
    version: 1,
    network: 'algorand-mainnet',
    address: account.addr.toString(),
    mnemonic: algosdk.secretKeyToMnemonic(account.sk),
    createdAt: now().toISOString(),
    purpose: 'A one-time wallet for paying A-Identity checks. Sweep it back to your own address when you are done.',
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
  return { address: file.address, created: true }
}

// ── reading the ledger ─────────────────────────────────────────────────────────────

export type WalletStatus = {
  address: string
  exists: boolean
  algo: number
  minBalanceAlgo: number
  usdcOptedIn: boolean
  usdc: number
  otherAssets: number
}

async function getJson(fetchImpl: FetchLikeAlgorand, url: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { status: res.status, json }
}

export async function readStatus(address: string, algod: string = DEFAULT_ALGOD, fetchImpl: FetchLikeAlgorand = fetch): Promise<WalletStatus> {
  const { status, json } = await getJson(fetchImpl, `${algod}/v2/accounts/${address}`)
  if (status === 404) return { address, exists: false, algo: 0, minBalanceAlgo: 0.1, usdcOptedIn: false, usdc: 0, otherAssets: 0 }
  if (status !== 200 || !json) throw new Error(`The Algorand node could not read ${address} (HTTP ${status}).`)
  const assets = (json.assets as { 'asset-id'?: number; amount?: number }[] | undefined) ?? []
  const usdc = assets.find((a) => a['asset-id'] === USDC_ASSET)
  return {
    address,
    exists: Number(json.amount ?? 0) > 0,
    algo: Number(json.amount ?? 0) / MICRO,
    minBalanceAlgo: Number(json['min-balance'] ?? 100_000) / MICRO,
    usdcOptedIn: Boolean(usdc),
    usdc: usdc ? Number(usdc.amount ?? 0) / MICRO : 0,
    otherAssets: assets.filter((a) => a['asset-id'] !== USDC_ASSET).length,
  }
}

/** What the user should do next, in one sentence a person can act on. */
export function nextStep(s: WalletStatus, priceUsd: number = 5): string {
  if (!s.usdcOptedIn && s.algo < 0.202) {
    return `Send ${ALGO_TO_SEND} ALGO on the Algorand network to ${s.address}. Send only ALGO for now: USDC sent before the next step would be refused.`
  }
  if (!s.usdcOptedIn) return 'The ALGO has arrived. Run: npx -y @a-identity/trust-mcp@latest wallet optin'
  if (s.usdc < priceUsd) {
    return `Send USDC on the Algorand network to ${s.address}. One address check costs ${priceUsd} USDC; it holds ${s.usdc}.`
  }
  return 'Ready. Run: npx -y @a-identity/trust-mcp@latest check <ADDRESS OR LINK>'
}

// ── writing to the ledger ──────────────────────────────────────────────────────────

type Params = { 'last-round'?: number; 'min-fee'?: number; 'genesis-id'?: string; 'genesis-hash'?: string }

export async function params(algod: string, fetchImpl: FetchLikeAlgorand) {
  const { status, json } = await getJson(fetchImpl, `${algod}/v2/transactions/params`)
  const p = (json ?? {}) as Params
  if (status !== 200 || typeof p['last-round'] !== 'number' || typeof p['genesis-hash'] !== 'string') {
    throw new Error(`The Algorand node returned no transaction parameters (HTTP ${status}).`)
  }
  const minFee = Number(p['min-fee'] ?? 1000)
  return {
    fee: minFee,
    flatFee: true,
    minFee,
    firstValid: p['last-round'] + 1,
    lastValid: p['last-round'] + 1000,
    genesisID: String(p['genesis-id']),
    genesisHash: Uint8Array.from(Buffer.from(p['genesis-hash'], 'base64')),
  }
}

export type Suggested = Awaited<ReturnType<typeof params>>

/** A zero-amount USDC transfer to itself: how an Algorand account agrees to hold USDC. */
export function buildOptIn(address: string, suggested: Suggested) {
  return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    assetIndex: USDC_ASSET,
    amount: 0,
    suggestedParams: suggested,
  })
}

/**
 * Everything back to `to` in one atomic group: all USDC (closing the holding), then all ALGO
 * (closing the account). `usdcCloseTo` is `to` when it can hold USDC, or the asset's creator
 * when the wallet holds none, since a holding can only be closed to an account that can take it.
 */
export function buildSweep(address: string, to: string, usdcCloseTo: string | null, suggested: Suggested) {
  const txns = []
  if (usdcCloseTo) {
    txns.push(
      algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: address,
        receiver: usdcCloseTo,
        closeRemainderTo: usdcCloseTo,
        assetIndex: USDC_ASSET,
        amount: 0,
        suggestedParams: suggested,
      }),
    )
  }
  txns.push(
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: address,
      receiver: to,
      closeRemainderTo: to,
      amount: 0,
      suggestedParams: suggested,
    }),
  )
  return txns.length > 1 ? algosdk.assignGroupID(txns) : txns
}

export async function submit(algod: string, fetchImpl: FetchLikeAlgorand, signed: Uint8Array[]): Promise<string> {
  const body = new Uint8Array(signed.reduce((n, b) => n + b.length, 0))
  let at = 0
  for (const b of signed) {
    body.set(b, at)
    at += b.length
  }
  const res = await fetchImpl(`${algod}/v2/transactions`, { method: 'POST', headers: { 'content-type': 'application/x-binary' }, body })
  const json = (await res.json().catch(() => null)) as { txId?: string; message?: string } | null
  if (res.status !== 200 || !json?.txId) throw new Error(`The Algorand node refused the transaction: ${json?.message ?? `HTTP ${res.status}`}`)
  for (let i = 0; i < 20; i++) {
    const { json: p } = await getJson(fetchImpl, `${algod}/v2/transactions/pending/${json.txId}`)
    if (Number(p?.['confirmed-round'] ?? 0) > 0) return json.txId
    if (typeof p?.['pool-error'] === 'string' && p['pool-error']) throw new Error(`The transaction was dropped: ${p['pool-error']}`)
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`Sent (${json.txId}) but not confirmed yet. Check it before trying again.`)
}

export async function optIn(w: WalletFile, algod: string = DEFAULT_ALGOD, fetchImpl: FetchLikeAlgorand = fetch): Promise<string> {
  const s = await readStatus(w.address, algod, fetchImpl)
  if (s.usdcOptedIn) return 'already'
  if (s.algo < 0.202) throw new Error(`The wallet holds ${s.algo} ALGO; it needs at least 0.202 to hold USDC. ${nextStep(s)}`)
  const { sk } = algosdk.mnemonicToSecretKey(w.mnemonic)
  const txn = buildOptIn(w.address, await params(algod, fetchImpl))
  return submit(algod, fetchImpl, [txn.signTxn(sk)])
}

export async function sweep(
  w: WalletFile,
  path: string,
  to: string,
  algod: string = DEFAULT_ALGOD,
  fetchImpl: FetchLikeAlgorand = fetch,
): Promise<{ txId: string; usdc: number; algo: number; retiredFile: string }> {
  if (!algosdk.isValidAddress(to)) throw new Error(`${to} is not a valid Algorand address.`)
  if (to === w.address) throw new Error('Sweep to an address of your own, not to this wallet.')
  const s = await readStatus(w.address, algod, fetchImpl)
  if (!s.exists) throw new Error('This wallet holds nothing to send back.')
  if (s.otherAssets > 0) throw new Error('This wallet holds assets other than USDC; move them out first.')
  let usdcCloseTo: string | null = null
  if (s.usdcOptedIn) {
    const dest = await readStatus(to, algod, fetchImpl)
    if (dest.usdcOptedIn) usdcCloseTo = to
    else if (s.usdc > 0) throw new Error(`${to} cannot receive USDC yet. Enable USDC on it (or pick an address that can), then sweep again.`)
    else {
      const { json } = await getJson(fetchImpl, `${algod}/v2/assets/${USDC_ASSET}`)
      usdcCloseTo = String(((json?.params ?? {}) as { creator?: string }).creator ?? '')
      if (!algosdk.isValidAddress(usdcCloseTo)) throw new Error('Could not read the USDC asset to close the empty holding.')
    }
  }
  const { sk } = algosdk.mnemonicToSecretKey(w.mnemonic)
  const txns = buildSweep(w.address, to, usdcCloseTo, await params(algod, fetchImpl))
  const txId = await submit(algod, fetchImpl, txns.map((t) => t.signTxn(sk)))
  const retiredFile = path.replace(/\.json$/, '') + `.closed-${Date.now()}.json`
  renameSync(path, retiredFile)
  return { txId, usdc: s.usdc, algo: s.algo, retiredFile }
}

/** Whether an Algorand transaction we may already have sent is on the ledger (read from the indexer). */
export async function algorandTxLanded(txId: string, algod: string = DEFAULT_ALGOD, fetchImpl: FetchLikeAlgorand = fetch): Promise<boolean> {
  // The node first: it knows a transaction that is still in its pool or just confirmed, which
  // the indexer may not have caught up with yet. Treating those as sent is what stops a resume
  // from sending the same money twice.
  const pending = await getJson(fetchImpl, `${algod}/v2/transactions/pending/${txId}`)
  if (pending.status === 200 && !pending.json?.['pool-error']) return true
  const idx = algod.replace('-api.', '-idx.')
  const { status, json } = await getJson(fetchImpl, `${idx}/v2/transactions/${txId}`)
  const t = json?.transaction as { 'confirmed-round'?: number } | undefined
  return status === 200 && Number(t?.['confirmed-round'] ?? 0) > 0
}

/**
 * One transfer out of the wallet: ALGO or USDC, a set amount or everything (`close`, which also
 * closes the ALGO account or the USDC holding). Returned unsent with its id, so a caller can
 * record the id before submitting and check it after a crash instead of sending twice.
 */
export function buildTransfer(
  w: WalletFile,
  a: { asset: 'algo' | 'usdc'; to: string; micro: number; close: boolean },
  suggested: Suggested,
): { txId: string; signed: Uint8Array } {
  const { sk } = algosdk.mnemonicToSecretKey(w.mnemonic)
  const txn =
    a.asset === 'algo'
      ? algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: w.address,
          receiver: a.to,
          amount: a.close ? 0 : a.micro,
          ...(a.close ? { closeRemainderTo: a.to } : {}),
          suggestedParams: suggested,
        })
      : algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          sender: w.address,
          receiver: a.to,
          assetIndex: USDC_ASSET,
          amount: a.close ? 0 : a.micro,
          ...(a.close ? { closeRemainderTo: a.to } : {}),
          suggestedParams: suggested,
        })
  return { txId: txn.txID(), signed: txn.signTxn(sk) }
}

/** The USDC creator: the one account an empty USDC holding can always be closed to. */
export async function usdcCreator(algod: string = DEFAULT_ALGOD, fetchImpl: FetchLikeAlgorand = fetch): Promise<string> {
  const { json } = await getJson(fetchImpl, `${algod}/v2/assets/${USDC_ASSET}`)
  const creator = String(((json?.params ?? {}) as { creator?: string }).creator ?? '')
  if (!algosdk.isValidAddress(creator)) throw new Error('Could not read the USDC asset to close the empty holding.')
  return creator
}
