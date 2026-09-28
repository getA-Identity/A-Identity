/**
 * A one-time Stellar wallet on the user's own machine, used only to receive XLM once and pass
 * it on to SideShift, so someone who holds XLM can pay for A-Identity checks on Algorand.
 *
 * Same rules as the Algorand wallet: the secret seed is written to a file only its owner can
 * read and never printed. Horizon is read and written over its REST API, and transactions are
 * built with @stellar/stellar-base rather than the full SDK, to keep `npx` fast.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Account, Asset, BASE_FEE, Keypair, Memo, Networks, Operation, StrKey, TransactionBuilder } from '@stellar/stellar-base'
import type { FetchLike } from '@a-identity/trust-guard'

export const HORIZON = 'https://horizon.stellar.org'
/** Base reserve (1 XLM for the account) plus room for fees. What cannot be passed on. */
export const STELLAR_KEEP_XLM = 1.5

export type StellarWalletFile = { version: 1; network: 'stellar-pubnet'; address: string; secret: string; createdAt: string; purpose: string }

export function stellarKeyfilePath(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.A_IDENTITY_STELLAR_KEYFILE?.trim()
  return set || join(homedir(), '.a-identity', 'stellar-wallet.json')
}

export function loadStellarWallet(path: string): StellarWalletFile | null {
  if (!existsSync(path)) return null
  const w = JSON.parse(readFileSync(path, 'utf8')) as Partial<StellarWalletFile>
  if (typeof w.address !== 'string' || typeof w.secret !== 'string') throw new Error(`${path} is not an A-Identity Stellar wallet file`)
  return w as StellarWalletFile
}

export function createStellarWallet(path: string, now: () => Date = () => new Date()): { address: string; created: boolean } {
  const existing = loadStellarWallet(path)
  if (existing) return { address: existing.address, created: false }
  const kp = Keypair.random()
  const file: StellarWalletFile = {
    version: 1,
    network: 'stellar-pubnet',
    address: kp.publicKey(),
    secret: kp.secret(),
    createdAt: now().toISOString(),
    purpose: 'A one-time Stellar wallet that passes XLM on to pay for A-Identity checks. Returned to your own address when you are done.',
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
  return { address: file.address, created: true }
}

export const isStellarAddress = (s: string) => StrKey.isValidEd25519PublicKey(s)

type HorizonAccount = { sequence?: string; subentry_count?: number; balances?: { asset_type?: string; balance?: string }[] }

async function horizonJson(fetchImpl: FetchLike, url: string): Promise<{ status: number; json: unknown }> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  return { status: res.status, json: await res.json().catch(() => null) }
}

export async function readXlm(address: string, horizon: string = HORIZON, fetchImpl: FetchLike = fetch): Promise<{ exists: boolean; xlm: number; sequence: string | null; subentries: number }> {
  const { status, json } = await horizonJson(fetchImpl, `${horizon}/accounts/${address}`)
  if (status === 404) return { exists: false, xlm: 0, sequence: null, subentries: 0 }
  const a = json as HorizonAccount | null
  if (status !== 200 || !a) throw new Error(`Stellar could not read ${address} (HTTP ${status}).`)
  const native = (a.balances ?? []).find((b) => b.asset_type === 'native')
  return { exists: true, xlm: Number(native?.balance ?? 0), sequence: a.sequence ?? null, subentries: Number(a.subentry_count ?? 0) }
}

/** SideShift hands out numeric memos; send them as MEMO_ID, anything else as text. */
export function memoFor(memo: string | null | undefined): Memo {
  if (!memo) return Memo.none()
  return /^[0-9]{1,19}$/.test(memo) ? Memo.id(memo) : Memo.text(memo)
}

/** Builds and signs; returns the hash BEFORE submitting, so a crash can be checked, not repeated. */
export function buildXlmPayment(
  w: StellarWalletFile,
  sequence: string,
  op: { kind: 'pay'; to: string; amountXlm: string; memo?: string | null } | { kind: 'merge'; to: string },
): { hash: string; xdr: string } {
  const kp = Keypair.fromSecret(w.secret)
  const builder = new TransactionBuilder(new Account(w.address, sequence), { fee: String(Number(BASE_FEE) * 10), networkPassphrase: Networks.PUBLIC })
  if (op.kind === 'pay') {
    builder.addOperation(Operation.payment({ destination: op.to, asset: Asset.native(), amount: op.amountXlm })).addMemo(memoFor(op.memo))
  } else {
    builder.addOperation(Operation.accountMerge({ destination: op.to }))
  }
  const tx = builder.setTimeout(300).build()
  tx.sign(kp)
  return { hash: tx.hash().toString('hex'), xdr: tx.toXDR() }
}

/** Whether a transaction we may already have sent landed. */
export async function stellarTxLanded(hash: string, horizon: string = HORIZON, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const { status, json } = await horizonJson(fetchImpl, `${horizon}/transactions/${hash}`)
  return status === 200 && (json as { successful?: boolean } | null)?.successful === true
}

export async function submitStellar(xdr: string, horizon: string = HORIZON, fetchImpl: FetchLike = fetch): Promise<string> {
  const res = await fetchImpl(`${horizon}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `tx=${encodeURIComponent(xdr)}`,
  })
  const json = (await res.json().catch(() => null)) as { hash?: string; extras?: { result_codes?: unknown } } | null
  if (res.status !== 200 || !json?.hash) throw new Error(`Stellar refused the transaction: ${JSON.stringify(json?.extras?.result_codes ?? res.status)}`)
  return json.hash
}
