/**
 * Our own read of the Algorand ledger: the step that turns "the facilitator
 * said success" into "the transfer is in the chain and matches what was paid
 * for". The indexer base derives from the registry's algod host (Nodely pairs
 * an -api. algod with an -idx. indexer) or from ALGORAND_*_INDEXER_URL, so no
 * host is typed here that the registry does not already know about.
 */
import type { ChainDescriptor } from '../chains/types.js'

export type AlgorandConfirmDeps = {
  env?: NodeJS.ProcessEnv
  fetcher?: typeof fetch
  /** Injectable for tests; defaults to a real sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Poll attempts before giving up (default 6, 1500ms apart: ~9s, three rounds). */
  attempts?: number
}

export type TransferExpectation = {
  txId: string
  /** ASA id, decimal string. */
  asset: string
  payTo: string
  minAmount: bigint
  payer: string
}

export function indexerBase(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): string {
  const envVar = chain.testnet ? 'ALGORAND_TESTNET_INDEXER_URL' : 'ALGORAND_MAINNET_INDEXER_URL'
  const fromEnv = (env[envVar] ?? '').trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  return (chain.rpcUrls[0] ?? '').replace('-api.', '-idx.').replace(/\/$/, '')
}

type IndexerTxn = {
  transaction?: {
    id?: string
    sender?: string
    'tx-type'?: string
    'confirmed-round'?: number
    'asset-transfer-transaction'?: { 'asset-id'?: number; amount?: number; receiver?: string }
  }
}

export async function confirmAlgorandTransfer(
  chain: ChainDescriptor,
  expect: TransferExpectation,
  deps: AlgorandConfirmDeps = {},
): Promise<{ ok: true; txId: string; round?: number } | { ok: false; reason: string }> {
  const fetcher = deps.fetcher ?? fetch
  const env = deps.env ?? process.env
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const attempts = deps.attempts ?? 6
  const base = indexerBase(chain, env)
  if (!base) return { ok: false, reason: 'no indexer endpoint could be derived for this chain' }

  let lastReason = 'not yet indexed'
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1500)
    let body: IndexerTxn | null = null
    try {
      const res = await fetcher(`${base}/v2/transactions/${expect.txId}`, { signal: AbortSignal.timeout(10_000) })
      if (res.status === 404) {
        lastReason = 'the transaction is not in the indexer yet'
        continue
      }
      if (!res.ok) {
        lastReason = `indexer answered HTTP ${res.status}`
        continue
      }
      body = (await res.json()) as IndexerTxn
    } catch (e) {
      lastReason = e instanceof Error ? e.message : String(e)
      continue
    }
    const t = body?.transaction
    if (!t || !t['confirmed-round']) {
      lastReason = 'the indexer returned the transaction without a confirmed round'
      continue
    }
    // The transaction exists and is final. Now it must be the RIGHT one: the
    // fields below decide whether a serving was actually paid for, so a
    // mismatch is a hard refusal, not a retry.
    if (t['tx-type'] !== 'axfer' || !t['asset-transfer-transaction']) {
      return { ok: false, reason: 'the confirmed transaction is not an ASA transfer' }
    }
    const at = t['asset-transfer-transaction']
    if (String(at['asset-id'] ?? '') !== expect.asset) {
      return { ok: false, reason: `the confirmed transfer moves ASA ${at['asset-id']}, not ${expect.asset}` }
    }
    if ((at.receiver ?? '') !== expect.payTo) {
      return { ok: false, reason: 'the confirmed transfer does not pay the expected payTo' }
    }
    if (BigInt(at.amount ?? 0) < expect.minAmount) {
      return { ok: false, reason: 'the confirmed transfer moves less than the price' }
    }
    if ((t.sender ?? '') !== expect.payer) {
      return { ok: false, reason: 'the confirmed transfer was not sent by the payer who signed the group' }
    }
    return { ok: true, txId: expect.txId, round: t['confirmed-round'] }
  }
  return { ok: false, reason: lastReason }
}
