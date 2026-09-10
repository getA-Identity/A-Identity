import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { __resetPlatformStateForTests, createAgent, startKyaChallenge, verifyKya, type PlatformAgent } from '../platform.js'
import { state } from './core.js'
import { verifyWalletSignature, contractSignatureChains, type ContractSignatureCheck } from '../erc1271.js'
import { CHAINS } from '../chains/index.js'

/**
 * KYA for contract accounts.
 *
 * The check used to be viem's offline recovery alone, which is right for a key and can
 * never be right for a smart contract account: there is no key to recover, the chain
 * decides through ERC-1271. Circle's agent wallets are such accounts. These tests pin
 * that a key still verifies exactly as before, that a contract account verifies through
 * the injected chain answer and records which chain said yes, and that every refusal is
 * a refusal rather than a crash.
 */
__resetPlatformStateForTests()

// Keys are generated when the tests run: nothing key-shaped lives in the tree.
const eoa = privateKeyToAccount(generatePrivateKey())
const other = privateKeyToAccount(generatePrivateKey())
/** A contract account has no key; any 65-byte blob will do as its "signature". */
const SCA = '0x00000000000000000000000000000000000000cA'
const SCA_SIG = ('0x' + 'ab'.repeat(65)) as `0x${string}`
const OWNER = 'owner@test'

let seq = 0
function seed(wallet: string): PlatformAgent {
  seq += 1
  const agent = createAgent({ name: `KYA Agent ${seq}`, description: 'Seeded for KYA tests.', category: 'Research', capabilities: [], permissions: {}, owner: OWNER })
  const row = state.agents.find((a) => a.id === agent.id) as PlatformAgent
  row.walletAddress = wallet
  return row
}

const yesOn = (id: string): ContractSignatureCheck => async (chain) => chain.id === id
const never: ContractSignatureCheck = () => new Promise(() => {})
const throws: ContractSignatureCheck = async () => { throw new Error('rpc down') }

test('a key-held wallet still verifies offline and records wallet-signature', async () => {
  const agent = seed(eoa.address)
  const c = startKyaChallenge(agent.id, OWNER)
  assert.ok(!('error' in c))
  const signature = await eoa.signMessage({ message: c.message })
  const r = await verifyKya(agent.id, c.message, signature, OWNER, { deps: { checkContract: throws } })
  assert.ok(!('error' in r))
  assert.equal(r.kya, 'verified')
  assert.equal(r.kyaProof?.method, 'wallet-signature')
  assert.equal(r.kyaProof?.chain, undefined)
})

test('a contract account verifies through ERC-1271 and the proof names the chain that answered', async () => {
  const agent = seed(SCA)
  const c = startKyaChallenge(agent.id, OWNER)
  assert.ok(!('error' in c))
  const r = await verifyKya(agent.id, c.message, SCA_SIG, OWNER, { deps: { checkContract: yesOn('base') } })
  assert.ok(!('error' in r), JSON.stringify(r))
  assert.equal(r.kyaProof?.method, 'erc1271-signature')
  assert.equal(r.kyaProof?.chain, 'base')
  assert.equal(agent.kya, 'verified')
  assert.ok(agent.activity.some((a) => a.text.includes('ERC-1271 on base')))
})

test('naming a chain narrows the contract check to it, so the wrong chain is a refusal', async () => {
  const agent = seed(SCA)
  const c = startKyaChallenge(agent.id, OWNER)
  assert.ok(!('error' in c))
  const wrong = await verifyKya(agent.id, c.message, SCA_SIG, OWNER, { chain: 'arbitrum', deps: { checkContract: yesOn('base') } })
  assert.ok('error' in wrong)
  assert.match(wrong.error, /contract account/)
  assert.equal(agent.kya, 'unverified')
  // The challenge survives a refusal, so the right chain can still answer.
  const right = await verifyKya(agent.id, c.message, SCA_SIG, OWNER, { chain: 'eip155:8453', deps: { checkContract: yesOn('base') } })
  assert.ok(!('error' in right))
  assert.equal(right.kyaProof?.chain, 'base')
})

test('a signature from a different key falls through to the contract path and is refused there', async () => {
  const agent = seed(eoa.address)
  const c = startKyaChallenge(agent.id, OWNER)
  assert.ok(!('error' in c))
  const signature = await other.signMessage({ message: c.message })
  const r = await verifyKya(agent.id, c.message, signature, OWNER, { deps: { checkContract: async () => false } })
  assert.ok('error' in r)
  assert.equal(agent.kya, 'unverified')
})

test('a chain that never answers or throws is a no, inside the deadline, not a hang or a crash', async () => {
  const agent = seed(SCA)
  const c = startKyaChallenge(agent.id, OWNER)
  assert.ok(!('error' in c))
  const t0 = Date.now()
  const r = await verifyKya(agent.id, c.message, SCA_SIG, OWNER, { deps: { checkContract: never, timeoutMs: 50 } })
  assert.ok('error' in r)
  assert.ok(Date.now() - t0 < 2000)
  const r2 = await verifyKya(agent.id, c.message, SCA_SIG, OWNER, { deps: { checkContract: throws } })
  assert.ok('error' in r2)
})

test('the on-chain attestation body names the method, so an ERC-1271 proof is not recorded as a key signature', async () => {
  // Without an anchored token no tx is attempted; the proof itself is what is checked here.
  const agent = seed(SCA)
  const c = startKyaChallenge(agent.id, OWNER)
  assert.ok(!('error' in c))
  const r = await verifyKya(agent.id, c.message, SCA_SIG, OWNER, { deps: { checkContract: yesOn('rhchain') } })
  assert.ok(!('error' in r))
  assert.deepEqual({ method: agent.kyaProof?.method, chain: agent.kyaProof?.chain }, { method: 'erc1271-signature', chain: 'rhchain' })
})

test('verifyWalletSignature asks every EVM chain in the registry, mainnets first, when none is named', async () => {
  const chains = contractSignatureChains()
  const evm = CHAINS.filter((c) => c.ecosystem === 'evm' && c.rpcUrls.length > 0)
  assert.equal(chains.length, evm.length)
  const firstTestnet = chains.findIndex((c) => c.testnet)
  const lastMainnet = chains.map((c) => c.testnet).lastIndexOf(false)
  assert.ok(firstTestnet === -1 || lastMainnet < firstTestnet, 'mainnets come before testnets')
  const asked: string[] = []
  const v = await verifyWalletSignature({ address: SCA, message: 'm', signature: SCA_SIG }, { checkContract: async (c) => { asked.push(c.id); return c.id === 'celo' } })
  assert.deepEqual(v, { ok: true, method: 'erc1271-signature', chain: 'celo' })
  assert.equal(asked.length, evm.length)
})

test('verifyWalletSignature refuses malformed input before touching a chain', async () => {
  let asked = 0
  const check: ContractSignatureCheck = async () => { asked += 1; return true }
  assert.deepEqual(await verifyWalletSignature({ address: 'nope', message: 'm', signature: SCA_SIG }, { checkContract: check }), { ok: false })
  assert.deepEqual(await verifyWalletSignature({ address: SCA, message: 'm', signature: 'zz' }, { checkContract: check }), { ok: false })
  assert.deepEqual(await verifyWalletSignature({ address: SCA, message: 'm', signature: SCA_SIG, chain: 'stellar' }, { checkContract: check }), { ok: false })
  assert.equal(asked, 0)
})
