/**
 * The Stellar adapter.
 *
 * Deliberately much smaller than the EVM one, and the omissions are information rather
 * than gaps to fill in later:
 *
 * - No `registerAgent`, `recordValidation` or `recordReputation`. ERC-8004 is EVM-only and
 *   no Soroban identity registry is deployed, so an agent id resolved here would be a
 *   claim about a different chain. Stubbing these would turn a missing capability into a
 *   silent wrong answer.
 * - No ERC-8183 escrow, no Arc precompiles. Those are other chains' contracts.
 *
 * What it does cover is the vault: read it, and prepare or execute the calls that move it.
 *
 * Prepared-or-executed, the same rule every chain here follows. Without a signer, a write
 * returns the exact invocation it WOULD submit and touches nothing. With one, it submits
 * and returns the receipt. Nothing is reported as settled without a transaction that
 * landed.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import { randomBytes } from 'node:crypto'

import type { ChainDescriptor } from '../types.js'
import {
  isLiveLedgerEntry,
  networkPassphrase,
  readBaseReserveStroops,
  readHorizonAccount,
  simulationArchivedEntries,
  sorobanServer,
  spendableStroops,
  stellarKeypair,
  stellarSignerAddress,
  stroopsToXlm,
  type HorizonAccount,
} from './client.js'
import { isAccountId, isContractId } from './strkey.js'

/**
 * A view the CONTRACT answered with an error, as opposed to a host nobody reached.
 *
 * The distinction decides what a public read says. A simulation error is the contract's
 * own answer and identical on every host, so a contract whose views answer this way is not
 * an AgentSpendPolicy (or not one we can read), which is a 422. A transport failure says
 * nothing about the contract at all, which is a 502 with a time stamp. Collapsing the two
 * would call a working vault "not a vault" on the day an RPC host is slow.
 */
export class SimulationError extends Error {
  constructor(
    readonly method: string,
    readonly detail: string,
  ) {
    super(`${method}: ${detail}`)
    this.name = 'SimulationError'
  }
}

/**
 * The stand-in source account for reads when no signer is configured.
 *
 * All-zero ed25519 key in StrKey form, the conventional Stellar "null account". It does
 * not exist on any network and cannot sign, which is exactly what makes it the honest
 * choice here: a read must not depend on holding a key, and hardcoding somebody's real
 * funded account would quietly couple our reads to their balance.
 */
export const READ_ONLY_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

/** Testnet and pubnet differ only by this string, and getting it wrong signs for the
 *  wrong network, so it is derived from the descriptor rather than passed around. */
/**
 * Four outcomes, and no boolean.
 *
 * This was `{ executed: boolean }` with a `successful` flag beside it, and an adversarial
 * review broke it in one line: a transaction that LANDED AND FAILED came back as
 * `executed: true`, which is this repo's signal for "it worked". The repo's own proven
 * failure (12df418f..., over-limit pay refused with typed error 5) read as a success.
 *
 * A discriminated union with no boolean is the fix, because it makes the failure case
 * unignorable rather than merely reported. A caller that only handles 'settled' now fails
 * to compile against the others instead of silently treating them as success.
 *
 * 'refused' and 'prepared' are also kept apart, though both mean nothing was submitted.
 * They read identically to a human and mean opposite things to an operator: prepared says
 * "set the key and this will run", refused says "the vault said no and it will keep saying
 * no".
 */
export type CallOutcome =
  /** No signer, so nothing was submitted. This is the exact call it would have made. */
  | {
      outcome: 'prepared'
      contract: string
      method: string
      args: unknown[]
      network: string
      reason: string
      /**
       * Present on a dry run only: the simulation accepted the call, and this is what it
       * would cost. A dry run is still `prepared`, never `settled`, because nothing landed.
       */
      simulation?: { minResourceFeeStroops: string; feeStroops: string; latestLedger: number }
    }
  /** Nothing reached a ledger: the contract refused it in simulation, or the network would
   *  not take the envelope. Either way it cost nothing beyond, at most, a retry. */
  | {
      outcome: 'refused'
      contract: string
      method: string
      args: unknown[]
      network: string
      reason: string
      /** The numeric code. Only OURS when `contractErrorIsOurs` is true; see errorIn(). */
      contractErrorCode?: number
      /** The contract that actually raised it, which is not always the one we called. */
      contractErrorFrom?: string
      /**
       * True when the code can be looked up in our frozen table in error.rs. False means it
       * came from the token or another callee and propagated outward, so our table does not
       * define it and a client must not read it as if it did.
       */
      contractErrorIsOurs?: boolean
      /**
       * Set when the NETWORK turned the envelope away at sendTransaction, as opposed to the
       * contract refusing it in simulation. `code` is what a client acts on; `resultCode` is
       * the core's own name for it (txBadSeq, txInsufficientFee, ...), kept verbatim.
       */
      rejection?: {
        code: 'not_accepted' | 'insufficient_balance' | 'insufficient_fee' | 'bad_seq' | 'error'
        resultCode: string
      }
      /**
       * The hash the envelope would have had. Present on a rejection so a client can cite it;
       * named apart from `txHash` because nothing with this hash is in any ledger.
       */
      rejectedHash?: string
      /** On an insufficient-balance rejection: what the source could spend, and what it needed. */
      xlm?: { availableXlm: string; neededXlm: string }
    }
  /** In the ledger and successful. */
  | {
      outcome: 'settled'
      txHash: string
      ledger: number | undefined
      explorerUrl: string
      /** What the source account was actually charged, read off the result. */
      feeChargedStroops?: string
    }
  /** In the ledger and failed. It consumed a fee and moved nothing. */
  | {
      outcome: 'failed'
      txHash: string
      ledger: number | undefined
      explorerUrl: string
      contractErrorCode?: number
      contractErrorFrom?: string
      contractErrorIsOurs?: boolean
      /** The transaction result's own name (txFailed, ...), and the operation's beneath it. */
      resultCode?: string
      opResultCode?: string
      feeChargedStroops?: string
      reason: string
    }
  /**
   * Submitted, and not in the ledger before we stopped waiting. NOT a failure: the
   * transaction stays valid for its full timeout, so it may still land. Reporting this as
   * failed would be a lie in the direction that loses money.
   */
  | {
      outcome: 'pending'
      txHash: string
      explorerUrl: string
      reason: string
    }

export type VaultState = {
  owner: string
  operator: string
  token: string
  decimals: number
  dailyCapRaw: string
  autoApproveMaxRaw: string
  frozen: boolean
  allowlistEnabled: boolean
  sessionKeyExpiry: string
  /** The contract's own UTC day index, floor(ledger close timestamp / 86400). */
  day: string
  spentTodayRaw: string
  balanceRaw: string
  /**
   * The newest ledger any of the simulations behind this state was answered at. Every view
   * is simulated against the latest ledger the host has, so the twelve answers can straddle
   * a ledger close; the highest one is reported, because a stamp that claims an OLDER ledger
   * than some of the numbers were read at would understate how fresh they are. Always set by
   * readVault; optional in the type only so a test double that predates it still compiles.
   */
  ledger?: number
}

/** The contract error code out of a simulation error string, when it names one. */
/**
 * The contract error code, AND which contract actually raised it.
 *
 * The code alone is not enough, and reporting it alone was wrong. A Soroban error propagates
 * outward: when our vault calls the token and the token fails, the vault re-raises the
 * token's code as its own, so `Error(Contract, #13)` appears against the vault in the
 * message even though our frozen table in error.rs stops at 10. A client that looked up 13
 * in our documented table would find nothing and conclude we return garbage.
 *
 * Real example, an owner_pay to an account with no USDC trustline:
 *
 *   0: contract:CAIL6ECR...(the vault)  error, Error(Contract, #13)  "escalating error to VM trap"
 *   1: contract:CAIL6ECR...(the vault)  error, Error(Contract, #13)  "contract call failed", transfer
 *   2: contract:CBIELTK6...(the SAC)    error, Error(Contract, #13)  "trustline entry is missing"
 *
 * The event log runs newest first, so the ORIGIN is the last matching line, not the first.
 * That is the one that says what the code means.
 */
export function errorIn(message: string, calledContract: string): { code: number; from?: string; ours: boolean } | undefined {
  const m = /Error\(Contract, #(\d+)\)/.exec(message)
  if (!m) return undefined
  const code = Number(m[1])
  // Every diagnostic line that carries an error, in log order. The deepest frame is last.
  const raisers = [...message.matchAll(/contract:(C[A-Z2-7]{55}),\s*topics:\[error,\s*Error\(Contract, #(\d+)\)/g)]
    .filter((r) => Number(r[2]) === code)
    .map((r) => r[1])
  const from = raisers.length ? raisers[raisers.length - 1] : undefined
  return { code, from, ours: from === undefined ? true : from === calledContract }
}

/** Spread into a result, so the three fields cannot drift apart at a call site. */
function errorFields(e: ReturnType<typeof errorIn>): Record<string, unknown> {
  if (!e) return {}
  return {
    contractErrorCode: e.code,
    ...(e.from ? { contractErrorFrom: e.from } : {}),
    contractErrorIsOurs: e.ours,
  }
}

/**
 * The refusal sentence for a call over archived state, with the rent named when it is known.
 *
 * Two shapes, and they mean different things. A restore PREAMBLE, the only shape before
 * protocol 23, says a separate restore transaction has to land first, so submitting without
 * one pays a fee to fail. The FOLDED form (protocol 23 on, CAP-0066) says the transaction
 * would restore the archived entries itself and succeed, with the rent inside its fee, so
 * whoever signs would pay for the restore. On the paths this server pays for, both get the
 * same answer: restoring is an operator decision, not a side effect of a request.
 */
function archivedRefusal(sim: rpc.Api.SimulateTransactionResponse, archived: number[], what: string): string {
  if (archived.length === 0) {
    return (
      `${what} reads state that has been archived, and the RPC answered with a separate restore ` +
      'preamble, so it needs a restore transaction before it can run. Nothing was submitted, ' +
      'because submitting without one pays a fee to fail.'
    )
  }
  const fee = rpc.Api.isSimulationSuccess(sim) ? sim.minResourceFee : undefined
  return (
    `${what} reads state that has been archived (footprint entries ${archived.join(', ')}). ` +
    'Since protocol 23 the ledger would restore it inside this same transaction' +
    (fee ? `, for a simulated resource fee of ${fee} stroops that includes the rent,` : '') +
    ' and this server would pay for it. Restoring is an operator decision rather than a side ' +
    'effect of a request, so nothing was submitted.'
  )
}

/**
 * The frozen error table from soroban/contracts/agent-spend-policy/src/error.rs, by number.
 *
 * It is duplicated here rather than derived because the Rust enum is not importable from
 * TypeScript, and because the discriminants are PUBLIC ABI: error.rs says the list is
 * append-only and a number is never reused, so this copy cannot legitimately drift. A test
 * pins the ten names.
 *
 * Only meaningful when `contractErrorIsOurs` is true. A code that propagated out of the
 * token carries a number this table does not define, and naming it from here would tell a
 * client that a trustline failure was a policy refusal.
 */
const OUR_ERROR_NAMES: Record<number, string> = {
  1: 'Frozen',
  2: 'SessionKeyExpired',
  3: 'PayeeNotAllowed',
  4: 'AboveAutoApprove',
  5: 'DailyCapExceeded',
  6: 'InvalidAmount',
  7: 'InvalidPayee',
  8: 'MathOverflow',
  9: 'InsufficientBalance',
  10: 'OwnerIsOperator',
}

/** The name of one of OUR typed errors, or undefined when the code is not in the table. */
export function errorName(code: number | undefined): string | undefined {
  return typeof code === 'number' ? OUR_ERROR_NAMES[code] : undefined
}

/** The name of an error ONLY when the vault we called is the contract that raised it. */
export function ourErrorName(e: ReturnType<typeof errorIn>): string | undefined {
  return e && e.ours ? errorName(e.code) : undefined
}

/**
 * Which of our typed codes each entrypoint can actually return, read off lib.rs and policy.rs.
 *
 * The frozen table says what a number MEANS; this says which numbers a given call can
 * produce at all, and the difference matters for naming. `withdraw` runs check_amount (6),
 * require_valid_payee (7) and its own balance check (9) and nothing else, so a #10 against
 * a withdraw is not OwnerIsOperator: that code is only raised by the constructor and
 * set_operator. A number outside an entrypoint's set means the code came from somewhere our
 * table does not describe (another build, or a callee whose frame we could not attribute),
 * and naming it from the table would be a confident wrong answer.
 *
 * The four owner setters that return no Result (set_frozen, set_allowed,
 * set_session_key_expiry) can fail only by trap, so their set is empty.
 */
export const METHOD_ERROR_CODES: Readonly<Record<string, readonly number[]>> = {
  pay: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  owner_pay: [6, 7, 8, 9],
  withdraw: [6, 7, 9],
  set_policy: [6],
  set_operator: [10],
  __constructor: [6, 10],
  set_frozen: [],
  set_allowed: [],
  set_session_key_expiry: [],
}

/**
 * The name of a typed error, only when the vault we called raised it AND the entrypoint we
 * called can raise that code. Undefined otherwise, and the bare number stays available.
 */
export function errorNameFor(method: string, e: { code: number; ours: boolean } | undefined): string | undefined {
  if (!e || !e.ours) return undefined
  const allowed = METHOD_ERROR_CODES[method]
  if (allowed && !allowed.includes(e.code)) return undefined
  return errorName(e.code)
}

/**
 * The six entrypoints only the vault OWNER may call.
 *
 * Frozen as a list rather than checked by a pattern, because this is an authorization
 * boundary: the prepare and submit routes relay a transaction we did not build, and the
 * thing that keeps that from being an open proxy into any Soroban contract is that the
 * method has to be one of these six on a vault the caller owns. `pay` is deliberately
 * absent: that is the agent operator's call and the server signs it itself.
 */
export const OWNER_METHODS = [
  'set_policy',
  'set_frozen',
  'set_allowed',
  'set_session_key_expiry',
  'withdraw',
  'owner_pay',
] as const
export type OwnerMethod = (typeof OWNER_METHODS)[number]

export function isOwnerMethod(v: unknown): v is OwnerMethod {
  return typeof v === 'string' && (OWNER_METHODS as readonly string[]).includes(v)
}

/**
 * One argument of an owner call, in a form that carries no SDK type.
 *
 * The routes and their pure logic decide WHAT to call with WHICH values; only this file
 * turns that into XDR. Keeping the plan SDK-free is what lets mcp/src/stellar-vault.ts be
 * unit-tested with no network and no Stellar import.
 */
export type ScArg =
  | { kind: 'i128'; value: string }
  | { kind: 'u64'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'address'; value: string }

/** What `prepareOwnerCall` hands back: an UNSIGNED envelope, or a typed refusal. */
export type PreparedOwnerCall =
  | {
      ok: true
      /** Base64 transaction envelope, unsigned. The owner's wallet signs it, not us. */
      xdr: string
      networkPassphrase: string
      network: string
      contract: string
      method: OwnerMethod
      args: unknown[]
      source: string
      /**
       * The ledger after which the signature on this call stops being accepted, when the
       * envelope carries an address-credentials authorization entry. Null when the call is
       * authorized by its own source account, which is the ordinary case here: then the
       * transaction's time bound governs instead, and `validUntil` reports it.
       */
      expiresAtLedger: number | null
      validUntil: string | null
      /** The whole transaction fee, in stroops, paid by the SOURCE account and not by us. */
      feeStroops: string
      /** The same fee in XLM, as a decimal string with trailing zeros trimmed. */
      feeXlm: string
      /**
       * Footprint entries this call would RESTORE from archived state, which since protocol 23
       * happens inside the call with the rent included in `feeStroops`. Empty in the ordinary case.
       */
      archivedEntries: number[]
      /** True when `archivedEntries` is non-empty: the call restores state inside its own fee. */
      restoreNeeded: boolean
      /**
       * What was checked before handing this back, so a client never mistakes an unchecked
       * preflight for a passed one. 'unchecked' means Horizon did not answer, and the
       * simulation, which did pass, is the only evidence.
       */
      preflight: {
        xlm: 'checked' | 'unchecked'
        trustline: 'checked' | 'not-needed' | 'unchecked'
      }
      summary: string
    }
  | {
      ok: false
      code: 'bad_request' | 'refused' | 'restore_needed' | 'rpc_error' | 'insufficient_xlm' | 'no_trustline'
      reason: string
      contractErrorCode?: number
      contractErrorFrom?: string
      contractErrorIsOurs?: boolean
      contractErrorName?: string
      /** insufficient_xlm: what the source can spend after reserves and liabilities, and what it needs. */
      availableXlm?: string
      neededXlm?: string
      /** no_trustline: the account that cannot receive, and the classic asset it lacks, CODE:ISSUER. */
      destination?: string
      asset?: string
    }

/** What an envelope somebody else signed turns out to contain. Never trusted, only read. */
export type EnvelopeInspection =
  | {
      ok: true
      source: string
      contract: string
      method: OwnerMethod
      args: unknown[]
      signatures: number
      /**
       * True when a signature on this envelope verifies against the SOURCE account's key
       * under this chain's passphrase. False is not proof of a forgery: a multisig owner
       * signs with co-signer keys that are not the source account, and a hardware signer
       * may add only one of several required signatures. It is proof of the one thing we
       * can check cheaply, and a wrong-network envelope is rejected outright above.
       */
      sourceSigned: boolean
    }
  | { ok: false; code: 'bad_request' | 'wrong_network'; reason: string }

/**
 * A deploy settles with a contract id, the salt and the wasm hash it was made from; a dry
 * run comes back `prepared` with the id the salt derives; every other arm is the ordinary
 * five-arm outcome.
 */
export type VaultDeployOutcome =
  | Exclude<CallOutcome, { outcome: 'settled' | 'prepared' }>
  | (Extract<CallOutcome, { outcome: 'prepared' }> & { vault?: string })
  | (Extract<CallOutcome, { outcome: 'settled' }> & { vault: string; salt?: string; wasmHash?: string })

/** Every diagnostic event a getTransaction answer carries, wherever this protocol put them. */
function diagnosticEventsOf(tx: rpc.Api.GetTransactionResponse): xdr.DiagnosticEvent[] {
  const out: xdr.DiagnosticEvent[] = []
  const top = (tx as { diagnosticEventsXdr?: unknown[] }).diagnosticEventsXdr ?? []
  for (const e of top) {
    if (e instanceof xdr.DiagnosticEvent) out.push(e)
    else if (typeof e === 'string') out.push(xdr.DiagnosticEvent.fromXDR(e, 'base64'))
  }
  if (out.length > 0) return out
  // Older RPCs leave the top-level field empty and keep the events inside the meta: under
  // sorobanMeta in a v3 meta, and at the top of a v4 one (protocol 23 on).
  const meta = (tx as { resultMetaXdr?: xdr.TransactionMeta }).resultMetaXdr
  if (!meta) return out
  const arm = meta.switch() as unknown as number
  if (arm === 3) return [...(meta.v3().sorobanMeta()?.diagnosticEvents() ?? [])]
  if (arm === 4) return [...meta.v4().diagnosticEvents()]
  return out
}

/**
 * The contract error out of a landed-and-FAILED transaction, decoded from XDR.
 *
 * This used to stringify each event and run a JSON regex over it for "contractCode", which
 * never matched the SDK's XDR objects, so a typed refusal that landed (the repo's own
 * 12df418f..., DailyCapExceeded) came back with no code at all. The topics of an error event
 * are [Symbol("error"), Error(...)], and the second one is an ScError whose `sceContract`
 * arm carries the contract's own u32.
 *
 * Attribution follows the same rule as `errorIn`, adjusted for order: these events are in
 * EMISSION order, oldest first, so the contract that raised a code first is the origin and
 * the frames after it are the callers propagating it. `ours` is true only when that origin is
 * the contract we called.
 */
export function failureErrorIn(
  tx: rpc.Api.GetTransactionResponse,
  calledContract: string,
): { code: number; from?: string; ours: boolean } | undefined {
  try {
    for (const ev of diagnosticEventsOf(tx)) {
      const body = ev.event().body()
      if ((body.switch() as unknown as number) !== 0) continue
      const topics = body.v0().topics()
      if (topics.length < 2 || topics[0].switch().name !== 'scvSymbol' || topics[0].sym().toString() !== 'error') continue
      const err = topics.find((t) => t.switch().name === 'scvError')
      if (!err || err.error().switch().name !== 'sceContract') continue
      const code = err.error().contractCode()
      const raw = ev.event().contractId()
      const from = raw ? StrKey.encodeContract(Buffer.from(raw as unknown as Uint8Array)) : undefined
      return { code, from, ours: from === undefined ? true : from === calledContract }
    }
  } catch {
    /* an event we cannot decode is simply absent, never a reason to invent a code */
  }
  return undefined
}

/** Just the number, for callers that only ever wanted that. */
export function failureCodeIn(tx: rpc.Api.GetTransactionResponse): number | undefined {
  return failureErrorIn(tx, '')?.code
}

/** The transaction result's name and its first operation's, both verbatim from the XDR. */
function resultCodesOf(result: xdr.TransactionResult | undefined): { resultCode?: string; opResultCode?: string; feeChargedStroops?: string } {
  if (!result) return {}
  const out: { resultCode?: string; opResultCode?: string; feeChargedStroops?: string } = {}
  try {
    out.feeChargedStroops = result.feeCharged().toString()
    const r = result.result()
    out.resultCode = r.switch().name
    if (out.resultCode === 'txFailed' || out.resultCode === 'txSuccess') {
      const op = r.results()[0]
      if (op && op.switch().name === 'opInner') {
        const tr = op.tr()
        if (tr.switch().name === 'invokeHostFunction') out.opResultCode = tr.invokeHostFunctionResult().switch().name
      }
    }
  } catch {
    /* a result we cannot decode leaves these absent rather than guessed */
  }
  return out
}

/**
 * The RPC surface this adapter uses, and nothing wider.
 *
 * Narrow on purpose: a unit test injects an object with these six methods and the adapter
 * never reaches the network, which is how the deploy, prepare and submit paths below are
 * exercised offline. Production passes nothing and gets `sorobanServer(chain, env)`.
 */
export type SorobanRpc = Pick<
  rpc.Server,
  'simulateTransaction' | 'getAccount' | 'sendTransaction' | 'getTransaction' | 'getLatestLedger' | 'getLedgerEntries'
>

export type StellarAdapterDeps = {
  /** TEST ONLY. Production never passes this. */
  server?: (env: NodeJS.ProcessEnv) => SorobanRpc
  /** TEST ONLY: the 32-byte deploy salt, so a deploy is reproducible. */
  salt?: () => Buffer
  /** TEST ONLY: the fetch the Horizon preflights use. Production uses the global one. */
  fetch?: typeof fetch
  /** TEST ONLY: how long `land` waits between polls. Production waits a second. */
  pollMs?: number
}

export function createStellarAdapter(chain: ChainDescriptor, deps: StellarAdapterDeps = {}) {
  if (chain.ecosystem !== 'stellar') {
    throw new Error(`createStellarAdapter: ${chain.id} is not a Stellar chain (${chain.ecosystem})`)
  }

  const net = networkPassphrase(chain)
  /** The OTHER Stellar network's passphrase, used only to prove a wrong-network signature. */
  const otherNet = net === Networks.PUBLIC ? Networks.TESTNET : Networks.PUBLIC
  const i128 = (v: bigint | string) => nativeToScVal(BigInt(v), { type: 'i128' })
  const u64 = (v: bigint | string) => nativeToScVal(BigInt(v), { type: 'u64' })
  const addr = (g: string) => new Address(g).toScVal()
  const rpcFor = (env: NodeJS.ProcessEnv): SorobanRpc =>
    deps.server ? deps.server(env) : sorobanServer(chain, env)

  /**
   * A read, done as a simulation, with the ledger it was answered at. Costs nothing,
   * touches nothing, signs nothing.
   *
   * A transaction needs a source account even to be simulated, but the simulator never
   * checks that the account exists or that its sequence is real: it is building a
   * footprint, not authorizing anything. So a read works with no signer, no funded account,
   * and no network round trip to fetch one. It must still be a CLASSIC account id; passing
   * the vault's own C... address fails, because a contract is not an account.
   */
  async function viewAt(
    contract: string,
    method: string,
    args: ReturnType<typeof nativeToScVal>[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ value: unknown; ledger: number }> {
    const server = rpcFor(env)
    const source = stellarSignerAddress(chain, env) ?? READ_ONLY_SOURCE
    const tx = new TransactionBuilder(new Account(source, '0'), { fee: BASE_FEE, networkPassphrase: net })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(30)
      .build()
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) throw new SimulationError(method, sim.error)
    if (!sim.result) throw new SimulationError(method, 'simulation returned no result')
    return { value: scValToNative(sim.result.retval), ledger: Number(sim.latestLedger) || 0 }
  }

  /** A no-argument view, value only. */
  async function view(vault: string, method: string, env: NodeJS.ProcessEnv): Promise<unknown> {
    return (await viewAt(vault, method, [], env)).value
  }

  /** A view with arguments (`balance(holder)` on a SAC), value only. */
  async function viewWith(
    contract: string,
    method: string,
    args: ReturnType<typeof nativeToScVal>[],
    env: NodeJS.ProcessEnv,
  ): Promise<unknown> {
    return (await viewAt(contract, method, args, env)).value
  }

  /**
   * Build, simulate, sign, submit, and wait. Returns `prepared` untouched when there is no
   * signer.
   *
   * A refused call is reported rather than thrown: on Soroban the contract's typed error
   * arrives as a simulation failure, and "the vault said no" is an answer the caller wants,
   * not an exception. Note the consequence, which is genuinely surprising coming from EVM
   * and is written up in mcp/scripts/stellar-prove-revert.mjs: a refused payment produces
   * NO transaction at all, so there is no hash to show for it.
   */
  async function write(
    vault: string,
    method: string,
    args: ReturnType<typeof nativeToScVal>[],
    display: unknown[],
    env: NodeJS.ProcessEnv,
  ): Promise<CallOutcome> {
    const shape = { contract: vault, method, args: display, network: chain.caip2 }
    const kp = stellarKeypair(chain, env)
    if (!kp) {
      return {
        outcome: 'prepared',
        ...shape,
        reason: `${chain.signerEnvVar ?? 'the chain signer'} is not set, so nothing was submitted. This is the exact call it would make.`,
      }
    }

    const server = rpcFor(env)
    const c = new Contract(vault)
    const account = await server.getAccount(kp.publicKey())
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net })
      .addOperation(c.call(method, ...args))
      .setTimeout(180)
      .build()

    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) {
      return {
        outcome: 'refused',
        ...shape,
        reason: `the contract refused it before it could be submitted: ${sim.error}`,
        ...errorFields(errorIn(sim.error, vault)),
      }
    }
    // Archived state is an expected condition rather than an edge case, because Soroban
    // archives entries as a matter of course, and it arrives in two shapes: a restore
    // preamble before protocol 23, or folded into the fee since. This call is signed and paid
    // for by the server's operator key, so both are refused rather than restored at its cost.
    const archived = simulationArchivedEntries(sim)
    if (rpc.Api.isSimulationRestore(sim) || archived.length > 0) {
      return { outcome: 'refused', ...shape, reason: archivedRefusal(sim, archived, 'this call') }
    }

    // The authorization this call needs, as the simulation recorded it. Recording mode
    // happily records an entry for ANY address that calls require_auth, so a simulation
    // succeeding proves nothing about whether our key can satisfy it. Source-account
    // credentials are satisfied by our envelope signature, because our key is the source.
    // An address credential names someone else, a vault owner who is a person's wallet or
    // a passkey smart account, and that entry would go out unsigned: the host refuses it
    // at apply time and the server's key pays the fee for a transaction that was never
    // going to pass. So it is not submitted at all, and the caller is told whose signature
    // the call needs instead. This is what makes it impossible for any path through
    // `write` to produce, or even attempt, an owner authorization for a vault this server
    // does not own.
    const needsOther = needsAddressAuth(sim)
    if (needsOther.length > 0) {
      return {
        outcome: 'prepared',
        ...shape,
        reason:
          `${method} needs an authorization from ${needsOther.join(', ')}, which is not this server's key ` +
          `(${kp.publicKey()}), so nothing was signed or submitted. An owner call on a vault owned by a ` +
          'wallet or a passkey account is signed by that owner: build it with POST /api/stellar/vault/prepare ' +
          'and submit what the owner signs.',
      }
    }

    const assembled = rpc.assembleTransaction(tx, sim).build()
    assembled.sign(kp)
    return land(server, assembled, shape)
  }

  /** The addresses whose OWN signature a simulated call needs, beyond the source account's. */
  function needsAddressAuth(sim: rpc.Api.SimulateTransactionResponse): string[] {
    const out: string[] = []
    const auth = (sim as { result?: { auth?: xdr.SorobanAuthorizationEntry[] } }).result?.auth ?? []
    for (const entry of auth) {
      try {
        if (entry.credentials().switch().name !== 'sorobanCredentialsAddress') continue
        out.push(Address.fromScAddress(entry.credentials().address().address()).toString())
      } catch {
        // An entry we cannot read is treated as someone else's: refusing to submit costs a
        // retry, submitting it costs a fee and a failed transaction in the ledger.
        out.push('<an address this server could not decode>')
      }
    }
    return out
  }

  /**
   * Submit a signed envelope and wait for it, shared by every path that broadcasts.
   *
   * Factored out of `write` so the owner-signed submit path cannot drift from the
   * operator-signed one on what counts as settled. The shape is carried through because a
   * refusal has to say WHICH call was refused, and that is not recoverable from a hash.
   */
  async function land(
    server: SorobanRpc,
    signed: Parameters<SorobanRpc['sendTransaction']>[0],
    shape: { contract: string; method: string; args: unknown[]; network: string },
  ): Promise<CallOutcome> {
    const sent = await server.sendTransaction(signed)
    const explorerUrl = `${chain.explorer}/tx/${sent.hash}`

    // Four statuses, and only two of them mean the network has the transaction.
    //
    // TRY_AGAIN_LATER: the node would not take it into its queue (it is full, or this source
    // already has one in flight). Nothing was accepted and nothing can land from this send,
    // so it is safe to retry, which is exactly why it must not read as pending: pending
    // tells a person to wait for something that is not coming.
    if (sent.status === 'TRY_AGAIN_LATER') {
      return {
        outcome: 'refused',
        ...shape,
        rejectedHash: sent.hash,
        rejection: { code: 'not_accepted', resultCode: 'TRY_AGAIN_LATER' },
        reason:
          'the network did not accept the transaction into its queue (TRY_AGAIN_LATER). Nothing ' +
          'was submitted to a ledger, so it is safe to send again in a few seconds.',
      }
    }
    // ERROR: the node validated it and turned it away, with a result saying why. The three
    // causes a person can act on are named; anything else keeps the core's own code.
    if (sent.status === 'ERROR') {
      const codes = resultCodesOf((sent as { errorResult?: xdr.TransactionResult }).errorResult)
      const resultCode = codes.resultCode ?? 'ERROR'
      const named =
        resultCode === 'txInsufficientBalance'
          ? ({
              code: 'insufficient_balance',
              why: 'the source account does not hold enough spendable XLM for the fee after its reserves',
            } as const)
          : resultCode === 'txInsufficientFee'
            ? ({
                code: 'insufficient_fee',
                why: 'the fee bid was below what the network is charging right now; prepare the call again for a current fee',
              } as const)
            : resultCode === 'txBadSeq'
              ? ({
                  code: 'bad_seq',
                  why: 'the source account sequence moved since this was built (another transaction from it landed first); prepare the call again',
                } as const)
              : ({ code: 'error', why: `the network rejected it with ${resultCode}` } as const)
      return {
        outcome: 'refused',
        ...shape,
        rejectedHash: sent.hash,
        rejection: { code: named.code, resultCode },
        reason: `the network rejected the transaction before the ledger: ${named.why}. Nothing landed and no fee was charged.`,
      }
    }

    // PENDING, and DUPLICATE, which means the network already holds this exact envelope from
    // an earlier send. Either way it may land, so both are polled, and both end as pending
    // rather than failed if the poll runs out first.
    const pause = deps.pollMs ?? 1000
    let got = await server.getTransaction(sent.hash)
    for (let i = 0; i < 30 && got.status === 'NOT_FOUND'; i += 1) {
      await new Promise((r) => setTimeout(r, pause))
      got = await server.getTransaction(sent.hash)
    }
    if (got.status === 'NOT_FOUND') {
      return {
        outcome: 'pending',
        txHash: sent.hash,
        explorerUrl,
        reason:
          (sent.status === 'DUPLICATE'
            ? 'the network already had this exact transaction from an earlier send (DUPLICATE), and it is not in a ledger yet. '
            : 'submitted and not in the ledger yet. ') +
          'The transaction stays valid for its full timeout, so it may still land: do not retry it and do not record it as failed.',
      }
    }
    if (got.status === 'FAILED') {
      const e = failureErrorIn(got, shape.contract)
      const codes = resultCodesOf((got as { resultXdr?: xdr.TransactionResult }).resultXdr)
      return {
        outcome: 'failed',
        txHash: sent.hash,
        ledger: got.ledger,
        explorerUrl,
        ...(e ? { contractErrorCode: e.code, contractErrorIsOurs: e.ours, ...(e.from ? { contractErrorFrom: e.from } : {}) } : {}),
        ...codes,
        reason: 'the transaction landed and failed. It consumed a fee and moved nothing.',
      }
    }
    const fee = resultCodesOf((got as { resultXdr?: xdr.TransactionResult }).resultXdr).feeChargedStroops
    return { outcome: 'settled', txHash: sent.hash, ledger: got.ledger, explorerUrl, ...(fee ? { feeChargedStroops: fee } : {}) }
  }

  /**
   * The contract id a deploy WILL produce, from the deployer and the salt.
   *
   * Used only as a fallback: the transaction's own return value is the authoritative
   * answer, because it is what the ledger recorded. This derivation reproduces the host's
   * rule (sha256 over the envelope-type preimage bound to the network id), so a receipt
   * whose return value we cannot decode still yields the address rather than a settled
   * deploy with nowhere to point.
   */
  function derivedContractId(deployer: string, salt: Buffer): string {
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({
        networkId: hash(Buffer.from(net)),
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({
            address: new Address(deployer).toScAddress(),
            salt,
          }),
        ),
      }),
    )
    return StrKey.encodeContract(hash(preimage.toXDR()))
  }

  /**
   * Deploy a fresh AgentSpendPolicy against the code entry the registry already names.
   *
   * INSTANTIATE, never upload. The wasm is on both networks already at the hash in
   * `contracts.spendVaultWasmHash`, so a new vault costs about 0.1 XLM instead of the
   * roughly 12 XLM a re-upload of the 11,625-byte module costs. That also means the deploy
   * is only possible while that code entry is LIVE: Soroban archives entries on a timer,
   * and an archived one needs a restore, which is an operator action and not something to
   * attempt inside a user's request. So the TTL is read first and a missing entry is a
   * labeled refusal rather than a surprise failure that still costs a fee.
   *
   * Source and fee payer are the chain signer, which becomes the vault's OPERATOR. The
   * owner is the human's own account and is never us; the contract itself refuses
   * owner == operator with OwnerIsOperator, and so does this function, before the network
   * is touched at all.
   *
   * The owner may be a CONTRACT as well as an account. The constructor takes any Address,
   * and a passkey smart account (an OpenZeppelin account whose signer is a WebAuthn
   * credential) is a C... id: proven on testnet 2026-09-19, where set_policy on a vault owned
   * by one was signed with the passkey through the account's `execute` and the vault's
   * `owner.require_auth()` was satisfied because the account was the direct invoker. The
   * operator stays a G... account on purpose: it is the key that signs `pay`, and this server
   * holds it.
   */
  async function deployVault(
    input: {
      owner: string
      operator: string
      token: string
      dailyCapRaw: bigint | string
      autoApproveMaxRaw: bigint | string
      /**
       * Instantiate against THIS code entry instead of `contracts.spendVaultWasmHash`, for a
       * new build (v0.1.1 on) whose hash is not the registry default yet. Its TTL is read
       * live exactly like the default's.
       */
      wasmHash?: string
      /** The 32-byte salt, so the contract id is known before the deploy and recorded after it. */
      salt?: Buffer
      /** Simulate only: return `prepared` with the simulated cost and the derived id. */
      dryRun?: boolean
      /** A dry run with no key needs a deployer account to simulate from; a real deploy ignores it. */
      deployer?: string
    },
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<VaultDeployOutcome> {
    const display = [
      input.owner,
      input.operator,
      input.token,
      String(input.dailyCapRaw),
      String(input.autoApproveMaxRaw),
    ]
    const shape = { contract: '<new>', method: '__constructor', args: display, network: chain.caip2 }
    const refuse = (reason: string): VaultDeployOutcome => ({ outcome: 'refused', ...shape, reason })

    if (!isAccountId(input.owner) && !isContractId(input.owner)) {
      return refuse(`${input.owner} is neither a Stellar account id (G... StrKey) nor a contract id (C... StrKey)`)
    }
    if (!isAccountId(input.operator)) return refuse(`${input.operator} is not a Stellar account id (G... StrKey)`)
    if (!isContractId(input.token)) return refuse(`${input.token} is not a Soroban contract id (C... StrKey)`)
    if (input.owner === input.operator) {
      return refuse(
        'the owner and the operator are the same account. The contract refuses this at ' +
          'construction with OwnerIsOperator, because one key that can both spend past the ' +
          'policy and lift the policy is the same as having no policy. Nothing was submitted.',
      )
    }
    if (BigInt(input.dailyCapRaw) < 0n || BigInt(input.autoApproveMaxRaw) < 0n) {
      return refuse('a negative cap or ceiling is refused by the constructor (InvalidAmount). Nothing was submitted.')
    }

    const wasmHash = (input.wasmHash ?? chain.contracts.spendVaultWasmHash ?? '').toLowerCase()
    if (!wasmHash) {
      return refuse(
        `${chain.name} declares no contracts.spendVaultWasmHash, so there is no code entry to ` +
          'instantiate against and no vault can be deployed here.',
      )
    }
    if (!/^[0-9a-f]{64}$/.test(wasmHash)) return refuse(`wasm hash ${wasmHash} is not 32 bytes of hex. Nothing was submitted.`)
    if (input.salt !== undefined && input.salt.length !== 32) {
      return refuse(`a deploy salt is exactly 32 bytes; this one is ${input.salt.length}. Nothing was submitted.`)
    }

    const kp = stellarKeypair(chain, env)
    // A dry run simulates from the deployer it is given when no key is set: the simulator
    // never checks a sequence or a signature, so the cost and the derived id come back
    // without anything that could sign.
    const dryDeployer = input.dryRun && !kp && input.deployer && isAccountId(input.deployer) ? input.deployer : null
    if (!kp && !dryDeployer) {
      return {
        outcome: 'prepared',
        ...shape,
        reason: `${chain.signerEnvVar ?? 'the chain signer'} is not set, so nothing was submitted. This is the exact call it would make.`,
      }
    }
    const deployer = kp ? kp.publicKey() : (dryDeployer as string)

    const server = rpcFor(env)
    // The code entry first. An archived one produces a simulation that asks for a restore
    // preamble, and submitting anyway pays a fee to fail; reporting it up front also says
    // the true thing, which is that a redeploy of the code entry is an operator action.
    let codeLive = false
    let codeArchived = false
    try {
      const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash, 'hex') }))
      const entries = await server.getLedgerEntries(key)
      // Not `entries.length > 0`. An archived code entry still comes back from the RPC, with
      // liveUntilLedgerSeq 0, and instantiating against it would restore the whole module
      // inside the deploy, at this server's cost.
      const entry = entries.entries[0] as { liveUntilLedgerSeq?: number } | undefined
      codeLive = isLiveLedgerEntry(entry, entries.latestLedger)
      codeArchived = entry !== undefined && !codeLive
    } catch (e) {
      return refuse(
        `the code entry for wasm hash ${wasmHash} could not be read on ${chain.name} ` +
          `(${e instanceof Error ? e.message : String(e)}). Nothing was submitted.`,
      )
    }
    if (!codeLive) {
      return refuse(
        `the code entry for wasm hash ${wasmHash} is ${codeArchived ? 'archived' : 'not live'} on ${chain.name}, so there is ` +
          'nothing to instantiate against. No upload was attempted: re-uploading the module, or ' +
          'restoring the archived entry, is an operator action rather than something to do inside ' +
          'a request. Nothing was submitted.',
      )
    }

    const salt = input.salt ?? (deps.salt ? deps.salt() : randomBytes(32))
    const account = kp ? await server.getAccount(deployer) : new Account(deployer, '0')
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net })
      .addOperation(
        Operation.createCustomContract({
          address: new Address(deployer),
          wasmHash: Buffer.from(wasmHash, 'hex'),
          salt,
          constructorArgs: [
            addr(input.owner),
            addr(input.operator),
            addr(input.token),
            i128(input.dailyCapRaw),
            i128(input.autoApproveMaxRaw),
          ],
        }),
      )
      .setTimeout(180)
      .build()

    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) {
      return {
        outcome: 'refused',
        ...shape,
        reason: `the deploy was refused before it could be submitted: ${sim.error}`,
        ...errorFields(errorIn(sim.error, '<new>')),
      }
    }
    const archived = simulationArchivedEntries(sim)
    if (rpc.Api.isSimulationRestore(sim) || archived.length > 0) {
      return refuse(archivedRefusal(sim, archived, 'this deploy'))
    }

    const assembled = rpc.assembleTransaction(tx, sim).build()
    if (input.dryRun || !kp) {
      return {
        outcome: 'prepared',
        ...shape,
        reason:
          `dry run: simulated against wasm ${wasmHash} with salt ${salt.toString('hex')} and accepted. ` +
          'Nothing was signed or submitted.',
        simulation: { minResourceFeeStroops: String(sim.minResourceFee), feeStroops: assembled.fee, latestLedger: Number(sim.latestLedger) || 0 },
        vault: derivedContractId(deployer, salt),
      }
    }
    assembled.sign(kp)
    const outcome = await land(server, assembled, shape)
    if (outcome.outcome !== 'settled') return outcome

    // The receipt is authoritative: createContract returns the new contract's Address.
    let vault: string
    try {
      const got = await server.getTransaction(outcome.txHash)
      const retval = (got as { returnValue?: xdr.ScVal }).returnValue
      vault = retval ? String(scValToNative(retval)) : derivedContractId(deployer, salt)
    } catch {
      vault = derivedContractId(deployer, salt)
    }
    if (!isContractId(vault)) vault = derivedContractId(deployer, salt)
    return { ...outcome, vault, salt: salt.toString('hex'), wasmHash }
  }

  /**
   * Upload an AgentSpendPolicy wasm as a code entry, so a NEW build can be instantiated.
   *
   * An operator action, called only by mcp/scripts/stellar-deploy-vault.mjs and never by a
   * route: it costs roughly 12 XLM on pubnet for an 11 KB module, and the code entry it
   * creates is permanent until it archives. Prepared-or-executed like every write here, and
   * a dry run simulates and returns the cost without signing. The hash returned is computed
   * locally from the bytes, which is exactly the hash the ledger keys the entry by, so a
   * receipt can record it before the network answers.
   */
  async function uploadVaultWasm(
    wasm: Buffer,
    opts: { dryRun?: boolean; deployer?: string } = {},
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<CallOutcome & { wasmHash: string }> {
    const wasmHash = hash(wasm).toString('hex')
    const shape = { contract: '<upload>', method: 'uploadContractWasm', args: [wasmHash, String(wasm.length)], network: chain.caip2 }
    const kp = stellarKeypair(chain, env)
    const dryDeployer = opts.dryRun && !kp && opts.deployer && isAccountId(opts.deployer) ? opts.deployer : null
    if (!kp && !dryDeployer) {
      return {
        outcome: 'prepared',
        ...shape,
        wasmHash,
        reason: `${chain.signerEnvVar ?? 'the chain signer'} is not set, so nothing was submitted. This is the exact call it would make.`,
      }
    }
    const source = kp ? kp.publicKey() : (dryDeployer as string)
    const server = rpcFor(env)
    const account = kp ? await server.getAccount(source) : new Account(source, '0')
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net })
      .addOperation(Operation.uploadContractWasm({ wasm }))
      .setTimeout(180)
      .build()
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) {
      return { outcome: 'refused', ...shape, wasmHash, reason: `the upload was refused before it could be submitted: ${sim.error}` }
    }
    const assembled = rpc.assembleTransaction(tx, sim).build()
    if (opts.dryRun || !kp) {
      return {
        outcome: 'prepared',
        ...shape,
        wasmHash,
        reason: 'dry run: the upload simulated and was accepted. Nothing was signed or submitted.',
        simulation: { minResourceFeeStroops: String(sim.minResourceFee), feeStroops: assembled.fee, latestLedger: Number(sim.latestLedger) || 0 },
      }
    }
    assembled.sign(kp)
    return { ...(await land(server, assembled, shape)), wasmHash }
  }

  /** One planned argument turned into XDR. The plan itself carries no SDK type. */
  function scArg(a: ScArg): ReturnType<typeof nativeToScVal> {
    switch (a.kind) {
      case 'i128':
        return i128(a.value)
      case 'u64':
        return u64(a.value)
      case 'bool':
        return nativeToScVal(a.value)
      case 'address':
        return addr(a.value)
    }
  }

  /** The Horizon read the preflights use: an account, or `null` when Horizon did not answer. */
  async function horizonAccount(id: string): Promise<HorizonAccount | null> {
    try {
      return await readHorizonAccount(chain, id, deps.fetch ?? fetch)
    } catch {
      return null
    }
  }

  /**
   * What an account can actually spend on a fee, in stroops, or null when Horizon did not
   * answer. Net of the minimum balance (two base reserves plus one per subentry and per entry
   * it sponsors, minus the ones sponsored for it) and of XLM locked in open offers, because
   * the network will not let a fee dip into either.
   */
  async function spendableXlm(account: string): Promise<{ available: bigint; reserve: bigint } | null> {
    const a = await horizonAccount(account)
    if (!a) return null
    const reserve = await readBaseReserveStroops(chain, deps.fetch ?? fetch).catch(() => null)
    if (reserve === null) return null
    if (!a.found) return { available: 0n, reserve }
    return { available: spendableStroops(a, reserve), reserve }
  }

  /**
   * Build an owner call the OWNER signs, and hand it back unsigned.
   *
   * This is the whole shape of the Stellar vault story: owner and operator are different
   * accounts by construction, we hold only the operator key, and every owner entrypoint
   * calls `owner.require_auth()`. So the honest thing the server can do is assemble the
   * exact transaction, prove by simulation that the contract would accept it, and give the
   * unsigned envelope to the person whose wallet can authorize it. We never sign it, and
   * the fee is charged to the owner's account because the owner's account is its source.
   *
   * Two preflights run around the simulation, because both failures are ones the contract
   * cannot name well and the person can fix before signing:
   *
   *  - A withdraw (or owner_pay) to a G... account checks that the account holds a trustline
   *    for the vault token's classic asset. Without one the SAC traps with its own #13, which
   *    reaches the owner as an anonymous refusal. A C... destination needs no trustline: a
   *    contract holds a SAC balance in its own storage.
   *  - The source's spendable XLM is compared with the simulated fee. The network would
   *    reject the envelope with txInsufficientBalance anyway, but only after the person has
   *    signed it.
   *
   * Both read Horizon, from the registry's horizonUrls. A Horizon that does not answer
   * leaves the preflight `unchecked` and says so; it never fails the prepare, because the
   * simulation, which did pass, is the authoritative check and Horizon is the courtesy.
   */
  async function prepareOwnerCall(
    vault: string,
    method: OwnerMethod,
    args: ScArg[],
    source: string,
    env: NodeJS.ProcessEnv = process.env,
    opts: { vaultToken?: string } = {},
  ): Promise<PreparedOwnerCall> {
    if (!isContractId(vault)) return { ok: false, code: 'bad_request', reason: `${vault} is not a Soroban contract id` }
    if (!isAccountId(source)) return { ok: false, code: 'bad_request', reason: `${source} is not a Stellar account id` }
    if (!isOwnerMethod(method)) return { ok: false, code: 'bad_request', reason: `${method} is not an owner entrypoint` }

    const display = args.map((a) => a.value)
    const server = rpcFor(env)
    let account: Account
    try {
      account = await server.getAccount(source)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // The SDK says "Account not found" when the ledger answered and there is no such
      // account; the failover layer underneath keeps a transport failure a transport failure.
      // An account that does not exist holds no XLM at all, which is the actionable reading.
      if (/not found/i.test(message)) {
        const reserve = (await readBaseReserveStroops(chain, deps.fetch ?? fetch).catch(() => null)) ?? 5_000_000n
        return {
          ok: false,
          code: 'insufficient_xlm',
          availableXlm: '0',
          neededXlm: stroopsToXlm(2n * reserve),
          reason:
            `${source} does not exist on ${chain.name}. On Stellar an account has to be created and hold ` +
            `its minimum balance of ${stroopsToXlm(2n * reserve)} XLM before it can be a transaction source, ` +
            'and the fee comes on top of that. Fund it, then prepare the call again.',
        }
      }
      return {
        ok: false,
        code: 'rpc_error',
        reason:
          `${source} could not be loaded on ${chain.name} (${message}). ` +
          'On Stellar an account has to exist and hold its XLM reserve before it can be a ' +
          'transaction source; an unfunded account is not an account.',
      }
    }

    // The trustline preflight, before the simulation, so the refusal names the real cause.
    let trustline: 'checked' | 'not-needed' | 'unchecked' = 'not-needed'
    if (method === 'withdraw' || method === 'owner_pay') {
      const to = String(args[0]?.value ?? '')
      if (isAccountId(to)) {
        trustline = 'unchecked'
        let token = opts.vaultToken
        if (!token) token = await view(vault, 'token', env).then(String).catch(() => undefined)
        const asset = (chain.settlementTokens ?? []).find((t) => t.address === token)?.classicAsset
        if (asset) {
          const dest = await horizonAccount(to)
          if (dest) {
            const [code, issuer] = asset.split(':')
            const line = dest.found ? dest.trustlines.find((t) => t.code === code && t.issuer === issuer) : undefined
            if (!dest.found || !line || !line.authorized) {
              return {
                ok: false,
                code: 'no_trustline',
                destination: to,
                asset,
                reason: !dest.found
                  ? `${to} does not exist on ${chain.name}, so it cannot hold ${code}. Nothing was prepared. Fund that account and add a ${code} trustline (issuer ${issuer}), or withdraw to an account that has one.`
                  : !line
                    ? `${to} has no trustline for ${code} (issuer ${issuer}), so the token contract would refuse the transfer. Nothing was prepared. Add the trustline in that wallet first, or withdraw to an account that has one.`
                    : `${to} holds a ${code} trustline that the issuer has not authorized, so the transfer would be refused. Nothing was prepared.`,
              }
            }
            trustline = 'checked'
          }
        }
      }
    }

    const c = new Contract(vault)
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net })
      .addOperation(c.call(method, ...args.map(scArg)))
      .setTimeout(300)
      .build()

    let sim: rpc.Api.SimulateTransactionResponse
    try {
      sim = await server.simulateTransaction(tx)
    } catch (e) {
      return { ok: false, code: 'rpc_error', reason: e instanceof Error ? e.message : String(e) }
    }
    if (rpc.Api.isSimulationError(sim)) {
      const e = errorIn(sim.error, vault)
      const name = errorNameFor(method, e)
      return {
        ok: false,
        code: 'refused',
        reason: `the contract refused it in simulation, so nothing was prepared: ${sim.error}`,
        ...errorFields(e),
        ...(name ? { contractErrorName: name } : {}),
      }
    }
    if (rpc.Api.isSimulationRestore(sim)) {
      return {
        ok: false,
        code: 'restore_needed',
        reason:
          'this call reads state that has been archived, and the RPC answered with a separate ' +
          'restore preamble, so it needs a restore transaction before it can run. Nothing was ' +
          'prepared, because a signature on it would pay a fee to fail. A restore is a ' +
          'RestoreFootprint transaction that any funded account may submit and pay for; once it ' +
          'lands, prepare this call again.',
      }
    }
    // Since protocol 23 archived state comes back WITHOUT a preamble: the transaction restores
    // it itself and the rent is inside its fee. Unlike the operator's calls, an owner call is
    // paid for by the owner, and refusing it here would put `withdraw`, the vault's escape
    // hatch, out of this console's reach on exactly the day it is needed. So it is prepared and
    // disclosed instead, and the owner's wallet shows the whole fee before anything is signed.
    const archivedEntries = simulationArchivedEntries(sim)

    const assembled = rpc.assembleTransaction(tx, sim).build()

    // The XLM preflight, against the fee the simulation produced.
    let xlm: 'checked' | 'unchecked' = 'unchecked'
    const spend = await spendableXlm(source)
    if (spend) {
      const fee = BigInt(assembled.fee)
      const available = spend.available > 0n ? spend.available : 0n
      if (available < fee) {
        return {
          ok: false,
          code: 'insufficient_xlm',
          availableXlm: stroopsToXlm(available),
          neededXlm: stroopsToXlm(fee),
          reason:
            `${source} can spend ${stroopsToXlm(available)} XLM after its reserves and open offers, ` +
            `and this call costs ${stroopsToXlm(fee)} XLM in fees. Nothing was prepared. Add XLM to that account, then prepare it again.`,
        }
      }
      xlm = 'checked'
    }

    // Address credentials carry their own signature expiry; source-account credentials, the
    // ordinary case when the owner IS the transaction source, do not. Reported as null in
    // that case rather than invented, with the time bound stated beside it.
    let expiresAtLedger: number | null = null
    for (const entry of (sim as { result?: { auth?: xdr.SorobanAuthorizationEntry[] } }).result?.auth ?? []) {
      if (entry.credentials().switch().name === 'sorobanCredentialsAddress') {
        const at = entry.credentials().address().signatureExpirationLedger()
        expiresAtLedger = expiresAtLedger === null ? at : Math.max(expiresAtLedger, at)
      }
    }
    const maxTime = assembled.timeBounds?.maxTime
    const validUntil = maxTime && Number(maxTime) > 0 ? new Date(Number(maxTime) * 1000).toISOString() : null

    return {
      ok: true,
      xdr: assembled.toXDR(),
      networkPassphrase: net,
      network: chain.caip2,
      contract: vault,
      method,
      args: display,
      source,
      expiresAtLedger,
      validUntil,
      feeStroops: assembled.fee,
      feeXlm: stroopsToXlm(BigInt(assembled.fee)),
      archivedEntries,
      restoreNeeded: archivedEntries.length > 0,
      preflight: { xlm, trustline },
      summary:
        `${method}(${display.join(', ')}) on vault ${vault} (${chain.caip2}). ` +
        `Simulated and accepted by the contract; NOT signed. The source account ${source} pays ` +
        `the ${assembled.fee} stroop fee for this transaction, not this server. ` +
        (archivedEntries.length
          ? `It also restores archived state (footprint entries ${archivedEntries.join(', ')}): the ledger does that inside this transaction, and the rent is part of that fee. `
          : '') +
        'If that account is multisig, every required signature has to be added before it is submitted.',
    }
  }

  /**
   * Read an envelope somebody else signed, and decide whether we will relay it at all.
   *
   * Pure inspection: it signs nothing, sends nothing, and refuses everything it cannot
   * positively recognise. The allowlist is deliberately narrow because this endpoint would
   * otherwise be an open relay into any Soroban contract with our IP address on it.
   */
  function inspectOwnerEnvelope(signedXdr: string): EnvelopeInspection {
    let tx: ReturnType<typeof TransactionBuilder.fromXDR>
    try {
      tx = TransactionBuilder.fromXDR(signedXdr, net)
    } catch (e) {
      return { ok: false, code: 'bad_request', reason: `this is not a transaction envelope: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (tx instanceof FeeBumpTransaction) {
      return {
        ok: false,
        code: 'bad_request',
        reason: 'a fee-bump envelope is not accepted here: submit the inner transaction the prepare step returned.',
      }
    }
    if (tx.operations.length !== 1) {
      return {
        ok: false,
        code: 'bad_request',
        reason: `this envelope carries ${tx.operations.length} operations; exactly one contract invocation is accepted.`,
      }
    }
    const op = tx.operations[0]
    if (op.type !== 'invokeHostFunction') {
      return { ok: false, code: 'bad_request', reason: `operation type ${op.type} is not accepted here; only a contract invocation is.` }
    }
    const func = op.func
    if (func.switch().name !== 'hostFunctionTypeInvokeContract') {
      return {
        ok: false,
        code: 'bad_request',
        reason: 'this envelope uploads or creates a contract rather than invoking one, which this endpoint does not relay.',
      }
    }
    const invocation = func.invokeContract()
    const contract = Address.fromScAddress(invocation.contractAddress()).toString()
    const method = invocation.functionName().toString()
    if (!isOwnerMethod(method)) {
      return {
        ok: false,
        code: 'bad_request',
        reason: `${method} is not one of the owner entrypoints this endpoint relays (${OWNER_METHODS.join(', ')}).`,
      }
    }
    if (!isContractId(contract)) {
      return { ok: false, code: 'bad_request', reason: `${contract} is not a Soroban contract id` }
    }

    const source = tx.source
    const signatures = tx.signatures.length
    if (signatures === 0) {
      return { ok: false, code: 'bad_request', reason: 'this envelope carries no signature, so there is nothing to submit.' }
    }

    // A signature is bound to a network passphrase, and the passphrase is not in the
    // envelope, so the only way to tell a testnet envelope from a pubnet one is to check
    // whether a signature verifies under each. A key that signed for the other network is
    // refused outright: relaying it would burn the owner's fee on a transaction the network
    // cannot accept, and it is the exact mistake a two-network product invites.
    const verifies = (passphrase: string): boolean => {
      try {
        const rebuilt = TransactionBuilder.fromXDR(signedXdr, passphrase)
        if (rebuilt instanceof FeeBumpTransaction) return false
        if (!isAccountId(source)) return false
        const key = Keypair.fromPublicKey(source)
        const digest = rebuilt.hash()
        return rebuilt.signatures.some((s) => key.verify(digest, s.signature()))
      } catch {
        return false
      }
    }
    const sourceSigned = verifies(net)
    if (!sourceSigned && verifies(otherNet)) {
      return {
        ok: false,
        code: 'wrong_network',
        reason:
          `this envelope was signed for the other Stellar network, not ${chain.caip2}. ` +
          'Re-sign it against the passphrase the prepare step returned.',
      }
    }

    return { ok: true, source, contract, method, args: invocation.args().map((a) => scValToNative(a)), signatures, sourceSigned }
  }

  /**
   * Broadcast an envelope the owner signed. We never sign it and we never pay for it.
   *
   * Same five-arm outcome as every other write here, because "it landed" and "it landed and
   * failed" are the two things a relay must never collapse.
   */
  async function submitSignedEnvelope(
    signedXdr: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ inspection: EnvelopeInspection; outcome?: CallOutcome }> {
    const inspection = inspectOwnerEnvelope(signedXdr)
    if (!inspection.ok) return { inspection }
    const tx = TransactionBuilder.fromXDR(signedXdr, net)
    const server = rpcFor(env)
    const shape = {
      contract: inspection.contract,
      method: inspection.method,
      args: inspection.args,
      network: chain.caip2,
    }
    try {
      const outcome = await land(server, tx as Parameters<SorobanRpc['sendTransaction']>[0], shape)
      // The network said the source cannot cover the fee. Say how far short it is, from the
      // same Horizon read the prepare preflight uses, so the owner learns the number rather
      // than the error name. Best effort: a Horizon that does not answer leaves it out.
      if (outcome.outcome === 'refused' && outcome.rejection?.code === 'insufficient_balance') {
        const spend = await spendableXlm(inspection.source)
        if (spend) {
          const available = spend.available > 0n ? spend.available : 0n
          outcome.xlm = { availableXlm: stroopsToXlm(available), neededXlm: stroopsToXlm(BigInt(tx.fee)) }
        }
      }
      return { inspection, outcome }
    } catch (e) {
      // A send that threw is NOT decided, for the reason client.ts gives at length: the
      // envelope may never have left, or it may have been accepted with the answer lost on
      // the way back. Calling that refused would invite the owner to sign again while the
      // first one may still land, so it is reported as pending under the hash the envelope
      // already has, and the ledger decides.
      return {
        inspection,
        outcome: {
          outcome: 'pending',
          txHash: tx.hash().toString('hex'),
          explorerUrl: `${chain.explorer}/tx/${tx.hash().toString('hex')}`,
          reason:
            `the RPC did not answer the submission (${e instanceof Error ? e.message : String(e)}), so whether ` +
            'it was accepted is unknown. It stays valid until its time bound: look the hash up before signing again.',
        },
      }
    }
  }

  return {
    deployVault,
    uploadVaultWasm,
    prepareOwnerCall,
    inspectOwnerEnvelope,
    submitSignedEnvelope,

    chain,

    /**
     * Live proof the chain is reachable AND that the settlement token is what the registry
     * says it is.
     *
     * The second half used to be a lie of omission: the token block was copied straight out
     * of the descriptor and returned next to a live ledger number and a checkedAt stamp,
     * which reads as observation. Now symbol() and decimals() are read off the SAC through
     * the same simulation the vault reads use, and a disagreement with the registry is
     * reported rather than smoothed over. A mismatch means the descriptor is wrong, which is
     * exactly the thing a live check exists to catch.
     */
    async readContracts(env: NodeJS.ProcessEnv = process.env) {
      const server = rpcFor(env)
      const latest = await server.getLatestLedger()
      const token = (chain.settlementTokens ?? [])[0]

      let observed: { symbol: string; decimals: number } | null = null
      let tokenError: string | null = null
      if (token) {
        try {
          const [symbol, decimals] = await Promise.all([
            view(token.address, 'symbol', env),
            view(token.address, 'decimals', env),
          ])
          observed = { symbol: String(symbol), decimals: Number(decimals) }
        } catch (e) {
          tokenError = e instanceof Error ? e.message : String(e)
        }
      }

      const mismatch =
        token && observed && (observed.symbol !== token.symbol || observed.decimals !== token.decimals)
          ? `the registry declares ${token.symbol}/${token.decimals} but the contract reports ` +
            `${observed.symbol}/${observed.decimals}. One of them is wrong and it is not the chain.`
          : null

      return {
        chain: chain.id,
        caip2: chain.caip2,
        protocolVersion: latest.protocolVersion,
        ledger: latest.sequence,
        reachable: true,
        settlementToken: token
          ? {
              sac: token.address,
              declared: { symbol: token.symbol, decimals: token.decimals },
              observed,
              ...(tokenError ? { unreadable: tokenError } : {}),
              ...(mismatch ? { mismatch } : {}),
            }
          : null,
        signer: stellarSignerAddress(chain, env),
        checkedAt: new Date().toISOString(),
      }
    },

    /** The whole vault state in one round of simulations. */
    async readVault(vault: string, env: NodeJS.ProcessEnv = process.env): Promise<VaultState> {
      if (!isContractId(vault)) throw new Error(`${vault} is not a Soroban contract id`)
      const s = (v: { value: unknown }) => String(v.value)
      const reads = await Promise.all([
        viewAt(vault, 'owner', [], env),
        viewAt(vault, 'operator', [], env),
        viewAt(vault, 'token', [], env),
        viewAt(vault, 'decimals', [], env),
        viewAt(vault, 'daily_cap', [], env),
        viewAt(vault, 'auto_approve_max', [], env),
        viewAt(vault, 'frozen', [], env),
        viewAt(vault, 'allowlist_enabled', [], env),
        viewAt(vault, 'session_key_expiry', [], env),
        viewAt(vault, 'today', [], env),
        viewAt(vault, 'spent_today', [], env),
        viewAt(vault, 'balance', [], env),
      ])
      const [owner, operator, token, decimals, dailyCap, autoApproveMax, frozen, allowlistEnabled, sessionKeyExpiry, day, spentToday, balance] =
        reads
      return {
        owner: s(owner),
        operator: s(operator),
        token: s(token),
        decimals: Number(decimals.value),
        dailyCapRaw: s(dailyCap),
        autoApproveMaxRaw: s(autoApproveMax),
        frozen: Boolean(frozen.value),
        allowlistEnabled: Boolean(allowlistEnabled.value),
        sessionKeyExpiry: s(sessionKeyExpiry),
        day: s(day),
        spentTodayRaw: s(spentToday),
        balanceRaw: s(balance),
        ledger: Math.max(...reads.map((r) => r.ledger)),
      }
    },

    /** A SEP-41 token's own `symbol()`, read by simulation, for a vault whose token the registry does not name. */
    async readTokenSymbol(token: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
      if (!isContractId(token)) throw new Error(`${token} is not a Soroban contract id`)
      return String(await view(token, 'symbol', env))
    },

    /**
     * Whether one payee is on the vault's allowlist, live, and whether the list is enforced.
     *
     * A checker rather than a list, because that is the shape the contract gives: it exposes
     * `is_allowed(payee)` and no view that enumerates the allowed set. The set can be
     * reconstructed from AllowlistSet events by an indexer that has kept them, but public RPC
     * nodes keep only about a week of events, so a list built from RPC history would be
     * silently incomplete for any vault older than that. Both reads are simulations at the
     * latest ledger, and the higher of the two ledgers is reported.
     */
    async isAllowed(
      vault: string,
      payee: string,
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<{ allowed: boolean; allowlistEnabled: boolean; ledger: number }> {
      if (!isContractId(vault)) throw new Error(`${vault} is not a Soroban contract id`)
      if (!isAccountId(payee) && !isContractId(payee)) throw new Error(`${payee} is not a Stellar address`)
      const [allowed, enabled] = await Promise.all([
        viewAt(vault, 'is_allowed', [addr(payee)], env),
        viewAt(vault, 'allowlist_enabled', [], env),
      ])
      return { allowed: Boolean(allowed.value), allowlistEnabled: Boolean(enabled.value), ledger: Math.max(allowed.ledger, enabled.ledger) }
    },

    /**
     * What code a contract instance runs, read off its instance entry with getLedgerEntries.
     *
     * The executable is the only thing that ties an address to source we can point at: a
     * contract id says nothing about what was deployed behind it. `wasmHash` is the sha256 of
     * the module, the same value soroban/releases/ records and `stellar contract fetch`
     * reproduces. A Stellar Asset Contract has no wasm and reports `stellar-asset`. The same
     * read carries the instance's TTL, so it is returned beside it rather than read twice.
     *
     * `found: false` means the RPC returned no instance entry at all: nothing is deployed at
     * that address on this network (or a testnet reset took it). An archived instance still
     * comes back, so it is `found` with `archived: true`.
     */
    async readExecutableWasmHash(
      contract: string,
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<{
      ledger: number
      found: boolean
      executable: 'wasm' | 'stellar-asset' | 'other' | null
      wasmHash: string | null
      liveUntilLedger: number | null
      archived: boolean
    }> {
      if (!isContractId(contract)) throw new Error(`${contract} is not a Soroban contract id`)
      const server = rpcFor(env)
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(contract).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      )
      const res = await server.getLedgerEntries(key)
      const entry = res.entries[0] as { liveUntilLedgerSeq?: number; val?: xdr.LedgerEntryData } | undefined
      if (!entry) {
        return { ledger: res.latestLedger, found: false, executable: null, wasmHash: null, liveUntilLedger: null, archived: false }
      }
      const live = isLiveLedgerEntry(entry, res.latestLedger)
      let executable: 'wasm' | 'stellar-asset' | 'other' | null = null
      let wasmHash: string | null = null
      try {
        const exe = (entry.val as xdr.LedgerEntryData).contractData().val().instance().executable()
        const arm = exe.switch().name
        if (arm === 'contractExecutableWasm') {
          executable = 'wasm'
          wasmHash = Buffer.from(exe.wasmHash() as unknown as Uint8Array).toString('hex')
        } else if (arm === 'contractExecutableStellarAsset') {
          executable = 'stellar-asset'
        } else {
          executable = 'other'
        }
      } catch {
        // An entry whose value we cannot decode is reported as found with no executable,
        // never given a hash we did not read.
      }
      return {
        ledger: res.latestLedger,
        found: true,
        executable,
        wasmHash,
        liveUntilLedger: live ? (entry.liveUntilLedgerSeq as number) : null,
        archived: !live,
      }
    },

    /**
     * How long a vault's INSTANCE entry has left before Soroban archives it.
     *
     * Every field this contract reads on every call lives in that one entry: owner,
     * operator, token, decimals, cap, ceiling, frozen, allowlist flag, session expiry.
     * `bump_instance` extends it, but only on writing entrypoints, so a vault that is
     * deployed, funded and then left alone drifts toward archival on a timer. Archival is
     * not a brick (a persistent entry comes back WITH its value), but it costs rent plus a
     * restoring footprint on the next call, and an operator who does not know it is coming.
     *
     * The same read mcp/scripts/stellar-vault-archival.mjs does, here so the public vault
     * view reports it instead of a human remembering to run the script.
     */
    async readInstanceTtl(
      contract: string,
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<{ ledger: number; liveUntilLedger: number | null; archived: boolean }> {
      if (!isContractId(contract)) throw new Error(`${contract} is not a Soroban contract id`)
      const server = rpcFor(env)
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(contract).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      )
      const res = await server.getLedgerEntries(key)
      const entry = res.entries[0] as { liveUntilLedgerSeq?: number } | undefined
      // An archived instance still comes back, with liveUntilLedgerSeq 0, and passing that 0 on
      // as a ledger number turned an archived vault into a countdown that ended at genesis.
      // Live means live for the next ledger. A lapsed entry is `archived`; a missing one is
      // not, because it may simply not be deployed on this network.
      const live = isLiveLedgerEntry(entry, res.latestLedger)
      return {
        ledger: res.latestLedger,
        liveUntilLedger: live ? (entry?.liveUntilLedgerSeq as number) : null,
        archived: entry !== undefined && !live,
      }
    },

    /**
     * A holder's balance of a SEP-41 token, in base units, read by simulation.
     *
     * Used before the seed transfer below, so a vault is only ever promised a seed the signer
     * can pay: a transfer the SAC would refuse for want of balance is not worth a round trip.
     */
    async readTokenBalance(token: string, holder: string, env: NodeJS.ProcessEnv = process.env): Promise<bigint> {
      if (!isContractId(token)) throw new Error(`${token} is not a Soroban contract id`)
      if (!isAccountId(holder) && !isContractId(holder)) throw new Error(`${holder} is not a Stellar address`)
      return BigInt(String(await viewWith(token, 'balance', [addr(holder)], env)))
    },

    /**
     * Move token out of the SIGNER's own account through the SAC: `transfer(signer, to, amount)`.
     *
     * The same shape as mcp/scripts/stellar-vault-fund.mjs, here so the passkey demo can seed
     * the vault it just deployed without a human running a script. It is the signer's OWN
     * balance that moves, which is why the amount is capped by the caller and why this is
     * prepared-or-executed like every other write: no key, no transfer, and the exact call is
     * returned instead.
     */
    async sacTransferFromSigner(token: string, to: string, amountRaw: bigint | string, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome> {
      const from = stellarSignerAddress(chain, env)
      if (!from) {
        return {
          outcome: 'prepared',
          contract: token,
          method: 'transfer',
          args: ['<the account the chain signer decodes to>', to, String(amountRaw)],
          network: chain.caip2,
          reason: `${chain.signerEnvVar ?? 'the chain signer'} is not set, so nothing was submitted. This is the exact call it would make.`,
        }
      }
      return write(token, 'transfer', [addr(from), addr(to), i128(amountRaw)], [from, to, String(amountRaw)], env)
    },

    /** The agent's bounded payment. Amount is in the token's own base units. */
    policyPay: (vault: string, to: string, amountRaw: bigint | string, env = process.env) =>
      write(vault, 'pay', [addr(to), i128(amountRaw)], [to, String(amountRaw)], env),

    // ── owner entrypoints signed with OUR key ─────────────────────────────────────────
    //
    // The six helpers below call owner-only entrypoints and sign with the chain's env key.
    // They exist for one case only: a vault whose owner IS that env key. They are reached
    // through platform/vault-adapter.ts (the console's policy sync, the session-key grant,
    // and the human-override settlement), never from a route that takes a vault from a
    // request body, and every one of them is prepared-or-executed like the rest of `write`.
    //
    // They can never authorize anything for a vault owned by a person's wallet or by a
    // passkey smart account. The contract calls `owner.require_auth()` against the owner it
    // stored, so our signature counts only if we are that owner; and `write` now reads the
    // simulation's recorded authorization and refuses to submit when it names any address
    // other than our own source account, returning `prepared` with the owner it would need.
    // So the worst a misrouted call can do is say which signature is missing. It cannot spend
    // our fee on a transaction the host would refuse, and it cannot produce an owner
    // authorization: that only ever comes from the owner's own wallet, through
    // /api/stellar/vault/prepare and /submit, where this server signs nothing.

    /** The human override: skips ceiling, allowlist and freeze, still counted by the cap. */
    policyOwnerPay: (vault: string, to: string, amountRaw: bigint | string, env = process.env) =>
      write(vault, 'owner_pay', [addr(to), i128(amountRaw)], [to, String(amountRaw)], env),

    policyWithdraw: (vault: string, to: string, amountRaw: bigint | string, env = process.env) =>
      write(vault, 'withdraw', [addr(to), i128(amountRaw)], [to, String(amountRaw)], env),

    policySetPolicy: (
      vault: string,
      dailyCapRaw: bigint | string,
      autoApproveMaxRaw: bigint | string,
      allowlistEnabled: boolean,
      env = process.env,
    ) =>
      write(
        vault,
        'set_policy',
        [i128(dailyCapRaw), i128(autoApproveMaxRaw), nativeToScVal(allowlistEnabled)],
        [String(dailyCapRaw), String(autoApproveMaxRaw), allowlistEnabled],
        env,
      ),

    policySetFrozen: (vault: string, frozen: boolean, env = process.env) =>
      write(vault, 'set_frozen', [nativeToScVal(frozen)], [frozen], env),

    policySetAllowed: (vault: string, payee: string, allowed: boolean, env = process.env) =>
      write(vault, 'set_allowed', [addr(payee), nativeToScVal(allowed)], [payee, allowed], env),

    policySetSessionExpiry: (vault: string, expiry: bigint | string, env = process.env) =>
      write(vault, 'set_session_key_expiry', [u64(expiry)], [String(expiry)], env),
  }
}

export type StellarAdapter = ReturnType<typeof createStellarAdapter>
