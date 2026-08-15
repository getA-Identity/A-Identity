/**
 * What "settled" means on Stellar.
 *
 * This is the load-bearing honesty primitive of the whole rail, and it exists because of a
 * weakness this repo already wrote down about itself. `x402-3009/engine.ts` says it in the
 * header: celo-x402.ts delegates to a third-party facilitator, "so the buyer pays no gas,
 * but 'settled' is that facilitator's word: nothing reads the chain to confirm it."
 *
 * On Stellar we can broadcast ourselves, and we also support OpenZeppelin Channels as a
 * fallback. Either way the answer to "did the money move" comes from here, and from
 * nowhere else: we fetch the transaction and look for the token's own transfer event with
 * our payee and our exact amount. A facilitator reporting success is an INPUT to this
 * check, never a substitute for it.
 *
 * The event shape below is not guessed. It was read off a real settlement on testnet
 * (3da74634..., ledger 4147945), where the SAC emitted:
 *
 *   contract  CBIELTK6...            the USDC Stellar Asset Contract
 *   topics    ["transfer", from, to, "USDC:GBBD47IF..."]
 *   data      "10000000"             i128 base units, 7 decimals
 *
 * Three failure modes are distinguished on purpose, because they need different responses:
 * a transaction that never landed may still land, one that landed and failed never will,
 * and one that succeeded without a matching transfer means we were told about the wrong
 * transaction entirely.
 */
import { StrKey, rpc, scValToNative, xdr } from '@stellar/stellar-sdk'

import type { ChainDescriptor } from '../chains/types.js'
import { sorobanServer } from '../chains/stellar/client.js'

export type TransferExpectation = {
  /** The SEP-41 contract the transfer must have been emitted by. */
  sac: string
  /** Our receiving account. A transfer to anyone else is not our settlement. */
  to: string
  /** Exact base units. Not a minimum: an amount we did not ask for is a different deal. */
  amountRaw: bigint
}

export type ConfirmFailureCode =
  /** Not in the ledger within the window. It may still land, so nothing is decided. */
  | 'not_found'
  /** Landed and failed. Decided, and decided against. */
  | 'tx_failed'
  /** Landed and succeeded, but carries no transfer matching what we asked for. */
  | 'no_matching_transfer'
  /** The RPC could not be reached or answered something unusable. */
  | 'unreachable'

export type ConfirmResult =
  | {
      confirmed: true
      txHash: string
      ledger: number
      /** Whoever actually paid, read from the event rather than from the request. */
      from: string
      amountRaw: string
      asset: string
    }
  | {
      confirmed: false
      txHash: string
      code: ConfirmFailureCode
      reason: string
      ledger?: number
      /** Every transfer we DID see on that transaction, so a mismatch is debuggable. */
      sawTransfers?: { sac: string; from: string; to: string; amountRaw: string }[]
    }

type SeenTransfer = { sac: string; from: string; to: string; amountRaw: string; asset: string }

/**
 * Pull every SEP-41 transfer event out of a transaction response.
 *
 * Defensive by construction: a single undecodable event must not lose the others, because
 * the one we need might be the one after it.
 */
function transfersIn(tx: rpc.Api.GetSuccessfulTransactionResponse): SeenTransfer[] {
  const out: SeenTransfer[] = []
  const groups = (tx.events?.contractEventsXdr ?? []) as unknown[]
  for (const group of groups) {
    for (const raw of Array.isArray(group) ? group : [group]) {
      try {
        const event =
          typeof raw === 'string' ? xdr.ContractEvent.fromXDR(raw, 'base64') : (raw as xdr.ContractEvent)
        const contractId = event.contractId()
        if (!contractId) continue
        const body = event.body().v0()
        const topics = body.topics().map((t) => {
          try {
            return scValToNative(t)
          } catch {
            return null
          }
        })
        if (topics[0] !== 'transfer' || topics.length < 3) continue
        const amount = scValToNative(body.data())
        out.push({
          // `contractId()` is an xdr.Hash, which is a Buffer at runtime but not in the
          // type, and StrKey wants the bytes.
          sac: StrKey.encodeContract(Buffer.from(contractId as unknown as Uint8Array)),
          from: String(topics[1]),
          to: String(topics[2]),
          amountRaw: String(amount),
          asset: topics.length > 3 ? String(topics[3]) : '',
        })
      } catch {
        // A malformed event is not evidence either way. Keep going.
      }
    }
  }
  return out
}

export type ConfirmDeps = {
  env?: NodeJS.ProcessEnv
  /** Injected in tests so the honesty check itself can be tested without a network. */
  server?: Pick<rpc.Server, 'getTransaction'>
  /** How long to wait for inclusion before reporting not_found. */
  timeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Did this transaction actually move what we required, to us?
 *
 * Returns rather than throws for every outcome a caller must act on differently. The only
 * thing that throws is a bug in this function.
 */
export async function confirmStellarTransfer(
  chain: ChainDescriptor,
  txHash: string,
  expect: TransferExpectation,
  deps: ConfirmDeps = {},
): Promise<ConfirmResult> {
  const env = deps.env ?? process.env
  const server = deps.server ?? sorobanServer(chain, env)
  const timeoutMs = deps.timeoutMs ?? 30_000
  const pollMs = deps.pollMs ?? 1_000
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  const deadline = Date.now() + timeoutMs
  let got: rpc.Api.GetTransactionResponse
  for (;;) {
    try {
      got = await server.getTransaction(txHash)
    } catch (e) {
      return {
        confirmed: false,
        txHash,
        code: 'unreachable',
        reason: `could not reach the RPC to confirm: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
    if (got.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) break
    if (Date.now() >= deadline) {
      return {
        confirmed: false,
        txHash,
        code: 'not_found',
        reason:
          `not in the ledger after ${Math.round(timeoutMs / 1000)}s. This is NOT a refusal: it ` +
          `may still land, so nothing may be recorded as settled and nothing may be retried blindly.`,
      }
    }
    await sleep(pollMs)
  }

  if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
    return {
      confirmed: false,
      txHash,
      code: 'tx_failed',
      reason: 'the transaction landed and failed, so no value moved',
      ledger: got.ledger,
    }
  }

  const success = got as rpc.Api.GetSuccessfulTransactionResponse
  const seen = transfersIn(success)
  const match = seen.find(
    (t) => t.sac === expect.sac && t.to === expect.to && t.amountRaw === expect.amountRaw.toString(),
  )
  if (!match) {
    return {
      confirmed: false,
      txHash,
      code: 'no_matching_transfer',
      reason:
        `the transaction succeeded but carries no transfer of ${expect.amountRaw} on ${expect.sac} ` +
        `to ${expect.to}. A successful transaction is not a payment to us.`,
      ledger: success.ledger,
      sawTransfers: seen.map(({ sac, from, to, amountRaw }) => ({ sac, from, to, amountRaw })),
    }
  }

  return {
    confirmed: true,
    txHash,
    ledger: success.ledger,
    from: match.from,
    amountRaw: match.amountRaw,
    asset: match.asset,
  }
}
