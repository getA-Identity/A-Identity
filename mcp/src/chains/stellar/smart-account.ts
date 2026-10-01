/**
 * Read an OpenZeppelin smart account, and the transaction a relayer paid for, off the ledger.
 *
 * The passkey endpoints make three decisions that rest on facts only the chain holds: which
 * code a C... address actually runs, who its signers are right now, and which account paid
 * the fee for a transaction somebody else broadcast. A request can CLAIM any of these; this
 * file is where they are read instead. It decodes into plain strings and decides nothing:
 * the rules over these reads live in `mcp/src/stellar-passkey.ts`, pure and unit-tested.
 *
 * Read-only by construction. Every call is a getLedgerEntries, a simulation, or a
 * getTransaction; nothing is signed, nothing is sent, and no key is needed for any of it.
 */
import { Account, Address, BASE_FEE, Contract, FeeBumpTransaction, TransactionBuilder, rpc, scValToNative, xdr } from '@stellar/stellar-sdk'

import type { ChainDescriptor } from '../types.js'
import { READ_ONLY_SOURCE } from './adapter.js'
import { isLiveLedgerEntry, networkPassphrase, sorobanServer } from './client.js'
import { isContractId } from './strkey.js'
import type { RelayContextType, RelaySigner } from './relay-shape.js'

/**
 * The most rules this reader enumerates. The OpenZeppelin account's own counter only grows,
 * so a removed rule still costs a read; past this many the account is not one this flow
 * made, and the honest answer is "too many to vouch for" rather than a partial list.
 */
export const MAX_RULES_READ = 16

/** What code a contract address runs, read from its instance entry. */
export type ContractCode = {
  /** The ledger the read was answered at. */
  ledger: number
  /** False when no instance entry exists: nothing is deployed at this address on this network. */
  found: boolean
  executable: 'wasm' | 'stellar-asset' | 'other' | null
  /** Lowercase hex sha256 of the wasm, when the executable is wasm. */
  wasmHash: string | null
  /** The instance entry has lapsed. Its code is still its code; it needs a restore to run. */
  archived: boolean
}

/** One active context rule, decoded to plain strings. */
export type SmartAccountRule = {
  id: number
  name: string | null
  contextType: RelayContextType
  signers: RelaySigner[]
  /** The policy contracts this rule installs. A non-empty list can authorize on its own. */
  policies: string[]
  validUntil: number | null
}

export type SmartAccountRules = {
  /** `get_context_rules_count`: every rule ever created, including removed ones. */
  count: number
  /** The rules that still exist, in id order. */
  rules: SmartAccountRule[]
  /** Ids below `count` that answered ContextRuleNotFound (#3000): removed rules. */
  removed: number[]
}

/** The fee side of a transaction someone else broadcast, as the ledger recorded it. */
export type FeePayerRead =
  | { found: false; status: 'NOT_FOUND'; ledger: number | null }
  | {
      found: true
      status: 'SUCCESS' | 'FAILED'
      ledger: number | null
      /** The account the network charged: the fee-bump's outer source, else the transaction source. */
      feeAccount: string
      /** The inner transaction's source, which on a relayer path is a channel account. */
      sourceAccount: string
      feeBump: boolean
      feeChargedStroops: string | null
    }

export type SmartAccountRpc = Pick<rpc.Server, 'simulateTransaction' | 'getLedgerEntries' | 'getTransaction'>

export type SmartAccountReader = {
  readCode(contract: string, env?: NodeJS.ProcessEnv): Promise<ContractCode>
  readRules(account: string, env?: NodeJS.ProcessEnv): Promise<SmartAccountRules>
  readFeePayer(hash: string, env?: NodeJS.ProcessEnv): Promise<FeePayerRead>
}

/** `Signer` as scValToNative renders it: `['External', 'C...', Buffer]` or `['Delegated', 'G...']`. */
function signerOf(v: unknown): RelaySigner {
  if (!Array.isArray(v) || typeof v[0] !== 'string') return { kind: 'unknown' }
  if (v[0] === 'External' && v.length === 3 && typeof v[1] === 'string' && (Buffer.isBuffer(v[2]) || v[2] instanceof Uint8Array)) {
    return { kind: 'external', verifier: v[1], keyHex: Buffer.from(v[2] as Uint8Array).toString('hex') }
  }
  if (v[0] === 'Delegated' && v.length === 2 && typeof v[1] === 'string') return { kind: 'delegated', address: v[1] }
  return { kind: 'unknown' }
}

function contextTypeOf(v: unknown): RelayContextType {
  if (!Array.isArray(v) || typeof v[0] !== 'string') return 'unknown'
  if (v[0] === 'Default' && v.length === 1) return 'default'
  if (v[0] === 'CallContract' && v.length === 2) return 'call-contract'
  if (v[0] === 'CreateContract' && v.length === 2) return 'create-contract'
  return 'unknown'
}

/** One `get_context_rule` result, as the OpenZeppelin account returns it (a symbol-keyed map). */
export function decodeContextRule(native: unknown): SmartAccountRule {
  if (!native || typeof native !== 'object' || Array.isArray(native)) throw new Error('get_context_rule did not return a map')
  const r = native as Record<string, unknown>
  const id = Number(r.id)
  if (!Number.isInteger(id) || id < 0) throw new Error('get_context_rule returned no id')
  const vu = r.valid_until
  return {
    id,
    name: typeof r.name === 'string' ? r.name : null,
    contextType: contextTypeOf(r.context_type),
    signers: Array.isArray(r.signers) ? r.signers.map((s) => signerOf(s)) : [],
    policies: Array.isArray(r.policies) ? r.policies.map((p) => String(p)) : [],
    validUntil: vu === null || vu === undefined ? null : Number(vu),
  }
}

/** The account answered ContextRuleNotFound, which on an id below the counter means removed. */
function isMissingRule(message: string): boolean {
  return /Error\(Contract, #3000\)/.test(message)
}

export function createSmartAccountReader(
  chain: ChainDescriptor,
  deps: { server?: (env: NodeJS.ProcessEnv) => SmartAccountRpc } = {},
): SmartAccountReader {
  if (chain.ecosystem !== 'stellar') throw new Error(`createSmartAccountReader: ${chain.id} is not a Stellar chain`)
  const net = networkPassphrase(chain)
  const rpcFor = (env: NodeJS.ProcessEnv): SmartAccountRpc => (deps.server ? deps.server(env) : sorobanServer(chain, env))

  /** A read done as a simulation from a source that need not exist, exactly as the adapter's views. */
  async function view(contract: string, method: string, args: xdr.ScVal[], env: NodeJS.ProcessEnv): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(READ_ONLY_SOURCE, '0'), { fee: BASE_FEE, networkPassphrase: net })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(30)
      .build()
    const sim = await rpcFor(env).simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`)
    if (!sim.result) throw new Error(`${method}: simulation returned no result`)
    return scValToNative(sim.result.retval)
  }

  return {
    async readCode(contract, env = process.env) {
      if (!isContractId(contract)) throw new Error(`${contract} is not a Soroban contract id`)
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(contract).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      )
      const res = await rpcFor(env).getLedgerEntries(key)
      const entry = res.entries[0]
      if (!entry) return { ledger: res.latestLedger, found: false, executable: null, wasmHash: null, archived: false }
      let executable: ContractCode['executable'] = null
      let wasmHash: string | null = null
      try {
        const exe = (entry.val as xdr.LedgerEntryData).contractData().val().instance().executable()
        const kind = exe.switch().name
        if (kind === 'contractExecutableWasm') {
          executable = 'wasm'
          wasmHash = Buffer.from(exe.wasmHash()).toString('hex')
        } else if (kind === 'contractExecutableStellarAsset') {
          executable = 'stellar-asset'
        } else {
          executable = 'other'
        }
      } catch {
        // Found, but not decodable as an instance: reported with no executable, which every
        // decision over it reads as "not the code we expect" rather than as a pass.
        executable = null
      }
      return {
        ledger: res.latestLedger,
        found: true,
        executable,
        wasmHash,
        archived: !isLiveLedgerEntry(entry as { liveUntilLedgerSeq?: number }, res.latestLedger),
      }
    },

    async readRules(account, env = process.env) {
      if (!isContractId(account)) throw new Error(`${account} is not a Soroban contract id`)
      const count = Number(await view(account, 'get_context_rules_count', [], env))
      if (!Number.isInteger(count) || count < 0) throw new Error('get_context_rules_count did not return a count')
      if (count > MAX_RULES_READ) {
        throw new Error(`the account has created ${count} context rules, more than the ${MAX_RULES_READ} this reader will vouch for`)
      }
      const rules: SmartAccountRule[] = []
      const removed: number[] = []
      for (let id = 0; id < count; id += 1) {
        try {
          rules.push(decodeContextRule(await view(account, 'get_context_rule', [xdr.ScVal.scvU32(id)], env)))
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          if (isMissingRule(message)) removed.push(id)
          else throw e
        }
      }
      return { count, rules, removed }
    },

    async readFeePayer(hash, env = process.env) {
      if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error('a transaction hash is 64 hex characters')
      const res = await rpcFor(env).getTransaction(hash.toLowerCase())
      if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { found: false, status: 'NOT_FOUND', ledger: null }
      const done = res as rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse
      const tx = TransactionBuilder.fromXDR(done.envelopeXdr.toXDR('base64'), net)
      const feeBump = tx instanceof FeeBumpTransaction
      let fee: string | null = null
      try {
        fee = done.resultXdr.feeCharged().toString()
      } catch {
        fee = null
      }
      return {
        found: true,
        status: done.status === rpc.Api.GetTransactionStatus.SUCCESS ? 'SUCCESS' : 'FAILED',
        ledger: done.ledger ?? null,
        feeAccount: feeBump ? tx.feeSource : tx.source,
        sourceAccount: feeBump ? tx.innerTransaction.source : tx.source,
        feeBump,
        feeChargedStroops: fee,
      }
    },
  }
}
