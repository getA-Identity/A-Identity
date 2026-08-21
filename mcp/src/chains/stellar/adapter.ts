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
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk'

import type { ChainDescriptor } from '../types.js'
import { networkPassphrase, sorobanServer, stellarKeypair, stellarSignerAddress } from './client.js'
import { isContractId } from './strkey.js'

/**
 * The stand-in source account for reads when no signer is configured.
 *
 * All-zero ed25519 key in StrKey form, the conventional Stellar "null account". It does
 * not exist on any network and cannot sign, which is exactly what makes it the honest
 * choice here: a read must not depend on holding a key, and hardcoding somebody's real
 * funded account would quietly couple our reads to their balance.
 */
const READ_ONLY_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

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

export function createStellarAdapter(chain: ChainDescriptor) {
  if (chain.ecosystem !== 'stellar') {
    throw new Error(`createStellarAdapter: ${chain.id} is not a Stellar chain (${chain.ecosystem})`)
  }

  const net = networkPassphrase(chain)
  const i128 = (v: bigint | string) => nativeToScVal(BigInt(v), { type: 'i128' })
  const u64 = (v: bigint | string) => nativeToScVal(BigInt(v), { type: 'u64' })
  const addr = (g: string) => new Address(g).toScVal()

  /** A read, done as a simulation. Costs nothing, touches nothing, signs nothing. */
  async function view(vault: string, method: string, env: NodeJS.ProcessEnv): Promise<unknown> {
    const server = sorobanServer(chain, env)
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

    const server = sorobanServer(chain, env)
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
    // An archived entry is not an error, it is a restore preamble, and submitting anyway
    // burns a fee on a transaction that cannot succeed. Soroban archives entries as a
    // matter of course, so this is an expected state rather than an edge case.
    if (rpc.Api.isSimulationRestore(sim)) {
      return {
        outcome: 'refused',
        ...shape,
        reason:
          'this call reads state that has been archived, so it needs a restore before it can run. ' +
          'Nothing was submitted, because submitting would have paid a fee to fail.',
      }
    }

    const assembled = rpc.assembleTransaction(tx, sim).build()
    assembled.sign(kp)
    const sent = await server.sendTransaction(assembled)
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

  return {
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
      const server = sorobanServer(chain, env)
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
