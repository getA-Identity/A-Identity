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
  simulationArchivedEntries,
  sorobanServer,
  stellarKeypair,
  stellarSignerAddress,
} from './client.js'
import { isAccountId, isContractId } from './strkey.js'

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
    }
  /** The contract refused it in simulation, so it never reached the ledger and cost nothing. */
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
    }
  /** In the ledger and successful. */
  | {
      outcome: 'settled'
      txHash: string
      ledger: number | undefined
      explorerUrl: string
    }
  /** In the ledger and failed. It consumed a fee and moved nothing. */
  | {
      outcome: 'failed'
      txHash: string
      ledger: number | undefined
      explorerUrl: string
      contractErrorCode?: number
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
  day: string
  spentTodayRaw: string
  balanceRaw: string
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
      /**
       * Footprint entries this call would RESTORE from archived state, which since protocol 23
       * happens inside the call with the rent included in `feeStroops`. Empty in the ordinary case.
       */
      archivedEntries: number[]
      summary: string
    }
  | {
      ok: false
      code: 'bad_request' | 'refused' | 'restore_needed' | 'rpc_error'
      reason: string
      contractErrorCode?: number
      contractErrorFrom?: string
      contractErrorIsOurs?: boolean
      contractErrorName?: string
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

/** A deploy settles with a contract id; every other arm is the ordinary five-arm outcome. */
export type VaultDeployOutcome =
  | Exclude<CallOutcome, { outcome: 'settled' }>
  | (Extract<CallOutcome, { outcome: 'settled' }> & { vault: string })

/**
 * The contract error code out of a failed transaction's diagnostic events.
 *
 * This field was previously declared and never assigned, so a caller branching on it had a
 * branch that could never be taken. Reading it is what makes a typed revert usable by the
 * client, which is the product claim: the revert reason is why the human path takes over.
 */
function failureCodeIn(tx: rpc.Api.GetTransactionResponse): number | undefined {
  try {
    for (const raw of (tx as { diagnosticEventsXdr?: unknown[] }).diagnosticEventsXdr ?? []) {
      const s = JSON.stringify(raw)
      const m = /"contractCode":(\d+)/.exec(s)
      if (m) return Number(m[1])
    }
  } catch {
    /* a code we cannot read is simply absent */
  }
  return undefined
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

  /** A read, done as a simulation. Costs nothing, touches nothing, signs nothing. */
  async function view(vault: string, method: string, env: NodeJS.ProcessEnv): Promise<unknown> {
    const server = rpcFor(env)
    const c = new Contract(vault)
    // A transaction needs a source account even to be simulated, but the simulator never
    // checks that the account exists or that its sequence is real: it is building a
    // footprint, not authorizing anything. So a read works with no signer, no funded
    // account, and no network round trip to fetch one. It must still be a CLASSIC account
    // id; passing the vault's own C... address fails, because a contract is not an account.
    const source = stellarSignerAddress(chain, env) ?? READ_ONLY_SOURCE
    const account = new Account(source, '0')
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net })
      .addOperation(c.call(method))
      .setTimeout(30)
      .build()
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`)
    if (!sim.result) throw new Error(`${method}: simulation returned no result`)
    return scValToNative(sim.result.retval)
  }

  /**
   * The same read, for a method that takes arguments (`balance(holder)` on a SAC). Kept apart
   * from `view` rather than widening it, so the twelve vault reads stay exactly as they were.
   */
  async function viewWith(
    contract: string,
    method: string,
    args: ReturnType<typeof nativeToScVal>[],
    env: NodeJS.ProcessEnv,
  ): Promise<unknown> {
    const server = rpcFor(env)
    const source = stellarSignerAddress(chain, env) ?? READ_ONLY_SOURCE
    const tx = new TransactionBuilder(new Account(source, '0'), { fee: BASE_FEE, networkPassphrase: net })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(30)
      .build()
    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`)
    if (!sim.result) throw new Error(`${method}: simulation returned no result`)
    return scValToNative(sim.result.retval)
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

    const assembled = rpc.assembleTransaction(tx, sim).build()
    assembled.sign(kp)
    return land(server, assembled, shape)
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
    if (sent.status === 'ERROR') {
      return {
        outcome: 'refused',
        ...shape,
        reason: `the network rejected the transaction before the ledger (${sent.status})`,
      }
    }

    let got = await server.getTransaction(sent.hash)
    for (let i = 0; i < 30 && got.status === 'NOT_FOUND'; i += 1) {
      await new Promise((r) => setTimeout(r, 1000))
      got = await server.getTransaction(sent.hash)
    }
    if (got.status === 'NOT_FOUND') {
      return {
        outcome: 'pending',
        txHash: sent.hash,
        explorerUrl,
        reason:
          'submitted and not in the ledger yet. The transaction stays valid for its full timeout, ' +
          'so it may still land: do not retry it and do not record it as failed.',
      }
    }
    if (got.status === 'FAILED') {
      return {
        outcome: 'failed',
        txHash: sent.hash,
        ledger: got.ledger,
        explorerUrl,
        ...(failureCodeIn(got) !== undefined ? { contractErrorCode: failureCodeIn(got) } : {}),
        reason: 'the transaction landed and failed. It consumed a fee and moved nothing.',
      }
    }
    return { outcome: 'settled', txHash: sent.hash, ledger: got.ledger, explorerUrl }
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

    const wasmHash = chain.contracts.spendVaultWasmHash
    if (!wasmHash) {
      return refuse(
        `${chain.name} declares no contracts.spendVaultWasmHash, so there is no code entry to ` +
          'instantiate against and no vault can be deployed here.',
      )
    }

    const kp = stellarKeypair(chain, env)
    if (!kp) {
      return {
        outcome: 'prepared',
        ...shape,
        reason: `${chain.signerEnvVar ?? 'the chain signer'} is not set, so nothing was submitted. This is the exact call it would make.`,
      }
    }

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

    const salt = deps.salt ? deps.salt() : randomBytes(32)
    const account = await server.getAccount(kp.publicKey())
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net })
      .addOperation(
        Operation.createCustomContract({
          address: new Address(kp.publicKey()),
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
    assembled.sign(kp)
    const outcome = await land(server, assembled, shape)
    if (outcome.outcome !== 'settled') return outcome

    // The receipt is authoritative: createContract returns the new contract's Address.
    let vault: string
    try {
      const got = await server.getTransaction(outcome.txHash)
      const retval = (got as { returnValue?: xdr.ScVal }).returnValue
      vault = retval ? String(scValToNative(retval)) : derivedContractId(kp.publicKey(), salt)
    } catch {
      vault = derivedContractId(kp.publicKey(), salt)
    }
    if (!isContractId(vault)) vault = derivedContractId(kp.publicKey(), salt)
    return { ...outcome, vault }
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

  /**
   * Build an owner call the OWNER signs, and hand it back unsigned.
   *
   * This is the whole shape of the Stellar vault story: owner and operator are different
   * accounts by construction, we hold only the operator key, and every owner entrypoint
   * calls `owner.require_auth()`. So the honest thing the server can do is assemble the
   * exact transaction, prove by simulation that the contract would accept it, and give the
   * unsigned envelope to the person whose wallet can authorize it. We never sign it, and
   * the fee is charged to the owner's account because the owner's account is its source.
   */
  async function prepareOwnerCall(
    vault: string,
    method: OwnerMethod,
    args: ScArg[],
    source: string,
    env: NodeJS.ProcessEnv = process.env,
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
      return {
        ok: false,
        code: 'rpc_error',
        reason:
          `${source} could not be loaded on ${chain.name} (${e instanceof Error ? e.message : String(e)}). ` +
          'On Stellar an account has to exist and hold its XLM reserve before it can be a ' +
          'transaction source; an unfunded account is not an account.',
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
      return {
        ok: false,
        code: 'refused',
        reason: `the contract refused it in simulation, so nothing was prepared: ${sim.error}`,
        ...errorFields(e),
        ...(ourErrorName(e) ? { contractErrorName: ourErrorName(e) } : {}),
      }
    }
    if (rpc.Api.isSimulationRestore(sim)) {
      return {
        ok: false,
        code: 'restore_needed',
        reason:
          'this call reads state that has been archived, and the RPC answered with a separate ' +
          'restore preamble, so it needs a restore transaction before it can run. Nothing was ' +
          'prepared, because a signature on it would pay a fee to fail.',
      }
    }
    // Since protocol 23 archived state comes back WITHOUT a preamble: the transaction restores
    // it itself and the rent is inside its fee. Unlike the operator's calls, an owner call is
    // paid for by the owner, and refusing it here would put `withdraw`, the vault's escape
    // hatch, out of this console's reach on exactly the day it is needed. So it is prepared and
    // disclosed instead, and the owner's wallet shows the whole fee before anything is signed.
    const archivedEntries = simulationArchivedEntries(sim)

    const assembled = rpc.assembleTransaction(tx, sim).build()
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
      archivedEntries,
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
      return { inspection, outcome: await land(server, tx as Parameters<SorobanRpc['sendTransaction']>[0], shape) }
    } catch (e) {
      return {
        inspection,
        outcome: {
          outcome: 'refused',
          ...shape,
          reason: `the RPC would not take the transaction: ${e instanceof Error ? e.message : String(e)}`,
        },
      }
    }
  }

  return {
    deployVault,
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
      const s = (v: unknown) => String(v)
      const [
        owner,
        operator,
        token,
        decimals,
        dailyCap,
        autoApproveMax,
        frozen,
        allowlistEnabled,
        sessionKeyExpiry,
        day,
        spentToday,
        balance,
      ] = await Promise.all([
        view(vault, 'owner', env),
        view(vault, 'operator', env),
        view(vault, 'token', env),
        view(vault, 'decimals', env),
        view(vault, 'daily_cap', env),
        view(vault, 'auto_approve_max', env),
        view(vault, 'frozen', env),
        view(vault, 'allowlist_enabled', env),
        view(vault, 'session_key_expiry', env),
        view(vault, 'today', env),
        view(vault, 'spent_today', env),
        view(vault, 'balance', env),
      ])
      return {
        owner: s(owner),
        operator: s(operator),
        token: s(token),
        decimals: Number(decimals),
        dailyCapRaw: s(dailyCap),
        autoApproveMaxRaw: s(autoApproveMax),
        frozen: Boolean(frozen),
        allowlistEnabled: Boolean(allowlistEnabled),
        sessionKeyExpiry: s(sessionKeyExpiry),
        day: s(day),
        spentTodayRaw: s(spentToday),
        balanceRaw: s(balance),
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
