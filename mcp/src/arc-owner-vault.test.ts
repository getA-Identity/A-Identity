import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getAddress, getCreateAddress, zeroAddress, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  ADMISSION_CHAIN,
  REHEARSAL_CHAIN,
  OUR_KEY_ENV_VARS,
  admissionHosts,
  agreeAcrossHosts,
  blockFingerprint,
  collectOurAddresses,
  constructorInputs,
  deployChecks,
  encodeCreationInput,
  envLoadedCheck,
  isoFromSeconds,
  liveOurAddressSources,
  matchCreationInput,
  matchRuntime,
  ourKeyEnvVars,
  parseOwnerKind,
  pasteReadyEntry,
  pasteViolations,
  receiptFingerprint,
  renderEntry,
  stateChecks,
  stateNotes,
  transactionFingerprint,
  utcDayFromSeconds,
  verdict,
  type DeployEvidence,
  type EntryInput,
  type HostAnswer,
  type OurAddresses,
  type RpcBlock,
  type RpcReceipt,
  type RpcTransaction,
  type RuntimeMatch,
  type VaultState,
} from './arc-owner-vault.js'
import { ARC_OWNER_HELD_VAULTS } from './arc-season.js'
import { PROVENANCE } from './chains/provenance.js'
import { getChainById } from './chains/registry.js'
import { AgentSpendPolicyAbi, AgentSpendPolicyBytecode } from './contracts/AgentSpendPolicy.js'
import { internalPayers as gatewayInternalPayers } from './x402-gateway/rail.js'
import { internalPayers as facilitatorInternalPayers } from './x402-3009/rail.js'

/**
 * The owner-held vault admission, fed what the hosts would return rather than the hosts.
 *
 * Milestone 1 counts a vault only when its owner key is one we never held, so the rule that
 * matters most is the one a careless entry would break: the owner is the wallet that sent the
 * deploy, and it is none of ours. Every other rule gets its own case below, each failing alone,
 * so a guard that stops refusing turns this file red rather than letting a vault through.
 */
const arc = getChainById(ADMISSION_CHAIN)!
const USDC = arc.contracts.usdc!
const TOKEN = { symbol: 'USDC', decimals: 6 }
const abi = AgentSpendPolicyAbi
const bytecode = AgentSpendPolicyBytecode as Hex

const OWNER = getAddress('0x1111111111111111111111111111111111111111')
const OPERATOR = getAddress('0x2222222222222222222222222222222222222222')
const OTHER = getAddress('0x3333333333333333333333333333333333333333')
const TX = `0x${'ab'.repeat(32)}`
const BLOCK_HASH = `0x${'cd'.repeat(32)}`
const NOW = 1_793_500_000n // 2026-11-01T02:26:40Z, the chain's current block time in these cases
const DEPLOYED = 1_793_400_000n // 2026-10-30T22:40:00Z

const ARGS = { owner: OWNER, operator: OPERATOR, usdc: USDC, dailyCap: 1_000_000n, autoApproveMax: 250_000n }
const INPUT = encodeCreationInput(bytecode, abi, ARGS)
const OURS: OurAddresses = collectOurAddresses(liveOurAddressSources({} as NodeJS.ProcessEnv))
/** Our operating wallet, read from the ledger the way the script reads it. */
const OPERATING = getAddress(PROVENANCE.find((p) => p.chain === ADMISSION_CHAIN)!.agent!.owner)

const STATE: VaultState = {
  owner: OWNER,
  operator: OPERATOR,
  usdc: USDC,
  dailyCap: 1_000_000n,
  autoApproveMax: 250_000n,
  sessionKeyExpiry: NOW + 14n * 86_400n,
  frozen: false,
  allowlistEnabled: false,
  balance: 0n,
}
const RUNTIME_OK: RuntimeMatch = matchRuntime('0x6080abcd', '0x6080abcd')

/** A deploy by `from` at `nonce`: the receipt, the transaction and the address they create. */
function deployedBy(from: string, nonce: number) {
  const vault = getCreateAddress({ from: getAddress(from), nonce: BigInt(nonce) })
  const receipt: RpcReceipt = {
    transactionHash: TX,
    status: '0x1',
    from: from.toLowerCase(),
    to: null,
    contractAddress: vault.toLowerCase(),
    blockNumber: '0x10',
    blockHash: BLOCK_HASH,
  }
  const tx: RpcTransaction = { hash: TX, from: from.toLowerCase(), to: null, nonce: `0x${nonce.toString(16)}`, input: INPUT, blockHash: BLOCK_HASH }
  return { vault, receipt, tx }
}

type Case = {
  receipt?: Partial<RpcReceipt> | null
  tx?: Partial<RpcTransaction> | null
  block?: Partial<RpcBlock> | null
  receiptAnswers?: HostAnswer<RpcReceipt>[]
  deployer?: { from: string; nonce: number }
  state?: Partial<VaultState> | null
  runtime?: RuntimeMatch | null
  runtimeRequired?: boolean
  expectedVault?: string
  ours?: OurAddresses
}

function run(c: Case = {}) {
  const d = deployedBy(c.deployer?.from ?? OWNER, c.deployer?.nonce ?? 7)
  const receipt = c.receipt === null ? null : { ...d.receipt, ...c.receipt }
  const tx = c.tx === null ? null : { ...d.tx, ...c.tx }
  const block = c.block === null ? null : { number: '0x10', hash: BLOCK_HASH, timestamp: `0x${DEPLOYED.toString(16)}`, ...c.block }
  const evidence: DeployEvidence = {
    txHash: TX,
    receipt: agreeAcrossHosts(c.receiptAnswers ?? [{ host: 'primary', value: null }, { host: 'drpc', value: receipt }], receiptFingerprint),
    tx: agreeAcrossHosts([{ host: 'drpc', value: tx }], transactionFingerprint),
    block: receipt ? agreeAcrossHosts([{ host: 'drpc', value: block }], blockFingerprint) : null,
    creation: tx ? matchCreationInput(tx.input as Hex, bytecode, abi) : null,
    expectedVault: c.expectedVault ?? null,
  }
  const trusted = evidence.receipt.conflict ? null : evidence.receipt.value
  const checks = [
    ...deployChecks(evidence),
    ...stateChecks({
      state: c.state === null ? null : { ...STATE, ...c.state },
      stateBlockedBy: c.state === null && !trusted ? 'receipt-found' : undefined,
      deployer: trusted?.from ?? null,
      deployerBlockedBy: trusted ? undefined : 'receipt-found',
      registryUsdc: USDC,
      ours: c.ours ?? OURS,
      blockTime: NOW,
      runtime: c.runtime === undefined ? RUNTIME_OK : c.runtime,
      runtimeRequired: c.runtimeRequired ?? false,
      token: TOKEN,
      chainId: arc.id,
    }),
  ]
  return { checks, v: verdict(checks) }
}
const refusedBy = (r: ReturnType<typeof run>) => r.v.refusals.map((c) => c.id)

test('admission runs on Arc Mainnet and rehearsal on Arc Testnet, each with a registry USDC', () => {
  const rehearsal = getChainById(REHEARSAL_CHAIN)
  assert.equal(arc.testnet, false)
  assert.equal(rehearsal?.testnet, true)
  assert.equal(arc.ecosystem, 'evm')
  assert.equal(rehearsal?.ecosystem, 'evm')
  assert.ok(USDC && rehearsal?.contracts.usdc, 'usdc() needs a registry address to be compared with on both')
})

test('the constructor is five static words in the order the creation-input split assumes', () => {
  const inputs = constructorInputs(abi)
  assert.deepEqual(
    inputs.map((p) => `${p.type} ${p.name}`),
    ['address _owner', 'address _operator', 'address _usdc', 'uint256 _dailyCap', 'uint256 _autoApproveMax'],
  )
  const changed = [{ type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: '_owner', type: 'address' }, { name: '_note', type: 'string' }] }] as const
  assert.throws(() => constructorInputs(changed), /not the five static words/)
})

test('a deploy of AgentSpendPolicyBytecode with canonical args matches by keccak, and its args read back', () => {
  const m = matchCreationInput(INPUT, bytecode, abi)
  assert.equal(m.method, 'creation-input')
  assert.equal(m.matches, true)
  assert.equal(m.reason, null)
  assert.equal(m.inputHash, m.expectedHash)
  assert.equal(m.inputBytes, m.artifactBytes + 160)
  assert.deepEqual({ ...m.args, owner: getAddress(m.args!.owner), operator: getAddress(m.args!.operator), usdc: getAddress(m.args!.usdc) }, { ...ARGS, usdc: getAddress(USDC) })
  // Case is not a difference: hosts return lowercase hex, the artifact may not.
  assert.equal(matchCreationInput(INPUT.toUpperCase().replace('0X', '0x') as Hex, bytecode, abi).matches, true)
})

test('another build, trailing bytes, a dirty argument word or a short input never match', () => {
  const body = INPUT.slice(2)
  // One byte of the creation code changed: another build, even with the right args after it.
  const flipped = `0x${body.slice(0, 200)}${body[200] === 'f' ? '0' : 'f'}${body.slice(201)}` as Hex
  const another = matchCreationInput(flipped, bytecode, abi)
  assert.equal(another.matches, false)
  assert.match(another.reason!, /is not AgentSpendPolicyBytecode/)
  assert.ok(another.args, 'the args are still read, so a refusal says what was deployed')

  const trailing = matchCreationInput(`${INPUT}${'00'.repeat(32)}` as Hex, bytecode, abi)
  assert.equal(trailing.matches, false)

  // The owner word with its upper twelve bytes set still decodes to the same address, and is
  // still not the encoding the artifact would have produced.
  const ownerWord = INPUT.length - 320
  const dirty = `${INPUT.slice(0, ownerWord)}ff${INPUT.slice(ownerWord + 2)}` as Hex
  const d = matchCreationInput(dirty, bytecode, abi)
  assert.equal(d.matches, false)
  assert.match(d.reason!, /not in canonical ABI encoding/)

  const short = matchCreationInput(`0x${'00'.repeat(100)}`, bytecode, abi)
  assert.equal(short.matches, false)
  assert.equal(short.args, null)
  assert.match(short.reason!, /shorter than the 160 bytes/)
})

test('runtime code matches only what the simulated creation returned; no code fails, no simulation is not run', () => {
  assert.equal(matchRuntime('0x6080aa', '0x6080AA').matches, true)
  const differs = matchRuntime('0x6080aa', '0x6080ab')
  assert.equal(differs.matches, false)
  assert.match(differs.reason!, /is not what AgentSpendPolicyBytecode returns/)
  const none = matchRuntime('0x', '0x6080aa')
  assert.equal(none.matches, false)
  assert.match(none.reason!, /no code at the address/)
  const unsimulated = matchRuntime('0x6080aa', null, 'eth_call refused')
  assert.equal(unsimulated.matches, null)
  assert.equal(unsimulated.reason, 'eth_call refused')
})

test('a null from one host is not an answer, an error is not an answer, and two answers that differ are a conflict', () => {
  const { receipt } = deployedBy(OWNER, 7)
  const one = agreeAcrossHosts<RpcReceipt>(
    [{ host: 'primary', value: null }, { host: 'blockdaemon', value: null, error: 'timeout' }, { host: 'drpc', value: receipt }],
    receiptFingerprint,
  )
  assert.equal(one.value, receipt)
  assert.deepEqual(one.answered, ['drpc'])
  assert.deepEqual(one.nulls, ['primary'])
  assert.deepEqual(one.errors, ['blockdaemon: timeout'])
  assert.equal(one.conflict, null)
  // Same receipt, different case: one answer, not two.
  const cased = agreeAcrossHosts<RpcReceipt>([{ host: 'a', value: receipt }, { host: 'b', value: { ...receipt, from: receipt.from.toUpperCase().replace('0X', '0x') } }], receiptFingerprint)
  assert.equal(cased.conflict, null)
  const split = agreeAcrossHosts<RpcReceipt>([{ host: 'a', value: receipt }, { host: 'b', value: { ...receipt, status: '0x0' } }], receiptFingerprint)
  assert.match(split.conflict!, /a say .*status 0x1.*; b say .*status 0x0/)
  const none = agreeAcrossHosts<RpcReceipt>([{ host: 'a', value: null }], receiptFingerprint)
  assert.equal(none.value, null)
})

test('a clean deploy by the owner, at its CREATE address, of the artifact, with bounded policy, is admitted', () => {
  const r = run()
  assert.deepEqual(refusedBy(r), [])
  assert.deepEqual(r.v.blocked, [])
  assert.equal(r.v.admitted, true)
  assert.ok(r.checks.every((c) => c.ok === true), r.checks.filter((c) => c.ok !== true).map((c) => c.id).join(', '))
})

test('each rule refuses on its own, naming itself', () => {
  const flipped = (() => {
    const body = INPUT.slice(2)
    return `0x${body.slice(0, 200)}${body[200] === 'f' ? '0' : 'f'}${body.slice(201)}`
  })()
  const byOther = deployedBy(OTHER, 7)
  const byUs = deployedBy(OPERATING, 3)
  const cases: [string, Case, string[]][] = [
    ['the deploy reverted', { receipt: { status: '0x0' } }, ['receipt-success']],
    ['the receipt names no contract', { receipt: { contractAddress: null } }, ['contract-created']],
    ['the transaction has a recipient, so it is not a deploy', { tx: { to: OTHER } }, ['creation-tx']],
    ['the transaction is in another block than the receipt', { tx: { blockHash: `0x${'ee'.repeat(32)}` } }, ['creation-tx']],
    ['the contract is not at the CREATE address of the sender and nonce', { tx: { nonce: '0x8' } }, ['create-address']],
    ['the hosts hold another block at that height', { block: { hash: `0x${'ee'.repeat(32)}` } }, ['deploy-block']],
    ['no host returned the deploy block', { block: null }, ['deploy-block']],
    ['another build was deployed', { tx: { input: flipped } }, ['creation-input']],
    ['the runtime code is not what the artifact returns', { runtime: matchRuntime('0x6080aa', '0x6080ab') }, ['runtime-code']],
    ['someone other than the owner sent the deploy', { deployer: { from: OTHER, nonce: 7 }, receipt: byOther.receipt, tx: byOther.tx }, ['owner-sent-deploy']],
    ['the owner is our operating wallet, and it sent the deploy itself', { deployer: { from: OPERATING, nonce: 3 }, receipt: byUs.receipt, tx: byUs.tx, state: { owner: OPERATING } }, ['owner-not-ours']],
    ['there is no operator', { state: { operator: zeroAddress } }, ['operator-set']],
    ['the operator is the owner', { state: { operator: OWNER } }, ['operator-set']],
    ['usdc() is another token', { state: { usdc: OTHER } }, ['usdc']],
    ['dailyCap is 0, no daily cap', { state: { dailyCap: 0n } }, ['daily-cap']],
    ['autoApproveMax is 0, no per-payment ceiling', { state: { autoApproveMax: 0n } }, ['auto-approve-max']],
    ['the session key never expires', { state: { sessionKeyExpiry: 0n } }, ['session-key-expiry']],
    ['the session key expires this very second', { state: { sessionKeyExpiry: NOW } }, ['session-key-expiry']],
    ['the session key has lapsed', { state: { sessionKeyExpiry: NOW - 1n } }, ['session-key-expiry']],
    ['the vault named next to the hash is not the one the receipt created', { expectedVault: OTHER }, ['contract-created']],
  ]
  for (const [name, c, expected] of cases) {
    const r = run(c)
    assert.equal(r.v.admitted, false, `${name}: admitted`)
    assert.deepEqual(refusedBy(r), expected, `${name}: refused by ${refusedBy(r).join(', ')}`)
  }
})

test('the owner is matched against our keys whatever its case, and the refusal names whose key it is', () => {
  const byUs = deployedBy(OPERATING, 3)
  for (const owner of [OPERATING, OPERATING.toLowerCase()]) {
    const r = run({ deployer: { from: OPERATING, nonce: 3 }, receipt: byUs.receipt, tx: byUs.tx, state: { owner } })
    const refusal = r.v.refusals.find((c) => c.id === 'owner-not-ours')!
    assert.match(refusal.detail, /is ours: the operating wallet/)
    assert.match(refusal.detail, /x402-gateway internal payer/)
  }
  // An operator that is ours is fine, and said: the agent that pays may be ours, the owner may not.
  const buyer = gatewayInternalPayers({} as NodeJS.ProcessEnv).find((a) => a.toLowerCase() !== OPERATING.toLowerCase())!
  const r = run({ state: { operator: buyer } })
  assert.equal(r.v.admitted, true)
  assert.match(r.checks.find((c) => c.id === 'operator-set')!.detail, /the agent that pays is ours, the owner is not/)
})

test('refusals lead with ownership, and a missing receipt refuses once with what it blocked listed apart', () => {
  const byUs = deployedBy(OPERATING, 3)
  const r = run({ deployer: { from: OPERATING, nonce: 3 }, receipt: byUs.receipt, tx: byUs.tx, state: { owner: OPERATING, dailyCap: 0n } })
  assert.deepEqual(refusedBy(r), ['owner-not-ours', 'daily-cap'])

  const missing = run({ receiptAnswers: [{ host: 'primary', value: null }, { host: 'blockdaemon', value: null }], state: null })
  assert.deepEqual(refusedBy(missing), ['receipt-found'])
  assert.match(missing.v.refusals[0].detail, /wait for it to be mined/)
  assert.ok(missing.v.blocked.length >= 10, `${missing.v.blocked.map((c) => c.id).join(', ')}`)
  assert.equal(missing.v.admitted, false)

  const { receipt } = deployedBy(OWNER, 7)
  const conflict = run({ receiptAnswers: [{ host: 'drpc', value: receipt }, { host: 'quicknode', value: { ...receipt, contractAddress: OTHER.toLowerCase() } }] })
  assert.equal(conflict.v.admitted, false)
  assert.equal(conflict.v.refusals[0].id, 'receipt-found')
  assert.match(conflict.v.refusals[0].detail, /the hosts disagree/)
})

test('a runtime check that cannot run spares a deploy whose creation input matched, but not a state-only read', () => {
  const unsimulated = matchRuntime('0x6080aa', null, 'no host could simulate the creation')
  const withReceipt = run({ runtime: unsimulated })
  assert.equal(withReceipt.v.admitted, true)
  assert.deepEqual(withReceipt.v.notRun.map((c) => c.id), ['runtime-code'])
  const stateOnly = run({ runtime: unsimulated, runtimeRequired: true })
  assert.deepEqual(refusedBy(stateOnly), ['runtime-code'])
})

test('ours: agent owners, both rails, the validator, env receiving wallets, and the address of each set EVM key', () => {
  const key = generatePrivateKey()
  const bare = generatePrivateKey()
  const env = {
    ARC_MAINNET_SIGNER_KEY: key,
    CCTP_EVM_SIGNER_KEY: bare.slice(2),
    ARC_VALIDATOR_KEY: 'not a key',
    X402_GATEWAY_PAYTO: ` ${OTHER} , not-an-address`,
  }
  const ours = collectOurAddresses({
    provenance: [
      { chain: ADMISSION_CHAIN, agent: { tokenId: '0', caip: 'x', owner: OPERATING, tokenUri: 'x' }, accounts: [] },
      { chain: 'base', agent: { tokenId: '1', caip: 'x', owner: OPERATING.toLowerCase(), tokenUri: 'x' } },
      {
        chain: 'stellar-testnet',
        accounts: [
          { role: 'deployer', address: OPERATOR, network: 'stellar-testnet', custody: 'ours: local CLI keystore', usedFor: 'x', publishedAt: '2026-10-01' },
          { role: 'a person', address: OWNER, network: 'stellar-testnet', custody: 'owner: passkey smart account', usedFor: 'x', publishedAt: '2026-10-01' },
        ],
      },
    ],
    gatewayInternalPayers: ['0x4444444444444444444444444444444444444444'],
    facilitatorInternalPayers: ['0x4444444444444444444444444444444444444444'],
    attestationValidators: ['0x5555555555555555555555555555555555555555'],
    keyEnvVars: ourKeyEnvVars(),
    addressEnvVars: ['X402_GATEWAY_PAYTO'],
    env,
  })
  const of = (a: string) => ours.byAddress.get(a.toLowerCase()) ?? []
  assert.deepEqual(of(OPERATING), [`the operating wallet (our agent's owner in the provenance ledger on ${ADMISSION_CHAIN}, base)`])
  assert.deepEqual(of(OPERATOR), ['provenance account on stellar-testnet: deployer'])
  assert.deepEqual(of(OWNER), [], 'an owner the ledger labels as not ours is not ours')
  assert.deepEqual(of('0x4444444444444444444444444444444444444444'), ['x402-gateway internal payer', 'x402-3009 internal payer'])
  assert.equal(of('0x5555555555555555555555555555555555555555').length, 1)
  assert.deepEqual(of(OTHER), ['env X402_GATEWAY_PAYTO'])
  assert.deepEqual(of(privateKeyToAccount(key).address), ['the address of env ARC_MAINNET_SIGNER_KEY'])
  assert.deepEqual(of(privateKeyToAccount(bare).address), ['the address of env CCTP_EVM_SIGNER_KEY'])
  assert.deepEqual(ours.envKeysDerived.sort(), ['ARC_MAINNET_SIGNER_KEY', 'CCTP_EVM_SIGNER_KEY'])
  assert.deepEqual(ours.envKeysUnreadable, ['ARC_VALIDATOR_KEY'])
  // A key is used for its address and nothing else: no source names any key material.
  const everything = JSON.stringify([...ours.byAddress])
  for (const secret of [key, bare.slice(2), 'not a key']) assert.ok(!everything.includes(secret))
})

test('the live sources name the launch-day vault owner, both rails\' buyers and every EVM signer env var', () => {
  assert.match(OURS.byAddress.get(OPERATING.toLowerCase())!.join('; '), /^the operating wallet \(our agent's owner in the provenance ledger on arc-mainnet/)
  for (const a of [...gatewayInternalPayers({} as NodeJS.ProcessEnv), ...facilitatorInternalPayers({} as NodeJS.ProcessEnv)]) {
    assert.ok(OURS.byAddress.has(a.toLowerCase()), `${a} is on a rail's internal list and must be ours`)
  }
  const vars = ourKeyEnvVars()
  assert.ok(arc.signerEnvVar && vars.includes(arc.signerEnvVar))
  for (const { name } of OUR_KEY_ENV_VARS) assert.ok(vars.includes(name))
  assert.equal(new Set(vars).size, vars.length)
  // The env lists the rails read are honored too, so a wallet added there is refused here.
  const extra = '0x6666666666666666666666666666666666666666'
  const withEnv = collectOurAddresses(liveOurAddressSources({ X402_GATEWAY_INTERNAL_PAYERS: extra } as NodeJS.ProcessEnv))
  assert.ok(withEnv.byAddress.has(extra))
})

test('every registry RPC host is read in order, and the env endpoint is added, never substituted or shown', () => {
  const plain = admissionHosts(arc, {})
  assert.deepEqual(plain.map((h) => h.url), arc.rpcUrls)
  assert.deepEqual(plain.map((h) => h.label), arc.rpcUrls.map((u) => new URL(u).host))
  const secretUrl = 'https://arc.example.invalid/v1/secret-token-path'
  const env = arc.rpcEnvVar ? { [arc.rpcEnvVar]: secretUrl } : {}
  const withOverride = admissionHosts(arc, env)
  assert.deepEqual(withOverride.map((h) => h.url), [...arc.rpcUrls, secretUrl])
  assert.ok(!withOverride.some((h) => h.label.includes('secret-token-path')), 'a credentialed path never reaches a label')
  assert.equal(admissionHosts(arc, arc.rpcEnvVar ? { [arc.rpcEnvVar]: arc.rpcUrls[0] } : {}).length, arc.rpcUrls.length)
})

test('the entry is paste-ready: it parses, round-trips, is ASCII and carries no chain constant', () => {
  const input: EntryInput = {
    vault: getCreateAddress({ from: OWNER, nonce: 7n }),
    ownerKind: 'external',
    deployTx: TX.toUpperCase().replace('0X', '0x'),
    deployBlockTime: 1_793_404_799n, // 2026-10-30T23:59:59Z: the UTC day, not the local one
    state: STATE,
    checkedBlock: 28_990_546n,
    checkedBlockTime: NOW,
    token: TOKEN,
    operatorIsOurs: false,
  }
  const ready = pasteReadyEntry(input)
  assert.ok(ready.ok)
  assert.equal(ready.trimmed, false)
  assert.equal(ready.entry.deployedAt, '2026-10-30')
  assert.equal(ready.entry.deployTx, TX)
  assert.equal(ready.entry.owner, OWNER)
  assert.equal(ready.entry.ownerKind, 'external')
  assert.match(ready.source, /ownerKind: 'external',/)
  assert.match(ready.entry.note, /dailyCap 1 USDC, autoApproveMax 0\.25 USDC/)
  assert.match(ready.source, /^[\x20-\x7e\n]+$/)
  assert.deepEqual(pasteViolations(ready.source), [])
  const parsed = new Function(`return [\n${ready.source}\n]`)() as unknown[]
  assert.deepEqual(parsed, [ready.entry])

  // A cap of 196 USDC is X Layer's chain id to the guard: the note drops its numbers rather
  // than hand over an entry that fails the build.
  const xlayer = getChainById('xlayer')!
  const collides = pasteReadyEntry({ ...input, state: { ...STATE, dailyCap: BigInt(xlayer.evmChainId!) * 1_000_000n } })
  assert.ok(collides.ok)
  assert.equal(collides.trimmed, true)
  assert.deepEqual(pasteViolations(collides.source), [])
  assert.doesNotMatch(collides.entry.note, /dailyCap/)

  assert.match(renderEntry({ ...ready.entry, note: "the owner's key" }), /note: 'the owner\\'s key',/)
})

test('admitting without our env refuses by name; a run with it passes that check', () => {
  const none = envLoadedCheck({ byAddress: new Map(), envKeysDerived: [], envKeysUnreadable: [] })
  assert.equal(none.ok, false)
  assert.equal(none.required, true)
  assert.match(none.detail, /--env-file=\.env/)
  const unreadable = envLoadedCheck({ byAddress: new Map(), envKeysDerived: ['A_KEY'], envKeysUnreadable: ['B_KEY'] })
  assert.equal(unreadable.ok, false)
  assert.match(unreadable.detail, /B_KEY/)
  const loaded = envLoadedCheck({ byAddress: new Map(), envKeysDerived: ['A_KEY'], envKeysUnreadable: [] })
  assert.equal(loaded.ok, true)
  assert.equal(verdict([none]).admitted, false)
  // The script asks only when it would admit: --tx on Milestone 1, not a rehearsal or a state read.
  const script = readFileSync(new URL('../scripts/arc-owner-vault-check.mjs', import.meta.url), 'utf8')
  assert.match(script, /opts\.tx && !rehearsal \? \[admission\.envLoadedCheck\(ours\)\]/)
})

test('--owner-kind is team or external and is never defaulted, and the script refuses to admit without it', () => {
  assert.equal(parseOwnerKind('team'), 'team')
  assert.equal(parseOwnerKind('external'), 'external')
  for (const bad of ['', 'Team', 'ours', 'internal', null, undefined]) assert.equal(parseOwnerKind(bad), null, String(bad))
  // Compiled to dist/, so the script sits one level up from here.
  const script = readFileSync(new URL('../scripts/arc-owner-vault-check.mjs', import.meta.url), 'utf8')
  assert.match(script, /if \(opts\.tx && !rehearsal && !ownerKind\) usage\(/)
  assert.match(script, /pasteReadyEntry\(\{\s*vault,\s*ownerKind,/)
})

test('the paste guard catches what chains/no-hardcoded-chains.test.ts catches, and only as whole values', () => {
  const id = String(arc.evmChainId)
  assert.ok(pasteViolations(`chain ${id} only`).includes(`${arc.id}'s numeric chain id`))
  assert.deepEqual(pasteViolations(`block ${id}7 and 0x${id}aa`), [])
  assert.ok(pasteViolations(USDC.toLowerCase()).includes(`${arc.id}'s USDC address`))
  assert.ok(pasteViolations(`see ${arc.explorer}/tx/0x1`).includes(`${arc.id}'s explorer host`))
  assert.ok(pasteViolations(new URL(arc.rpcUrls[0]).host).includes(`${arc.id}'s RPC host`))
})

test('times beyond the calendar print as numbers, and a listed day is always a UTC day', () => {
  assert.equal(isoFromSeconds(0n), '1970-01-01T00:00:00Z')
  assert.match(isoFromSeconds(2n ** 256n - 1n), /beyond any calendar date/)
  assert.equal(utcDayFromSeconds(1_789_561_282n), '2026-09-16')
  assert.throws(() => utcDayFromSeconds(2n ** 64n), /no calendar day/)
  const notes = stateNotes({ ...STATE, frozen: true, sessionKeyExpiry: NOW + 400n * 86_400n }, NOW)
  assert.equal(notes.length, 2)
  assert.match(notes[0], /frozen/)
  assert.match(notes[1], /more than a year/)
  assert.deepEqual(stateNotes(STATE, NOW), [])
})

test('the curated list holds each vault once, and none owned by a key of ours', () => {
  // Passes on the empty list and guards the day it fills: a vault pasted twice counts twice,
  // and a vault owned by one of our keys is exactly what this milestone does not count.
  const addresses = ARC_OWNER_HELD_VAULTS.map((v) => v.address.toLowerCase())
  const hashes = ARC_OWNER_HELD_VAULTS.map((v) => v.deployTx.toLowerCase())
  assert.equal(new Set(addresses).size, addresses.length, 'a vault is listed twice')
  assert.equal(new Set(hashes).size, hashes.length, 'a deploy hash is listed twice')
  for (const v of ARC_OWNER_HELD_VAULTS) {
    assert.ok(!OURS.byAddress.has(v.owner.toLowerCase()), `vault ${v.address} is owned by ${v.owner}, which is ours: ${OURS.byAddress.get(v.owner.toLowerCase())?.join('; ')}`)
    assert.ok(Number.isFinite(Date.parse(`${v.deployedAt}T00:00:00Z`)), `vault ${v.address} has no real deploy day`)
  }
})
