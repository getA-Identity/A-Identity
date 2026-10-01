import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Account, Address, Keypair, Networks, Operation, StrKey, TransactionBuilder, scValToNative, xdr } from '@stellar/stellar-sdk'

import { CHAINS } from '../registry.js'
import { MAX_RULES_READ, createSmartAccountReader, decodeContextRule, type SmartAccountRpc } from './smart-account.js'

/**
 * The ledger reads behind the passkey endpoints' three live decisions, against a fake RPC.
 *
 * What is worth pinning here is the DECODING, because every rule in stellar-passkey.ts is
 * written against the plain shape this file produces: a context rule exactly as the
 * OpenZeppelin account returns it (a symbol-keyed map, read live off testnet on 2026-10-02 to
 * fix the shape), an instance entry's executable, and a fee-bump's outer source. Every value
 * below is built with the SDK's own XDR types and every key is generated at runtime.
 */

const testnet = CHAINS.find((c) => c.id === 'stellar-testnet')!
const WASM = testnet.contracts.smartAccount!.wasmHash
const VERIFIER = testnet.contracts.smartAccount!.webauthnVerifier
const contractId = (): string => StrKey.encodeContract(randomBytes(32))

const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const addr = (a: string) => xdr.ScVal.scvAddress(new Address(a).toScAddress())

/** A `ContextRule` as get_context_rule returns it: map keys in the contract's own (sorted) order. */
function ruleScVal(id: number, signers: xdr.ScVal[], over: { policies?: string[]; validUntil?: number; context?: xdr.ScVal } = {}): xdr.ScVal {
  const entry = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(k), val: v })
  return xdr.ScVal.scvMap([
    entry('context_type', over.context ?? xdr.ScVal.scvVec([sym('Default')])),
    entry('id', xdr.ScVal.scvU32(id)),
    entry('name', xdr.ScVal.scvString('multisig')),
    entry('policies', xdr.ScVal.scvVec((over.policies ?? []).map(addr))),
    entry('policy_ids', xdr.ScVal.scvVec([])),
    entry('signer_ids', xdr.ScVal.scvVec(signers.map((_, i) => xdr.ScVal.scvU32(i)))),
    entry('signers', xdr.ScVal.scvVec(signers)),
    entry('valid_until', over.validUntil === undefined ? xdr.ScVal.scvVoid() : xdr.ScVal.scvU32(over.validUntil)),
  ])
}
const external = (verifier: string, key: Buffer) => xdr.ScVal.scvVec([sym('External'), addr(verifier), xdr.ScVal.scvBytes(key)])
const delegated = (g: string) => xdr.ScVal.scvVec([sym('Delegated'), addr(g)])

/** A fake RPC that answers simulations by method name and argument, and counts them. */
function fakeRpc(opts: {
  count?: number
  rules?: Record<number, xdr.ScVal | 'missing'>
  instance?: xdr.ContractExecutable | null
  liveUntil?: number
  tx?: Awaited<ReturnType<SmartAccountRpc['getTransaction']>>
}): { rpc: SmartAccountRpc; sims: string[] } {
  const sims: string[] = []
  const rpc = {
    async simulateTransaction(tx: { operations: { func: xdr.HostFunction }[] }) {
      const inv = tx.operations[0].func.invokeContract()
      const method = inv.functionName().toString()
      const arg = inv.args()[0]
      sims.push(arg ? `${method}(${arg.u32()})` : method)
      if (method === 'get_context_rules_count') return { result: { retval: xdr.ScVal.scvU32(opts.count ?? 1) } }
      const r = opts.rules?.[arg.u32()]
      if (!r || r === 'missing') return { error: 'HostError: Error(Contract, #3000)' }
      return { result: { retval: r } }
    },
    async getLedgerEntries() {
      if (!opts.instance) return { latestLedger: 100, entries: [] }
      const val = xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: new xdr.ExtensionPoint(0),
          contract: new Address(contractId()).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
          val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: opts.instance, storage: null })),
        }),
      )
      return { latestLedger: 100, entries: [{ val, liveUntilLedgerSeq: opts.liveUntil ?? 1000 }] }
    },
    async getTransaction() {
      return opts.tx ?? { status: 'NOT_FOUND' }
    },
  }
  return { rpc: rpc as unknown as SmartAccountRpc, sims }
}

const readerOver = (rpc: SmartAccountRpc) => createSmartAccountReader(testnet, { server: () => rpc })

test('an instance running the account wasm is read as that wasm, by hash', async () => {
  const { rpc } = fakeRpc({ instance: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(WASM, 'hex')) })
  const code = await readerOver(rpc).readCode(contractId(), {})
  assert.deepEqual(code, { ledger: 100, found: true, executable: 'wasm', wasmHash: WASM, archived: false })
})

test('no instance means nothing is deployed; a Stellar Asset Contract has no wasm; a lapsed entry says archived', async () => {
  assert.equal((await readerOver(fakeRpc({ instance: null }).rpc).readCode(contractId(), {})).found, false)
  const sac = await readerOver(fakeRpc({ instance: xdr.ContractExecutable.contractExecutableStellarAsset() }).rpc).readCode(contractId(), {})
  assert.equal(sac.executable, 'stellar-asset')
  assert.equal(sac.wasmHash, null)
  const lapsed = await readerOver(fakeRpc({ instance: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(WASM, 'hex')), liveUntil: 50 }).rpc).readCode(contractId(), {})
  assert.equal(lapsed.archived, true)
  assert.equal(lapsed.wasmHash, WASM, 'archival does not change which code an address runs')
})

test('rules are enumerated up to the counter, a removed rule is skipped by its #3000, and signers decode', async () => {
  const key = Buffer.concat([Buffer.from([4]), randomBytes(64), randomBytes(20)])
  const g = Keypair.random().publicKey()
  const { rpc, sims } = fakeRpc({
    count: 3,
    rules: { 0: ruleScVal(0, [external(VERIFIER, key)]), 1: 'missing', 2: ruleScVal(2, [delegated(g)], { validUntil: 77 }) },
  })
  const r = await readerOver(rpc).readRules(contractId(), {})
  assert.deepEqual(sims, ['get_context_rules_count', 'get_context_rule(0)', 'get_context_rule(1)', 'get_context_rule(2)'])
  assert.equal(r.count, 3)
  assert.deepEqual(r.removed, [1])
  assert.equal(r.rules.length, 2)
  assert.deepEqual(r.rules[0].signers, [{ kind: 'external', verifier: VERIFIER, keyHex: key.toString('hex') }])
  assert.equal(r.rules[0].contextType, 'default')
  assert.equal(r.rules[0].validUntil, null)
  assert.deepEqual(r.rules[1].signers, [{ kind: 'delegated', address: g }])
  assert.equal(r.rules[1].validUntil, 77)
})

test('a simulation error that is not ContextRuleNotFound stops the read rather than shortening the list', async () => {
  const { rpc } = fakeRpc({ count: 1, rules: {} })
  const broken = { ...rpc, simulateTransaction: async () => ({ error: 'HostError: Error(Budget, ExceededLimit)' }) } as unknown as SmartAccountRpc
  await assert.rejects(readerOver(broken).readRules(contractId(), {}), /ExceededLimit/)
})

test('an account with more rules than this reader vouches for is refused, not partially listed', async () => {
  const { rpc } = fakeRpc({ count: MAX_RULES_READ + 1 })
  await assert.rejects(readerOver(rpc).readRules(contractId(), {}), /more than the/)
})

test('a context rule decodes its policy list and a CallContract context, and an unknown signer stays unknown', () => {
  const policy = contractId()
  const raw = ruleScVal(4, [xdr.ScVal.scvVec([sym('Quantum'), addr(contractId())])], { policies: [policy], context: xdr.ScVal.scvVec([sym('CallContract'), addr(contractId())]) })
  // scValToNative is what the reader applies; doing it here keeps the test on the same path.
  const rule = decodeContextRule(scValToNative(raw))
  assert.equal(rule.id, 4)
  assert.equal(rule.contextType, 'call-contract')
  assert.deepEqual(rule.policies, [policy])
  assert.deepEqual(rule.signers, [{ kind: 'unknown' }])
  assert.throws(() => decodeContextRule([1, 2]), /did not return a map/)
})

test('the fee payer of a fee-bump is its outer source, and the inner source is named apart', async () => {
  const inner = Keypair.random()
  const outer = Keypair.random()
  const tx = new TransactionBuilder(new Account(inner.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
    .setTimeout(30)
    .build()
  tx.sign(inner)
  const bump = TransactionBuilder.buildFeeBumpTransaction(outer, '200', tx, Networks.TESTNET)
  bump.sign(outer)
  const { rpc } = fakeRpc({
    tx: {
      status: 'SUCCESS',
      ledger: 4242,
      envelopeXdr: bump.toEnvelope(),
      resultXdr: { feeCharged: () => ({ toString: () => '345' }) },
    } as never,
  })
  const r = await readerOver(rpc).readFeePayer('ab'.repeat(32), {})
  assert.equal(r.found, true)
  if (r.found) {
    assert.equal(r.feeAccount, outer.publicKey())
    assert.equal(r.sourceAccount, inner.publicKey())
    assert.equal(r.feeBump, true)
    assert.equal(r.feeChargedStroops, '345')
    assert.equal(r.ledger, 4242)
  }
  const missing = await readerOver(fakeRpc({}).rpc).readFeePayer('cd'.repeat(32), {})
  assert.equal(missing.found, false)
  await assert.rejects(readerOver(fakeRpc({}).rpc).readFeePayer('not-a-hash', {}), /64 hex/)
})
