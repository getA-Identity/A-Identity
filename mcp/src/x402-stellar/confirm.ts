/**
 * What "settled" means on Stellar.
 *
 * This is the load-bearing honesty primitive of the rail. It exists because of a weakness
 * this repo already wrote down about itself: x402-3009/engine.ts says the Celo rail
 * "delegates to a third-party facilitator, so the buyer pays no gas, but 'settled' is that
 * facilitator's word: nothing reads the chain to confirm it." Here the answer to "did the
 * money move" comes from this function and nowhere else, whether we broadcast or OZ did.
 *
 * ## It is not enough to find A payment. It has to be THIS payment.
 *
 * The first version of this file checked only {sac, to, amount}, and an adversarial review
 * broke it immediately: any transaction that had EVER paid that amount to our payee
 * confirmed, forever, for anyone. The reviewer found a real unrelated testnet transaction
 * (713e0828..., ledger 4140858) that moved exactly 10000000 base units and would have
 * bought a tool for free. The EIP-3009 rail never had that hole because it keys on the
 * authorization nonce (x402-3009/engine.ts paymentKey); this one was written without the
 * equivalent.
 *
 * So the expectation now binds to the specific authorization. `from` and `authNonce` are
 * REQUIRED, not optional conveniences. We always have both: the buyer hands us its signed
 * Soroban authorization entry in X-PAYMENT, and the nonce is inside it, before anything is
 * broadcast. A transaction that does not carry that exact nonce for that exact payer is
 * somebody else's transaction, however much it looks like ours.
 *
 * Note what this deliberately gives up: there is no way to ask "did this hash pay us" in
 * general. That question is the hole.
 *
 * ## The event data is not always an i128
 *
 * Under CAP-67 a SAC transfer event carries a MAP when the payment has a muxed destination
 * or memo, and a bare i128 otherwise. Both shapes were read off the live network rather
 * than assumed, which is the correction to how the first version was written: it sampled
 * ONE real transaction and generalised from it, which is better than guessing and still
 * not the shape space.
 *
 *   plain   scvI128  ->  10000000n
 *           (our settlement 3da74634..., ledger 4147945)
 *   memo    scvMap   ->  { amount: 10000000n, to_muxed_id: 'AT-ORDER-OYO1' }
 *           (a real classic payment 9c7042f4..., ledger 4140857)
 *
 * Reading the second with String() produced "[object Object]", so every memo-bearing
 * payment was refused as not a payment to us.
 */
import { Address, StrKey, rpc, scValToNative, xdr } from '@stellar/stellar-sdk'

import type { ChainDescriptor } from '../chains/types.js'
import { sorobanServer } from '../chains/stellar/client.js'

export type TransferExpectation = {
  /** The SEP-41 contract the transfer must have been emitted by. */
  sac: string
  /** Our receiving account. A transfer to anyone else is not our settlement. */
  to: string
  /** The payer. Required: without it, anyone's payment of the right size counts as ours. */
  from: string
  /** Exact base units. Not a minimum: an amount we did not ask for is a different deal. */
  amountRaw: bigint
  /**
   * The nonce from the buyer's signed authorization entry, as a decimal string.
   *
   * Required on the `soroban-auth` scheme, and the reason is the whole point of the file:
   * this is what ties a transaction on the ledger to the specific purchase it paid for.
   * Callers on that path always have it, because it is inside the X-PAYMENT the buyer sent
   * before anything is broadcast.
   *
   * Null ONLY on the `settled` scheme, where the buyer paid from a bounded-authority vault
   * and hands us the resulting hash instead of an authorization. There the binding is the
   * hash itself: one hash, one redemption, enforced by the durable spent set. See
   * WEAKER_BINDING below for exactly what that gives up. It is null rather than optional so
   * a caller cannot reach the weaker check by forgetting a field.
   */
  authNonce: string | null
}

/**
 * What the hash-bound scheme gives up, written once so both callers and reviewers see the
 * same sentence.
 *
 * With an authorization nonce we can say "this transaction paid for THIS purchase". With a
 * hash alone we can only say "this transaction really moved this amount to us, and nobody
 * has redeemed it here before". The gap is that whoever holds the hash can choose which
 * purchase to spend it on, among purchases of the same price. That is acceptable on the
 * vault path, where the payer is a contract whose spending we already bound on-chain and
 * every payment is one we authorized, and it would NOT be acceptable as the default.
 */
export const WEAKER_BINDING =
  'Bound to the transaction hash, not to an authorization nonce. We can prove this payment ' +
  'happened and that it has not been redeemed here before; we cannot prove it was made for ' +
  'this particular purchase rather than another of the same price, and we cannot prove the ' +
  'party presenting it is the party that made it. Every field of a landed transaction is ' +
  'public, so whoever presents a hash first is served and the payer loses the payment if ' +
  'somebody beat them to it. This is inherent to redeeming a hash rather than an ' +
  'authorization, it is the same property this repo\'s Arc rail has, and it is the reason ' +
  'the scheme is restricted to contract payers: a plain account can sign an authorization ' +
  'entry and should, because that binding has none of these gaps.'

export type ConfirmFailureCode =
  /** Not in the ledger within the window. It may still land, so nothing is decided. */
  | 'not_found'
  /** Older than the RPC's retention window, so absence here proves nothing either. */
  | 'beyond_retention'
  /** Landed and failed. Decided, and decided against. */
  | 'tx_failed'
  /** Landed and succeeded, but carries no transfer matching what we asked for. */
  | 'no_matching_transfer'
  /**
   * The response carried no event data at all, which is a statement about the RPC and not
   * about the transaction. Kept apart from no_matching_transfer, which means "we looked
   * and it is not there": an RPC that omits the field would otherwise turn every real
   * settlement into a confident refusal.
   */
  | 'no_event_data'
  /** The transfer is there, but it settles a different authorization than ours. */
  | 'wrong_authorization'
  /** The RPC could not be reached or answered something unusable. */
  | 'unreachable'

export type ConfirmResult =
  | {
      confirmed: true
      txHash: string
      ledger: number
      from: string
      amountRaw: string
      asset: string
      authNonce: string
      /** Present when the payment carried a CAP-67 muxed destination. */
      muxedId?: string
      /** Present only on the hash-bound scheme, so a caller cannot mistake it for the other. */
      binding?: 'tx-hash'
      bindingNote?: string
    }
  | {
      confirmed: false
      txHash: string
      code: ConfirmFailureCode
      reason: string
      ledger?: number
      /** Every transfer we DID see, so a mismatch is debuggable rather than a mystery. */
      sawTransfers?: { sac: string; from: string; to: string; amountRaw: string }[]
      /** Every authorization nonce the transaction actually carried. */
      sawNonces?: string[]
    }

type SeenTransfer = {
  sac: string
  from: string
  to: string
  amountRaw: string
  asset: string
  muxedId?: string
}

/**
 * Contract events read out of the transaction meta, the source that cannot be omitted.
 *
 * Returns null when the meta itself gives us nothing to look at, which is the only honest
 * `no_event_data`. Returns an empty array when the meta parses and genuinely holds no events,
 * because that IS an answer about the transaction.
 *
 * Only meta v4 is handled, and deliberately not by guessing at older shapes: both networks
 * run Protocol 27, the SDK is pinned, and a silent fallback that quietly reads nothing from
 * an unexpected version is exactly the failure this function exists to prevent. An
 * unrecognised version returns null, which reads as "we cannot see" rather than "there is
 * nothing".
 */
function eventsFromMeta(tx: rpc.Api.GetSuccessfulTransactionResponse): unknown[] | null {
  const meta = tx.resultMetaXdr as unknown as { switch?: () => { name?: string }; v4?: () => unknown }
  try {
    if (meta?.switch?.().name !== 'transactionMetaV4') return null
    const v4 = meta.v4?.() as { operations?: () => { events?: () => unknown[] }[] } | undefined
    const ops = v4?.operations?.()
    if (!ops) return null
    return ops.map((op) => op.events?.() ?? [])
  } catch {
    return null
  }
}

/**
 * The amount out of a transfer event's data, in either shape CAP-67 permits.
 *
 * Returns null rather than a wrong number when the shape is neither, because a settlement
 * decided from a misparsed amount is worse than one that refuses and says why.
 */
function amountOf(data: xdr.ScVal): { amount: bigint; muxedId?: string } | null {
  let native: unknown
  try {
    native = scValToNative(data)
  } catch {
    return null
  }
  if (typeof native === 'bigint') return { amount: native }
  if (native && typeof native === 'object' && 'amount' in native) {
    const raw = (native as { amount: unknown; to_muxed_id?: unknown }).amount
    if (typeof raw !== 'bigint') return null
    const muxed = (native as { to_muxed_id?: unknown }).to_muxed_id
    return { amount: raw, muxedId: muxed === undefined ? undefined : String(muxed) }
  }
  return null
}

/**
 * Every SEP-41 transfer event on a transaction, or null when nothing we can read carried
 * event data at all.
 *
 * TWO sources, and the second one is the correction. The first version guarded on
 * `if (!tx.events) return null`, reasoning that an RPC which omits the field would otherwise
 * look like a transaction with no transfers. A review pointed out that the guard is
 * unreachable: the SDK's parseTransactionInfo builds
 * `events: { contractEventsXdr: (raw.events?.contractEventsXdr ?? []).map(...) }`
 * unconditionally, so a missing field arrives here as an EMPTY ARRAY and the distinction the
 * guard existed for was lost anyway. The comment described a defence the code did not have.
 *
 * The real second source is `resultMetaXdr`, which is a required field the SDK always parses.
 * Under Protocol 23's meta v4 the contract events live at
 * `resultMetaXdr.v4().operations()[i].events()`, verified against our own settlement
 * e1b0097a on stellar:testnet. So an RPC that drops the convenience field still cannot hide
 * the events from us, and `no_event_data` now means what it says: neither source had any.
 */
function transfersIn(tx: rpc.Api.GetSuccessfulTransactionResponse): SeenTransfer[] | null {
  const primary = (tx.events?.contractEventsXdr ?? []) as unknown[]
  const groups = primary.length ? primary : eventsFromMeta(tx)
  if (groups === null) return null
  const out: SeenTransfer[] = []
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
        const value = amountOf(body.data())
        if (!value) continue
        out.push({
          // contractId() is an xdr.Hash, a Buffer at runtime but not in the type.
          sac: StrKey.encodeContract(Buffer.from(contractId as unknown as Uint8Array)),
          from: String(topics[1]),
          to: String(topics[2]),
          amountRaw: value.amount.toString(),
          asset: topics.length > 3 ? String(topics[3]) : '',
          muxedId: value.muxedId,
        })
      } catch {
        // A malformed event is not evidence either way. Keep going.
      }
    }
  }
  return out
}

/** Every authorization nonce the transaction's operations carried, with its payer. */
function noncesIn(tx: rpc.Api.GetSuccessfulTransactionResponse): { address: string; nonce: string }[] {
  const out: { address: string; nonce: string }[] = []
  try {
    const env = tx.envelopeXdr
    const inner = env.switch().name === 'envelopeTypeTxV0' ? env.v0().tx() : env.v1().tx()
    for (const op of inner.operations()) {
      if (op.body().switch().name !== 'invokeHostFunction') continue
      for (const entry of op.body().invokeHostFunctionOp().auth()) {
        const creds = entry.credentials()
        if (creds.switch().name !== 'sorobanCredentialsAddress') continue
        const ca = creds.address()
        out.push({
          address: Address.fromScAddress(ca.address()).toString(),
          nonce: ca.nonce().toString(),
        })
      }
    }
  } catch {
    // An envelope we cannot decode yields no nonces, which fails closed below.
  }
  return out
}

export type ConfirmDeps = {
  env?: NodeJS.ProcessEnv
  /** Injected in tests so the honesty check itself can be tested without a network. */
  server?: Pick<rpc.Server, 'getTransaction'> & Partial<Pick<rpc.Server, 'getLatestLedger'>>
  timeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  /** The oldest ledger this RPC still holds, for telling "gone" from "not yet". */
  oldestLedger?: number
  /**
   * The ledger this transaction is known to have been in, when a caller knows it.
   *
   * Required to claim `beyond_retention`, because that claim is a comparison and not a
   * vibe: without a ledger to place the transaction in, "we cannot see it" is `not_found`,
   * which leaves the question open instead of closing it wrongly.
   */
  knownLedger?: number
}

/**
 * Did THIS authorization actually move what we required, to us?
 *
 * Returns rather than throws for every outcome a caller must act on differently. Building
 * the RPC handle is inside the guard too, because a misconfigured chain used to throw out
 * of here rather than reporting `unreachable` as the type promises.
 */
export async function confirmStellarTransfer(
  chain: ChainDescriptor,
  txHash: string,
  expect: TransferExpectation,
  deps: ConfirmDeps = {},
): Promise<ConfirmResult> {
  const env = deps.env ?? process.env
  const timeoutMs = deps.timeoutMs ?? 30_000
  const pollMs = deps.pollMs ?? 1_000
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  let server: Pick<rpc.Server, 'getTransaction'> & Partial<Pick<rpc.Server, 'getLatestLedger'>>
  try {
    server = deps.server ?? sorobanServer(chain, env)
  } catch (e) {
    return {
      confirmed: false,
      txHash,
      code: 'unreachable',
      reason: `could not build an RPC client for ${chain.id}: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

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
      // Soroban RPC keeps only a short window, currently about a week on testnet. Outside
      // it, NOT_FOUND means "we cannot see it", which is a different claim from "it has
      // not landed", and telling an operator to keep waiting for a transaction the RPC
      // will never show again would be a lie of omission.
      const oldest =
        deps.oldestLedger ??
        (typeof got.oldestLedger === 'number' ? got.oldestLedger : undefined)
      const latest = typeof got.latestLedger === 'number' ? got.latestLedger : undefined
      const windowNote =
        oldest !== undefined && latest !== undefined
          ? ` This RPC retains ledgers ${oldest} to ${latest}; anything older is invisible to it, not absent from the chain.`
          : ''
      // beyond_retention needs a LEDGER TO COMPARE, not merely the presence of the window.
      // The first version returned it whenever oldestLedger was set, and that field is
      // mandatory in the RPC response, so every miss was reported as "older than we can see"
      // including a transaction broadcast one second ago. That reads as "stop waiting" for a
      // payment that is simply still in flight.
      const known = deps.knownLedger
      const provablyGone = oldest !== undefined && known !== undefined && known < oldest
      return {
        confirmed: false,
        txHash,
        code: provablyGone ? 'beyond_retention' : 'not_found',
        reason:
          `not visible after ${Math.round(timeoutMs / 1000)}s. This is NOT a refusal: it may still ` +
          `land, or it may have landed before this RPC's retention window. Nothing may be recorded ` +
          `as settled and nothing may be retried blindly.${windowNote}`,
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

  // The authorization first. A transfer that matches every visible detail but settles a
  // different authorization is not our sale, and checking it first means a replay attempt
  // is reported as what it is rather than as a near miss on the amount.
  const nonces = noncesIn(success)
  // Skipped only when the caller explicitly passed null, which is the `settled` scheme
  // saying it has a hash and no nonce. Every other path still fails closed on a mismatch.
  const boundToUs =
    expect.authNonce === null ||
    nonces.some((n) => n.nonce === expect.authNonce && n.address === expect.from)
  if (!boundToUs) {
    return {
      confirmed: false,
      txHash,
      code: 'wrong_authorization',
      reason:
        `this transaction does not carry authorization nonce ${expect.authNonce} for ${expect.from}. ` +
        `It may well be a real payment; it is not the one this purchase authorized.`,
      ledger: success.ledger,
      sawNonces: nonces.map((n) => `${n.address}:${n.nonce}`),
    }
  }

  const seen = transfersIn(success)
  if (seen === null) {
    return {
      confirmed: false,
      txHash,
      code: 'no_event_data',
      reason:
        'the RPC returned this transaction with no event data, so we cannot see whether the ' +
        'transfer happened. This says nothing about the payment: it is our blindness, not a ' +
        'refusal, and it must not be recorded as one. Point at an RPC that returns events.',
      ledger: success.ledger,
    }
  }
  const match = seen.find(
    (t) =>
      t.sac === expect.sac &&
      t.to === expect.to &&
      t.from === expect.from &&
      t.amountRaw === expect.amountRaw.toString(),
  )
  if (!match) {
    return {
      confirmed: false,
      txHash,
      code: 'no_matching_transfer',
      reason:
        `the transaction succeeded and carries our authorization, but no transfer of ` +
        `${expect.amountRaw} on ${expect.sac} from ${expect.from} to ${expect.to}. A successful ` +
        `transaction is not a payment to us.`,
      ledger: success.ledger,
      sawTransfers: seen.map(({ sac, from, to, amountRaw }) => ({ sac, from, to, amountRaw })),
      sawNonces: nonces.map((n) => `${n.address}:${n.nonce}`),
    }
  }

  return {
    confirmed: true,
    txHash,
    ledger: success.ledger,
    from: match.from,
    amountRaw: match.amountRaw,
    asset: match.asset,
    authNonce: expect.authNonce ?? '',
    ...(expect.authNonce === null ? { binding: 'tx-hash' as const, bindingNote: WEAKER_BINDING } : {}),
    ...(match.muxedId ? { muxedId: match.muxedId } : {}),
  }
}
